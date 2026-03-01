import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowDownUp,
  Database,
  ExternalLink,
  RefreshCw,
  Timer,
  TrendingUp,
} from 'lucide-react';
import { LiveApi } from '../services/liveApi';
import { LiveCoin, UniverseSnapshot } from '../types/live';

type TrendTimeframe = 'm5' | 'h1' | 'h6' | 'h24';
type SortDirection = 'asc' | 'desc';
type SortKey =
  | 'rank'
  | 'symbol'
  | 'liveScore'
  | 'priceUsd'
  | 'trend'
  | 'liquidityUsd'
  | 'marketCap'
  | 'volumeH24Usd'
  | 'ageMinutes'
  | 'txnsH1'
  | 'boostsActive';

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'rank', label: 'Default rank' },
  { value: 'symbol', label: 'Ticker' },
  { value: 'liveScore', label: 'Publicity score' },
  { value: 'priceUsd', label: 'Price' },
  { value: 'trend', label: 'Selected trend' },
  { value: 'liquidityUsd', label: 'Liquidity' },
  { value: 'marketCap', label: 'Market cap' },
  { value: 'volumeH24Usd', label: '24h volume' },
  { value: 'ageMinutes', label: 'Age' },
  { value: 'txnsH1', label: '1h transactions' },
  { value: 'boostsActive', label: 'Boosts active' },
];

const TIMEFRAME_OPTIONS: Array<{ value: TrendTimeframe; label: string }> = [
  { value: 'm5', label: '5m' },
  { value: 'h1', label: '1h' },
  { value: 'h6', label: '6h' },
  { value: 'h24', label: '24h' },
];

function formatCompactUsd(value: number) {
  if (!Number.isFinite(value)) return '-';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPrice(value: number) {
  if (!Number.isFinite(value)) return '-';
  if (value >= 1) {
    return value.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 4,
    });
  }

  if (value >= 0.0001) {
    return `$${value.toFixed(6)}`;
  }

  return `$${value.toFixed(8)}`;
}

