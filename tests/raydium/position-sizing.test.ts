/**
 * Deposit sizing tests.
 *
 * The first test in "the 19 failures" block is the one that matters: it replays
 * the exact wallet state and range that failed on mainnet 19 times and asserts
 * the solver now produces something the pool would accept.
 */

import { sizeDeposit, DepositSizingError } from '../../src/raydium/position-sizing';
import { alignTicks } from '../../src/raydium/clmmMath';

const DEC_A = 9;
const DEC_B = 6;
const SPACING = 1;
const PRICE = 99.74;

function ticksFor(lowerPct: number, upperPct: number, price = PRICE, mode: 'contain' | 'floor' = 'contain') {
  return alignTicks(price * (1 + lowerPct), price * (1 + upperPct), price, DEC_A, DEC_B, SPACING, mode);
}

const base = {
  price: PRICE,
  decimalsA: DEC_A,
  decimalsB: DEC_B,
  slippage: 0.001,
};

describe('the 19 mainnet failures', () => {
  // Wallet at 2026-09-17T07:06:21Z, immediately before tx 5DbF4pRHRW...
  const SOL_AVAILABLE = 4.9997;
  const USDC_AVAILABLE = 498.664926;

  it('REGRESSION: sizes a deposit the pool will accept, where the old code did not', () => {
    const t = ticksFor(-0.05, 0.05, PRICE, 'floor');
    const plan = sizeDeposit({
      ...base,
      solAvailable: SOL_AVAILABLE,
      usdcAvailable: USDC_AVAILABLE,
      tickLower: t.tickLower,
      tickUpper: t.tickUpper,
      tickCurrent: t.tickCurrent,
    });

    // The invariant the old code violated on every single attempt.
    expect(plan.requiredUsdc).toBeLessThanOrEqual(plan.otherAmountMax);
    expect(plan.otherAmountMax).toBeLessThanOrEqual(USDC_AVAILABLE);

    // USDC was the binding side, so the SOL leg had to shrink. The old code
    // deposited all 4.9997 SOL and demanded 535.07 USDC it did not have.
    expect(plan.limitedBy).toBe('USDC');
    expect(plan.solAmount).toBeLessThan(SOL_AVAILABLE);
  });

  it('a 50/50 wallet against a +/-5% range is USDC-bound, not SOL-bound', () => {
    const t = ticksFor(-0.05, 0.05);
    const plan = sizeDeposit({
      ...base,
      solAvailable: 5.0,
      usdcAvailable: 5.0 * PRICE, // exactly 50/50 by value
      tickLower: t.tickLower,
      tickUpper: t.tickUpper,
      tickCurrent: t.tickCurrent,
    });
    // The range wants 51.2% USDC, so holding 50% makes USDC the constraint.
    expect(plan.limitedBy).toBe('USDC');
  });

  it('the ML range is far more USDC-hungry than 50/50', () => {
    const t = ticksFor(-0.0621, 0.0281); // an asymmetric range
    const plan = sizeDeposit({
      ...base,
      solAvailable: 5.0,
      usdcAvailable: 5.0 * PRICE,
      tickLower: t.tickLower,
      tickUpper: t.tickUpper,
      tickCurrent: t.tickCurrent,
    });

    const solShare = (plan.solAmount * PRICE) / plan.valueUsd;
    expect(solShare * 100).toBeCloseTo(30.4, 0);
    expect(plan.limitedBy).toBe('USDC');
  });
});

describe('budget', () => {
  it('a $10 request deposits $10, not the whole wallet', () => {
    const t = ticksFor(-0.0621, 0.0281);
    const plan = sizeDeposit({
      ...base,
      solAvailable: 5.05,
      usdcAvailable: 498.66,
      budgetUsd: 10,
      tickLower: t.tickLower,
      tickUpper: t.tickUpper,
      tickCurrent: t.tickCurrent,
    });

    expect(plan.valueUsd).toBeCloseTo(10, 6);
    expect(plan.limitedBy).toBe('BUDGET');
    // ...and it still splits by the range's true ratio.
    expect((plan.solAmount * PRICE) / plan.valueUsd * 100).toBeCloseTo(30.4, 0);
  });

  it('a budget larger than the wallet falls back to the wallet', () => {
    const t = ticksFor(-0.05, 0.05);
    const plan = sizeDeposit({
      ...base,
      solAvailable: 0.05,
      usdcAvailable: 5,
      budgetUsd: 1_000_000,
      tickLower: t.tickLower,
      tickUpper: t.tickUpper,
      tickCurrent: t.tickCurrent,
    });
    expect(plan.limitedBy).not.toBe('BUDGET');
    expect(plan.valueUsd).toBeLessThan(15);
  });

  it('rejects a non-positive budget', () => {
    const t = ticksFor(-0.05, 0.05);
    expect(() =>
      sizeDeposit({
        ...base,
        solAvailable: 1,
        usdcAvailable: 100,
        budgetUsd: 0,
        tickLower: t.tickLower,
        tickUpper: t.tickUpper,
        tickCurrent: t.tickCurrent,
      })
    ).toThrow(DepositSizingError);
  });
});

