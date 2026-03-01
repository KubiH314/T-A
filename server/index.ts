import express from 'express';
import { appConfig } from './config';
import { YouTubePublicityManager } from './publicity';
import { SolanaTracker } from './solanaTracker';
import { UniverseManager } from './universe';

const app = express();
const manager = new UniverseManager();
const publicityManager = new YouTubePublicityManager();
const solanaTracker = new SolanaTracker();

function getTrackedCoinManifest() {
  return manager.getSnapshot().items.map((coin) => ({
    coinId: coin.tokenAddress,
    symbol: coin.symbol,
    name: coin.name,
    contractAddress: coin.tokenAddress,
  }));
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'memepulse-live-universe',
    chainId: appConfig.chainId,
    now: new Date().toISOString(),
    youtube: publicityManager.getStatus(),
  });
});

app.get('/api/live-universe', (_req, res) => {
  res.json(publicityManager.attachToSnapshot(manager.getSnapshot()));
});

app.get('/api/publicity-snapshot', (_req, res) => {
  res.json(publicityManager.getPublicitySnapshot(manager.getSnapshot()));
});

app.get('/api/publicity-history/:coinId', (req, res) => {
  const coinId = String(req.params.coinId || '').trim();
  const windowMinutes = Math.max(10, Math.min(1_440, Number(req.query.windowMinutes) || 60));
  const bucketMinutes = Math.max(1, Math.min(60, Number(req.query.bucketMinutes) || 2));

  res.json({
    ok: true,
    coinId,
    windowMinutes,
    bucketMinutes,
    points: publicityManager.getCoinHistory(coinId, windowMinutes, bucketMinutes),
  });
});

app.get('/api/onchain-metrics/:mintAddress', async (req, res) => {
  try {
    const mintAddress = String(req.params.mintAddress || '').trim();
    const snapshot = await solanaTracker.getTokenMetrics(mintAddress);
    res.json(snapshot);
  } catch (error) {
    console.error('[solana-tracker] route failed', error);
    res.status(200).json({
      mintAddress: String(req.params.mintAddress || '').trim(),
      retentionRate24h: null,
      medianHoldTimeHours: null,
      status: 'calculating',
      message: 'New Launch - Calculating...',
      source: 'fallback',
      updatedAt: new Date().toISOString(),
    });
  }
});

app.get('/api/debug/candidates', (_req, res) => {
  const snapshot = publicityManager.attachToSnapshot(manager.getSnapshot());
  res.json({
    status: snapshot.status,
    counts: snapshot.counts,
    topTen: snapshot.items.slice(0, 10),
  });
});

async function bootstrap() {
  await manager.initialize();
  manager.start();
  publicityManager.start(getTrackedCoinManifest);

  app.listen(appConfig.port, '0.0.0.0', () => {
    console.log(
      `MemePulse live-universe API running on http://0.0.0.0:${appConfig.port}`,
    );
  });
}

bootstrap().catch((error) => {
  console.error('Failed to start backend', error);
  process.exit(1);
});