function formatPct(value: number) {
  if (!Number.isFinite(value)) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
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

function getPublicityScore(coin: LiveCoin) {
  const raw = coin.publicityScore ?? coin.publicity_score ?? coin.liveScore ?? 0;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : 0;
}

function getYouTubeMentions(coin: LiveCoin) {
  const raw = coin.youtubeMentionCount ?? coin.socialMentionCount ?? 0;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function Dashboard() {
  const [snapshot, setSnapshot] = useState<UniverseSnapshot | null>(null);
  const [selectedTokenAddress, setSelectedTokenAddress] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>('rank');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [trendTimeframe, setTrendTimeframe] = useState<TrendTimeframe>('h1');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadUniverse = async (showSpinner = false) => {
    if (showSpinner) {
      setIsRefreshing(true);
    }

    try {
      const next = await LiveApi.getUniverse();
      setSnapshot(next);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown backend error';
      setError(message);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    loadUniverse(false);
    const interval = window.setInterval(() => {
      loadUniverse(false);
    }, 15_000);

    return () => window.clearInterval(interval);
  }, []);

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
      } else if (sortBy === 'liveScore') {
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
      } else if (sortBy === 'txnsH1') {
        aValue = a.txnsH1;
        bValue = b.txnsH1;
      } else if (sortBy === 'boostsActive') {
        aValue = a.boostsActive;
        bValue = b.boostsActive;
      }

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return aValue.localeCompare(bValue) * multiplier;
      }

      const numericA = Number(aValue);
      const numericB = Number(bValue);
      if (numericA === numericB) {
        return getPublicityScore(b) - getPublicityScore(a);
      }

      return (numericA - numericB) * multiplier;
    });

    return items;
  }, [snapshot, sortBy, sortDirection, trendTimeframe]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-neutral-950 p-8 text-white">
        <div className="mx-auto max-w-6xl">
          <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-6">
            <RefreshCw className="h-5 w-5 animate-spin text-indigo-300" />
            <span>Loading live market data…</span>
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
              <p className="font-medium">We’re having trouble loading live data right now.</p>
              <p className="mt-2 text-sm text-neutral-300">Please try again in a moment.</p>
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
                Live Market Overview
              </div>
              <h1 className="text-3xl font-semibold tracking-tight">MemePulse</h1>
              <p className="max-w-3xl text-sm text-neutral-300">
                Track live market moves, compare social momentum, and monitor each coin in one place.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                onClick={() => loadUniverse(true)}
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm transition hover:bg-white/10"
              >
                <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <StatCard
              icon={TrendingUp}
              label="Coins tracked"
              value={`${snapshot.counts.tracked}/${snapshot.config.targetUniverse}`}
              subValue={`Watching ${snapshot.counts.candidatePool} candidates`}
            />
            <StatCard
              icon={Timer}
              label="Update speed"
              value={`${snapshot.config.fastRefreshMs / 1000}s`}
              subValue={`Rebalanced every ${snapshot.config.rebalanceMs / 60000}m`}
            />
            <StatCard
              icon={Database}
              label="Minimum liquidity"
              value={formatCompactUsd(snapshot.config.minLiquidityUsd)}
              subValue={`24h volume floor ${formatCompactUsd(snapshot.config.minVolumeH24Usd)}`}
            />
            <StatCard
              icon={Activity}
              label="Updated"
              value={new Date(snapshot.generatedAt).toLocaleTimeString()}
              subValue={snapshot.status === 'live' ? 'Live data connected' : 'Refreshing data feed'}
            />
          </div>

          {error && (
            <div className="mt-4 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              We had trouble refreshing live data. Showing the most recent snapshot.
            </div>
          )}
        </div>

        <div className="overflow-hidden rounded-3xl border border-white/10 bg-white/[0.03]">
          <div className="border-b border-white/10 px-5 py-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <div className="text-sm font-medium text-neutral-200">Live market watchlist</div>
                <div className="mt-1 text-xs text-neutral-400">Sort the table and click any coin to view details.</div>
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
                    onClick={() => setSortDirection((current) => (current === 'desc' ? 'asc' : 'desc'))}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white transition hover:bg-white/10"
                  >
                    <ArrowDownUp className="h-4 w-4" />
                    {sortDirection === 'desc' ? 'High → Low' : 'Low → High'}
                  </button>
                </label>

                <label className="space-y-1 text-xs text-neutral-400">
                  <span className="block">Trend timeframe</span>
                  <select
                    value={trendTimeframe}
                    onChange={(event) => setTrendTimeframe(event.target.value as TrendTimeframe)}
                    className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
                  >
                    {TIMEFRAME_OPTIONS.map((option) => (
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
                  <th className="px-4 py-3">Publicity</th>
                  <th className="px-4 py-3">
                    Trend ({TIMEFRAME_OPTIONS.find((item) => item.value === trendTimeframe)?.label})
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
                      <td className="px-4 py-3 font-medium text-indigo-300">{getPublicityScore(coin).toFixed(2)}</td>
                      <td className="px-4 py-3">
                        <div className={trend >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{formatPct(trend)}</div>
                        <div className="text-xs text-neutral-500">{getTimeframeVolumeContext(coin, trendTimeframe)}</div>
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
                <div>
                  <div className="text-2xl font-semibold">{selectedCoin.symbol}</div>
                  <div className="text-sm text-neutral-400">{selectedCoin.name}</div>
                </div>
                <div className="mt-2 text-xs text-neutral-400">Click any row to switch coin.</div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <a
                  href={selectedCoin.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-4 py-2 text-sm text-indigo-300 transition hover:bg-white/10"
                >
                  <ExternalLink className="h-4 w-4" />
                  Open market page
                </a>
              </div>
            </div>

            <div className="mt-5 rounded-3xl border border-white/10 bg-black/20 p-4">
              <div className="text-sm font-medium text-neutral-200">Financial Metrics</div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <MiniMetric label="Price" value={formatPrice(selectedCoin.priceUsd)} />
                <MiniMetric label="Publicity score" value={getPublicityScore(selectedCoin).toFixed(2)} />
                <MiniMetric
                  label="YouTube mentions"
                  value={getYouTubeMentions(selectedCoin).toLocaleString('en-US')}
                />
                <MiniMetric label="Market cap" value={formatCompactUsd(selectedCoin.marketCap)} />
                <MiniMetric label="Liquidity" value={formatCompactUsd(selectedCoin.liquidityUsd)} />
                <MiniMetric label="5m volume" value={formatCompactUsd(selectedCoin.volumeM5Usd)} />
                <MiniMetric label="1h volume" value={formatCompactUsd(selectedCoin.volumeH1Usd)} />
                <MiniMetric label="24h volume" value={formatCompactUsd(selectedCoin.volumeH24Usd)} />
                <MiniMetric label="5m change" value={formatPct(selectedCoin.priceChangeM5)} />
                <MiniMetric label="1h change" value={formatPct(selectedCoin.priceChangeH1)} />
                <MiniMetric label="6h change" value={formatPct(selectedCoin.priceChangeH6)} />
                <MiniMetric label="24h change" value={formatPct(selectedCoin.priceChangeH24)} />
                <MiniMetric label="5m txns" value={selectedCoin.txnsM5.toLocaleString('en-US')} />
                <MiniMetric label="1h txns" value={selectedCoin.txnsH1.toLocaleString('en-US')} />
                <MiniMetric label="Boosts active" value={selectedCoin.boostsActive.toLocaleString('en-US')} />
                <MiniMetric label="Age" value={formatAge(selectedCoin.ageMinutes)} />
                <MiniMetric label="DEX" value={selectedCoin.dexId.toUpperCase()} />
                <MiniMetric label="Chain" value={selectedCoin.chainId.toUpperCase()} />
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

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-sm font-medium text-white">{value}</div>
    </div>
  );
}
