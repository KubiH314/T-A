import { appConfig } from './config';
import { DexPair } from './types';

const API_BASE = 'https://api.dexscreener.com';

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value == null) return [];
  return [value as T];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('429') ||
    message.includes('5') ||
    message.includes('timeout') ||
    message.includes('abort') ||
    message.includes('fetch') ||
    message.includes('network')
  );
}

export class DexScreenerClient {
  private async getJsonOnce<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), appConfig.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`DEX Screener request failed: ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getJson<T>(url: string): Promise<T> {
    const attempts = Math.max(1, appConfig.dexRetryCount);

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.getJsonOnce<T>(url);
      } catch (error) {
        if (attempt >= attempts || !shouldRetry(error)) {
          throw error;
        }

        const delay = appConfig.dexRetryDelayMs * attempt;
        await sleep(delay);
      }
    }

    throw new Error('DEX Screener request exhausted retries.');
  }

  async fetchLatestTokenProfiles() {
    const payload = await this.getJson<unknown>(`${API_BASE}/token-profiles/latest/v1`);
    return asArray<any>(payload).filter((item) => item?.chainId === appConfig.chainId);
  }

  async fetchLatestBoosts() {
    const payload = await this.getJson<unknown>(`${API_BASE}/token-boosts/latest/v1`);
    return asArray<any>(payload).filter((item) => item?.chainId === appConfig.chainId);
  }

  async fetchTopBoosts() {
    const payload = await this.getJson<unknown>(`${API_BASE}/token-boosts/top/v1`);
    return asArray<any>(payload).filter((item) => item?.chainId === appConfig.chainId);
  }

  async fetchCommunityTakeovers() {
    const payload = await this.getJson<unknown>(`${API_BASE}/community-takeovers/latest/v1`);
    return asArray<any>(payload).filter((item) => item?.chainId === appConfig.chainId);
  }

  async searchPairs(query: string): Promise<DexPair[]> {
    const url = new URL(`${API_BASE}/latest/dex/search`);
    url.searchParams.set('q', query);

    const payload = await this.getJson<{ pairs?: DexPair[] }>(url.toString());
    return (payload.pairs || []).filter((pair) => pair?.chainId === appConfig.chainId);
  }

  async fetchPairsByTokenAddresses(addresses: string[]): Promise<DexPair[]> {
    const deduped = Array.from(new Set(addresses.filter(Boolean)));
    if (deduped.length === 0) return [];

    const chunks: string[][] = [];
    for (let i = 0; i < deduped.length; i += 30) {
      chunks.push(deduped.slice(i, i + 30));
    }

    const results = await Promise.all(
      chunks.map(async (chunk) => {
        const url = `${API_BASE}/tokens/v1/${appConfig.chainId}/${chunk.join(',')}`;
        const payload = await this.getJson<unknown>(url);
        return asArray<DexPair>(payload).filter((pair) => pair?.chainId === appConfig.chainId);
      }),
    );

    return results.flat();
  }
}
