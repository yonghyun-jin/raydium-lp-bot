/**
 * Price Types
 */

export interface PriceResult {
  token: string;           // 'SOL' | 'USDC' | 'ETH' etc.
  price_usd: number;       // Price in USD
  source: string;          // 'pyth' | 'coingecko' | 'jupiter' | 'constant'
  timestamp: string;       // ISO 8601 when price was fetched
  confidence?: number;     // Pyth confidence interval (optional)
}

export interface PriceCache {
  result: PriceResult;
  expires_at: number;      // Unix timestamp in ms
}
