/**
 * Fees must be read as accrued growth, never as the position's checkpoint.
 *
 * WHY: `tokenFeesOwed` on a CLMM position account is a CHECKPOINT. The program
 * settles fees into it only when the position is TOUCHED -- increase/decrease
 * liquidity, or collect. A position sitting in range and genuinely earning
 * leaves it at 0 indefinitely, so the bot reported "Fees Earned: $0.00" for
 * every position it had ever opened, and the fee half of P&L was structurally
 * absent.
 *
 * The fixture below is real mainnet state, captured from position
 * 9RXMvuKfSN7QfBk83SsAgyrjLiqoyh6ozkU51Vgy61ot (SOL/USDC, in range, $9.73).
 * Its `tokenFeesOwed` really is 0 while the position really is earning -- the
 * bug and its fix in one set of numbers.
 */

import BN from 'bn.js';
import * as fs from 'fs';
import * as path from 'path';
import { PositionUtils } from '@raydium-io/raydium-sdk-v2';

const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;

// Real mainnet state. Do not "tidy" these numbers -- see the wrapping test.
const pool = {
  tickCurrent: -21934,
  feeGrowthGlobalX64A: new BN('6396099273137841738'),
  feeGrowthGlobalX64B: new BN('939716773963286239'),
};

const position = {
  tickLower: -22448,
  tickUpper: -21326,
  liquidity: new BN('526385595'),
  feeGrowthInsideLastX64A: new BN('340282366920938463461219157243859757596'),
  feeGrowthInsideLastX64B: new BN('340282366920938463463027123354792223390'),
  tokenFeesOwedA: new BN('0'),
  tokenFeesOwedB: new BN('0'),
};

const tickLowerState: any = {
  tick: -22448,
  feeGrowthOutsideX64A: new BN('6396007462120583283'),
  feeGrowthOutsideX64B: new BN('939708280613850251'),
};

const tickUpperState: any = {
  tick: -21326,
  feeGrowthOutsideX64A: new BN('2155450187908453860'),
  feeGrowthOutsideX64B: new BN('347484076975988066'),
};

describe('CLMM fee accrual', () => {
  it('the checkpoint alone reports nothing -- this is the bug', () => {
    // Exactly what the old code did: read tokenFeesOwed and divide.
    const feeA = parseFloat(position.tokenFeesOwedA.toString()) / 10 ** SOL_DECIMALS;
    const feeB = parseFloat(position.tokenFeesOwedB.toString()) / 10 ** USDC_DECIMALS;
    expect(feeA).toBe(0);
    expect(feeB).toBe(0);
    // ...for a position that was in range and earning at the time of capture.
  });

  it('the growth delta reports the fees that were actually accruing', () => {
    const { tokenFeeAmountA, tokenFeeAmountB } = PositionUtils.GetPositionFees(
      pool as any,
      position as any,
      tickLowerState,
      tickUpperState
    );

    // Pinned exactly: the fixture is one consistent snapshot, so the maths is
    // deterministic. Non-zero is the headline -- the checkpoint above said 0.
    expect(tokenFeeAmountA.toString()).toBe('2619');
    expect(tokenFeeAmountB.toString()).toBe('242');

    const feeA = parseFloat(tokenFeeAmountA.toString()) / 10 ** SOL_DECIMALS;
    const feeB = parseFloat(tokenFeeAmountB.toString()) / 10 ** USDC_DECIMALS;
    expect(feeA).toBeGreaterThan(0);
    expect(feeB).toBeGreaterThan(0);

    // Order of magnitude, which is what a decimals mix-up destroys: on a $9.73
    // position these are sub-cent amounts, not whole tokens. Swapping the 10^9
    // and 10^6 divisors puts them out by a factor of 1000.
    expect(feeA).toBeLessThan(0.001);
    expect(feeB).toBeLessThan(0.01);
  });

  it('feeGrowthInside is a WRAPPED value and must never be read at face value', () => {
    // This is why the SDK helper is used rather than hand-rolled maths. Both
    // feeGrowthInside and the position's stored checkpoint are U128 values that
    // have wrapped past zero, so each is astronomically large on its own; only
    // their modular DIFFERENCE is a real quantity. Nothing here crashes or
    // looks wrong -- an implementation that clamps or takes these literally
    // returns a confident, enormous, wrong number.
    const TWO_128 = new BN(2).pow(new BN(128));

    const { feeGrowthInsideX64A } = PositionUtils.getfeeGrowthInside(
      pool as any,
      tickLowerState,
      tickUpperState
    );

    // Both sit just under 2^128 -- wrapped, not genuinely huge.
    for (const v of [feeGrowthInsideX64A, position.feeGrowthInsideLastX64A]) {
      expect(v.lt(TWO_128)).toBe(true);
      expect(v.gt(TWO_128.muln(99).divn(100))).toBe(true);
    }

    // Taken at face value, the fee would come out around 10^18 SOL.
    const literal = feeGrowthInsideX64A
      .mul(position.liquidity)
      .div(new BN(2).pow(new BN(64)));
    expect(literal.gt(new BN('1000000000000000000000000'))).toBe(true);

    // The difference is small, positive, and the number the fee is built from.
    const delta = feeGrowthInsideX64A.sub(position.feeGrowthInsideLastX64A);
    expect(delta.isNeg()).toBe(false);
    expect(delta.toString()).toBe('91811017258455');
  });

  it('client.ts does not read tokenFeesOwed on its own', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/raydium/client.ts'),
      'utf8'
    );
    // The checkpoint may only reach the fee figure THROUGH the SDK helper,
    // which adds it to the accrued growth. A bare read is the regression.
    expect(src).toContain('PositionUtils.GetPositionFees');
    expect(src).not.toMatch(/const\s+feeA\s*=\s*parseFloat\(\s*pos\.tokenFeesOwedA/);
    expect(src).not.toMatch(/const\s+feeB\s*=\s*parseFloat\(\s*pos\.tokenFeesOwedB/);
  });
});

/**
 * The other half of the same defect: once fees CAN be unknown, the operator
 * must be told so. Rendering null as "$0.00" puts the original lie back into
 * the one place the user actually reads, and it is most convincing exactly
 * when it is wrong -- an in-range position showing $0.00 reads as a dead pool
 * worth closing.
 */
describe('reporting unknown fees', () => {
  const { messages } = require('../../src/telegram/messages');

  const status = (feesEarned: number | null) => ({
    inRange: true,
    currentPrice: 111.63,
    rangeLower: 105.96,
    rangeUpper: 118.54,
    feesEarned,
    ageHours: 12,
    nftMint: 'MINT',
  });

  it('says "unknown" rather than a dollar amount when fees could not be read', () => {
    const text = messages.positionStatus(status(null));
    expect(text).toMatch(/Fees Earned: unknown/);
    expect(text).not.toMatch(/Fees Earned: \$/);
  });

  it('still prints a real figure when there is one', () => {
    expect(messages.positionStatus(status(1.23))).toContain('Fees Earned: $1.23');
    // Zero is a legitimate answer and must stay distinguishable from unknown.
    expect(messages.positionStatus(status(0))).toContain('Fees Earned: $0.00');
  });

  it('applies to the out-of-range message too, where a rebalance is decided', () => {
    const rec = {
      strategy: 'NEUTRAL' as const,
      rangeLower: 100,
      rangeUpper: 120,
      confidence: 0.8,
      reason: 'test',
    };
    expect(messages.outOfRange(status(null), rec)).toMatch(/Fees Earned: unknown/);
    expect(messages.outOfRange(status(null), rec)).not.toMatch(/Fees Earned: \$/);
  });
});
