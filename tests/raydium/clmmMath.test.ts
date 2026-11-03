/**
 * CLMM math tests.
 *
 * These pin the arithmetic that decides how money is split between SOL and
 * USDC. Getting it wrong is not a rounding error — a 2.5% ratio mistake made
 * every position creation fail on-chain for five days straight.
 */

import {
  alignTicks,
  calculateDepositRatio,
  liquidityFromSol,
  liquidityFromUsdc,
  solForLiquidity,
  usdcForLiquidity,
  priceToTick,
  tickToPrice,
  floorTick,
  ceilTick,
  tickArrayStartIndex,
} from '../../src/raydium/clmmMath';

// The live SOL/USDC CLMM pool: 3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv
const DEC_A = 9; // SOL
const DEC_B = 6; // USDC
const SPACING = 1;
const PRICE = 99.74; // SOL/USDC at the time of the 2026-09-17 failure

describe('price <-> tick', () => {
  it('round-trips a price through tick space', () => {
    const tick = priceToTick(PRICE, DEC_A, DEC_B);
    expect(tickToPrice(tick, DEC_A, DEC_B)).toBeCloseTo(PRICE, 6);
  });

  it('agrees with the on-chain pool tick', () => {
    // Read live from pool 3ucNos4...: tickCurrent = -23015, tickSpacing = 1.
    // Assert the round-trip rather than a 2dp price, which would land a tick off.
    const price = tickToPrice(-23015, DEC_A, DEC_B);
    expect(price).toBeCloseTo(100.12, 2);
    expect(floorTick(priceToTick(price, DEC_A, DEC_B), SPACING)).toBe(-23015);
  });

  it('floors negative ticks downward, not toward zero', () => {
    // SOL/USDC ticks are around -23000. Truncation would round the wrong way
    // and silently shift the range.
    expect(floorTick(-23015.4, 10)).toBe(-23020);
    expect(ceilTick(-23015.4, 10)).toBe(-23010);
  });

  it('computes tick array start indices for negative ticks', () => {
    // 60 ticks per array at spacing 1; -23015 sits in the array starting -23040.
    expect(tickArrayStartIndex(-23015, 1)).toBe(-23040);
    expect(tickArrayStartIndex(-23040, 1)).toBe(-23040);
  });

  it('rejects a non-positive price', () => {
    expect(() => priceToTick(0, DEC_A, DEC_B)).toThrow(/positive/);
  });
});

describe('calculateDepositRatio', () => {
  it('a symmetric +/-5% range is NOT 50/50', () => {
    const { solRatio, usdcRatio } = calculateDepositRatio(PRICE, PRICE * 0.95, PRICE * 1.05);

    expect(solRatio * 100).toBeCloseTo(48.77, 1);
    expect(usdcRatio * 100).toBeCloseTo(51.23, 1);
    expect(solRatio + usdcRatio).toBeCloseTo(1, 12);
  });

  it('reproduces the ratio the ML model asks for', () => {
    // an asymmetric range: -6.21% / +2.81% -> SOL 30.4% / USDC 69.6%
    const { solRatio } = calculateDepositRatio(PRICE, PRICE * (1 - 0.0621), PRICE * (1 + 0.0281));
    expect(solRatio * 100).toBeCloseTo(30.4, 0);
  });

  it('is independent of the absolute price for the same percentage range', () => {
    const a = calculateDepositRatio(100, 95, 105);
    const b = calculateDepositRatio(250, 237.5, 262.5);
    expect(a.solRatio).toBeCloseTo(b.solRatio, 10);
  });

  it('needs more USDC as the range gets WIDER', () => {
    // Ported from tests/lp/lp.test.ts before src/lp was deleted. It was the one
    // case the dead copy covered and this one did not -- width monotonicity, as
    // distinct from the skew case below. See docs/v1/scopes/D3-deposit-sizing.md:
    // deleting a module and its tests together silently drops coverage of code
    // that survives.
    const narrow = calculateDepositRatio(100, 98, 102);   // +/-2%
    const wide = calculateDepositRatio(100, 90, 110);     // +/-10%
    expect(wide.usdcRatio).toBeGreaterThan(narrow.usdcRatio);
  });

  it('needs more USDC when the range skews downward', () => {
    const down = calculateDepositRatio(PRICE, PRICE * 0.9, PRICE * 1.02);
    const up = calculateDepositRatio(PRICE, PRICE * 0.98, PRICE * 1.1);
    expect(down.usdcRatio).toBeGreaterThan(up.usdcRatio);
  });

  it('is all SOL below the range and all USDC above it', () => {
    expect(calculateDepositRatio(90, 95, 105).solRatio).toBe(1);
    expect(calculateDepositRatio(110, 95, 105).usdcRatio).toBe(1);
  });

  it('rejects an inverted range', () => {
    expect(() => calculateDepositRatio(100, 105, 95)).toThrow(/must be below/);
  });
});

