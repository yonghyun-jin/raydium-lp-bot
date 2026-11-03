/**
 * Price Feed Tests (offline)
 *
 * Only the deterministic, no-network paths live here. The CoinGecko-backed
 * cases moved to price.live.test.ts — they used to swallow HTTP 429 and pass,
 * which meant this suite was green even with no network at all.
 */

import { getPrice, getPrices, clearPriceCache } from '../../src/price';

describe('Price Feed (offline)', () => {
  beforeEach(() => {
    clearPriceCache();
  });

  describe('getPrice - stablecoins', () => {
    it('should return $1 for USDC', async () => {
      const result = await getPrice('USDC');

      expect(result.token).toBe('USDC');
      expect(result.price_usd).toBe(1);
      expect(result.source).toBe('constant');
    });

    it('should return $1 for USDT', async () => {
      const result = await getPrice('USDT');

      expect(result.token).toBe('USDT');
      expect(result.price_usd).toBe(1);
      expect(result.source).toBe('constant');
    });

    it('should handle case-insensitive token names', async () => {
      const result1 = await getPrice('usdc');
      const result2 = await getPrice('Usdc');

      expect(result1.token).toBe('USDC');
      expect(result2.token).toBe('USDC');
      expect(result1.price_usd).toBe(1);
      expect(result2.price_usd).toBe(1);
    });
  });

  describe('getPrices - stablecoins only', () => {
    it('resolves every stablecoin without touching the network', async () => {
      const prices = await getPrices(['USDC', 'USDT']);

      expect(prices.size).toBe(2);
      expect(prices.get('USDC')?.source).toBe('constant');
      expect(prices.get('USDT')?.source).toBe('constant');
    });
  });

  describe('network isolation', () => {
    it('a non-stablecoin lookup fails loudly offline rather than passing silently', async () => {
      // Guards the regression this split was made to fix: the old suite caught
      // 429s and returned early, so it reported green with no network.
      await expect(getPrice('SOL')).rejects.toThrow();
    });
  });
});
