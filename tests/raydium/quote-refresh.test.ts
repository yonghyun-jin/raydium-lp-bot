/**
 * A rebuild re-quotes, and re-runs the price guard on what it got back.
 *
 * WHY: `buildSwapTx` is handed to the Jito ladder as its rebuild hook, and it
 * used to re-POST Jupiter's /swap with the FIRST quote. That gave each window a
 * fresh blockhash and a minimum-out fixed minutes earlier. The reasoning was
 * sound as far as it went -- `slippageBps` still bounds the fill, so a stale
 * quote can never execute at a worse price than the guard allowed -- but the
 * failure it produces is not a bad fill, it is no fill at all: once the price
 * has drifted past MAX_SLIPPAGE every later bundle is one the chain would
 * reject, and Jito drops those in simulation without a word.
 *
 * On 2026-10-13 that is what a 90s budget bought. Two attempts, ~30 bundles, all
 * on one quote, tips at 25-87x the 99th percentile of landed tips, not one of
 * them included, and $3,636.90 left sitting in the wallet.
 *
 * These are source assertions rather than behavioural ones because the function
 * is a closure inside a private method whose every exit is an `assertSendAllowed`
 * that must refuse a test process. What they pin is the SHAPE: that the quote and
 * its verdict are reached through one function, and that a rebuild calls it.
 */

import * as fs from 'fs';
import * as path from 'path';

const client = fs.readFileSync(
  path.join(__dirname, '../../src/raydium/client.ts'),
  'utf8'
);

/** The body of jupiterSwap, up to the next method. */
function jupiterSwap(): string {
  const start = client.indexOf('private async jupiterSwap');
  expect(start).toBeGreaterThan(-1);
  const rest = client.slice(start);
  return rest.slice(0, rest.indexOf('\n  private ', 1));
}

describe('a Jito rebuild gets a fresh quote', () => {
  it('quoting and guarding the price happen in ONE function', () => {
    // Two call sites for the quote with the guard at only one of them is the
    // bug this shape exists to prevent -- the second quote would then be the
    // unchecked one.
    const body = jupiterSwap();
    expect(body).toMatch(/const quoteAndGuard = async \(/);
    expect(body).toMatch(/throw new SendBlockedError\(`\[PRICE\] Refusing the swap/);

    const guardCalls = body.match(/checkQuotePrice\(\{/g) ?? [];
    expect(guardCalls.length).toBe(1);
  });

  it('the rebuild hook re-quotes instead of reusing the first quote', () => {
    const body = jupiterSwap();
    const build = body.slice(body.indexOf('const buildSwapTx = async'));

    // The rebuild asks for a new quote...
    expect(build).toMatch(/quote = await quoteAndGuard\(/);
    // ...and the first build does not, so the opening send is not double-quoted.
    expect(build).toMatch(/if \(builds > 0\)/);
  });

  it('the price guard is reached before any send on every quote', () => {
    // quoteAndGuard must not be able to return a quote it has not judged: the
    // refusal has to sit between the fetch and the return.
    const body = jupiterSwap();
    const fn = body.slice(body.indexOf('const quoteAndGuard = async'));
    const scope = fn.slice(0, fn.indexOf('\n    };'));

    const refusal = scope.indexOf('throw new SendBlockedError');
    const ret = scope.lastIndexOf('return quote;');
    expect(refusal).toBeGreaterThan(-1);
    expect(ret).toBeGreaterThan(refusal);
  });
});
