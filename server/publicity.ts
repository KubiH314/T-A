import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appConfig } from './config';
import { LiveCoin, UniverseSnapshot } from './types';

interface TrackedCoinManifest {
  coinId: string;
  symbol: string;
  name: string;
  contractAddress: string;
}

interface StoredYouTubeMention {
  mentionId: string;
  coinId: string;
  timestamp: string;
  baseValue: number;
}

interface CoinPublicityAggregate {
  publicityScore: number;
  sentimentConsensus: null;
  mentionCount: number;
}

const MIN_RETAINED_POST_VALUE = 0.01;
const MAX_RETAINED_POST_AGE_HOURS = 72;

function resolveProjectPath(relativePath: string) {
  if (path.isAbsolute(relativePath)) return relativePath;
  return path.resolve(process.cwd(), relativePath);
}

function defaultAggregate(): CoinPublicityAggregate {
  return {
    publicityScore: 0,
    sentimentConsensus: null,
    mentionCount: 0,
  };
}

function safeTimestampMs(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function computeCurrentPostValue(baseValue: number, timestamp: string, nowMs: number) {
  const timestampMs = safeTimestampMs(timestamp);
  if (!timestampMs) {
    return {
      hoursElapsed: Number.POSITIVE_INFINITY,
      currentPostValue: 0,
    };
  }

  const hoursElapsed = Math.max(0, (nowMs - timestampMs) / 3_600_000);
  const decayFactor = 1 / (1 + 0.2 * hoursElapsed);
  const currentPostValue = baseValue * decayFactor;

  return {
    hoursElapsed,
    currentPostValue,
  };
}

export class YouTubePublicityManager {
  private readonly databasePath = resolveProjectPath(appConfig.youtubeDbPath);
  private readonly manifestPath = resolveProjectPath(appConfig.youtubeManifestPath);
  private readonly schemaPath = resolveProjectPath('server/youtube_schema.sql');
  private readonly scraperPath = resolveProjectPath('server/youtube_scraper.py');
  private readonly database;
  private readonly deleteRowStatement;
  private publicityByCoin = new Map<string, CoinPublicityAggregate>();
  private isScraping = false;
  private lastRunAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private nextCoinOffset = 0;

  constructor() {
    mkdirSync(path.dirname(this.databasePath), { recursive: true });
    mkdirSync(path.dirname(this.manifestPath), { recursive: true });

    this.database = new Database(this.databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('busy_timeout = 5000');
    this.database.exec(readFileSync(this.schemaPath, 'utf8'));

    this.deleteRowStatement = this.database.prepare(
      'DELETE FROM youtube_mentions WHERE mention_id = ? AND coin_id = ?',
    );

    this.refreshCache();
  }

  start(getCoins: () => TrackedCoinManifest[]) {
    this.scheduleScrape(getCoins, 'startup').catch((error) => {
      console.error('[youtube-scraper] startup run failed', error);
    });

    setInterval(() => {
      this.scheduleScrape(getCoins, 'interval').catch((error) => {
        console.error('[youtube-scraper] scheduled run failed', error);
      });
    }, appConfig.youtubeScrapeMs);
  }

  getStatus() {
    return {
      enabled: appConfig.youtubeScraperEnabled,
      credentialsConfigured: this.hasCredentials(),
      coinsPerRun: appConfig.youtubeCoinsPerRun,
      requireShorts: appConfig.youtubeRequireShorts,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
    };
  }

  attachToSnapshot(snapshot: UniverseSnapshot): UniverseSnapshot {
    return {
      ...snapshot,
      items: snapshot.items.map((coin) => this.attachToCoin(coin)),
    };
  }

  getPublicitySnapshot(snapshot: UniverseSnapshot) {
    return {
      ok: true,
      source: 'youtube',
      ...this.getStatus(),
      updatedAt: snapshot.updatedAt,
      generatedAt: snapshot.generatedAt,
      items: snapshot.items.map((coin) => {
        const aggregate = this.publicityByCoin.get(coin.tokenAddress) || defaultAggregate();
        const publicityScore = Number(aggregate.publicityScore.toFixed(6));
        return {
          coinId: coin.tokenAddress,
          symbol: coin.symbol,
          name: coin.name,
          publicityScore,
          publicity_score: publicityScore,
          Publicity_Score: publicityScore,
          sentimentConsensus: aggregate.sentimentConsensus,
          sentiment_consensus: aggregate.sentimentConsensus,
          youtubeMentionCount: aggregate.mentionCount,
          socialMentionCount: aggregate.mentionCount,
        };
      }),
    };
  }

  private attachToCoin(coin: LiveCoin) {
    const aggregate = this.publicityByCoin.get(coin.tokenAddress) || defaultAggregate();
    const publicityScore = Number(aggregate.publicityScore.toFixed(6));

    return {
      ...coin,
      publicityScore,
      publicity_score: publicityScore,
      Publicity_Score: publicityScore,
      sentimentConsensus: aggregate.sentimentConsensus,
      sentiment_consensus: aggregate.sentimentConsensus,
      youtubeMentionCount: aggregate.mentionCount,
      socialMentionCount: aggregate.mentionCount,
    };
  }

  getCoinHistory(coinId: string, windowMinutes = 60, bucketMinutes = 2) {
    const safeWindowMinutes = Math.max(10, Math.min(1_440, Number(windowMinutes) || 60));
    const safeBucketMinutes = Math.max(1, Math.min(60, Number(bucketMinutes) || 2));
    const nowMs = Date.now();
    const startMs = nowMs - safeWindowMinutes * 60_000;
    const bucketMs = safeBucketMinutes * 60_000;

    const rows = this.database
      .prepare(
        `SELECT timestamp, base_value
           FROM youtube_mentions
          WHERE coin_id = ?
            AND timestamp >= ?
          ORDER BY timestamp ASC`,
      )
      .all(coinId, new Date(startMs).toISOString()) as Array<{
        timestamp: string;
        base_value: number;
      }>;

    const buckets = new Map<number, number>();

    for (const row of rows) {
      const timestampMs = safeTimestampMs(row.timestamp);
      if (!timestampMs || timestampMs < startMs) continue;
      const bucketStart = Math.floor(timestampMs / bucketMs) * bucketMs;
      const current = buckets.get(bucketStart) || 0;
      buckets.set(bucketStart, current + Number(row.base_value || 0));
    }

    const currentAggregate = this.publicityByCoin.get(coinId);
    if (currentAggregate && currentAggregate.publicityScore > 0) {
      const currentBucket = Math.floor(nowMs / bucketMs) * bucketMs;
      const existing = buckets.get(currentBucket) || 0;
      buckets.set(currentBucket, Math.max(existing, currentAggregate.publicityScore));
    }

    return Array.from(buckets.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([time, publicityScore]) => ({
        time,
        publicityScore: Number(publicityScore.toFixed(6)),
      }));
  }

  private async scheduleScrape(getCoins: () => TrackedCoinManifest[], trigger: 'startup' | 'interval') {
    if (this.isScraping) {
      return;
    }

    this.lastRunAt = new Date().toISOString();

    const batch = this.selectBatch(this.sanitizeCoins(getCoins()));
    this.writeManifest(batch);

    if (batch.length === 0) {
      this.refreshCache();
      return;
    }

    if (!appConfig.youtubeScraperEnabled) {
      this.refreshCache();
      return;
    }

    if (!this.hasCredentials()) {
      this.lastError = 'YouTube scraper is enabled but YOUTUBE_API_KEY is missing.';
      if (trigger === 'startup') {
        console.warn('[youtube-scraper] skipped because credentials are missing');
      }
      this.refreshCache();
      return;
    }

    this.isScraping = true;

    try {
      const runResult = await this.runPythonScraper();
      this.refreshCache();

      if (runResult === 'quota_skipped') {
        this.lastError = 'YouTube API quota exhausted; kept the existing cached mentions and will retry on the next run.';
        return;
      }

      this.lastSuccessAt = new Date().toISOString();
      this.lastError = null;
    } catch (error) {
      this.refreshCache();
      this.lastError = error instanceof Error ? error.message : 'Unknown scraper failure';
      throw error;
    } finally {
      this.isScraping = false;
    }
  }

  private hasCredentials() {
    return Boolean(appConfig.youtubeApiKey);
  }

  private sanitizeCoins(coins: TrackedCoinManifest[]) {
    const seen = new Set<string>();
    const sanitized: TrackedCoinManifest[] = [];

    for (const coin of coins) {
      if (!coin?.coinId || !coin?.contractAddress || seen.has(coin.coinId)) {
        continue;
      }

      seen.add(coin.coinId);
      sanitized.push({
        coinId: coin.coinId,
        symbol: coin.symbol,
        name: coin.name,
        contractAddress: coin.contractAddress,
      });
    }

    return sanitized;
  }

  private selectBatch(coins: TrackedCoinManifest[]) {
    if (coins.length <= appConfig.youtubeCoinsPerRun) {
      return coins;
    }

    const batch: TrackedCoinManifest[] = [];
    const start = this.nextCoinOffset % coins.length;
    const count = Math.max(1, appConfig.youtubeCoinsPerRun);

    for (let index = 0; index < Math.min(count, coins.length); index += 1) {
      batch.push(coins[(start + index) % coins.length]);
    }

    this.nextCoinOffset = (start + count) % coins.length;
    return batch;
  }

  private writeManifest(coins: TrackedCoinManifest[]) {
    writeFileSync(this.manifestPath, JSON.stringify(coins, null, 2));
  }

  private async runPythonScraper(): Promise<'ok' | 'quota_skipped'> {
    if (!existsSync(this.scraperPath)) {
      throw new Error(`YouTube scraper not found at ${this.scraperPath}`);
    }

    return await new Promise<'ok' | 'quota_skipped'>((resolve, reject) => {
      const child = spawn(
        appConfig.pythonBin,
        [
          this.scraperPath,
          '--coins',
          this.manifestPath,
          '--db',
          this.databasePath,
          '--limit',
          String(appConfig.youtubeSearchLimit),
          '--comment-limit',
          String(appConfig.youtubeCommentLimit),
          '--lookback-hours',
          String(appConfig.youtubePublishedLookbackHours),
          '--shorts-max-seconds',
          String(appConfig.youtubeShortsMaxSeconds),
          '--max-queries-per-coin',
          String(appConfig.youtubeMaxQueriesPerCoin),
          ...(appConfig.youtubeRequireShorts ? ['--require-shorts'] : []),
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (result: 'ok' | 'quota_skipped' = 'ok', error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) {
          reject(error);
        } else {
          if (stdout.trim()) {
            console.log(`[youtube-scraper] ${stdout.trim()}`);
          }
          resolve(result);
        }
      };

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        finish('ok', error instanceof Error ? error : new Error(String(error)));
      });

      child.on('close', (code) => {
        const details = stderr.trim() || stdout.trim();
        const quotaSoftFail =
          code === 86 || /quotaExceeded|exceeded your .*quota/i.test(details);

        if (code === 0) {
          finish('ok');
          return;
        }

        if (quotaSoftFail) {
          if (details) {
            console.warn(`[youtube-scraper] ${details}`);
          }
          finish('quota_skipped');
          return;
        }
        finish(
          'ok',
          new Error(
            details || `YouTube scraper exited with code ${code ?? 'unknown'}`,
          ),
        );
      });

      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        finish(
          'ok',
          new Error(
            `YouTube scraper timed out after ${appConfig.youtubeScrapeTimeoutMs}ms`,
          ),
        );
      }, appConfig.youtubeScrapeTimeoutMs);
    });
  }

  private refreshCache() {
    this.database.exec(readFileSync(this.schemaPath, 'utf8'));

    const rows = this.database
      .prepare(
        `SELECT mention_id as mentionId, coin_id as coinId, timestamp, base_value as baseValue
         FROM youtube_mentions`,
      )
      .all() as StoredYouTubeMention[];

    const nowMs = Date.now();
    const pruneTargets: Array<{ mentionId: string; coinId: string }> = [];
    const next = new Map<string, CoinPublicityAggregate>();

    for (const row of rows) {
      const { hoursElapsed, currentPostValue } = computeCurrentPostValue(
        Number(row.baseValue),
        row.timestamp,
        nowMs,
      );

      if (
        hoursElapsed > MAX_RETAINED_POST_AGE_HOURS ||
        currentPostValue < MIN_RETAINED_POST_VALUE
      ) {
        pruneTargets.push({
          mentionId: row.mentionId,
          coinId: row.coinId,
        });
        continue;
      }

      const aggregate = next.get(row.coinId) || defaultAggregate();
      aggregate.publicityScore += currentPostValue;
      aggregate.mentionCount += 1;
      next.set(row.coinId, aggregate);
    }

    if (pruneTargets.length) {
      const prune = this.database.transaction(
        (targets: Array<{ mentionId: string; coinId: string }>) => {
          for (const target of targets) {
            this.deleteRowStatement.run(target.mentionId, target.coinId);
          }
        },
      );
      prune(pruneTargets);
    }

    this.publicityByCoin = next;
  }
}
