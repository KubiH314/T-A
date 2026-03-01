export type BucketType = 'trending' | 'fresh' | 'persistence';

export interface LiveCoin {
  tokenAddress: string;
  pairAddress: string;
  symbol: string;
  name: string;
  chainId: string;
  dexId: string;
  url: string;
  imageUrl?: string;
  bucket: BucketType;
  rank: number;
  liveScore: number;
  scoreBreakdown: {
    liquidity: number;
    volume: number;
    momentum: number;
    freshness: number;
    discovery: number;
    holdBonus: number;
  };
  priceUsd: number;
  marketCap: number;
  liquidityUsd: number;
  volumeM5Usd: number;
  volumeH1Usd: number;
  volumeH24Usd: number;
  txnsM5: number;
  txnsH1: number;
  priceChangeM5: number;
  priceChangeH1: number;
  priceChangeH6: number;
  priceChangeH24: number;
  boostsActive: number;
  hasProfile: boolean;
  hasCommunityTakeover: boolean;
  ageMinutes: number;
  pairCreatedAt: number;
  updatedAt: number;
  publicityScore?: number;
  publicity_score?: number;
  Publicity_Score?: number;
  sentimentConsensus?: string | null;
  sentiment_consensus?: string | null;
  youtubeMentionCount?: number;
  socialMentionCount?: number;
}

export interface UniverseSnapshot {
  updatedAt: number;
  generatedAt: string;
  status: 'warming_up' | 'live';
  config: {
    chainId: string;
    targetUniverse: number;
    trendingSlots: number;
    freshSlots: number;
    persistenceSlots: number;
    fastRefreshMs: number;
    candidateRefreshMs: number;
    rebalanceMs: number;
    minLiquidityUsd: number;
    minVolumeH24Usd: number;
  };
  counts: {
    tracked: number;
    candidatePool: number;
  };
  items: LiveCoin[];
}

export interface PublicityHistoryPoint {
  time: number;
  publicityScore: number;
}

export interface PublicityHistoryResponse {
  ok: boolean;
  coinId: string;
  windowMinutes: number;
  bucketMinutes: number;
  points: PublicityHistoryPoint[];
}

export interface OnchainMetricSnapshot {
  mintAddress: string;
  retentionRate24h: number | null;
  medianHoldTimeHours: number | null;
  status: 'ready' | 'calculating';
  message: string;
  source: 'helius' | 'cache' | 'fallback';
  updatedAt: string;
}