describe('invariant holds across the whole range space', () => {
  it('never requires more USDC than otherAmountMax allows', () => {
    const lowers = [-0.20, -0.15, -0.10, -0.0621, -0.05, -0.03, -0.01, -0.002];
    const uppers = [0.002, 0.01, 0.03, 0.05, 0.0281, 0.10, 0.15, 0.20];
    const wallets: Array<[number, number]> = [
      [5.05, 498.66], // the real wallet
      [0.05, 5],      // tiny, SOL-heavy
      [10, 1],        // SOL-heavy
      [0.01, 5000],   // USDC-heavy
      [1, 100],       // balanced
    ];
    const slippages = [0.001, 0.003, 0.005, 0.01, 0.02]; // client.ts:829 ladder

    let checked = 0;
    for (const lo of lowers) {
      for (const up of uppers) {
        const t = ticksFor(lo, up);
        for (const [sol, usdc] of wallets) {
          for (const slippage of slippages) {
            const plan = sizeDeposit({
              ...base,
              slippage,
              solAvailable: sol,
              usdcAvailable: usdc,
              tickLower: t.tickLower,
              tickUpper: t.tickUpper,
              tickCurrent: t.tickCurrent,
            });
            expect(plan.requiredUsdc).toBeLessThanOrEqual(plan.otherAmountMax + 1e-9);
            expect(plan.otherAmountMax).toBeLessThanOrEqual(usdc + 1e-9);
            expect(plan.solAmount).toBeLessThanOrEqual(sol + 1e-12);
            expect(plan.liquidity).toBeGreaterThan(0);
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(lowers.length * uppers.length * wallets.length * slippages.length);
  });

  it('down-skewed ranges are USDC-bound, up-skewed ranges are SOL-bound', () => {
    const balanced = { solAvailable: 5, usdcAvailable: 5 * PRICE };
    const down = ticksFor(-0.15, 0.01);
    const up = ticksFor(-0.01, 0.15);

    expect(
      sizeDeposit({ ...base, ...balanced, tickLower: down.tickLower, tickUpper: down.tickUpper, tickCurrent: down.tickCurrent }).limitedBy
    ).toBe('USDC');
    expect(
      sizeDeposit({ ...base, ...balanced, tickLower: up.tickLower, tickUpper: up.tickUpper, tickCurrent: up.tickCurrent }).limitedBy
    ).toBe('SOL');
  });
});

describe('out of range', () => {
  it('below the range the position is all SOL', () => {
    const t = alignTicks(PRICE * 1.05, PRICE * 1.15, PRICE, DEC_A, DEC_B, SPACING);
    const plan = sizeDeposit({
      ...base,
      solAvailable: 1,
      usdcAvailable: 500,
      tickLower: t.tickLower,
      tickUpper: t.tickUpper,
      tickCurrent: t.tickCurrent,
    });
    expect(plan.requiredUsdc).toBe(0);
    expect(plan.solAmount).toBeCloseTo(1, 9);
    expect(plan.limitedBy).toBe('SOL');
  });

  it('above the range the position is all USDC', () => {
    const t = alignTicks(PRICE * 0.85, PRICE * 0.95, PRICE, DEC_A, DEC_B, SPACING);
    const plan = sizeDeposit({
      ...base,
      solAvailable: 1,
      usdcAvailable: 500,
      tickLower: t.tickLower,
      tickUpper: t.tickUpper,
      tickCurrent: t.tickCurrent,
    });
    expect(plan.solAmount).toBe(0);
    expect(plan.requiredUsdc).toBeGreaterThan(0);
    expect(plan.limitedBy).toBe('USDC');
  });
});

describe('input validation', () => {
  const t = ticksFor(-0.05, 0.05);
  const ok = { ...base, solAvailable: 1, usdcAvailable: 100, tickLower: t.tickLower, tickUpper: t.tickUpper, tickCurrent: t.tickCurrent };

  it('rejects an inverted tick range', () => {
    expect(() => sizeDeposit({ ...ok, tickLower: t.tickUpper, tickUpper: t.tickLower })).toThrow(/must be below/);
  });

  it('rejects an empty wallet', () => {
    expect(() => sizeDeposit({ ...ok, solAvailable: 0, usdcAvailable: 0 })).toThrow(/No fundable liquidity/);
  });

  it('rejects a negative balance', () => {
    expect(() => sizeDeposit({ ...ok, usdcAvailable: -1 })).toThrow(/cannot be negative/);
  });

  it('rejects nonsense slippage', () => {
    expect(() => sizeDeposit({ ...ok, slippage: 1.5 })).toThrow(/slippage/);
  });
});
