/**
 * CoinGecko Price Feed
 *
 * Works with no key on the public endpoint (10-30 calls/minute). If
 * COINGECKO_API_KEY is set it is sent as a Demo key header, which is what the
 * `CG-` prefix denotes; a Pro key would need pro-api.coingecko.com instead.
 *
 * The key was configured long before anything read it, so every call went out
 * unauthenticated and rate-limited. That matters because this is the LAST
 * price source: when it fails there is no other, and `getCurrentPrice()`
 * returns null and refuses to open a position. An unused key turned a
 * recoverable rate limit into a refused deposit.
 */

import { PriceResult } from './types';

const COINGECKO_API = 'https://api.coingecko.com/api/v3/simple/price';

/** Demo-key header, only when a key is configured. */
function authHeaders(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY;
  return key ? { 'x-cg-demo-api-key': key } : {};
}

// CoinGecko API response type
interface CoinGeckoResponse {
  [id: string]: {
    usd: number;
  };
}

// Map token symbols to CoinGecko IDs
const COINGECKO_IDS: Record<string, string> = {
  'SOL': 'solana',
  'USDC': 'usd-coin',
  'USDT': 'tether',
  'ETH': 'ethereum',
  'BTC': 'bitcoin',
  'RAY': 'raydium',
  'JUP': 'jupiter-exchange-solana',
};

/**
 * Get price from CoinGecko API
 */
export async function getCoinGeckoPrice(token: string): Promise<PriceResult> {
  const id = COINGECKO_IDS[token.toUpperCase()];

  if (!id) {
    throw new Error(`Unknown token for CoinGecko: ${token}`);
  }

  const url = `${COINGECKO_API}?ids=${id}&vs_currencies=usd`;

  const response = await fetch(url, { headers: authHeaders() });

  if (!response.ok) {
    throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as CoinGeckoResponse;

  if (!data[id] || typeof data[id].usd !== 'number') {
    throw new Error(`Invalid CoinGecko response for ${token}`);
  }

  return {
    token: token.toUpperCase(),
    price_usd: data[id].usd,
    source: 'coingecko',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Get multiple prices from CoinGecko in one request
 */
export async function getCoinGeckoPrices(tokens: string[]): Promise<Map<string, PriceResult>> {
  const ids = tokens
    .map((t) => COINGECKO_IDS[t.toUpperCase()])
    .filter((id): id is string => id !== undefined);

  if (ids.length === 0) {
    return new Map();
  }

  const url = `${COINGECKO_API}?ids=${ids.join(',')}&vs_currencies=usd`;

  const response = await fetch(url, { headers: authHeaders() });

  if (!response.ok) {
    throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as CoinGeckoResponse;
  const timestamp = new Date().toISOString();
  const results = new Map<string, PriceResult>();

  for (const token of tokens) {
    const id = COINGECKO_IDS[token.toUpperCase()];
    if (id && data[id] && typeof data[id].usd === 'number') {
      results.set(token.toUpperCase(), {
        token: token.toUpperCase(),
        price_usd: data[id].usd,
        source: 'coingecko',
        timestamp,
      });
    }
  }

  return results;
}
