/**
 * Price Feed Tests (live network)
 *
 * Run with: npm run test:live
 * Excluded from the default suite. A rate limit here is a FAILURE, not a skip.
 */

import { getPrice, getPrices, getSolPrice, clearPriceCache } from '../../src/price';

describe('Price Feed (live)', () => {
  beforeEach(() => {
    clearPriceCache();
  });

  it('gets the SOL price from CoinGecko', async () => {
    const result = await getPrice('SOL');

    expect(result.token).toBe('SOL');
    expect(result.price_usd).toBeGreaterThan(0);
    expect(result.source).toBe('coingecko');
    expect(result.timestamp).toBeDefined();
  });

  it('caches prices within the TTL', async () => {
    const result1 = await getPrice('SOL');
    const result2 = await getPrice('SOL');

    expect(result1.timestamp).toBe(result2.timestamp);
  });

  it('gets multiple prices at once', async () => {
    const prices = await getPrices(['SOL', 'USDC']);

    expect(prices.size).toBe(2);
    expect(prices.get('SOL')?.price_usd).toBeGreaterThan(0);
    expect(prices.get('USDC')?.price_usd).toBe(1);
  });

  it('mixes stablecoin constants with fetched prices', async () => {
    const prices = await getPrices(['USDC', 'USDT', 'SOL']);

    expect(prices.get('USDC')?.source).toBe('constant');
    expect(prices.get('USDT')?.source).toBe('constant');
    expect(prices.get('SOL')?.source).toBe('coingecko');
  });

  it('getSolPrice returns a positive number', async () => {
    const price = await getSolPrice();

    expect(typeof price).toBe('number');
    expect(price).toBeGreaterThan(0);
  });
});
