/**
 * CLMM math — the single source of truth.
 *
 * Before this module the same maths existed in four divergent copies:
 *   - src/raydium/client.ts:963-990   (create path)
 *   - src/raydium/client.ts:502-532   (read path)
 *   - src/orchestrator/components/SwapToRatio.ts:162-186
 *   - src/lp/ratio.ts                 (unused, but the best-tested copy)
 *
 * The create-path copy carried a spurious `decimalAdjust` factor that made its
 * liquidity 10^1.5 (~31.6x) too large. It went unnoticed because
 * `openPositionFromBase` derives the required amounts from `baseAmount`, not
 * from the `liquidity` handed to it.
 *
 * Conventions
 * -----------
 * token0 = SOL (decimalsA, 9), token1 = USDC (decimalsB, 6).
 * The protocol prices token1 per token0 in RAW units:
 *     P_raw = P_human * 10^(decimalsB - decimalsA)
 *     tick  = log(P_raw) / log(1.0001)
 *     sqrtP = 1.0001^(tick/2) = sqrt(P_raw)
 *
 * Amounts in raw units (lamports, micro-USDC), for a range [Pa, Pb]:
 *     amount0 = L * (sqrtPb - sqrtP) / (sqrtP * sqrtPb)
 *     amount1 = L * (sqrtP - sqrtPa)
 * clamped so that below the range the position is all token0 and above it all
 * token1. No other decimal factor belongs anywhere in here.
 */

export const TICK_BASE = 1.0001;
export const TICK_ARRAY_SIZE = 60;

// --------------------------------------------------------------------------
// Price <-> tick
// --------------------------------------------------------------------------

/** Raw (protocol) price from a human price. */
export function toRawPrice(humanPrice: number, decimalsA: number, decimalsB: number): number {
  return humanPrice * Math.pow(10, decimalsB - decimalsA);
}

/** Unaligned tick for a human price. */
export function priceToTick(price: number, decimalsA: number, decimalsB: number): number {
  if (!(price > 0)) throw new Error(`priceToTick: price must be positive, got ${price}`);
  return Math.log(toRawPrice(price, decimalsA, decimalsB)) / Math.log(TICK_BASE);
}

/** Human price for a tick. */
export function tickToPrice(tick: number, decimalsA: number, decimalsB: number): number {
  return Math.pow(TICK_BASE, tick) * Math.pow(10, decimalsA - decimalsB);
}

/** sqrt of the raw price at a tick. */
export function tickToSqrtPrice(tick: number): number {
  return Math.pow(TICK_BASE, tick / 2);
}

/**
 * Snap a tick to the pool's spacing.
 *
 * `Math.floor` is used rather than truncation so negative ticks (SOL/USDC sits
 * near -23000) round consistently downward instead of toward zero.
 */
export function floorTick(tick: number, tickSpacing: number): number {
  return Math.floor(tick / tickSpacing) * tickSpacing;
}

export function ceilTick(tick: number, tickSpacing: number): number {
  return Math.ceil(tick / tickSpacing) * tickSpacing;
}

export type TickAlignMode =
  /** Widen to contain the requested range (floor lower, ceil upper). */
  | 'contain'
  /** Floor both bounds. This is what client.ts did, and it silently narrows
   *  the range on the upper side, raising the USDC the position needs. */
  | 'floor';

export interface AlignedTicks {
  tickLower: number;
  tickUpper: number;
  tickCurrent: number;
}

export function alignTicks(
  priceLower: number,
  priceUpper: number,
  currentPrice: number,
  decimalsA: number,
  decimalsB: number,
  tickSpacing: number,
  mode: TickAlignMode = 'contain'
): AlignedTicks {
  if (priceLower >= priceUpper) {
    throw new Error(`alignTicks: priceLower (${priceLower}) must be below priceUpper (${priceUpper})`);
  }

  const rawLower = priceToTick(priceLower, decimalsA, decimalsB);
  const rawUpper = priceToTick(priceUpper, decimalsA, decimalsB);
  const rawCurrent = priceToTick(currentPrice, decimalsA, decimalsB);

  const tickLower = floorTick(rawLower, tickSpacing);
  const tickUpper = mode === 'contain' ? ceilTick(rawUpper, tickSpacing) : floorTick(rawUpper, tickSpacing);

  if (tickLower >= tickUpper) {
    throw new Error(`alignTicks: range collapsed to a single tick (spacing ${tickSpacing})`);
  }

  return { tickLower, tickUpper, tickCurrent: floorTick(rawCurrent, tickSpacing) };
}

/** Start index of the tick array containing `tick`. */
export function tickArrayStartIndex(tick: number, tickSpacing: number): number {
  const ticksPerArray = TICK_ARRAY_SIZE * tickSpacing;
  return Math.floor(tick / ticksPerArray) * ticksPerArray;
}

// --------------------------------------------------------------------------
// Liquidity <-> amounts (raw units)
// --------------------------------------------------------------------------

