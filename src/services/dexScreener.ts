import { CoinData } from '../types';

const BASE_URL = 'https://api.dexscreener.com/latest/dex';

export class DexScreenerService {
  static async getNewPairs(): Promise<CoinData[]> {
    try {
      // Fetching trending/new pairs. 
      // Note: DexScreener doesn't have a specific "new pairs" endpoint that is public and simple without filters, 
      // but "search" or specific chain endpoints work. For MVP, we'll fetch latest boosted or trending.
      // Alternatively, we can search for specific known recent memecoins to populate the list.
      // Let's try fetching some trending tokens on Solana (common for memecoins).
      
      const response = await fetch(`${BASE_URL}/tokens/sol/So11111111111111111111111111111111111111112`); // Fallback to getting some data
      // Actually, let's use a search query for "meme" or just fetch top pairs.
      // Better approach for "New Pairs": Use the /tokens endpoint with specific addresses if we knew them, 
      // or just simulate "New" by fetching trending and filtering by age in the app logic if possible.
      // For this MVP, let's fetch trending pairs.
      
      // Using a hardcoded list of popular/recent memecoin addresses for the MVP to ensure we get data.
      // PEPE, BONK, WIF, etc.
      const addresses = [
        'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
        'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
        '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump', // PNUT
        'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC', // AI16Z
      ].join(',');

      const res = await fetch(`${BASE_URL}/tokens/${addresses}`);
      const data = await res.json();

      if (!data.pairs) return [];

      return data.pairs.map((pair: any) => ({
        address: pair.baseToken.address,
        symbol: pair.baseToken.symbol,
        name: pair.baseToken.name,
        priceUsd: pair.priceUsd,
        liquidity: {
          usd: pair.liquidity?.usd || 0,
        },
        volume: {
          h24: pair.volume?.h24 || 0,
        },
        marketCap: pair.marketCap || pair.fdv || 0,
        pairCreatedAt: pair.pairCreatedAt || Date.now() - 1000 * 60 * 60 * 24 * 10, // Fallback
        url: pair.url,
        chainId: pair.chainId,
        dexId: pair.dexId,
        priceChange: pair.priceChange || {},
      }));
    } catch (error) {
      console.error('Failed to fetch from DexScreener:', error);
      return [];
    }
  }
}
