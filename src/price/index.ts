/**
 * Price Feed Module
 *
 * Get USD prices for tokens at transaction time.
 * Used for recording price_usd in ledger.
 *
 * Priority:
 * 1. Constant for stablecoins (USDC, USDT = $1)
 * 2. CoinGecko (fallback, no API key needed)
 *
 * TODO: Add Pyth oracle as primary source
 */

import { PriceResult, PriceCache } from './types';
import { getCoinGeckoPrice, getCoinGeckoPrices } from './coingecko';

// Cache prices for 10 seconds to avoid rate limits
const CACHE_TTL_MS = 10_000;
const priceCache = new Map<string, PriceCache>();

// Stablecoins always $1
const STABLECOINS = ['USDC', 'USDT', 'DAI', 'BUSD'];

/**
 * Get current USD price for a token
 */
export async function getPrice(token: string): Promise<PriceResult> {
  const upperToken = token.toUpperCase();

  // Stablecoins are always $1
  if (STABLECOINS.includes(upperToken)) {
    return {
      token: upperToken,
      price_usd: 1,
      source: 'constant',
      timestamp: new Date().toISOString(),
    };
  }

  // Check cache
  const cached = priceCache.get(upperToken);
  if (cached && cached.expires_at > Date.now()) {
    return cached.result;
  }

  // Fetch from CoinGecko
  // TODO: Try Pyth first, then fall back to CoinGecko
  const result = await getCoinGeckoPrice(upperToken);

  // Cache result
  priceCache.set(upperToken, {
    result,
    expires_at: Date.now() + CACHE_TTL_MS,
  });

  return result;
}

/**
 * Get prices for multiple tokens
 */
export async function getPrices(tokens: string[]): Promise<Map<string, PriceResult>> {
  const results = new Map<string, PriceResult>();
  const tokensToFetch: string[] = [];
  const timestamp = new Date().toISOString();

  for (const token of tokens) {
    const upperToken = token.toUpperCase();

    // Stablecoins are always $1
    if (STABLECOINS.includes(upperToken)) {
      results.set(upperToken, {
        token: upperToken,
        price_usd: 1,
        source: 'constant',
        timestamp,
      });
      continue;
    }

    // Check cache
    const cached = priceCache.get(upperToken);
    if (cached && cached.expires_at > Date.now()) {
      results.set(upperToken, cached.result);
      continue;
    }

    tokensToFetch.push(upperToken);
  }

  // Fetch remaining tokens from CoinGecko
  if (tokensToFetch.length > 0) {
    const fetched = await getCoinGeckoPrices(tokensToFetch);

    for (const [token, result] of fetched) {
      results.set(token, result);
      priceCache.set(token, {
        result,
        expires_at: Date.now() + CACHE_TTL_MS,
      });
    }
  }

  return results;
}

/**
 * Get SOL price specifically (most common use case)
 */
export async function getSolPrice(): Promise<number> {
  const result = await getPrice('SOL');
  return result.price_usd;
}

/**
 * Clear price cache (for testing)
 */
export function clearPriceCache(): void {
  priceCache.clear();
}

// Re-export types
export { PriceResult, PriceCache } from './types';
