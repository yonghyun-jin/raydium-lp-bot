/**
 * Position sizing — solving for a deposit the pool will actually accept.
 *
 * THE BUG THIS FIXES
 * ------------------
 * `client.ts:996-997` set `otherAmountMax` from what the WALLET HELD:
 *
 *     otherAmountMax = usdcAmount * 1e6 * (1 + slippage)
 *
 * but the amount of USDC a CLMM position needs is fixed by its liquidity and
 * its tick range, not by the wallet. When the two disagree by more than the
 * slippage tolerance, the program rejects the transaction with
 * `6017 PriceSlippageCheck`. Between 2026-09-12 and 2026-09-17 that happened
 * 19 times in a row, every attempt paying a priority fee and a Jito tip.
 *
 * Here we do it the other way round: pick the largest liquidity BOTH balances
 * can fund, then derive the amounts from it. The required USDC is then
 * affordable by construction, so ratio-driven 6017 becomes impossible.
 *
 * ON HEADROOM (no arbitrary numbers)
 * ----------------------------------
 * The only reserve applied is the caller's own `slippage`, which is what
 * `otherAmountMax` already multiplies by. Sizing against
 * `usdcAvailable / (1 + slippage)` makes `otherAmountMax <= usdcAvailable`
 * an identity rather than a hope. Tick rounding needs no separate allowance
 * because sizing runs AFTER the ticks are final. `safetyBuffer` therefore
 * defaults to zero; set it only with a documented reason.
 */

import {
  liquidityFromSol,
  liquidityFromUsdc,
  solForLiquidity,
  usdcForLiquidity,
} from './clmmMath';

export interface SizeDepositInput {
  /** SOL the wallet can commit (already net of any gas reserve). */
  solAvailable: number;
  /** USDC the wallet can commit. */
  usdcAvailable: number;
  /** Optional cap on the position's total USD value. */
  budgetUsd?: number;

  /** FINAL ticks, after tick-array validation. Sizing before this is stale. */
  tickLower: number;
  tickUpper: number;
  tickCurrent: number;

  /** Human SOL price, used only to value the position in USD. */
  price: number;
  decimalsA: number;
  decimalsB: number;

  /** Slippage tolerance for this attempt, e.g. 0.001 for 0.1%. */
  slippage: number;
  /** Extra reserve above the slippage tolerance. Defaults to 0 — see above. */
  safetyBuffer?: number;
}

export interface DepositPlan {
  /** SOL to deposit (the `baseAmount` handed to openPositionFromBase). */
  solAmount: number;
  /** USDC the position requires at the current tick. */
  usdcAmount: number;
  /** Same as usdcAmount; named for the on-chain comparison it feeds. */
  requiredUsdc: number;
  /** What to pass as `otherAmountMax`. Guaranteed <= usdcAvailable. */
  otherAmountMax: number;
  /** Liquidity L for the position. */
  liquidity: number;
  /** Which balance bound the size. */
  limitedBy: 'SOL' | 'USDC' | 'BUDGET';
  /** Total USD value being deposited. */
  valueUsd: number;
}

export class DepositSizingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DepositSizingError';
  }
}

export function sizeDeposit(input: SizeDepositInput): DepositPlan {
  const {
    solAvailable,
    usdcAvailable,
    budgetUsd,
    tickLower,
    tickUpper,
    tickCurrent,
    price,
    decimalsA,
    decimalsB,
    slippage,
    safetyBuffer = 0,
  } = input;

  if (tickLower >= tickUpper) {
    throw new DepositSizingError(`tickLower (${tickLower}) must be below tickUpper (${tickUpper})`);
  }
  if (solAvailable < 0 || usdcAvailable < 0) {
    throw new DepositSizingError('Available balances cannot be negative');
  }
  if (!(price > 0)) {
    throw new DepositSizingError(`price must be positive, got ${price}`);
  }
  if (slippage < 0 || slippage >= 1) {
    throw new DepositSizingError(`slippage must be in [0, 1), got ${slippage}`);
  }

  const headroom = 1 + slippage + safetyBuffer;

  // Largest liquidity each side can fund on its own.
  const lFromSol = liquidityFromSol(solAvailable, tickLower, tickUpper, tickCurrent, decimalsA);
  const lFromUsdc = liquidityFromUsdc(
    usdcAvailable / headroom,
    tickLower,
    tickUpper,
    tickCurrent,
    decimalsB
  );

  let liquidity = Math.min(lFromSol, lFromUsdc);
  let limitedBy: DepositPlan['limitedBy'] = lFromSol <= lFromUsdc ? 'SOL' : 'USDC';

  if (!Number.isFinite(liquidity) || liquidity <= 0) {
    throw new DepositSizingError(
      `No fundable liquidity: ${solAvailable} SOL + ${usdcAvailable} USDC ` +
        `cannot open a position on ticks [${tickLower}, ${tickUpper}] at tick ${tickCurrent}`
    );
  }

  // Apply the caller's USD budget, if any.
  if (budgetUsd !== undefined) {
    if (budgetUsd <= 0) {
      throw new DepositSizingError(`budgetUsd must be positive, got ${budgetUsd}`);
    }
    const valueAtFull =
      solForLiquidity(liquidity, tickLower, tickUpper, tickCurrent, decimalsA) * price +
      usdcForLiquidity(liquidity, tickLower, tickUpper, tickCurrent, decimalsB);

    if (valueAtFull > budgetUsd) {
      // Amounts are linear in L, so a single scaling is exact.
      liquidity *= budgetUsd / valueAtFull;
      limitedBy = 'BUDGET';
    }
  }

  const solAmount = solForLiquidity(liquidity, tickLower, tickUpper, tickCurrent, decimalsA);
  const requiredUsdc = usdcForLiquidity(liquidity, tickLower, tickUpper, tickCurrent, decimalsB);
  const otherAmountMax = requiredUsdc * (1 + slippage);

  // The invariant this module exists to guarantee. If it ever trips, the
  // transaction would fail with 6017 on-chain -- refuse here instead, for free.
  if (otherAmountMax > usdcAvailable + 1e-9) {
    throw new DepositSizingError(
      `Sizing invariant violated: otherAmountMax ${otherAmountMax.toFixed(6)} USDC ` +
        `exceeds available ${usdcAvailable.toFixed(6)} USDC. This would fail on-chain with 6017.`
    );
  }
  if (solAmount > solAvailable + 1e-12) {
    throw new DepositSizingError(
      `Sizing invariant violated: solAmount ${solAmount} exceeds available ${solAvailable}`
    );
  }

  return {
    solAmount,
    usdcAmount: requiredUsdc,
    requiredUsdc,
    otherAmountMax,
    liquidity,
    limitedBy,
    valueUsd: solAmount * price + requiredUsdc,
  };
}
