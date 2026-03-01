import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowDownUp,
  Database,
  ExternalLink,
  RefreshCw,
  Timer,
  TrendingUp,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { LiveApi } from '../services/liveApi';
import {
  LiveCoin,
  OnchainMetricSnapshot,
  PublicityHistoryPoint,
  UniverseSnapshot,
} from '../types/live';

type TrendTimeframe = 'm5' | 'h1' | 'h6' | 'h24';
type SortDirection = 'asc' | 'desc';
type SortKey =
  | 'rank'
  | 'symbol'
  | 'publicityScore'
  | 'priceUsd'
  | 'trend'
  | 'liquidityUsd'
  | 'marketCap'
  | 'volumeH24Usd'
  | 'ageMinutes';
type ChartWindowKey = 'm10' | 'm30' | 'h1' | 'h12' | 'h24';
type MetricTimeframe = 'm5' | 'h1' | 'h24';
type TxnTimeframe = 'm5' | 'h1';

interface CoinHistoryPoint {
  time: number;
  priceUsd: number;
  publicityScore: number;
  liquidityUsd: number;
  volumeM5Usd: number;
  volumeH1Usd: number;
  volumeH24Usd: number;
  txnsM5: number;
  txnsH1: number;
  marketCap: number;
  priceChangeM5: number;
  priceChangeH1: number;
  priceChangeH24: number;
  boostsActive: number;
}

interface ChartPoint {
  time: number;
  priceUsd: number | null;
  publicityScore: number | null;
}

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'rank', label: 'Default rank' },
  { value: 'symbol', label: 'Ticker' },
  { value: 'publicityScore', label: 'Publicity score' },
  { value: 'priceUsd', label: 'Price' },
  { value: 'trend', label: 'Selected trend' },
  { value: 'liquidityUsd', label: 'Liquidity' },
  { value: 'marketCap', label: 'Market cap' },
  { value: 'volumeH24Usd', label: '24h volume' },
  { value: 'ageMinutes', label: 'Age' },
];

const TREND_OPTIONS: Array<{ value: TrendTimeframe; label: string }> = [
  { value: 'm5', label: '5m' },
  { value: 'h1', label: '1h' },
  { value: 'h6', label: '6h' },
  { value: 'h24', label: '24h' },
];

const CHART_WINDOWS: Array<{
  value: ChartWindowKey;
  label: string;
  windowMinutes: number;
  bucketMinutes: number;
}> = [
  { value: 'm10', label: '10m', windowMinutes: 10, bucketMinutes: 1 },
  { value: 'm30', label: '30m', windowMinutes: 30, bucketMinutes: 2 },
  { value: 'h1', label: '1h', windowMinutes: 60, bucketMinutes: 3 },
  { value: 'h12', label: '12h', windowMinutes: 720, bucketMinutes: 30 },
  { value: 'h24', label: '24h', windowMinutes: 1_440, bucketMinutes: 60 },
];

const POLL_BASE_MS = 15_000;
const POLL_MAX_MS = 60_000;
const HISTORY_POINTS_PER_COIN = 720;

function formatCompactUsd(value: number) {
  if (!Number.isFinite(value)) return '-';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPrice(value: number | null) {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  const safeValue = Number(value);
  if (safeValue >= 1) {
    return safeValue.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 4,
    });
  }

  if (safeValue >= 0.0001) {
    return `$${safeValue.toFixed(6)}`;
  }

  return `$${safeValue.toFixed(8)}`;
}

