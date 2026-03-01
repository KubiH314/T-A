import 'dotenv/config';

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const targetUniverse = envNumber('DEX_TARGET_UNIVERSE', 100);
const trendingSlots = envNumber('DEX_TRENDING_SLOTS', 60);
const freshSlots = envNumber('DEX_FRESH_SLOTS', 25);
const configuredPersistence = envNumber(
  'DEX_PERSISTENCE_SLOTS',
  Math.max(0, targetUniverse - trendingSlots - freshSlots),
);

export const appConfig = {
  port: envNumber('PORT', 3001),
  chainId: process.env.DEX_CHAIN_ID || 'solana',
  targetUniverse,
  trendingSlots,
  freshSlots,
  persistenceSlots: Math.max(
    0,
    Math.min(targetUniverse, configuredPersistence),
  ),
  minLiquidityUsd: envNumber('DEX_MIN_LIQUIDITY_USD', 25_000),
  minVolumeM5Usd: envNumber('DEX_MIN_VOLUME_M5_USD', 5_000),
  minVolumeH1Usd: envNumber('DEX_MIN_VOLUME_H1_USD', 25_000),
  minVolumeH24Usd: envNumber('DEX_MIN_VOLUME_H24_USD', 100_000),
  minAgeMinutes: envNumber('DEX_MIN_AGE_MINUTES', 5),
  fastRefreshMs: envNumber('DEX_FAST_REFRESH_MS', 15_000),
  candidateRefreshMs: envNumber('DEX_CANDIDATE_REFRESH_MS', 60_000),
  rebalanceMs: envNumber('DEX_REBALANCE_MS', 300_000),
  weakCyclesBeforeDrop: envNumber('DEX_WEAK_CYCLES_BEFORE_DROP', 2),
  candidatePoolSize: envNumber('DEX_CANDIDATE_POOL_SIZE', 250),
  freshAgeHours: envNumber('DEX_FRESH_AGE_HOURS', 6),
  maxFreshAgeHours: envNumber('DEX_MAX_FRESH_AGE_HOURS', 24),
  requestTimeoutMs: envNumber('DEX_REQUEST_TIMEOUT_MS', 8_000),
  dexRetryCount: envNumber('DEX_REQUEST_RETRY_COUNT', 3),
  dexRetryDelayMs: envNumber('DEX_REQUEST_RETRY_DELAY_MS', 900),
  searchTerms: (process.env.DEX_SEARCH_TERMS || 'pump,moon,meme,ai,cat,dog,sol')
    .split(',')
    .map((term) => term.trim())
    .filter(Boolean),
  youtubeScraperEnabled: envBoolean('YOUTUBE_SCRAPER_ENABLED', true),
  youtubeScrapeMs: envNumber('YOUTUBE_SCRAPE_MS', 3_600_000),
  youtubeScrapeTimeoutMs: envNumber('YOUTUBE_SCRAPE_TIMEOUT_MS', 120_000),
  youtubeSearchLimit: envNumber('YOUTUBE_SEARCH_LIMIT', 8),
  youtubeCommentLimit: envNumber('YOUTUBE_COMMENT_LIMIT', 25),
  youtubeCoinsPerRun: envNumber('YOUTUBE_COINS_PER_RUN', 4),
  youtubePublishedLookbackHours: envNumber('YOUTUBE_PUBLISHED_LOOKBACK_HOURS', 72),
  youtubeShortsMaxSeconds: envNumber('YOUTUBE_SHORTS_MAX_SECONDS', 75),
  youtubeRequireShorts: envBoolean('YOUTUBE_REQUIRE_SHORTS', true),
  youtubeMaxQueriesPerCoin: envNumber('YOUTUBE_MAX_QUERIES_PER_COIN', 1),
  youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
  pythonBin: process.env.PYTHON_BIN || 'python3',
  youtubeDbPath: process.env.YOUTUBE_DB_PATH || 'server/data/youtube-publicity.sqlite',
  youtubeManifestPath: process.env.YOUTUBE_MANIFEST_PATH || 'server/data/tracked-coins.json',
  onchainMetricRefreshMs: envNumber('ONCHAIN_METRIC_REFRESH_MS', 3_600_000),
  heliusApiKey: process.env.HELIUS_API_KEY || '',
  heliusRpcUrl: process.env.HELIUS_RPC_URL || 'https://mainnet.helius-rpc.com',
  bitqueryApiKey: process.env.BITQUERY_API_KEY || '',
  duneApiKey: process.env.DUNE_API_KEY || '',
} as const;
