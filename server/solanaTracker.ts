import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { appConfig } from './config';

export interface SolanaMetricSnapshot {
  mintAddress: string;
  retentionRate24h: number | null;
  medianHoldTimeHours: number | null;
  status: 'ready' | 'calculating';
  message: string;
  source: 'helius' | 'cache' | 'fallback';
  updatedAt: string;
}

interface HolderLike {
  owner: string;
  amount: number;
  previousAmount: number | null;
  firstSeenAt: number | null;
}

function resolveProjectPath(relativePath: string) {
  if (path.isAbsolute(relativePath)) return relativePath;
  return path.resolve(process.cwd(), relativePath);
}

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function asNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asTimestampMs(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value > 10_000_000_000 ? value : value * 1_000;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

function calculatingSnapshot(
  mintAddress: string,
  message = 'New Launch - Calculating...',
  source: SolanaMetricSnapshot['source'] = 'fallback',
): SolanaMetricSnapshot {
  return {
    mintAddress,
    retentionRate24h: null,
    medianHoldTimeHours: null,
    status: 'calculating',
    message,
    source,
    updatedAt: new Date().toISOString(),
  };
}

export class SolanaTracker {
  private readonly databasePath = resolveProjectPath(appConfig.youtubeDbPath);
  private readonly database: any;

  constructor() {
    mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.database = new Database(this.databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('busy_timeout = 5000');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS solana_token_metrics (
        mint_address TEXT PRIMARY KEY,
        retention_rate_24h REAL,
        median_hold_time_hours REAL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  async getTokenMetrics(mintAddress: string): Promise<SolanaMetricSnapshot> {
    const cleanMintAddress = String(mintAddress || '').trim();
    if (!cleanMintAddress) {
      return calculatingSnapshot('', 'New Launch - Calculating...');
    }

    const cached = this.getCached(cleanMintAddress);
    if (cached) {
      return cached;
    }

    const refreshed = await this.refreshTokenMetrics(cleanMintAddress);
    this.saveSnapshot(refreshed);
    return refreshed;
  }

  private getCached(mintAddress: string): SolanaMetricSnapshot | null {
    const row = this.database
      .prepare(
        `SELECT mint_address, retention_rate_24h, median_hold_time_hours, status, message, source, updated_at
           FROM solana_token_metrics
          WHERE mint_address = ?`,
      )
      .get(mintAddress) as
      | {
          mint_address: string;
          retention_rate_24h: number | null;
          median_hold_time_hours: number | null;
          status: 'ready' | 'calculating';
          message: string;
          source: SolanaMetricSnapshot['source'];
          updated_at: string;
        }
      | undefined;

    if (!row) return null;

    const ageMs = Date.now() - Date.parse(row.updated_at);
    if (Number.isFinite(ageMs) && ageMs <= appConfig.onchainMetricRefreshMs) {
      return {
        mintAddress: row.mint_address,
        retentionRate24h: row.retention_rate_24h,
        medianHoldTimeHours: row.median_hold_time_hours,
        status: row.status,
        message: row.message,
        source: 'cache',
        updatedAt: row.updated_at,
      };
    }

    return null;
  }

  private saveSnapshot(snapshot: SolanaMetricSnapshot) {
    this.database
      .prepare(
        `INSERT INTO solana_token_metrics (
            mint_address,
            retention_rate_24h,
            median_hold_time_hours,
            status,
            message,
            source,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(mint_address) DO UPDATE SET
            retention_rate_24h = excluded.retention_rate_24h,
            median_hold_time_hours = excluded.median_hold_time_hours,
            status = excluded.status,
            message = excluded.message,
            source = excluded.source,
            updated_at = excluded.updated_at`,
      )
      .run(
        snapshot.mintAddress,
        snapshot.retentionRate24h,
        snapshot.medianHoldTimeHours,
        snapshot.status,
        snapshot.message,
        snapshot.source,
        snapshot.updatedAt,
      );
  }

  private async refreshTokenMetrics(mintAddress: string): Promise<SolanaMetricSnapshot> {
    if (!appConfig.heliusApiKey) {
      return calculatingSnapshot(mintAddress, 'New Launch - Calculating...');
    }

    try {
      const heliusSnapshot = await this.fetchFromHelius(mintAddress);
      if (heliusSnapshot) {
        return heliusSnapshot;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown on-chain error';
      console.warn(`[solana-tracker] ${mintAddress} refresh failed`, message);
    }

    return calculatingSnapshot(mintAddress, 'New Launch - Calculating...');
  }

  private async fetchFromHelius(mintAddress: string): Promise<SolanaMetricSnapshot | null> {
    const endpoint = `${appConfig.heliusRpcUrl.replace(/\/$/, '')}/?api-key=${encodeURIComponent(appConfig.heliusApiKey)}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `memepulse-${mintAddress}`,
        method: 'getTokenHolders',
        params: {
          mint: mintAddress,
          limit: 500,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Helius request failed: ${response.status}`);
    }

    const payload = (await response.json()) as any;
    const holders = this.extractHolders(payload);
    if (holders.length < 3) {
      return calculatingSnapshot(mintAddress, 'New Launch - Calculating...', 'helius');
    }

    const currentHolders = holders.filter((holder) => holder.amount > 0);
    const holders24hAgo = holders.filter(
      (holder) => (holder.previousAmount ?? holder.amount) > 0,
    );
    const retainedCount = currentHolders.filter(
      (holder) => (holder.previousAmount ?? holder.amount) > 0,
    ).length;

    const denominator = holders24hAgo.length;
    const retentionRate24h =
      denominator > 0 ? clamp((retainedCount / denominator) * 100, 0, 100) : null;

    const nowMs = Date.now();
    const holdTimesHours = currentHolders
      .map((holder) => {
        if (!holder.firstSeenAt) return null;
        const elapsedMs = nowMs - holder.firstSeenAt;
        if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
        return elapsedMs / 3_600_000;
      })
      .filter((value): value is number => value != null);

    const medianHoldTimeHours = median(holdTimesHours);

    if (retentionRate24h == null && medianHoldTimeHours == null) {
      return calculatingSnapshot(mintAddress, 'New Launch - Calculating...', 'helius');
    }

    return {
      mintAddress,
      retentionRate24h:
        retentionRate24h == null ? null : Number(retentionRate24h.toFixed(2)),
      medianHoldTimeHours:
        medianHoldTimeHours == null ? null : Number(medianHoldTimeHours.toFixed(2)),
      status: 'ready',
      message: 'Helius holder snapshot cached in SQLite (1h refresh).',
      source: 'helius',
      updatedAt: new Date().toISOString(),
    };
  }

  private extractHolders(payload: any): HolderLike[] {
    const sourceRows =
      payload?.result?.tokenHolders ||
      payload?.result?.holders ||
      payload?.result?.items ||
      payload?.result ||
      [];

    if (!Array.isArray(sourceRows)) {
      return [];
    }

    return sourceRows
      .map((row: any) => {
        const amount =
          asNumber(row?.amount) ??
          asNumber(row?.balance) ??
          asNumber(row?.uiAmount) ??
          asNumber(row?.tokenAmount?.uiAmount) ??
          0;

        const previousAmount =
          asNumber(row?.previousAmount) ??
          asNumber(row?.balance24hAgo) ??
          asNumber(row?.previous_balance) ??
          null;

        return {
          owner:
            String(
              row?.owner ||
                row?.wallet ||
                row?.address ||
                row?.account ||
                '',
            ).trim(),
          amount,
          previousAmount,
          firstSeenAt:
            asTimestampMs(row?.firstSeenAt) ??
            asTimestampMs(row?.firstAcquiredAt) ??
            asTimestampMs(row?.firstTransferAt) ??
            asTimestampMs(row?.firstBuyAt) ??
            asTimestampMs(row?.openedAt),
        };
      })
      .filter((holder) => holder.owner && holder.amount >= 0);
  }
}
