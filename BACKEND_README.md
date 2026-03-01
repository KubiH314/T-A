# Backend YouTube scanner setup

This repo now includes a YouTube-backed publicity pipeline that runs alongside the existing TypeScript API.

## What it does

- The TypeScript server still owns the live coin universe (`/api/live-universe`).
- A scheduled Python worker (`server/youtube_scraper.py`) uses the public YouTube Data API v3 to scan tracked coins.
- It searches YouTube videos using each coin's ticker, full name, and contract address, then validates exact matches locally.
- The worker inspects:
  - video title / description
  - creator tags and parsed hashtags
  - top-level comments and inline replies returned by `commentThreads.list`
- Matches are stored in SQLite (`server/data/youtube-publicity.sqlite`).
- On every scraper pass, the backend recalculates each coin's `publicityScore` using the same decay formula and prunes stale rows.
- The enriched score is returned both on:
  - `GET /api/live-universe` (attached to each coin item)
  - `GET /api/publicity-snapshot` (YouTube-only payload)

## Important API limitations

- The YouTube Data API does **not** expose a dedicated "Shorts only" search switch. This backend uses `videoDuration=short` plus a second duration filter (`YOUTUBE_SHORTS_MAX_SECONDS`) as a practical heuristic.
- This MVP intentionally does **not** fetch subtitle/transcript text. It focuses on title, description, tags, hashtags, comments, and replies.
- Search quota is the expensive part (`search.list`). To stay near the default quota budget, the backend scans a rotating batch of tracked coins each run (`YOUTUBE_COINS_PER_RUN`).

## Environment variables

Add these to your `.env`:

- `YOUTUBE_SCRAPER_ENABLED=true`
- `YOUTUBE_API_KEY=...`
- `YOUTUBE_SCRAPE_MS=3600000`
- `YOUTUBE_SCRAPE_TIMEOUT_MS=120000`
- `YOUTUBE_SEARCH_LIMIT=8`
- `YOUTUBE_COMMENT_LIMIT=25`
- `YOUTUBE_COINS_PER_RUN=4`
- `YOUTUBE_PUBLISHED_LOOKBACK_HOURS=72`
- `YOUTUBE_SHORTS_MAX_SECONDS=75`
- `YOUTUBE_REQUIRE_SHORTS=true`
- `PYTHON_BIN=python3`
- `YOUTUBE_DB_PATH=server/data/youtube-publicity.sqlite`
- `YOUTUBE_MANIFEST_PATH=server/data/tracked-coins.json`

The existing DexScreener variables are still required for the live universe.

## How to get a YouTube API key

1. Open Google Cloud Console.
2. Create or select a project.
3. Enable **YouTube Data API v3** for that project.
4. Create an **API key** in the project's credentials page.
5. Paste that value into `YOUTUBE_API_KEY`.

## Install dependencies

Node dependencies are unchanged for the database layer because the repo already ships with `better-sqlite3`.

The Python worker uses only the standard library, so `requirements.txt` is intentionally empty apart from comments.

```bash
npm install
```

## Run the backend

Normal development flow:

```bash
npm install
npm run dev:server
```

When the server starts, it will:

1. build the live coin universe,
2. write `server/data/tracked-coins.json` for the next scan batch,
3. launch the YouTube scraper immediately,
4. keep scraping on the configured interval.

## Run the scraper manually

If you want a one-off manual scrape:

```bash
set -a
source .env
set +a
npm run scrape:youtube
```

This uses the tracked-coin manifest at `server/data/tracked-coins.json`. If that file does not exist yet, start the backend once first, or run the Python script directly with `--coins /path/to/your-manifest.json`.

## Stored mention fields

Each matched YouTube mention stores:

- `mention_id`
- `timestamp`
- `user_id`
- `follower_count`
- `engagement_count`
- `user_post_index`
- `coin_id`

Video metadata mentions use the uploader's `subscriberCount` as `follower_count` when it is public.
Comment mentions use the comment author's public channel `subscriberCount` when `authorChannelId` is available.
If subscriber counts are hidden or unavailable, the value falls back to `0`.

## Publicity score formula

The backend uses the same formula as before:

- `Follower_Score = follower_count / 1000`
- `Engagement_Score = engagement_count * 2`
- `Raw_Impact = Follower_Score + Engagement_Score`
- `Spam_Penalty = sqrt(user_post_index)`
- `Base_Value = Raw_Impact / Spam_Penalty`
- `Hours_Elapsed = (current time - post timestamp) in hours`
- `Decay_Factor = 1 / (1 + (0.2 * Hours_Elapsed))`
- `Current_Post_Value = Base_Value * Decay_Factor`
- `Publicity_Score = sum(Current_Post_Value)` per coin

Rows are pruned from SQLite when either:

- `Current_Post_Value < 0.01`, or
- the mention is older than 72 hours.

## Frontend note

The frontend does not need code changes for the API to keep working. The backend now returns:

- `publicityScore`
- `publicity_score`
- `sentimentConsensus`
- `sentiment_consensus`
- `youtubeMentionCount`
- `socialMentionCount`

If you want the dashboard to explicitly label the source, the only optional UI tweak would be surfacing `youtubeMentionCount` in the detail pane or renaming any generic social labels to "YouTube".
