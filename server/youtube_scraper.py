#!/usr/bin/env python3
"""YouTube social scanner for MemePulse.

This worker keeps the same sidecar contract as the existing backend:
- Node writes a tracked-coin manifest.
- Node launches this script on a schedule.
- This script stores normalized mention events in SQLite using the existing schema.

This version is intentionally less restrictive than the original implementation while
still staying efficient:
- Discovery does *not* require the contract address in the YouTube search query.
- Searches can use a small number of prioritized query variants per coin.
- Shorts-only filtering is optional and only applied when requested.
- Comments can be scanned on a bounded set of recent candidate videos even when the
  video metadata itself did not already match.
- Matching uses lightweight meme-coin context heuristics to reduce false positives for
  generic symbols like "USA", "AI", "DOG", etc.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import urlopen

SERVER_DIR = Path(__file__).resolve().parent
DEFAULT_DB_PATH = SERVER_DIR / 'data' / 'youtube-publicity.sqlite'
DEFAULT_COINS_PATH = SERVER_DIR / 'data' / 'tracked-coins.json'
SCHEMA_PATH = SERVER_DIR / 'youtube_schema.sql'
API_BASE_URL = 'https://www.googleapis.com/youtube/v3'

DURATION_RE = re.compile(
    r'^P(?:T(?:(?P<hours>\d+)H)?(?:(?P<minutes>\d+)M)?(?:(?P<seconds>\d+)S)?)$'
)
HASHTAG_RE = re.compile(r'(?<!\w)#([A-Za-z0-9_]+)')
WHITESPACE_RE = re.compile(r'\s+')

# Context words help screen out false positives for very generic tickers.
MEME_CONTEXT_RE = re.compile(
    r'\b('
    r'coin|token|crypto|memecoin|meme\s*coin|sol|solana|pump|moon|cto|'
    r'raydium|dex|dexscreener|liquidity|market\s*cap|holder|launch|airdrop'
    r')\b',
    re.IGNORECASE,
)


class YouTubeApiError(RuntimeError):
    pass


def is_fatal_api_error(exc: BaseException) -> bool:
    message = str(exc).casefold()
    fatal_markers = (
        'quota',
        'dailylimit',
        'ratelimit',
        'forbidden',
        'access not configured',
        'api key',
        'keyinvalid',
        'key expired',
        'iprefererblocked',
        'youtube data api has not been used',
    )
    return any(marker in message for marker in fatal_markers)


@dataclass(frozen=True)
class CoinSignal:
    coin_id: str
    symbol: str
    symbol_upper: str
    name: str
    contract_address: str
    symbol_is_ambiguous: bool
    cashtag_re: Optional[re.Pattern[str]]
    hashtag_re: Optional[re.Pattern[str]]
    symbol_re: Optional[re.Pattern[str]]
    name_re: Optional[re.Pattern[str]]
    contract_re: Optional[re.Pattern[str]]


@dataclass
class VideoCandidate:
    video: Dict[str, Any]
    metadata_score: float
    metadata_match_text: str


@dataclass
class MatchResult:
    score: float
    matched_text: str
    matched_via_symbol_only: bool


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Scan YouTube for tracked memecoins.')
    parser.add_argument('--coins', default=str(DEFAULT_COINS_PATH), help='Path to tracked coin manifest JSON.')
    parser.add_argument('--db', default=str(DEFAULT_DB_PATH), help='Path to SQLite database file.')
    parser.add_argument('--limit', type=int, default=8, help='Per-coin YouTube search result cap.')
    parser.add_argument('--comment-limit', type=int, default=25, help='Per-video top-level comment cap.')
    parser.add_argument('--lookback-hours', type=int, default=72, help='How far back to search for new videos.')
    parser.add_argument('--shorts-max-seconds', type=int, default=75, help='Maximum duration to treat as a Short-like clip.')
    parser.add_argument('--require-shorts', action='store_true', help='Discard videos longer than --shorts-max-seconds.')
    parser.add_argument('--max-queries-per-coin', type=int, default=1, help='Maximum number of YouTube search queries to issue per coin.')
    return parser.parse_args()


def require_env(name: str) -> str:
    value = os.getenv(name, '').strip()
    if not value:
        raise SystemExit(f'Missing required environment variable: {name}')
    return value


def ensure_schema(connection: sqlite3.Connection) -> None:
    schema = SCHEMA_PATH.read_text(encoding='utf-8')
    connection.executescript(schema)
    connection.commit()


def load_coins(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        raise SystemExit(
            f'Tracked coin manifest not found at {path}. Start the backend once so it can write server/data/tracked-coins.json, or pass --coins explicitly.'
        )

    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, list):
        raise SystemExit('Tracked coin manifest must be a JSON array.')

    coins: List[Dict[str, Any]] = []
    seen: set[str] = set()

    for item in payload:
        if not isinstance(item, dict):
            continue

        coin_id = str(item.get('coinId') or '').strip()
        contract_address = str(item.get('contractAddress') or '').strip()
        if not coin_id or not contract_address or coin_id in seen:
            continue

        seen.add(coin_id)
        coins.append(
            {
                'coinId': coin_id,
                'symbol': str(item.get('symbol') or '').strip(),
                'name': str(item.get('name') or '').strip(),
                'contractAddress': contract_address,
            }
        )

    return coins


def iso_now() -> str:
    return (
        datetime.now(tz=timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace('+00:00', 'Z')
    )


def normalize_iso(value: str) -> str:
    text = str(value or '').strip()
    if not text:
        return iso_now()
    return text.replace('.000000Z', 'Z')


def published_after_iso(hours: int) -> str:
    lookback = max(1, int(hours))
    return (
        (datetime.now(tz=timezone.utc) - timedelta(hours=lookback))
        .replace(microsecond=0)
        .isoformat()
        .replace('+00:00', 'Z')
    )


def safe_int(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def safe_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def parse_duration_seconds(value: str) -> int:
    match = DURATION_RE.match(str(value or '').strip())
    if not match:
        return 0

    hours = int(match.group('hours') or 0)
    minutes = int(match.group('minutes') or 0)
    seconds = int(match.group('seconds') or 0)
    return (hours * 3600) + (minutes * 60) + seconds


def chunked(values: Sequence[str], size: int) -> Iterable[List[str]]:
    if size <= 0:
        size = 1
    for start in range(0, len(values), size):
        yield list(values[start : start + size])


def normalize_space(text: str) -> str:
    return WHITESPACE_RE.sub(' ', str(text or '')).strip()


def snippet_around(text: str, start: int, end: int, radius: int = 48) -> str:
    normalized = str(text or '')
    return normalize_space(normalized[max(0, start - radius) : min(len(normalized), end + radius)])


def make_boundary_regex(token: str, *, prefix: str = '') -> Optional[re.Pattern[str]]:
    cleaned = normalize_space(str(token or ''))
    if not cleaned:
        return None
    body = r'\s+'.join(re.escape(part) for part in cleaned.split())
    return re.compile(rf'(?<!\w){re.escape(prefix)}{body}(?!\w)', re.IGNORECASE)


def is_ambiguous_symbol(symbol: str) -> bool:
    clean_alpha = re.sub(r'[^A-Za-z]', '', str(symbol or ''))
    if not clean_alpha:
        return False
    return len(clean_alpha) <= 2


def build_coin_signal(coin: Dict[str, Any]) -> CoinSignal:
    symbol = str(coin.get('symbol') or '').strip()
    name = normalize_space(str(coin.get('name') or ''))
    contract_address = str(coin.get('contractAddress') or '').strip()

    return CoinSignal(
        coin_id=str(coin.get('coinId') or '').strip(),
        symbol=symbol,
        symbol_upper=symbol.upper(),
        name=name,
        contract_address=contract_address,
        symbol_is_ambiguous=is_ambiguous_symbol(symbol),
        cashtag_re=make_boundary_regex(symbol, prefix='$') if symbol else None,
        hashtag_re=make_boundary_regex(symbol, prefix='#') if symbol else None,
        symbol_re=make_boundary_regex(symbol) if symbol else None,
        name_re=make_boundary_regex(name) if name else None,
        contract_re=re.compile(re.escape(contract_address), re.IGNORECASE) if contract_address else None,
    )


def build_search_queries(signal: CoinSignal) -> List[str]:
    queries: List[str] = []

    def add(value: str) -> None:
        query = normalize_space(value)
        if not query:
            return
        folded = query.casefold()
        if folded in {existing.casefold() for existing in queries}:
            return
        queries.append(query)

    if signal.name:
        add(signal.name)

    if signal.symbol:
        if signal.symbol_is_ambiguous:
            add(f'{signal.symbol} coin')
            if signal.name and signal.name.casefold() != signal.symbol.casefold():
                add(f'{signal.name} token')
        else:
            add(signal.symbol_upper)
            add(f'${signal.symbol_upper}')

    if signal.symbol and signal.name and signal.name.casefold() != signal.symbol.casefold():
        add(f'{signal.symbol_upper} {signal.name}')

    if not queries:
        add(signal.coin_id)

    return queries[:3]


def extract_hashtags(text: str) -> List[str]:
    return [f'#{match.group(1)}' for match in HASHTAG_RE.finditer(str(text or ''))]


def find_best_text_match(text: str, signal: CoinSignal) -> MatchResult:
    haystack = str(text or '')
    if not haystack:
        return MatchResult(0.0, '', False)

    best_score = 0.0
    best_snippet = ''
    matched_via_symbol_only = False
    symbol_hit = False
    non_symbol_hit = False

    def consider(regex: Optional[re.Pattern[str]], score: float, symbol_only: bool) -> None:
        nonlocal best_score, best_snippet, matched_via_symbol_only, symbol_hit, non_symbol_hit
        if regex is None:
            return
        match = regex.search(haystack)
        if not match:
            return
        if symbol_only:
            symbol_hit = True
        else:
            non_symbol_hit = True
        if score > best_score:
            best_score = score
            best_snippet = snippet_around(haystack, match.start(), match.end())
            matched_via_symbol_only = symbol_only

    consider(signal.contract_re, 9.0, False)
    consider(signal.cashtag_re, 8.0, False)
    consider(signal.name_re, 7.0, False)
    consider(signal.hashtag_re, 6.0, False)
    consider(signal.symbol_re, 4.5 if signal.symbol_is_ambiguous else 5.5, True)

    if best_score <= 0:
        return MatchResult(0.0, '', False)

    context_present = bool(MEME_CONTEXT_RE.search(haystack))

    if signal.symbol_is_ambiguous and symbol_hit and not non_symbol_hit and not context_present:
        return MatchResult(0.0, '', False)

    if context_present:
        best_score += 1.0

    return MatchResult(best_score, best_snippet, matched_via_symbol_only and not non_symbol_hit)


def video_metadata_match(video: Dict[str, Any], signal: CoinSignal) -> MatchResult:
    snippet = video.get('snippet') or {}
    title = str(snippet.get('title') or '')
    description = str(snippet.get('description') or '')
    tags = snippet.get('tags') or []
    if not isinstance(tags, list):
        tags = []

    title_match = find_best_text_match(title, signal)
    description_match = find_best_text_match(description, signal)
    tags_match = find_best_text_match(' '.join(str(tag) for tag in tags), signal)
    hashtag_match = find_best_text_match(' '.join(extract_hashtags(title + ' ' + description)), signal)

    weighted: List[Tuple[float, str, bool]] = []
    if title_match.score > 0:
        weighted.append((title_match.score * 1.5, title_match.matched_text, title_match.matched_via_symbol_only))
    if hashtag_match.score > 0:
        weighted.append((hashtag_match.score * 1.2, hashtag_match.matched_text, hashtag_match.matched_via_symbol_only))
    if tags_match.score > 0:
        weighted.append((tags_match.score * 1.1, tags_match.matched_text, tags_match.matched_via_symbol_only))
    if description_match.score > 0:
        weighted.append((description_match.score, description_match.matched_text, description_match.matched_via_symbol_only))

    if not weighted:
        return MatchResult(0.0, '', False)

    score, matched_text, matched_via_symbol_only = max(weighted, key=lambda item: item[0])

    combined_text = ' '.join(
        part for part in [title, description, ' '.join(str(tag) for tag in tags)] if part
    )
    if signal.symbol_is_ambiguous and matched_via_symbol_only and not MEME_CONTEXT_RE.search(combined_text):
        return MatchResult(0.0, '', False)

    return MatchResult(score, matched_text, matched_via_symbol_only)


def youtube_get(endpoint: str, api_key: str, **params: Any) -> Dict[str, Any]:
    query: Dict[str, Any] = {'key': api_key}
    for key, value in params.items():
        if value is None:
            continue
        if isinstance(value, bool):
            query[key] = 'true' if value else 'false'
        else:
            query[key] = value

    url = f'{API_BASE_URL}/{endpoint}?{urlencode(query, doseq=True)}'

    try:
        with urlopen(url, timeout=20) as response:
            payload = response.read().decode('utf-8')
    except HTTPError as exc:  # pragma: no cover - network/runtime path
        details = exc.read().decode('utf-8', errors='replace')
        raise YouTubeApiError(f'YouTube API HTTP {exc.code}: {details}') from exc
    except URLError as exc:  # pragma: no cover - network/runtime path
        raise YouTubeApiError(f'YouTube API request failed: {exc}') from exc

    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:  # pragma: no cover - malformed remote response
        raise YouTubeApiError('YouTube API returned invalid JSON.') from exc

    if isinstance(data, dict) and isinstance(data.get('error'), dict):
        message = str(data['error'].get('message') or 'Unknown YouTube API error')
        raise YouTubeApiError(message)

    if not isinstance(data, dict):  # pragma: no cover - malformed remote response
        raise YouTubeApiError('YouTube API returned an unexpected payload shape.')

    return data


def search_video_ids_for_coin(
    api_key: str,
    signal: CoinSignal,
    search_limit: int,
    lookback_hours: int,
    require_shorts: bool,
    max_queries_per_coin: int,
) -> List[str]:
    unique_ids: List[str] = []
    seen_ids: set[str] = set()
    queries = build_search_queries(signal)[: max(1, int(max_queries_per_coin))]
    max_results = max(1, min(int(search_limit), 25))
    target_count = max_results

    def collect_ids(
        query: str,
        *,
        request_limit: int,
        order: str,
        published_after: Optional[str],
    ) -> int:
        if request_limit <= 0 or len(unique_ids) >= target_count:
            return 0

        search_kwargs: Dict[str, Any] = {
            'part': 'snippet',
            'type': 'video',
            'order': order,
            'q': query,
            'maxResults': max(1, min(int(request_limit), 25)),
        }
        if published_after:
            search_kwargs['publishedAfter'] = published_after
        if require_shorts:
            search_kwargs['videoDuration'] = 'short'

        payload = youtube_get('search', api_key, **search_kwargs)
        added = 0
        for item in payload.get('items', []) or []:
            if not isinstance(item, dict):
                continue
            identifier = item.get('id') or {}
            if not isinstance(identifier, dict):
                continue
            video_id = str(identifier.get('videoId') or '').strip()
            if video_id and video_id not in seen_ids:
                seen_ids.add(video_id)
                unique_ids.append(video_id)
                added += 1
                if len(unique_ids) >= target_count:
                    break
        return added

    fresh_cutoff = published_after_iso(lookback_hours)

    for index, query in enumerate(queries):
        if len(unique_ids) >= target_count:
            break
        request_limit = max_results if index == 0 else max(2, min(max_results // 2, 8))
        collect_ids(query, request_limit=request_limit, order='date', published_after=fresh_cutoff)

    # If the fresh search comes back sparse, do a small relevance-ordered fallback without
    # the publishedAfter constraint. This helps recover older videos that are still getting
    # fresh comments, which otherwise disappear entirely.
    if len(unique_ids) < min(3, target_count):
        for query in queries[:2]:
            if len(unique_ids) >= target_count:
                break
            remaining = target_count - len(unique_ids)
            fallback_limit = max(2, min(5, remaining))
            collect_ids(query, request_limit=fallback_limit, order='relevance', published_after=None)

    return unique_ids


def fetch_video_map(video_ids: Sequence[str], api_key: str) -> Dict[str, Dict[str, Any]]:
    videos: Dict[str, Dict[str, Any]] = {}
    for group in chunked(list(dict.fromkeys(video_ids)), 50):
        payload = youtube_get(
            'videos',
            api_key,
            part='snippet,statistics,contentDetails',
            id=','.join(group),
            maxResults=len(group),
        )
        for item in payload.get('items', []) or []:
            if not isinstance(item, dict):
                continue
            video_id = str(item.get('id') or '').strip()
            if video_id:
                videos[video_id] = item
    return videos


def fetch_channel_stats(channel_ids: Sequence[str], api_key: str) -> Dict[str, int]:
    stats: Dict[str, int] = {}
    for group in chunked(list(dict.fromkeys(channel_ids)), 50):
        payload = youtube_get(
            'channels',
            api_key,
            part='statistics',
            id=','.join(group),
            maxResults=len(group),
        )
        for item in payload.get('items', []) or []:
            if not isinstance(item, dict):
                continue
            channel_id = str(item.get('id') or '').strip()
            statistics = item.get('statistics') or {}
            if channel_id:
                stats[channel_id] = safe_int(statistics.get('subscriberCount'))
    return stats


def fetch_comment_threads(video_id: str, api_key: str, limit: int) -> List[Dict[str, Any]]:
    comments: List[Dict[str, Any]] = []
    next_page_token: Optional[str] = None
    remaining = max(0, limit)

    while remaining > 0:
        page_size = min(100, remaining)
        payload = youtube_get(
            'commentThreads',
            api_key,
            part='snippet,replies',
            videoId=video_id,
            order='time',
            textFormat='plainText',
            maxResults=page_size,
            pageToken=next_page_token,
        )

        items = payload.get('items', []) or []
        if not isinstance(items, list):
            break

        for item in items:
            if isinstance(item, dict):
                comments.append(item)

        remaining -= len(items)
        next_page_token = str(payload.get('nextPageToken') or '').strip() or None
        if not next_page_token or not items:
            break

    return comments


def fetch_comment_replies(parent_id: str, api_key: str, limit: int) -> List[Dict[str, Any]]:
    replies: List[Dict[str, Any]] = []
    next_page_token: Optional[str] = None
    remaining = max(0, limit)

    while remaining > 0:
        page_size = min(100, remaining)
        payload = youtube_get(
            'comments',
            api_key,
            part='snippet',
            parentId=parent_id,
            textFormat='plainText',
            maxResults=page_size,
            pageToken=next_page_token,
        )

        items = payload.get('items', []) or []
        if not isinstance(items, list):
            break

        for item in items:
            if isinstance(item, dict):
                replies.append(item)

        remaining -= len(items)
        next_page_token = str(payload.get('nextPageToken') or '').strip() or None
        if not next_page_token or not items:
            break

    return replies


def expand_comment_replies(
    comment_items: Sequence[Dict[str, Any]],
    api_key: str,
    per_thread_limit: int = 20,
) -> List[Dict[str, Any]]:
    expanded: List[Dict[str, Any]] = []

    for item in comment_items:
        if not isinstance(item, dict):
            continue

        updated_item = dict(item)
        snippet = updated_item.get('snippet') or {}
        top_wrapper = (snippet.get('topLevelComment') or {})
        top_comment_id = str(top_wrapper.get('id') or '').strip()
        total_reply_count = safe_int(snippet.get('totalReplyCount'))

        existing_replies = ((updated_item.get('replies') or {}).get('comments') or [])
        if not isinstance(existing_replies, list):
            existing_replies = []
        merged_replies = [reply for reply in existing_replies if isinstance(reply, dict)]

        missing = max(0, total_reply_count - len(merged_replies))
        room = max(0, per_thread_limit - len(merged_replies))
        if top_comment_id and missing > 0 and room > 0:
            fetched_replies = fetch_comment_replies(top_comment_id, api_key, min(missing, room))
            seen_reply_ids = {
                str((reply or {}).get('id') or '').strip()
                for reply in merged_replies
                if isinstance(reply, dict)
            }
            for reply in fetched_replies:
                reply_id = str(reply.get('id') or '').strip()
                if reply_id and reply_id in seen_reply_ids:
                    continue
                if reply_id:
                    seen_reply_ids.add(reply_id)
                merged_replies.append(reply)

        if merged_replies or total_reply_count > 0:
            replies_wrapper = dict(updated_item.get('replies') or {})
            replies_wrapper['comments'] = merged_replies
            updated_item['replies'] = replies_wrapper

        expanded.append(updated_item)

    return expanded


def gather_comment_author_channels(items: Sequence[Dict[str, Any]]) -> List[str]:
    channel_ids: List[str] = []
    for item in items:
        snippet = item.get('snippet') or {}
        top_level = ((snippet.get('topLevelComment') or {}).get('snippet') or {})
        author_channel = (top_level.get('authorChannelId') or {})
        channel_id = str(author_channel.get('value') or '').strip()
        if channel_id:
            channel_ids.append(channel_id)

        replies = (item.get('replies') or {}).get('comments') or []
        if not isinstance(replies, list):
            continue
        for reply in replies:
            if not isinstance(reply, dict):
                continue
            reply_snippet = reply.get('snippet') or {}
            reply_author_channel = (reply_snippet.get('authorChannelId') or {})
            reply_channel_id = str(reply_author_channel.get('value') or '').strip()
            if reply_channel_id:
                channel_ids.append(reply_channel_id)
    return channel_ids


def compute_base_value(follower_count: int, engagement_count: int, user_post_index: int) -> float:
    follower_score = follower_count / 1000
    engagement_score = engagement_count * 2
    raw_impact = follower_score + engagement_score
    spam_penalty = math.sqrt(max(1, user_post_index))
    return raw_impact / spam_penalty


def fetch_existing_user_post_index(connection: sqlite3.Connection, mention_id: str, coin_id: str) -> Optional[int]:
    row = connection.execute(
        'SELECT user_post_index FROM youtube_mentions WHERE mention_id = ? AND coin_id = ?',
        (mention_id, coin_id),
    ).fetchone()
    if row is None:
        return None
    return int(row[0])


def next_user_post_index(connection: sqlite3.Connection, coin_id: str, user_id: str) -> int:
    row = connection.execute(
        'SELECT post_count FROM youtube_user_coin_counts WHERE coin_id = ? AND user_id = ?',
        (coin_id, user_id),
    ).fetchone()
    prior_count = int(row[0]) if row else 0
    return prior_count + 1


def record_user_post_index(
    connection: sqlite3.Connection,
    coin_id: str,
    user_id: str,
    user_post_index: int,
) -> None:
    connection.execute(
        '''
        INSERT INTO youtube_user_coin_counts (coin_id, user_id, post_count, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(coin_id, user_id)
        DO UPDATE SET post_count = excluded.post_count, updated_at = excluded.updated_at
        ''',
        (coin_id, user_id, user_post_index, iso_now()),
    )


def upsert_mention(
    connection: sqlite3.Connection,
    *,
    mention_id: str,
    coin_id: str,
    source_type: str,
    timestamp: str,
    user_id: str,
    follower_count: int,
    engagement_count: int,
    video_id: str,
    channel_id: str,
    title: str,
    matched_text: str,
    permalink: str,
) -> None:
    existing_user_post_index = fetch_existing_user_post_index(connection, mention_id, coin_id)
    user_post_index = (
        existing_user_post_index
        if existing_user_post_index is not None
        else next_user_post_index(connection, coin_id, user_id)
    )

    base_value = compute_base_value(follower_count, engagement_count, user_post_index)

    if existing_user_post_index is None:
        record_user_post_index(connection, coin_id, user_id, user_post_index)
        connection.execute(
            '''
            INSERT INTO youtube_mentions (
              mention_id,
              coin_id,
              source_type,
              timestamp,
              user_id,
              follower_count,
              engagement_count,
              user_post_index,
              base_value,
              video_id,
              channel_id,
              title,
              matched_text,
              permalink,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''',
            (
                mention_id,
                coin_id,
                source_type,
                normalize_iso(timestamp),
                user_id,
                max(0, follower_count),
                max(0, engagement_count),
                user_post_index,
                base_value,
                video_id,
                channel_id,
                title,
                matched_text,
                permalink,
                iso_now(),
            ),
        )
        return

    connection.execute(
        '''
        UPDATE youtube_mentions
        SET source_type = ?,
            timestamp = ?,
            user_id = ?,
            follower_count = ?,
            engagement_count = ?,
            base_value = ?,
            video_id = ?,
            channel_id = ?,
            title = ?,
            matched_text = ?,
            permalink = ?,
            updated_at = ?
        WHERE mention_id = ? AND coin_id = ?
        ''',
        (
            source_type,
            normalize_iso(timestamp),
            user_id,
            max(0, follower_count),
            max(0, engagement_count),
            base_value,
            video_id,
            channel_id,
            title,
            matched_text,
            permalink,
            iso_now(),
            mention_id,
            coin_id,
        ),
    )


def extract_video_permalink(video_id: str) -> str:
    return f'https://www.youtube.com/watch?v={video_id}'


def select_video_candidates(
    ordered_video_ids: Sequence[str],
    video_map: Dict[str, Dict[str, Any]],
    signal: CoinSignal,
    require_shorts: bool,
    shorts_max_seconds: int,
    search_limit: int,
) -> Tuple[List[VideoCandidate], List[VideoCandidate]]:
    candidates: List[VideoCandidate] = []

    for video_id in ordered_video_ids:
        video = video_map.get(video_id)
        if not video:
            continue

        duration_seconds = parse_duration_seconds((video.get('contentDetails') or {}).get('duration') or '')
        if require_shorts and duration_seconds > max(1, shorts_max_seconds):
            continue

        metadata_match = video_metadata_match(video, signal)
        candidates.append(
            VideoCandidate(
                video=video,
                metadata_score=metadata_match.score,
                metadata_match_text=metadata_match.matched_text,
            )
        )

    if not candidates:
        return [], []

    metadata_matched = [candidate for candidate in candidates if candidate.metadata_score > 0]

    # Keep comment scanning bounded. Favor strong metadata matches, but still allow a few
    # recent discovery hits through so comments can rescue cases where only the comments
    # mention the token.
    comment_budget = max(2, min(len(candidates), max(4, min(int(search_limit), 8))))
    comment_candidates = sorted(
        candidates,
        key=lambda candidate: (
            candidate.metadata_score,
            safe_int((candidate.video.get('statistics') or {}).get('viewCount')),
        ),
        reverse=True,
    )[:comment_budget]

    return metadata_matched, comment_candidates


def upsert_comment_mentions(
    connection: sqlite3.Connection,
    signal: CoinSignal,
    video: Dict[str, Any],
    comment_items: Sequence[Dict[str, Any]],
    channel_stats: Dict[str, int],
) -> int:
    coin_id = signal.coin_id
    video_id = str(video.get('id') or '').strip()
    permalink = extract_video_permalink(video_id)
    video_title = str((video.get('snippet') or {}).get('title') or '')
    count = 0

    for item in comment_items:
        top_wrapper = (item.get('snippet') or {}).get('topLevelComment') or {}
        top_comment_id = str(top_wrapper.get('id') or '').strip()
        top_snippet = top_wrapper.get('snippet') or {}
        top_text = str(top_snippet.get('textDisplay') or top_snippet.get('textOriginal') or '')
        top_match = find_best_text_match(f'{top_text}\n{video_title}', signal)
        if top_comment_id and top_match.score > 0:
            author_channel = (top_snippet.get('authorChannelId') or {})
            commenter_channel_id = str(author_channel.get('value') or '').strip()
            user_id = commenter_channel_id or str(top_snippet.get('authorDisplayName') or 'anonymous')
            engagement_count = safe_int(top_snippet.get('likeCount')) + safe_int((item.get('snippet') or {}).get('totalReplyCount'))
            upsert_mention(
                connection,
                mention_id=f'comment:{top_comment_id}',
                coin_id=coin_id,
                source_type='comment',
                timestamp=str(top_snippet.get('publishedAt') or iso_now()),
                user_id=user_id,
                follower_count=channel_stats.get(commenter_channel_id, 0),
                engagement_count=engagement_count,
                video_id=video_id,
                channel_id=commenter_channel_id or user_id,
                title=video_title,
                matched_text=top_match.matched_text,
                permalink=f'{permalink}&lc={top_comment_id}',
            )
            count += 1

        replies = (item.get('replies') or {}).get('comments') or []
        if not isinstance(replies, list):
            continue

        for reply in replies:
            if not isinstance(reply, dict):
                continue
            reply_id = str(reply.get('id') or '').strip()
            reply_snippet = reply.get('snippet') or {}
            reply_text = str(reply_snippet.get('textDisplay') or reply_snippet.get('textOriginal') or '')
            reply_match = find_best_text_match(f'{reply_text}\n{video_title}', signal)
            if not reply_id or reply_match.score <= 0:
                continue
            reply_author_channel = (reply_snippet.get('authorChannelId') or {})
            reply_channel_id = str(reply_author_channel.get('value') or '').strip()
            reply_user_id = reply_channel_id or str(reply_snippet.get('authorDisplayName') or 'anonymous')
            upsert_mention(
                connection,
                mention_id=f'comment:{reply_id}',
                coin_id=coin_id,
                source_type='comment',
                timestamp=str(reply_snippet.get('publishedAt') or iso_now()),
                user_id=reply_user_id,
                follower_count=channel_stats.get(reply_channel_id, 0),
                engagement_count=safe_int(reply_snippet.get('likeCount')),
                video_id=video_id,
                channel_id=reply_channel_id or reply_user_id,
                title=video_title,
                matched_text=reply_match.matched_text,
                permalink=f'{permalink}&lc={reply_id}',
            )
            count += 1

    return count


def scrape_coin(
    api_key: str,
    connection: sqlite3.Connection,
    coin: Dict[str, Any],
    search_limit: int,
    comment_limit: int,
    lookback_hours: int,
    require_shorts: bool,
    shorts_max_seconds: int,
    max_queries_per_coin: int,
) -> int:
    signal = build_coin_signal(coin)
    if not signal.coin_id:
        return 0

    video_ids = search_video_ids_for_coin(
        api_key=api_key,
        signal=signal,
        search_limit=search_limit,
        lookback_hours=lookback_hours,
        require_shorts=require_shorts,
        max_queries_per_coin=max(1, int(max_queries_per_coin)),
    )
    if not video_ids:
        return 0

    video_map = fetch_video_map(video_ids, api_key)
    if not video_map:
        return 0

    metadata_matched, comment_candidates = select_video_candidates(
        ordered_video_ids=video_ids,
        video_map=video_map,
        signal=signal,
        require_shorts=require_shorts,
        shorts_max_seconds=shorts_max_seconds,
        search_limit=search_limit,
    )
    if not metadata_matched and not comment_candidates:
        return 0

    uploader_channel_ids: List[str] = []
    for candidate in metadata_matched:
        channel_id = str(((candidate.video.get('snippet') or {}).get('channelId') or '')).strip()
        if channel_id:
            uploader_channel_ids.append(channel_id)
    uploader_stats = fetch_channel_stats(uploader_channel_ids, api_key) if uploader_channel_ids else {}

    total_mentions = 0

    for candidate in metadata_matched:
        video = candidate.video
        snippet = video.get('snippet') or {}
        stats = video.get('statistics') or {}
        video_id = str(video.get('id') or '').strip()
        channel_id = str(snippet.get('channelId') or '').strip()
        channel_user_id = channel_id or str(snippet.get('channelTitle') or 'anonymous-channel')
        engagement_count = safe_int(stats.get('likeCount')) + safe_int(stats.get('commentCount'))
        upsert_mention(
            connection,
            mention_id=f'video:{video_id}',
            coin_id=signal.coin_id,
            source_type='video_metadata',
            timestamp=str(snippet.get('publishedAt') or iso_now()),
            user_id=channel_user_id,
            follower_count=uploader_stats.get(channel_id, 0),
            engagement_count=engagement_count,
            video_id=video_id,
            channel_id=channel_id or channel_user_id,
            title=str(snippet.get('title') or ''),
            matched_text=candidate.metadata_match_text,
            permalink=extract_video_permalink(video_id),
        )
        total_mentions += 1

    seen_comment_videos: set[str] = set()
    for candidate in comment_candidates:
        video = candidate.video
        video_id = str(video.get('id') or '').strip()
        if not video_id or video_id in seen_comment_videos:
            continue
        seen_comment_videos.add(video_id)

        try:
            comment_items = fetch_comment_threads(video_id, api_key, max(0, comment_limit))
        except YouTubeApiError as exc:  # pragma: no cover - runtime API path
            message = str(exc)
            if 'commentsDisabled' in message or 'disabled comments' in message.lower():
                continue
            raise

        if not comment_items:
            continue

        comment_items = expand_comment_replies(comment_items, api_key, per_thread_limit=20)

        comment_author_ids = gather_comment_author_channels(comment_items)
        comment_channel_stats = fetch_channel_stats(comment_author_ids, api_key) if comment_author_ids else {}
        total_mentions += upsert_comment_mentions(
            connection=connection,
            signal=signal,
            video=video,
            comment_items=comment_items,
            channel_stats=comment_channel_stats,
        )

    return total_mentions


def configure_connection(connection: sqlite3.Connection) -> None:
    connection.execute('PRAGMA busy_timeout = 5000;')
    try:
        connection.execute('PRAGMA journal_mode = WAL;')
    except sqlite3.OperationalError:
        # Some mounted/dev filesystems reject WAL sidecar files. Fall back cleanly.
        connection.execute('PRAGMA journal_mode = DELETE;')


def main() -> int:
    args = parse_args()
    coins = load_coins(Path(args.coins).resolve())

    if not coins:
        print('No tracked coins found. Nothing to scrape.')
        return 0

    api_key = require_env('YOUTUBE_API_KEY')

    db_path = Path(args.db).resolve()
    db_path.parent.mkdir(parents=True, exist_ok=True)

    connection = sqlite3.connect(str(db_path))
    configure_connection(connection)
    ensure_schema(connection)

    total_mentions = 0
    fatal_error: Optional[BaseException] = None

    try:
        for coin in coins:
            try:
                total_mentions += scrape_coin(
                    api_key=api_key,
                    connection=connection,
                    coin=coin,
                    search_limit=max(1, int(args.limit)),
                    comment_limit=max(0, int(args.comment_limit)),
                    lookback_hours=max(1, int(args.lookback_hours)),
                    require_shorts=bool(args.require_shorts),
                    shorts_max_seconds=max(1, int(args.shorts_max_seconds)),
                    max_queries_per_coin=max(1, int(args.max_queries_per_coin)),
                )
            except Exception as exc:  # pragma: no cover - runtime/network path
                print(
                    f"Failed to scrape YouTube for {coin.get('symbol') or coin.get('coinId')}: {exc}",
                    file=sys.stderr,
                )
                if isinstance(exc, YouTubeApiError) and is_fatal_api_error(exc):
                    fatal_error = exc
                    break
        connection.commit()
    finally:
        connection.close()

    if fatal_error is not None:
        print('Aborted YouTube scrape early due to a fatal API error.', file=sys.stderr)
        return 86

    print(f'Scanned {len(coins)} coins and upserted {total_mentions} YouTube mentions.')
    return 0



if __name__ == '__main__':
    raise SystemExit(main())
