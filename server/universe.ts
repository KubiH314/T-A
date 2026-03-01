import { appConfig } from './config';
import { DexScreenerClient } from './dexscreener';
import { BucketType, DexPair, DiscoveryHint, LiveCoin, UniverseSnapshot } from './types';

const BLOCKED_TOKEN_MARKERS = ['hitler', 'not wrong just early'];

function normalizeTokenText(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

type ScoredCandidate = Omit<LiveCoin, 'bucket' | 'rank'>;

function clamp(value: number, min = 0, max = Number.POSITIVE_INFINITY) {
  return Math.max(min, Math.min(max, value));
}

function safeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function logScore(value: number, weight: number) {
  return Math.log10(Math.max(1, value) + 1) * weight;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export class UniverseManager {
  private readonly client = new DexScreenerClient();
  private readonly tracked = new Map<string, LiveCoin>();
  private readonly weakCycles = new Map<string, number>();
  private readonly discoveryHints = new Map<string, DiscoveryHint>();
  private candidatePool: ScoredCandidate[] = [];
  private snapshot: UniverseSnapshot = this.buildSnapshot('warming_up');
  private lastRebalancedAt = 0;
  private isFastRefreshRunning = false;
  private isCandidateRefreshRunning = false;
  private isRebalanceRunning = false;

  async initialize() {
    await this.refreshCandidatePool();
    this.rebalanceUniverse(true);
    await this.refreshTrackedUniverse();
    this.snapshot = this.buildSnapshot('live');
  }

  start() {
    setInterval(() => {
      if (this.isFastRefreshRunning) return;
      this.isFastRefreshRunning = true;
      this.refreshTrackedUniverse()
        .catch((error) => {
          console.error('[fast-refresh] failed', error);
        })
        .finally(() => {
          this.isFastRefreshRunning = false;
        });
    }, appConfig.fastRefreshMs);

    setInterval(() => {
      if (this.isCandidateRefreshRunning) return;
      this.isCandidateRefreshRunning = true;
      this.refreshCandidatePool()
        .then(() => this.rebalanceUniverse(false))
        .catch((error) => {
          console.error('[candidate-refresh] failed', error);
        })
        .finally(() => {
          this.isCandidateRefreshRunning = false;
        });
    }, appConfig.candidateRefreshMs);

    setInterval(() => {
      if (this.isRebalanceRunning) return;
      this.isRebalanceRunning = true;
      Promise.resolve()
        .then(() => this.rebalanceUniverse(false))
        .finally(() => {
          this.isRebalanceRunning = false;
        });
    }, appConfig.rebalanceMs);
  }

  getSnapshot(): UniverseSnapshot {
    return this.snapshot;
  }

  private upsertHint(tokenAddress: string, patch: Partial<DiscoveryHint>) {
    const current = this.discoveryHints.get(tokenAddress) || {
      hasProfile: false,
      hasCommunityTakeover: false,
      hasBoost: false,
      hasTopBoost: false,
    };

    const next = {
      ...current,
      ...patch,
    };

    this.discoveryHints.set(tokenAddress, next);
  }

  private isBlockedPair(pair: DexPair) {
    const searchableText = [
      pair.baseToken?.name,
      pair.baseToken?.symbol,
      pair.url,
    ]
      .map((value) => normalizeTokenText(value))
      .filter(Boolean)
      .join(' ');

    return BLOCKED_TOKEN_MARKERS.some((marker) => searchableText.includes(marker));
  }

  private purgeBlockedTrackedCoins() {
    for (const [tokenAddress, coin] of this.tracked.entries()) {
      const searchableText = [coin.name, coin.symbol, coin.url]
        .map((value) => normalizeTokenText(value))
        .filter(Boolean)
        .join(' ');

      if (BLOCKED_TOKEN_MARKERS.some((marker) => searchableText.includes(marker))) {
        this.tracked.delete(tokenAddress);
        this.weakCycles.delete(tokenAddress);
      }
    }
  }

  private chooseCanonicalPairs(pairs: DexPair[]): DexPair[] {
    const byToken = new Map<string, DexPair>();

    for (const pair of pairs) {
      if (this.isBlockedPair(pair)) continue;

      const tokenAddress = pair.baseToken?.address;
      if (!tokenAddress) continue;

      const current = byToken.get(tokenAddress);
      const currentLiquidity = safeNumber(current?.liquidity?.usd);
      const candidateLiquidity = safeNumber(pair.liquidity?.usd);

      if (!current || candidateLiquidity > currentLiquidity) {
        byToken.set(tokenAddress, pair);
      }
    }

    return Array.from(byToken.values());
  }

  private passesEntryFilter(pair: DexPair) {
    const liquidityUsd = safeNumber(pair.liquidity?.usd);
    const volumeM5Usd = safeNumber(pair.volume?.m5);
    const volumeH1Usd = safeNumber(pair.volume?.h1);
    const volumeH24Usd = safeNumber(pair.volume?.h24);
    const ageMinutes = Math.max(
      0,
      (Date.now() - safeNumber(pair.pairCreatedAt || Date.now())) / 60_000,
    );

    return (
      liquidityUsd >= appConfig.minLiquidityUsd &&
      volumeH24Usd >= appConfig.minVolumeH24Usd &&
      (volumeH1Usd >= appConfig.minVolumeH1Usd || volumeM5Usd >= appConfig.minVolumeM5Usd) &&
      ageMinutes >= appConfig.minAgeMinutes
    );
  }

  private passesKeepFilter(pair: DexPair) {
    return (
      safeNumber(pair.liquidity?.usd) >= appConfig.minLiquidityUsd * 0.6 &&
      safeNumber(pair.volume?.h24) >= appConfig.minVolumeH24Usd * 0.4
    );
  }

  private makeCandidate(pair: DexPair): ScoredCandidate | null {
    const tokenAddress = pair.baseToken?.address;
    const name = pair.baseToken?.name;
    const symbol = pair.baseToken?.symbol;

    if (!tokenAddress || !name || !symbol) {
      return null;
    }

    if (!this.passesEntryFilter(pair)) {
      return null;
    }

    const hint = this.discoveryHints.get(tokenAddress) || {
      hasProfile: false,
      hasCommunityTakeover: false,
      hasBoost: false,
      hasTopBoost: false,
    };

    const existing = this.tracked.get(tokenAddress);
    const ageMinutes = Math.max(
      0,
      (Date.now() - safeNumber(pair.pairCreatedAt || Date.now())) / 60_000,
    );
    const ageHours = ageMinutes / 60;

    const liquidityUsd = safeNumber(pair.liquidity?.usd);
    const volumeM5Usd = safeNumber(pair.volume?.m5);
    const volumeH1Usd = safeNumber(pair.volume?.h1);
    const volumeH24Usd = safeNumber(pair.volume?.h24);

    const txnsM5 =
      safeNumber(pair.txns?.m5?.buys) +
      safeNumber(pair.txns?.m5?.sells);
    const txnsH1 =
      safeNumber(pair.txns?.h1?.buys) +
      safeNumber(pair.txns?.h1?.sells);

    const extrapolatedM5ToH1 = volumeM5Usd * 12;
    const volumeAcceleration = extrapolatedM5ToH1 / Math.max(1, volumeH1Usd);
    const tradeAcceleration = (txnsM5 * 12) / Math.max(1, txnsH1);

    const liquidityScore = logScore(liquidityUsd, 7);
    const volumeScore =
      logScore(volumeM5Usd, 11) +
      logScore(volumeH1Usd, 9) +
      logScore(volumeH24Usd, 5);

    const momentumScore =
      clamp(safeNumber(pair.priceChange?.m5), 0) * 1.6 +
      clamp(safeNumber(pair.priceChange?.h1), 0) * 1.0 +
      clamp(volumeAcceleration - 1, 0, 3) * 10 +
      clamp(tradeAcceleration - 1, 0, 3) * 8;

    const freshnessScore =
      ageHours <= appConfig.maxFreshAgeHours
        ? clamp(24 - ageHours, 0, 24)
        : 0;

    const discoveryScore =
      (hint.hasProfile ? 6 : 0) +
      (hint.hasCommunityTakeover ? 10 : 0) +
      (hint.hasBoost ? 8 : 0) +
      (hint.hasTopBoost ? 10 : 0) +
      safeNumber(pair.boosts?.active) * 4;

    const weakCycles = this.weakCycles.get(tokenAddress) || 0;
    const holdBonus =
      existing && weakCycles < appConfig.weakCyclesBeforeDrop ? 14 : 0;

    const liveScore =
      liquidityScore +
      volumeScore +
      momentumScore +
      freshnessScore +
      discoveryScore +
      holdBonus;

    return {
      tokenAddress,
      pairAddress: pair.pairAddress,
      symbol,
      name,
      chainId: pair.chainId,
      dexId: pair.dexId,
      url: pair.url,
      imageUrl: pair.info?.imageUrl,
      liveScore,
      scoreBreakdown: {
        liquidity: Number(liquidityScore.toFixed(2)),
        volume: Number(volumeScore.toFixed(2)),
        momentum: Number(momentumScore.toFixed(2)),
        freshness: Number(freshnessScore.toFixed(2)),
        discovery: Number(discoveryScore.toFixed(2)),
        holdBonus: Number(holdBonus.toFixed(2)),
      },
      priceUsd: safeNumber(pair.priceUsd),
      marketCap: safeNumber(pair.marketCap || pair.fdv),
      liquidityUsd,
      volumeM5Usd,
      volumeH1Usd,
      volumeH24Usd,
      txnsM5,
      txnsH1,
      priceChangeM5: safeNumber(pair.priceChange?.m5),
      priceChangeH1: safeNumber(pair.priceChange?.h1),
      priceChangeH6: safeNumber(pair.priceChange?.h6),
      priceChangeH24: safeNumber(pair.priceChange?.h24),
      boostsActive: safeNumber(pair.boosts?.active),
      hasProfile: hint.hasProfile,
      hasCommunityTakeover: hint.hasCommunityTakeover,
      ageMinutes: Math.round(ageMinutes),
      pairCreatedAt: safeNumber(pair.pairCreatedAt || Date.now()),
      updatedAt: Date.now(),
    };
  }

  private markWeakCyclesFromLivePairs(pairsByToken: Map<string, DexPair>) {
    for (const [tokenAddress, existing] of this.tracked.entries()) {
      const latestPair = pairsByToken.get(tokenAddress);

      if (!latestPair) {
        const prior = this.weakCycles.get(tokenAddress) || 0;
        this.weakCycles.set(tokenAddress, prior + 1);
        continue;
      }

      if (this.passesKeepFilter(latestPair)) {
        this.weakCycles.set(tokenAddress, 0);
      } else {
        const prior = this.weakCycles.get(tokenAddress) || 0;
        this.weakCycles.set(tokenAddress, prior + 1);
      }

      const updatedCandidate = this.makeCandidate(latestPair);
      if (!updatedCandidate) {
        if ((this.weakCycles.get(tokenAddress) || 0) >= appConfig.weakCyclesBeforeDrop) {
          this.tracked.delete(tokenAddress);
        }
        continue;
      }

      this.tracked.set(tokenAddress, {
        ...existing,
        ...updatedCandidate,
        bucket: existing.bucket,
        rank: existing.rank,
      });
    }
  }

  async refreshTrackedUniverse() {
    this.purgeBlockedTrackedCoins();

    const trackedAddresses = Array.from(this.tracked.keys());
    if (trackedAddresses.length === 0) {
      this.snapshot = this.buildSnapshot(this.candidatePool.length ? 'live' : 'warming_up');
      return;
    }

    const rawPairs = await this.client.fetchPairsByTokenAddresses(trackedAddresses);
    const canonicalPairs = this.chooseCanonicalPairs(rawPairs);
    const pairsByToken = new Map(
      canonicalPairs.map((pair) => [pair.baseToken!.address, pair] as const),
    );

    this.markWeakCyclesFromLivePairs(pairsByToken);
    this.snapshot = this.buildSnapshot('live');
  }

  async refreshCandidatePool() {
    const [
      profilesResult,
      boostsResult,
      topBoostsResult,
      communityResult,
      searchedResults,
      trackedResults,
    ] = await Promise.allSettled([
      this.client.fetchLatestTokenProfiles(),
      this.client.fetchLatestBoosts(),
      this.client.fetchTopBoosts(),
      this.client.fetchCommunityTakeovers(),
      Promise.all(appConfig.searchTerms.map((term) => this.client.searchPairs(term))),
      this.client.fetchPairsByTokenAddresses(Array.from(this.tracked.keys())),
    ]);

    const rawPairs: DexPair[] = [];

    if (profilesResult.status === 'fulfilled') {
      for (const item of profilesResult.value) {
        if (item?.tokenAddress) {
          this.upsertHint(item.tokenAddress, { hasProfile: true });
        }
      }
    }

    if (boostsResult.status === 'fulfilled') {
      for (const item of boostsResult.value) {
        if (item?.tokenAddress) {
          this.upsertHint(item.tokenAddress, { hasBoost: true });
        }
      }
    }

    if (topBoostsResult.status === 'fulfilled') {
      for (const item of topBoostsResult.value) {
        if (item?.tokenAddress) {
          this.upsertHint(item.tokenAddress, { hasTopBoost: true });
        }
      }
    }

    if (communityResult.status === 'fulfilled') {
      for (const item of communityResult.value) {
        if (item?.tokenAddress) {
          this.upsertHint(item.tokenAddress, { hasCommunityTakeover: true });
        }
      }
    }

    if (searchedResults.status === 'fulfilled') {
      rawPairs.push(...searchedResults.value.flat());
    }

    if (trackedResults.status === 'fulfilled') {
      rawPairs.push(...trackedResults.value);
    }

    const discoveryAddresses = new Set<string>();
    if (profilesResult.status === 'fulfilled') {
      for (const item of profilesResult.value) {
        if (item?.tokenAddress) discoveryAddresses.add(item.tokenAddress);
      }
    }
    if (boostsResult.status === 'fulfilled') {
      for (const item of boostsResult.value) {
        if (item?.tokenAddress) discoveryAddresses.add(item.tokenAddress);
      }
    }
    if (topBoostsResult.status === 'fulfilled') {
      for (const item of topBoostsResult.value) {
        if (item?.tokenAddress) discoveryAddresses.add(item.tokenAddress);
      }
    }
    if (communityResult.status === 'fulfilled') {
      for (const item of communityResult.value) {
        if (item?.tokenAddress) discoveryAddresses.add(item.tokenAddress);
      }
    }

    const discoveryAddressChunks = chunk(Array.from(discoveryAddresses), 120);
    for (const addresses of discoveryAddressChunks) {
      try {
        const pairs = await this.client.fetchPairsByTokenAddresses(addresses);
        rawPairs.push(...pairs);
      } catch (error) {
        console.error('[candidate-pool] failed to hydrate token list', error);
      }
    }

    const canonicalPairs = this.chooseCanonicalPairs(rawPairs);
    const candidates = canonicalPairs
      .map((pair) => this.makeCandidate(pair))
      .filter((candidate): candidate is ScoredCandidate => Boolean(candidate))
      .sort((a, b) => b.liveScore - a.liveScore)
      .slice(0, appConfig.candidatePoolSize);

    this.candidatePool = candidates;
    this.snapshot = this.buildSnapshot(this.tracked.size ? 'live' : 'warming_up');
  }

  private assignSelected(
    selected: LiveCoin[],
    seen: Set<string>,
    candidates: ScoredCandidate[],
    limit: number,
    bucket: BucketType,
    predicate: (candidate: ScoredCandidate) => boolean = () => true,
  ) {
    for (const candidate of candidates) {
      if (selected.length >= limit) return;
      if (seen.has(candidate.tokenAddress)) continue;
      if (!predicate(candidate)) continue;
      seen.add(candidate.tokenAddress);
      selected.push({
        ...candidate,
        bucket,
        rank: 0,
      });
    }
  }

  private rebalanceUniverse(force: boolean) {
    this.purgeBlockedTrackedCoins();

    const now = Date.now();
    if (!force && now - this.lastRebalancedAt < appConfig.rebalanceMs) {
      return;
    }

    if (this.candidatePool.length === 0 && this.tracked.size === 0) {
      this.snapshot = this.buildSnapshot('warming_up');
      return;
    }

    const selected: LiveCoin[] = [];
    const seen = new Set<string>();

    const persistenceCandidates = this.candidatePool
      .filter((candidate) => this.tracked.has(candidate.tokenAddress))
      .filter(
        (candidate) =>
          (this.weakCycles.get(candidate.tokenAddress) || 0) <
          appConfig.weakCyclesBeforeDrop,
      )
      .sort((a, b) => b.liveScore - a.liveScore);

    this.assignSelected(
      selected,
      seen,
      persistenceCandidates,
      appConfig.persistenceSlots,
      'persistence',
    );

    const freshCandidates = this.candidatePool
      .filter((candidate) => candidate.ageMinutes <= appConfig.maxFreshAgeHours * 60)
      .sort((a, b) => {
        const freshnessA = a.scoreBreakdown.freshness + a.liveScore;
        const freshnessB = b.scoreBreakdown.freshness + b.liveScore;
        return freshnessB - freshnessA;
      });

    const afterPersistence = selected.length + appConfig.freshSlots;
    this.assignSelected(
      selected,
      seen,
      freshCandidates,
      afterPersistence,
      'fresh',
      (candidate) => candidate.ageMinutes <= appConfig.maxFreshAgeHours * 60,
    );

    const afterTrending = Math.min(
      appConfig.targetUniverse,
      selected.length + appConfig.trendingSlots,
    );
    this.assignSelected(
      selected,
      seen,
      this.candidatePool,
      afterTrending,
      'trending',
    );

    this.assignSelected(
      selected,
      seen,
      this.candidatePool,
      appConfig.targetUniverse,
      'trending',
    );

    const nextTracked = new Map<string, LiveCoin>();
    selected
      .sort((a, b) => b.liveScore - a.liveScore)
      .forEach((coin, index) => {
        const rankedCoin: LiveCoin = {
          ...coin,
          rank: index + 1,
          updatedAt: Date.now(),
        };
        nextTracked.set(rankedCoin.tokenAddress, rankedCoin);
      });

    for (const tokenAddress of this.tracked.keys()) {
      if (!nextTracked.has(tokenAddress)) {
        const weak = this.weakCycles.get(tokenAddress) || 0;
        if (weak + 1 >= appConfig.weakCyclesBeforeDrop) {
          this.weakCycles.delete(tokenAddress);
        } else {
          this.weakCycles.set(tokenAddress, weak + 1);
        }
      } else {
        this.weakCycles.set(tokenAddress, 0);
      }
    }

    this.tracked.clear();
    for (const [tokenAddress, coin] of nextTracked.entries()) {
      this.tracked.set(tokenAddress, coin);
    }

    this.lastRebalancedAt = now;
    this.snapshot = this.buildSnapshot('live');
  }

  private buildSnapshot(status: UniverseSnapshot['status']): UniverseSnapshot {
    const items = Array.from(this.tracked.values()).sort((a, b) => b.liveScore - a.liveScore);

    return {
      updatedAt: Date.now(),
      generatedAt: new Date().toISOString(),
      status,
      config: {
        chainId: appConfig.chainId,
        targetUniverse: appConfig.targetUniverse,
        trendingSlots: appConfig.trendingSlots,
        freshSlots: appConfig.freshSlots,
        persistenceSlots: appConfig.persistenceSlots,
        fastRefreshMs: appConfig.fastRefreshMs,
        candidateRefreshMs: appConfig.candidateRefreshMs,
        rebalanceMs: appConfig.rebalanceMs,
        minLiquidityUsd: appConfig.minLiquidityUsd,
        minVolumeH24Usd: appConfig.minVolumeH24Usd,
      },
      counts: {
        tracked: items.length,
        candidatePool: this.candidatePool.length,
      },
      items,
    };
  }
}