describe('liquidity <-> amounts', () => {
  const t = alignTicks(PRICE * 0.95, PRICE * 1.05, PRICE, DEC_A, DEC_B, SPACING);

  it('round-trips SOL through liquidity', () => {
    const L = liquidityFromSol(1.5, t.tickLower, t.tickUpper, t.tickCurrent, DEC_A);
    expect(solForLiquidity(L, t.tickLower, t.tickUpper, t.tickCurrent, DEC_A)).toBeCloseTo(1.5, 9);
  });

  it('round-trips USDC through liquidity', () => {
    const L = liquidityFromUsdc(250, t.tickLower, t.tickUpper, t.tickCurrent, DEC_B);
    expect(usdcForLiquidity(L, t.tickLower, t.tickUpper, t.tickCurrent, DEC_B)).toBeCloseTo(250, 6);
  });

  it('tick-level amounts agree with the closed-form ratio', () => {
    // If these two ever disagree, one of them is wrong and money moves on the
    // wrong one. This is the cross-check that the four old copies never had.
    const L = liquidityFromSol(1, t.tickLower, t.tickUpper, t.tickCurrent, DEC_A);
    const sol = solForLiquidity(L, t.tickLower, t.tickUpper, t.tickCurrent, DEC_A);
    const usdc = usdcForLiquidity(L, t.tickLower, t.tickUpper, t.tickCurrent, DEC_B);

    const fromAmounts = (sol * PRICE) / (sol * PRICE + usdc);
    const closedForm = calculateDepositRatio(
      tickToPrice(t.tickCurrent, DEC_A, DEC_B),
      tickToPrice(t.tickLower, DEC_A, DEC_B),
      tickToPrice(t.tickUpper, DEC_A, DEC_B)
    ).solRatio;

    expect(fromAmounts).toBeCloseTo(closedForm, 3);
  });

  it('carries no spurious decimal factor (the legacy 10^1.5 bug)', () => {
    // client.ts:987 divided by decimalAdjust = 10^((decB-decA)/2), inflating
    // liquidity by 10^1.5 ~= 31.6x. Reproduce the old formula and show the gap.
    const sqrtPc = Math.pow(1.0001, t.tickCurrent / 2);
    const sqrtPb = Math.pow(1.0001, t.tickUpper / 2);
    const decimalAdjust = Math.pow(10, (DEC_B - DEC_A) / 2);

    const legacyL = ((4.9997 * 1e9) * sqrtPc * sqrtPb) / (sqrtPb - sqrtPc) / decimalAdjust;
    const correctL = liquidityFromSol(4.9997, t.tickLower, t.tickUpper, t.tickCurrent, DEC_A);

    expect(legacyL / correctL).toBeCloseTo(Math.pow(10, 1.5), 3);
  });
});

describe('the 2026-09-17 on-chain failure', () => {
  it('explains error 6017: required USDC exceeded what the wallet allowed', () => {
    // Reconstructed from the failing transaction 5DbF4pRHRW... :
    //   Left  (otherAmountMax) = 499163590 = floor(498.664926 * 1e6 * 1.001)
    //   Right (required USDC)  = 535074377
    const walletUsdc = 498.664926;
    const otherAmountMax = walletUsdc * 1.001;

    // client.ts floored BOTH bounds, which narrows the top of the range and
    // raises the USDC requirement.
    const t = alignTicks(PRICE * 0.95, PRICE * 1.05, PRICE, DEC_A, DEC_B, SPACING, 'floor');
    const L = liquidityFromSol(4.9997, t.tickLower, t.tickUpper, t.tickCurrent, DEC_A);
    const requiredUsdc = usdcForLiquidity(L, t.tickLower, t.tickUpper, t.tickCurrent, DEC_B);

    // The position needed materially more USDC than it was allowed to spend...
    expect(requiredUsdc).toBeGreaterThan(otherAmountMax);

    // ...by more than the widest rung of the retry ladder (2%), which is why
    // all five slippage steps failed and why 19 attempts in a row failed.
    const shortfall = requiredUsdc / otherAmountMax - 1;
    expect(shortfall).toBeGreaterThan(0.02);
  });

  it('a 50/50 split cannot satisfy a +/-5% range within the 2% ladder', () => {
    const { usdcRatio } = calculateDepositRatio(PRICE, PRICE * 0.95, PRICE * 1.05);
    // Holding 50/50 while the position wants 51.23% USDC is a 2.5% shortfall
    // on the USDC side -- already past the widest slippage step.
    const shortfall = usdcRatio / 0.5 - 1;
    expect(shortfall).toBeGreaterThan(0.02);
  });
});
