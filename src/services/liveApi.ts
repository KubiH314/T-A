import {
  OnchainMetricSnapshot,
  PublicityHistoryResponse,
  UniverseSnapshot,
} from '../types/live';

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

export class LiveApi {
  static async getUniverse(): Promise<UniverseSnapshot> {
    return getJson<UniverseSnapshot>('/api/live-universe');
  }

  static async getPublicityHistory(
    coinId: string,
    windowMinutes: number,
    bucketMinutes: number,
  ): Promise<PublicityHistoryResponse> {
    const params = new URLSearchParams({
      windowMinutes: String(windowMinutes),
      bucketMinutes: String(bucketMinutes),
    });

    return getJson<PublicityHistoryResponse>(
      `/api/publicity-history/${encodeURIComponent(coinId)}?${params.toString()}`,
    );
  }

  static async getOnchainMetrics(mintAddress: string): Promise<OnchainMetricSnapshot> {
    return getJson<OnchainMetricSnapshot>(
      `/api/onchain-metrics/${encodeURIComponent(mintAddress)}`,
    );
  }
}