function rawAmount0FromL(L: number, sqrtP: number, sqrtPa: number, sqrtPb: number): number {
  if (sqrtP >= sqrtPb) return 0; // above range: all token1
  const lo = Math.max(sqrtP, sqrtPa);
  return (L * (sqrtPb - lo)) / (lo * sqrtPb);
}

function rawAmount1FromL(L: number, sqrtP: number, sqrtPa: number, sqrtPb: number): number {
  if (sqrtP <= sqrtPa) return 0; // below range: all token0
  const hi = Math.min(sqrtP, sqrtPb);
  return L * (hi - sqrtPa);
}

export interface RangeSqrt {
  sqrtP: number;
  sqrtPa: number;
  sqrtPb: number;
}

export function sqrtPricesFromTicks(tickLower: number, tickUpper: number, tickCurrent: number): RangeSqrt {
  return {
    sqrtP: tickToSqrtPrice(tickCurrent),
    sqrtPa: tickToSqrtPrice(tickLower),
    sqrtPb: tickToSqrtPrice(tickUpper),
  };
}

/** Liquidity implied by depositing `sol` (human units) as token0. */
export function liquidityFromSol(
  sol: number,
  tickLower: number,
  tickUpper: number,
  tickCurrent: number,
  decimalsA: number
): number {
  const { sqrtP, sqrtPa, sqrtPb } = sqrtPricesFromTicks(tickLower, tickUpper, tickCurrent);
  if (sqrtP >= sqrtPb) return Infinity; // token0 contributes nothing above range
  const lo = Math.max(sqrtP, sqrtPa);
  const raw0 = sol * Math.pow(10, decimalsA);
  return (raw0 * lo * sqrtPb) / (sqrtPb - lo);
}

/** Liquidity implied by depositing `usdc` (human units) as token1. */
export function liquidityFromUsdc(
  usdc: number,
  tickLower: number,
  tickUpper: number,
  tickCurrent: number,
  decimalsB: number
): number {
  const { sqrtP, sqrtPa, sqrtPb } = sqrtPricesFromTicks(tickLower, tickUpper, tickCurrent);
  if (sqrtP <= sqrtPa) return Infinity; // token1 contributes nothing below range
  const hi = Math.min(sqrtP, sqrtPb);
  const raw1 = usdc * Math.pow(10, decimalsB);
  return raw1 / (hi - sqrtPa);
}

/** SOL (human units) required for a given liquidity. */
export function solForLiquidity(
  L: number,
  tickLower: number,
  tickUpper: number,
  tickCurrent: number,
  decimalsA: number
): number {
  const { sqrtP, sqrtPa, sqrtPb } = sqrtPricesFromTicks(tickLower, tickUpper, tickCurrent);
  return rawAmount0FromL(L, sqrtP, sqrtPa, sqrtPb) / Math.pow(10, decimalsA);
}

/** USDC (human units) required for a given liquidity. */
export function usdcForLiquidity(
  L: number,
  tickLower: number,
  tickUpper: number,
  tickCurrent: number,
  decimalsB: number
): number {
  const { sqrtP, sqrtPa, sqrtPb } = sqrtPricesFromTicks(tickLower, tickUpper, tickCurrent);
  return rawAmount1FromL(L, sqrtP, sqrtPa, sqrtPb) / Math.pow(10, decimalsB);
}

// --------------------------------------------------------------------------
// Deposit ratio
// --------------------------------------------------------------------------

export interface DepositRatio {
  solRatio: number; // fraction of total USD value, 0..1
  usdcRatio: number; // fraction of total USD value, 0..1
}

/**
 * Value split a CLMM position requires for a given range.
 *
 * Even a symmetric range is NOT 50/50, because sqrt-price space is asymmetric:
 * +/-5% needs roughly 48.8% SOL / 51.2% USDC. Depositing 50/50 into a +/-5%
 * range is what produced 19 consecutive `6017 PriceSlippageCheck` failures.
 */
export function calculateDepositRatio(
  currentPrice: number,
  priceLower: number,
  priceUpper: number
): DepositRatio {
  if (!(currentPrice > 0) || !(priceLower > 0) || !(priceUpper > 0)) {
    throw new Error('calculateDepositRatio: prices must be positive');
  }
  if (priceLower >= priceUpper) {
    throw new Error(
      `calculateDepositRatio: priceLower (${priceLower}) must be below priceUpper (${priceUpper})`
    );
  }

  const sp = Math.sqrt(currentPrice);
  const spa = Math.sqrt(priceLower);
  const spb = Math.sqrt(priceUpper);

  // Out of range: the position is entirely one asset.
  if (currentPrice <= priceLower) return { solRatio: 1, usdcRatio: 0 };
  if (currentPrice >= priceUpper) return { solRatio: 0, usdcRatio: 1 };

  const solValue = (sp * (spb - sp)) / spb;
  const usdcValue = sp - spa;
  const total = solValue + usdcValue;

  return { solRatio: solValue / total, usdcRatio: usdcValue / total };
}
