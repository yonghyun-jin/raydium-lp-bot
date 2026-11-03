/**
 * The regression that matters.
 *
 * Between 2026-09-12 and 2026-09-17 the bot attempted 19 mainnet LP positions
 * and all 19 failed with `6017 PriceSlippageCheck`. The last one, tx
 * 5DbF4pRHRW... at 2026-09-17T07:06:21Z, logged:
 *
 *     Left:  499163590      (otherAmountMax = wallet USDC 498.664926 x 1.001)
 *     Right: 535074377      (USDC the position actually needed)
 *
 * These tests replay that exact wallet state through the fake, once with the
 * old sizing and once with the current sizing, and assert the failure is gone.
 */

import { FakeLpClient } from '../fakes/FakeLpClient';
import { CreatePosition } from '../../src/orchestrator/components/CreatePosition';

// Wallet immediately before the final failed attempt.
const SOL = 4.9997;
const USDC = 498.664926;
const PRICE = 99.74;

// The range the bot used: prediction.ts's hardcoded +/-5% fallback.
const FALLBACK_LOWER = PRICE * 0.95;
const FALLBACK_UPPER = PRICE * 1.05;

// What the ML model actually predicted that day.
const ML_LOWER = PRICE * (1 - 0.0621);
const ML_UPPER = PRICE * (1 + 0.0281);

function client(legacySizing: boolean) {
  return new FakeLpClient({ sol: SOL, usdc: USDC, price: PRICE, legacySizing });
}

describe('error 6017', () => {
  it('the old sizing reproduces the on-chain failure', () => {
    const fake = client(true);

    return expect(
      fake.createPosition('POOL', SOL, USDC, FALLBACK_LOWER, FALLBACK_UPPER)
    ).rejects.toThrow(/\{"Custom":6017\}/);
  });

  it('the old sizing fails by more than the widest slippage step', async () => {
    const fake = client(true);
    let message = '';
    try {
      await fake.createPosition('POOL', SOL, USDC, FALLBACK_LOWER, FALLBACK_UPPER);
    } catch (e) {
      message = (e as Error).message;
    }

    const m = message.match(/Left: (\d+) Right: (\d+)/);
    expect(m).not.toBeNull();
    const left = Number(m![1]);
    const right = Number(m![2]);

    // The shape of the real log: needed more than allowed.
    expect(right).toBeGreaterThan(left);
    // And by more than 2%, the top rung of slippageSteps in client.ts:829 --
    // which is why retrying five times could never have worked.
    expect(right / left - 1).toBeGreaterThan(0.02);
  });

  it('the current sizing succeeds on the same inputs', async () => {
    const fake = client(false);

    const result = await fake.createPosition('POOL', SOL, USDC, FALLBACK_LOWER, FALLBACK_UPPER);

    expect(result.nftMint).toBeTruthy();
    const pos = await fake.getPositionDetails(result.nftMint);
    expect(pos?.inRange).toBe(true);
  });

  it('the current sizing also handles the ML range, which the old one could not', async () => {
    // The ML range needs ~70% USDC. Under the old sizing a 50/50 wallet was
    // ~39% short -- an order of magnitude past the retry ladder.
    await expect(
      client(true).createPosition('POOL', SOL, USDC, ML_LOWER, ML_UPPER)
    ).rejects.toThrow(/6017/);

    const fake = client(false);
    const result = await fake.createPosition('POOL', SOL, USDC, ML_LOWER, ML_UPPER);
    expect(result.nftMint).toBeTruthy();
  });
});

describe('CreatePosition component', () => {
  it('passes the range through to the client unmodified', async () => {
    const fake = client(false);
    const component = new CreatePosition(fake);

    await component.executeWithPrices('POOL', 0.03, 7, ML_LOWER, ML_UPPER);

    const [poolId, sol, usdc, lower, upper] = fake.argsOf('createPosition')[0];
    expect(poolId).toBe('POOL');
    expect(sol).toBe(0.03);
    expect(usdc).toBe(7);
    // Guards the arity bug found in scripts/test-lp-flow.ts:181, where a
    // fraction (0.01) was passed as priceLower and priceUpper was omitted.
    expect(lower).toBe(ML_LOWER);
    expect(upper).toBe(ML_UPPER);
  });
});
