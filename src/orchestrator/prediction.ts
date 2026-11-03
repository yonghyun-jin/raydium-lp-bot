/**
 * Range Selection (v0)
 *
 * v0 opens every position on a FIXED range: the live price plus or minus
 * V0_HALF_WIDTH_PCT. There is no model in this version. The deposit ratio
 * comes from CLMM maths, never from a guess.
 *
 * Every range carries a `source`, so a fixed range can never be mistaken for
 * something smarter than it is.
 */

import { calculateDepositRatio } from '../raydium/clmmMath';

/**
 * Half-width of the v0 range, in percent of the live price: 4 means the
 * position covers -4% .. +4% (8% in total).
 */
export const V0_HALF_WIDTH_PCT = 4;

/** Where a range came from. */
export type PredictionSource = 'fixed' | 'fallback';

export interface RangePrediction {
  lower: number;
  upper: number;
  current_price: number;
  width_pct: number;
  /** Fraction of position value to hold as SOL, 0..1. */
  sol_ratio: number;
  /** Fraction of position value to hold as USDC, 0..1. */
  usdc_ratio: number;
  source: PredictionSource;
  /** Unused in v0; kept so the recording schema is unchanged. */
  features?: Record<string, number>;
  neighbor_stats?: Record<string, number>;
}

export class PredictionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PredictionError';
  }
}

/**
 * The range for the next position: live price +/- V0_HALF_WIDTH_PCT.
 *
 * Requires the live price. Without it there is nothing to anchor on, and a
 * range anchored on a stale number is the kind of plausible guess that loses
 * money, so this throws instead.
 */
export async function getRangePrediction(currentPrice?: number): Promise<RangePrediction> {
  if (currentPrice === undefined) {
    throw new PredictionError('No live price to anchor the fixed range on');
  }
  return { ...buildFallbackPrediction(currentPrice, V0_HALF_WIDTH_PCT * 2), source: 'fixed' };
}

/**
 * A symmetric range with the deposit ratio CLMM maths actually requires.
 *
 * Explicitly tagged `source: 'fallback'`. It is never returned in place of a
 * model output without the caller asking for it.
 */
export function buildFallbackPrediction(currentPrice: number, widthPct: number): RangePrediction {
  if (!(currentPrice > 0)) {
    throw new PredictionError(`Cannot build a fallback range from price ${currentPrice}`);
  }
  if (!(widthPct > 0) || widthPct >= 200) {
    throw new PredictionError(`Fallback width must be in (0, 200), got ${widthPct}`);
  }

  const halfWidth = ((widthPct / 100) * currentPrice) / 2;
  const lower = currentPrice - halfWidth;
  const upper = currentPrice + halfWidth;
  const { solRatio, usdcRatio } = calculateDepositRatio(currentPrice, lower, upper);

  return {
    lower,
    upper,
    current_price: currentPrice,
    width_pct: widthPct,
    sol_ratio: solRatio,
    usdc_ratio: usdcRatio,
    source: 'fallback',
  };
}

/** Sanity-check a range before money is committed to it. */
export function validatePrediction(prediction: RangePrediction): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (prediction.lower >= prediction.upper) {
    errors.push('Lower bound must be less than upper bound');
  }
  if (prediction.lower <= 0 || prediction.upper <= 0) {
    errors.push('Bounds must be positive');
  }
  if (prediction.width_pct <= 0 || prediction.width_pct > 100) {
    errors.push('Width must be between 0 and 100%');
  }
  if (prediction.current_price < prediction.lower || prediction.current_price > prediction.upper) {
    errors.push('Current price must be within predicted range');
  }
  if (
    !(prediction.sol_ratio >= 0 && prediction.sol_ratio <= 1) ||
    !(prediction.usdc_ratio >= 0 && prediction.usdc_ratio <= 1)
  ) {
    // Guards the percent-vs-fraction confusion that has bitten this codebase.
    errors.push('Ratios must be fractions between 0 and 1');
  }
  if (Math.abs(prediction.sol_ratio + prediction.usdc_ratio - 1) > 1e-6) {
    errors.push('Ratios must sum to 1');
  }

  return { valid: errors.length === 0, errors };
}
