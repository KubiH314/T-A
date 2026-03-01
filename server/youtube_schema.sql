CREATE TABLE IF NOT EXISTS youtube_mentions (
  mention_id TEXT NOT NULL,
  coin_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  user_id TEXT NOT NULL,
  follower_count INTEGER NOT NULL,
  engagement_count INTEGER NOT NULL,
  user_post_index INTEGER NOT NULL,
  base_value REAL NOT NULL,
  video_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  title TEXT,
  matched_text TEXT,
  permalink TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mention_id, coin_id)
);

CREATE INDEX IF NOT EXISTS idx_youtube_mentions_coin_id ON youtube_mentions (coin_id);
CREATE INDEX IF NOT EXISTS idx_youtube_mentions_timestamp ON youtube_mentions (timestamp);
CREATE INDEX IF NOT EXISTS idx_youtube_mentions_coin_user ON youtube_mentions (coin_id, user_id);

CREATE TABLE IF NOT EXISTS youtube_user_coin_counts (
  coin_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  post_count INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (coin_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_youtube_user_coin_counts_coin_id ON youtube_user_coin_counts (coin_id);