function formatPct(value: number) {
  if (!Number.isFinite(value)) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function formatSignedNumber(value: number, digits = 2) {
  if (!Number.isFinite(value)) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}`;
}

function formatAge(ageMinutes: number) {
  if (!Number.isFinite(ageMinutes) || ageMinutes < 0) return '-';
  if (ageMinutes < 60) return `${ageMinutes}m`;

  const hours = Math.floor(ageMinutes / 60);
  const minutes = ageMinutes % 60;
  if (hours < 24) return `${hours}h ${minutes}m`;

  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return `${days}d ${remainderHours}h`;
}

function formatRelativeSync(timestamp: number | null) {
  if (!timestamp) return 'Waiting for first sync';
  const deltaSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const minutes = Math.floor(deltaSeconds / 60);
  const seconds = deltaSeconds % 60;
  return `${minutes}m ${seconds}s ago`;
}

function formatHours(value: number | null) {
  if (value == null || !Number.isFinite(value)) return 'New Launch - Calculating...';
  if (value < 24) return `${value.toFixed(1)}h`;
  return `${(value / 24).toFixed(1)}d`;
}

function getPublicityScore(coin: LiveCoin) {
  const raw =
    coin.Publicity_Score ?? coin.publicityScore ?? coin.publicity_score ?? 0;
  return Number.isFinite(Number(raw)) ? Number(raw) : 0;
}

function getTimeframeChange(coin: LiveCoin, timeframe: TrendTimeframe) {
  if (timeframe === 'm5') return coin.priceChangeM5 ?? 0;
  if (timeframe === 'h1') return coin.priceChangeH1 ?? 0;
  if (timeframe === 'h6') return coin.priceChangeH6 ?? coin.priceChangeH24 ?? 0;
  return coin.priceChangeH24 ?? 0;
}

function getTimeframeVolumeContext(coin: LiveCoin, timeframe: TrendTimeframe) {
  if (timeframe === 'm5') return `5m vol ${formatCompactUsd(coin.volumeM5Usd)}`;
  if (timeframe === 'h1') return `1h vol ${formatCompactUsd(coin.volumeH1Usd)}`;
  if (timeframe === 'h6') return `24h vol ${formatCompactUsd(coin.volumeH24Usd)}`;
  return `24h vol ${formatCompactUsd(coin.volumeH24Usd)}`;
}

function buildHistoryPoint(coin: LiveCoin, time: number): CoinHistoryPoint {
  return {
    time,
    priceUsd: coin.priceUsd,
    publicityScore: getPublicityScore(coin),
    liquidityUsd: coin.liquidityUsd,
    volumeM5Usd: coin.volumeM5Usd,
    volumeH1Usd: coin.volumeH1Usd,
    volumeH24Usd: coin.volumeH24Usd,
    txnsM5: coin.txnsM5,
    txnsH1: coin.txnsH1,
    marketCap: coin.marketCap,
    priceChangeM5: coin.priceChangeM5,
    priceChangeH1: coin.priceChangeH1,
    priceChangeH24: coin.priceChangeH24,
    boostsActive: coin.boostsActive,
  };
}

function calculatePublicityVelocity(history: CoinHistoryPoint[]) {
  if (history.length < 2) return null;
  const window = history.slice(-Math.min(8, history.length));
  const first = window[0];
  const last = window[window.length - 1];
  const hoursElapsed = (last.time - first.time) / 3_600_000;
  if (hoursElapsed <= 0) return null;
  return (last.publicityScore - first.publicityScore) / hoursElapsed;
}

function mergeChartSeries(
  localHistory: CoinHistoryPoint[],
  backendHistory: PublicityHistoryPoint[],
  windowMinutes: number,
  bucketMinutes: number,
): ChartPoint[] {
  const now = Date.now();
  const start = now - windowMinutes * 60_000;
  const bucketMs = bucketMinutes * 60_000;
  const local = [...localHistory]
    .filter((point) => point.time >= start)
    .sort((a, b) => a.time - b.time);
  const backend = [...backendHistory]
    .filter((point) => point.time >= start)
    .sort((a, b) => a.time - b.time);

  const timeline = new Set<number>();
  for (const point of local) timeline.add(point.time);
  for (const point of backend) timeline.add(point.time);

  const sortedTimes = Array.from(timeline).sort((a, b) => a - b);
  if (sortedTimes.length === 0) {
    return [];
  }

  const series: ChartPoint[] = [];
  let localIndex = 0;
  let backendIndex = 0;
  let lastLocal: CoinHistoryPoint | null = null;
  let lastBackend: PublicityHistoryPoint | null = null;

  for (const time of sortedTimes) {
    while (localIndex < local.length && local[localIndex].time <= time) {
      lastLocal = local[localIndex];
      localIndex += 1;
    }

    while (backendIndex < backend.length && backend[backendIndex].time <= time) {
      lastBackend = backend[backendIndex];
      backendIndex += 1;
    }

    const priceAgeMs = lastLocal ? time - lastLocal.time : Number.POSITIVE_INFINITY;
    const publicityAgeMs = lastBackend ? time - lastBackend.time : Number.POSITIVE_INFINITY;

    const priceUsd =
      lastLocal && priceAgeMs <= Math.max(bucketMs * 2, 5 * 60_000)
        ? lastLocal.priceUsd
        : null;

    const publicityScore =
      lastBackend && publicityAgeMs <= bucketMs * 2
        ? lastBackend.publicityScore
        : lastLocal && priceAgeMs <= Math.max(bucketMs * 2, 5 * 60_000)
          ? lastLocal.publicityScore
          : null;

    if (priceUsd == null && publicityScore == null) {
      continue;
    }

    series.push({
      time,
      priceUsd,
      publicityScore,
    });
  }

  return series;
}

export function Dashboard() {
  const [snapshot, setSnapshot] = useState<UniverseSnapshot | null>(null);
  const [selectedTokenAddress, setSelectedTokenAddress] = useState<string | null>(null);
  const [coinHistories, setCoinHistories] = useState<Record<string, CoinHistoryPoint[]>>({});
  const [backendPublicityHistory, setBackendPublicityHistory] = useState<PublicityHistoryPoint[]>([]);
  const [onchainMetrics, setOnchainMetrics] = useState<OnchainMetricSnapshot | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>('rank');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [trendTimeframe, setTrendTimeframe] = useState<TrendTimeframe>('h1');
  const [chartWindow, setChartWindow] = useState<ChartWindowKey>('h1');
  const [volumeWindow, setVolumeWindow] = useState<MetricTimeframe>('h1');
  const [priceChangeWindow, setPriceChangeWindow] = useState<MetricTimeframe>('h1');
  const [txnWindow, setTxnWindow] = useState<TxnTimeframe>('h1');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const consecutiveSyncFailuresRef = useRef(0);
  const requestInFlightRef = useRef(false);

  const loadUniverse = useCallback(async (showSpinner = false) => {
    if (requestInFlightRef.current) {
      return false;
    }

    if (showSpinner) {
      setIsRefreshing(true);
    }

    requestInFlightRef.current = true;

    try {
      const next = await LiveApi.getUniverse();
      const stamp = next.updatedAt || Date.now();

      setSnapshot(next);
      setLastSyncAt(Date.now());
      consecutiveSyncFailuresRef.current = 0;
      setError(null);
      setCoinHistories((previous) => {
        const updated: Record<string, CoinHistoryPoint[]> = {};

        for (const coin of next.items) {
          const prior = previous[coin.tokenAddress] || [];
          const point = buildHistoryPoint(coin, stamp);
          const lastPoint = prior[prior.length - 1];

          if (
            !lastPoint ||
            lastPoint.time !== point.time ||
            lastPoint.priceUsd !== point.priceUsd ||
            lastPoint.publicityScore !== point.publicityScore
          ) {
            updated[coin.tokenAddress] = [...prior, point].slice(-HISTORY_POINTS_PER_COIN);
          } else {
            updated[coin.tokenAddress] = prior;
          }
        }

        return updated;
      });

      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown backend error';
      setError(message);
      consecutiveSyncFailuresRef.current += 1;
      return false;
    } finally {
      requestInFlightRef.current = false;
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | undefined;

    const schedule = (delayMs: number) => {
      if (cancelled) return;
      timeoutId = window.setTimeout(run, delayMs);
    };

    const run = async () => {
      const ok = await loadUniverse(false);
      if (cancelled) return;
      const nextDelay = ok
        ? POLL_BASE_MS
        : Math.min(POLL_MAX_MS, POLL_BASE_MS * (2 ** Math.min(3, consecutiveSyncFailuresRef.current)));
      schedule(nextDelay);
    };

    void loadUniverse(false).then((ok) => {
      if (cancelled) return;
      schedule(ok ? POLL_BASE_MS : Math.min(POLL_MAX_MS, POLL_BASE_MS * 2));
    });

    const handleVisibilityWake = () => {
      if (document.visibilityState === 'visible') {
        if (timeoutId) {
          window.clearTimeout(timeoutId);
        }
        void loadUniverse(false).then((ok) => {
          if (!cancelled) {
            schedule(ok ? POLL_BASE_MS : Math.min(POLL_MAX_MS, POLL_BASE_MS * 2));
          }
        });
      }
    };

    window.addEventListener('focus', handleVisibilityWake);
    document.addEventListener('visibilitychange', handleVisibilityWake);

    return () => {
      cancelled = true;
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
      window.removeEventListener('focus', handleVisibilityWake);
      document.removeEventListener('visibilitychange', handleVisibilityWake);
    };
  }, [loadUniverse]);

  useEffect(() => {
    if (!snapshot) return;

    if (
      selectedTokenAddress &&
      snapshot.items.some((item) => item.tokenAddress === selectedTokenAddress)
    ) {
      return;
    }

    if (snapshot.items.length > 0) {
      setSelectedTokenAddress(snapshot.items[0].tokenAddress);
    }
  }, [snapshot, selectedTokenAddress]);

  const selectedCoin = useMemo(() => {
    if (!snapshot || !selectedTokenAddress) return null;
    return snapshot.items.find((item) => item.tokenAddress === selectedTokenAddress) || null;
  }, [snapshot, selectedTokenAddress]);

  const selectedChartWindow = useMemo(
    () => CHART_WINDOWS.find((item) => item.value === chartWindow) || CHART_WINDOWS[2],
    [chartWindow],
  );

  useEffect(() => {
    if (!selectedCoin) {
      setBackendPublicityHistory([]);
      setOnchainMetrics(null);
      return;
    }

    let cancelled = false;

    LiveApi.getPublicityHistory(
      selectedCoin.tokenAddress,
      selectedChartWindow.windowMinutes,
      selectedChartWindow.bucketMinutes,
    )
      .then((response) => {
        if (!cancelled) {
          setBackendPublicityHistory(response.points || []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBackendPublicityHistory([]);
        }
      });

    LiveApi.getOnchainMetrics(selectedCoin.tokenAddress)
      .then((response) => {
        if (!cancelled) {
          setOnchainMetrics(response);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOnchainMetrics({
            mintAddress: selectedCoin.tokenAddress,
            retentionRate24h: null,
            medianHoldTimeHours: null,
            status: 'calculating',
            message: 'New Launch - Calculating...',
            source: 'fallback',
            updatedAt: new Date().toISOString(),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedCoin, selectedChartWindow]);

  const sortedCoins = useMemo(() => {
    const items = [...(snapshot?.items || [])];
    const multiplier = sortDirection === 'asc' ? 1 : -1;

    items.sort((a, b) => {
      let aValue: string | number = 0;
      let bValue: string | number = 0;

      if (sortBy === 'rank') {
        aValue = a.rank;
        bValue = b.rank;
      } else if (sortBy === 'symbol') {
        aValue = a.symbol;
        bValue = b.symbol;
      } else if (sortBy === 'publicityScore') {
        aValue = getPublicityScore(a);
        bValue = getPublicityScore(b);
      } else if (sortBy === 'priceUsd') {
        aValue = a.priceUsd;
        bValue = b.priceUsd;
      } else if (sortBy === 'trend') {
        aValue = getTimeframeChange(a, trendTimeframe);
        bValue = getTimeframeChange(b, trendTimeframe);
      } else if (sortBy === 'liquidityUsd') {
        aValue = a.liquidityUsd;
        bValue = b.liquidityUsd;
      } else if (sortBy === 'marketCap') {
        aValue = a.marketCap;
        bValue = b.marketCap;
      } else if (sortBy === 'volumeH24Usd') {
        aValue = a.volumeH24Usd;
        bValue = b.volumeH24Usd;
      } else if (sortBy === 'ageMinutes') {
        aValue = a.ageMinutes;
        bValue = b.ageMinutes;
      }

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return aValue.localeCompare(bValue) * multiplier;
      }

      const numericA = Number(aValue);
      const numericB = Number(bValue);
      if (numericA === numericB) {
        return b.rank - a.rank;
      }

      return (numericA - numericB) * multiplier;
    });

    return items;
  }, [snapshot, sortBy, sortDirection, trendTimeframe]);

  const selectedHistory = selectedCoin ? coinHistories[selectedCoin.tokenAddress] || [] : [];
  const mergedChartData = useMemo(
    () =>
      mergeChartSeries(
        selectedHistory,
        backendPublicityHistory,
        selectedChartWindow.windowMinutes,
        selectedChartWindow.bucketMinutes,
      ),
    [selectedHistory, backendPublicityHistory, selectedChartWindow],
  );
  const publicityVelocity = useMemo(
    () => calculatePublicityVelocity(selectedHistory),
    [selectedHistory],
  );

  const isStale = lastSyncAt != null && Date.now() - lastSyncAt > POLL_BASE_MS * 3;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-neutral-950 p-8 text-white">
        <div className="mx-auto max-w-6xl">
          <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-6">
            <RefreshCw className="h-5 w-5 animate-spin text-indigo-300" />
            <span>Booting live universe backend…</span>
          </div>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="min-h-screen bg-neutral-950 p-8 text-white">
        <div className="mx-auto max-w-6xl rounded-2xl border border-rose-500/20 bg-rose-500/10 p-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 text-rose-300" />
            <div>
              <p className="font-medium">The frontend could not reach /api/live-universe.</p>
              <p className="mt-2 text-sm text-neutral-300">
                Start the backend with <code>npm run dev:server</code>, then reload this page.
              </p>
              {error && <p className="mt-2 text-sm text-rose-200">{error}</p>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 p-4 text-white md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-white/5 to-white/[0.02] p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-indigo-500/20 bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-300">
                <Activity className="h-3.5 w-3.5" />
                Live Meme Coin Watchlist
              </div>
              <h1 className="text-3xl font-semibold tracking-tight">MemePulse v1</h1>
              <p className="max-w-3xl text-sm text-neutral-300">
                Be on top of the public reactions and harness the power of social media for investment decisions.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                onClick={() => {
                  void loadUniverse(true);
                }}
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm transition hover:bg-white/10"
              >
                <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                Refresh now
              </button>
              <a
                href="/api/health"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm transition hover:bg-white/10"
              >
                <Database className="h-4 w-4" />
                API health
              </a>
            </div>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <StatCard
              icon={TrendingUp}
              label="Tracked universe"
              value={`${snapshot.counts.tracked}/${snapshot.config.targetUniverse}`}
              subValue={`Candidate pool: ${snapshot.counts.candidatePool}`}
            />
            <StatCard
              icon={Timer}
              label="Cadence"
              value={`${snapshot.config.fastRefreshMs / 1000}s`}
              subValue={`Fast refresh · ${snapshot.config.rebalanceMs / 60000}m rebalance`}
            />
            <StatCard
              icon={Database}
              label="Hard floor"
              value={formatCompactUsd(snapshot.config.minLiquidityUsd)}
              subValue={`Min liquidity · ${formatCompactUsd(snapshot.config.minVolumeH24Usd)} 24h vol`}
            />
            <StatCard
              icon={isStale ? WifiOff : Wifi}
              label="Last sync"
              value={formatRelativeSync(lastSyncAt)}
              subValue={isStale ? 'Retry loop active' : 'Live stream healthy'}
            />
          </div>

          {(error || isStale) && (
            <div className="mt-4 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              {isStale ? 'DexScreener sync is retrying automatically.' : 'Last refresh warning:'}{' '}
              {error || 'Waiting for next successful poll.'}
            </div>
          )}
        </div>

        <div className="overflow-hidden rounded-3xl border border-white/10 bg-white/[0.03]">
          <div className="border-b border-white/10 px-5 py-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <div className="text-sm font-medium text-neutral-200">Top live universe</div>
                <div className="mt-1 text-xs text-neutral-400">
                  The table is price-led, always live, and PUBLICITY is sourced directly from the backend
                  YouTube pipeline.
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <label className="space-y-1 text-xs text-neutral-400">
                  <span className="block">Sort by</span>
                  <select
                    value={sortBy}
                    onChange={(event) => setSortBy(event.target.value as SortKey)}
                    className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                  >
                    {SORT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value} className="bg-neutral-900">
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1 text-xs text-neutral-400">
                  <span className="block">Order</span>
                  <button
                    onClick={() =>
                      setSortDirection((current) => (current === 'desc' ? 'asc' : 'desc'))
                    }
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white transition hover:bg-white/10"
                  >
                    <ArrowDownUp className="h-4 w-4" />
                    {sortDirection === 'desc' ? 'High -> Low' : 'Low -> High'}
                  </button>
                </label>

                <label className="space-y-1 text-xs text-neutral-400">
                  <span className="block">Trend timeframe</span>
                  <select
                    value={trendTimeframe}
                    onChange={(event) => setTrendTimeframe(event.target.value as TrendTimeframe)}
                    className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                  >
                    {TREND_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value} className="bg-neutral-900">
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          </div>

          <div className="max-h-[70vh] overflow-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="sticky top-0 bg-neutral-950/95 backdrop-blur">
                <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-neutral-400">
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">Coin</th>
                  <th className="px-4 py-3">Price</th>
                  <th className="px-4 py-3">PUBLICITY</th>
                  <th className="px-4 py-3">
                    Trend ({TREND_OPTIONS.find((item) => item.value === trendTimeframe)?.label})
                  </th>
                  <th className="px-4 py-3">Liquidity</th>
                  <th className="px-4 py-3">Age</th>
                </tr>
              </thead>
              <tbody>
                {sortedCoins.map((coin, index) => {
                  const trend = getTimeframeChange(coin, trendTimeframe);
                  const isSelected = coin.tokenAddress === selectedTokenAddress;

                  return (
                    <tr
                      key={coin.tokenAddress}
                      onClick={() => setSelectedTokenAddress(coin.tokenAddress)}
                      className={`cursor-pointer border-b border-white/5 transition ${
                        isSelected ? 'bg-indigo-500/10' : 'hover:bg-white/[0.03]'
                      }`}
                    >
                      <td className="px-4 py-3 text-neutral-400">{index + 1}</td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-white">{coin.symbol}</div>
                        <div className="text-xs text-neutral-400">{coin.name}</div>
                      </td>
                      <td className="px-4 py-3">{formatPrice(coin.priceUsd)}</td>
                      <td className="px-4 py-3 font-medium text-indigo-300">
                        {getPublicityScore(coin).toFixed(2)}
                      </td>
                      <td className="px-4 py-3">
                        <div className={trend >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                          {formatPct(trend)}
                        </div>
                        <div className="text-xs text-neutral-500">
                          {getTimeframeVolumeContext(coin, trendTimeframe)}
                        </div>
                      </td>
                      <td className="px-4 py-3">{formatCompactUsd(coin.liquidityUsd)}</td>
                      <td className="px-4 py-3 text-neutral-300">{formatAge(coin.ageMinutes)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {selectedCoin ? (
          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <div>
                    <div className="text-2xl font-semibold">{selectedCoin.symbol}</div>
                    <div className="text-sm text-neutral-400">{selectedCoin.name}</div>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-neutral-400">
                  <span>Dual-axis chart is locked to live price + backend publicity.</span>
                  <span>•</span>
                  <span>Click any row to switch coin.</span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <a
                  href={selectedCoin.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-4 py-2 text-sm text-indigo-300 transition hover:bg-white/10"
                >
                  <ExternalLink className="h-4 w-4" />
                  Open on DexScreener
                </a>
              </div>
            </div>

            <div className="mt-5 rounded-3xl border border-white/10 bg-black/20 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-400">
                  <span className="inline-flex items-center gap-2 rounded-full bg-white/5 px-3 py-1">
                    <span className="h-2 w-2 rounded-full bg-emerald-400" />
                    Price (live DexScreener stream)
                  </span>
                  <span className="inline-flex items-center gap-2 rounded-full bg-white/5 px-3 py-1">
                    <span className="h-2 w-2 rounded-full bg-indigo-400" />
                    Publicity Score (backend Publicity_Score)
                  </span>
                </div>

                <div className="flex flex-wrap gap-2">
                  {CHART_WINDOWS.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => setChartWindow(option.value)}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                        chartWindow === option.value
                          ? 'bg-indigo-500 text-white'
                          : 'border border-white/10 bg-white/5 text-neutral-300 hover:bg-white/10'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <SynchronizedChart data={mergedChartData} />
            </div>

            <div className="mt-5 grid gap-5 xl:grid-cols-2">
              <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-neutral-200">Financial Metrics</div>
                  <div className="text-xs text-neutral-500">Dense market tape</div>
                </div>
                <DenseMetricTable
                  rows={[
                    { label: 'Price', value: formatPrice(selectedCoin.priceUsd), detail: 'Live spot from current pair' },
                    { label: 'Market Cap', value: formatCompactUsd(selectedCoin.marketCap), detail: 'Current FDV / market cap view' },
                    { label: 'Liquidity', value: formatCompactUsd(selectedCoin.liquidityUsd), detail: 'Current pool liquidity' },
                    {
                      label: 'Volume',
                      value:
                        volumeWindow === 'm5'
                          ? formatCompactUsd(selectedCoin.volumeM5Usd)
                          : volumeWindow === 'h1'
                            ? formatCompactUsd(selectedCoin.volumeH1Usd)
                            : formatCompactUsd(selectedCoin.volumeH24Usd),
                      detail: `DexScreener ${volumeWindow} feed`,
                      control: (
                        <InlineToggle
                          value={volumeWindow}
                          options={[
                            { value: 'm5', label: '5m' },
                            { value: 'h1', label: '1h' },
                            { value: 'h24', label: '24h' },
                          ]}
                          onChange={(value) => setVolumeWindow(value as MetricTimeframe)}
                        />
                      ),
                    },
                    {
                      label: 'Price Change',
                      value:
                        priceChangeWindow === 'm5'
                          ? formatPct(selectedCoin.priceChangeM5)
                          : priceChangeWindow === 'h1'
                            ? formatPct(selectedCoin.priceChangeH1)
                            : formatPct(selectedCoin.priceChangeH24),
                      detail: `DexScreener ${priceChangeWindow} delta`,
                      control: (
                        <InlineToggle
                          value={priceChangeWindow}
                          options={[
                            { value: 'm5', label: '5m' },
                            { value: 'h1', label: '1h' },
                            { value: 'h24', label: '24h' },
                          ]}
                          onChange={(value) => setPriceChangeWindow(value as MetricTimeframe)}
                        />
                      ),
                    },
                    {
                      label: 'Txns',
                      value:
                        txnWindow === 'm5'
                          ? selectedCoin.txnsM5.toLocaleString('en-US')
                          : selectedCoin.txnsH1.toLocaleString('en-US'),
                      detail: `DexScreener ${txnWindow} transaction count`,
                      control: (
                        <InlineToggle
                          value={txnWindow}
                          options={[
                            { value: 'm5', label: '5m' },
                            { value: 'h1', label: '1h' },
                          ]}
                          onChange={(value) => setTxnWindow(value as TxnTimeframe)}
                        />
                      ),
                    },
                    { label: 'Boosts Active', value: selectedCoin.boostsActive.toLocaleString('en-US'), detail: 'Current DexScreener boost count' },
                    { label: 'Age', value: formatAge(selectedCoin.ageMinutes), detail: 'Pair age from creation timestamp' },
                    { label: 'DEX', value: selectedCoin.dexId.toUpperCase(), detail: 'Primary venue' },
                    { label: 'Chain', value: selectedCoin.chainId.toUpperCase(), detail: 'Network' },
                  ]}
                />
              </div>

              <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-neutral-200">Publicity</div>
                  <div className="text-xs text-neutral-500">Backend and on-chain cache</div>
                </div>
                <DenseMetricTable
                  rows={[
                    {
                      label: 'PUBLICITY SCORE',
                      value: getPublicityScore(selectedCoin).toFixed(2),
                      detail: 'Direct mapping from backend Publicity_Score',
                    },
                    {
                      label: 'YouTube Mentions',
                      value: (selectedCoin.youtubeMentionCount || 0).toLocaleString('en-US'),
                      detail: 'Active retained mentions in the current backend cache',
                    },
                    {
                      label: 'Velocity of Publicity',
                      value:
                        publicityVelocity == null
                          ? 'Collecting...'
                          : `${formatSignedNumber(publicityVelocity, 2)}/hr`,
                      detail: 'Slope of recent Publicity_Score samples in the live session',
                    },
                    {
                      label: 'Retention Rate (24H)',
                      value:
                        onchainMetrics?.retentionRate24h == null
                          ? 'New Launch - Calculating...'
                          : `${onchainMetrics.retentionRate24h.toFixed(2)}%`,
                      detail:
                        'Helius or fallback holder overlap vs 24h-ago snapshot, cached hourly in SQLite.',
                    },
                    {
                      label: 'Median Hold Time',
                      value: formatHours(onchainMetrics?.medianHoldTimeHours ?? null),
                      detail:
                        'Top-holder first-buy to now or sell duration, refreshed hourly via server/solanaTracker.ts.',
                    },
                  ]}
                />
                {onchainMetrics && (
                  <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-neutral-400">
                    {onchainMetrics.message}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex min-h-[240px] items-center justify-center rounded-3xl border border-dashed border-white/10 bg-black/10 p-8 text-center text-sm text-neutral-400">
            Select a coin to open the detailed dashboard.
          </div>
        )}
      </div>
    </div>
  );
}

function SynchronizedChart({ data }: { data: ChartPoint[] }) {
  if (data.length < 2) {
    return (
      <div className="flex h-[360px] items-center justify-center rounded-2xl border border-dashed border-white/10 text-sm text-neutral-400">
        Waiting for more synchronized price + publicity points.
      </div>
    );
  }

  return (
    <div className="h-[360px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
          <XAxis
            dataKey="time"
            tickFormatter={(value) =>
              new Date(Number(value)).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })
            }
            stroke="#737373"
            fontSize={12}
            minTickGap={24}
          />
          <YAxis
            yAxisId="left"
            stroke="#818cf8"
            fontSize={12}
            width={72}
            tickFormatter={(value) => Number(value).toFixed(1)}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            stroke="#34d399"
            fontSize={12}
            width={96}
            tickFormatter={(value) => formatPrice(Number(value))}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#0a0a0a',
              borderColor: '#262626',
              borderRadius: '14px',
              color: '#fafafa',
            }}
            labelFormatter={(value) => new Date(Number(value)).toLocaleString()}
            formatter={(value, name) => {
              if (value == null) {
                return ['-', name === 'publicityScore' ? 'Publicity Score' : 'Price'];
              }
              if (name === 'publicityScore') {
                return [Number(value).toFixed(2), 'Publicity Score'];
              }
              return [formatPrice(Number(value)), 'Price'];
            }}
          />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="publicityScore"
            stroke="#818cf8"
            strokeWidth={2.5}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="priceUsd"
            stroke="#34d399"
            strokeWidth={2.5}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  subValue,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  subValue: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-neutral-500">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-2 text-xl font-semibold text-white">{value}</div>
      <div className="mt-1 text-xs text-neutral-400">{subValue}</div>
    </div>
  );
}

function InlineToggle({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="inline-flex rounded-full border border-white/10 bg-black/20 p-1">
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
            value === option.value
              ? 'bg-indigo-500 text-white'
              : 'text-neutral-400 hover:text-white'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function DenseMetricTable({
  rows,
}: {
  rows: Array<{
    label: string;
    value: string;
    detail: string;
    control?: React.ReactNode;
  }>;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/10">
      <table className="min-w-full text-left text-sm">
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b border-white/5 last:border-b-0">
              <td className="w-[26%] px-3 py-3 align-top text-xs font-medium uppercase tracking-wide text-neutral-500">
                <div className="flex flex-wrap items-center gap-2">
                  <span>{row.label}</span>
                  {row.control}
                </div>
              </td>
              <td className="w-[22%] px-3 py-3 align-top font-medium text-white">{row.value}</td>
              <td className="px-3 py-3 align-top text-xs text-neutral-400">{row.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
