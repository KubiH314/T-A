export interface SocialPost {
  post_id: string;
  timestamp: number; // Unix timestamp in milliseconds
  user_id: string;
  username: string;
  platform: 'X' | 'YouTube';
  follower_count: number;
  engagement_count: number; // Likes + comments + replies
  user_post_index: number; // Nth post by this user about this coin
  content: string;
}

export interface HypeMetrics {
  base_value: number;
  decay_factor: number;
  current_value: number;
}

export interface CoinData {
  address: string;
  symbol: string;
  name: string;
  priceUsd: string;
  liquidity: {
    usd: number;
  };
  volume: {
    h24: number;
  };
  marketCap: number;
  pairCreatedAt: number;
  url: string;
  chainId: string;
  dexId: string;
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
}

export interface TrackedCoin extends CoinData {
  trueHypeScore: number;
  posts: (SocialPost & HypeMetrics)[];
  history: { time: number; score: number; price: number }[];
}
