/**
 * "Don't buy expensive" is a different question from "don't slip".
 *
 * An adversarial audit of the swap path returned 16 findings with one shape:
 * every limit in the codebase answers "how much" or "how often", and none
 * answers "at what price". slippageBps bounds the FILL against the QUOTE, so a
 * route 20% below market filled to the lamport is a perfect zero-slippage
 * execution by every measure the bot had.
 *
 * These drive the decision directly. The band is deliberately not one number:
 * two of its three terms are properties of the trade, and only the third is a
 * policy choice — which is the difference between a derived limit and the kind
 * of arbitrary constant that cost this project 19 positions.
 */

import { checkQuotePrice, impliedPriceFromQuote } from '../../src/raydium/quotePrice';
import { config } from '../../src/raydium/config';

const base = {
  poolFeeRate: 0.0004, // the working pool's tier
  slippageRate: 0.003,
  maxImpactRate: 0.01,
  direction: 'SOL_TO_USDC' as const,
};

describe('a fair quote passes', () => {
  it('a quote at the reference is accepted', () => {
    const v = checkQuotePrice({ ...base, impliedPrice: 100, referencePrice: 100 });
    expect(v.acceptable).toBe(true);
  });

  it('a quote inside the band is accepted', () => {
    // 1% worse: fee 0.04 + fill 0.3 + impact 1.0 = 1.34% allowed.
    const v = checkQuotePrice({ ...base, impliedPrice: 99, referencePrice: 100 });
    expect(v.acceptable).toBe(true);
  });

  it('a quote BETTER than the reference is always accepted', () => {
    const v = checkQuotePrice({ ...base, impliedPrice: 140, referencePrice: 100 });
    expect(v.acceptable).toBe(true);
  });
});

describe('a bad quote is refused', () => {
  it('the 20%-below-market route that slippage called perfect', () => {
    const v = checkQuotePrice({ ...base, impliedPrice: 80, referencePrice: 100 });

    expect(v.acceptable).toBe(false);
    expect(v.deviation).toBeCloseTo(-0.2, 6);
    expect(v.reason).toMatch(/20\.000% worse/);
    // The message has to say WHY slippage did not catch it, or the next
    // person reads the refusal as the slippage setting being too tight.
    expect(v.reason).toMatch(/not the quote against the MARKET/);
  });

  it('the reason names each term, so the band can be argued with', () => {
    const v = checkQuotePrice({ ...base, impliedPrice: 80, referencePrice: 100 });
    expect(v.reason).toMatch(/pool fee/);
    expect(v.reason).toMatch(/fill allowance/);
    expect(v.reason).toMatch(/impact budget/);
  });
});

describe('direction decides which way is worse', () => {
  it('selling SOL, a LOW price is the bad one', () => {
    expect(checkQuotePrice({ ...base, direction: 'SOL_TO_USDC', impliedPrice: 80, referencePrice: 100 }).acceptable)
      .toBe(false);
    expect(checkQuotePrice({ ...base, direction: 'SOL_TO_USDC', impliedPrice: 120, referencePrice: 100 }).acceptable)
      .toBe(true);
  });

  it('buying SOL, a HIGH price is the bad one', () => {
    // Getting this backwards would refuse good fills and wave through bad
    // ones — silently, and in the direction that costs money.
    expect(checkQuotePrice({ ...base, direction: 'USDC_TO_SOL', impliedPrice: 120, referencePrice: 100 }).acceptable)
      .toBe(false);
    expect(checkQuotePrice({ ...base, direction: 'USDC_TO_SOL', impliedPrice: 80, referencePrice: 100 }).acceptable)
      .toBe(true);
  });
});

describe('it fails closed', () => {
  it.each([
    ['null', null],
    ['NaN', NaN],
    ['zero', 0],
    ['negative', -100],
  ])('a %s reference price refuses the swap', (_label, referencePrice) => {
    // An unreadable reference is not permission to accept any rate. This gates
    // a spend, and the project rule is that such reads fail closed.
    const v = checkQuotePrice({ ...base, impliedPrice: 100, referencePrice: referencePrice as number | null });
    expect(v.acceptable).toBe(false);
  });

  it('an unusable implied price refuses too', () => {
    expect(checkQuotePrice({ ...base, impliedPrice: NaN, referencePrice: 100 }).acceptable).toBe(false);
    expect(checkQuotePrice({ ...base, impliedPrice: 0, referencePrice: 100 }).acceptable).toBe(false);
  });

  it('a missing pool fee narrows the band rather than widening it', () => {
    // getPoolFeeRate returns null on failure and the caller substitutes 0.
    // That makes the band SMALLER, so an unreadable fee refuses more, never
    // less. Guessing a fee high would be the dangerous direction.
    const withFee = checkQuotePrice({ ...base, impliedPrice: 100, referencePrice: 100 });
    const without = checkQuotePrice({ ...base, poolFeeRate: 0, impliedPrice: 100, referencePrice: 100 });
    expect(without.allowed).toBeLessThan(withFee.allowed);
  });
});

describe('the implied price scales the decimals', () => {
  it('SOL to USDC', () => {
    // 1 SOL (1e9) -> 150 USDC (150e6). Getting the scaling wrong is a 1000x
    // error that makes every quote look catastrophic or free.
    expect(impliedPriceFromQuote('1000000000', '150000000', 'SOL_TO_USDC')).toBeCloseTo(150, 6);
  });

  it('USDC to SOL', () => {
    expect(impliedPriceFromQuote('150000000', '1000000000', 'USDC_TO_SOL')).toBeCloseTo(150, 6);
  });

  it('an unusable quote is null, not a number', () => {
    expect(impliedPriceFromQuote(undefined, '1', 'SOL_TO_USDC')).toBeNull();
    expect(impliedPriceFromQuote('0', '1', 'SOL_TO_USDC')).toBeNull();
    expect(impliedPriceFromQuote('abc', '1', 'SOL_TO_USDC')).toBeNull();
  });
});

describe('the band is mostly derived, and says which part is not', () => {
  it('two terms come from the trade, one is policy', () => {
    const v = checkQuotePrice({ ...base, impliedPrice: 100, referencePrice: 100 });
    expect(v.allowed).toBeCloseTo(0.0004 + 0.003 + 0.01, 9);
  });

  it('a different pool gives a different band', () => {
    // The whole point of not hardcoding it: a 1% pool legitimately costs more
    // to trade in than a 0.04% one.
    const cheap = checkQuotePrice({ ...base, poolFeeRate: 0.0004, impliedPrice: 100, referencePrice: 100 });
    const dear = checkQuotePrice({ ...base, poolFeeRate: 0.01, impliedPrice: 100, referencePrice: 100 });
    expect(dear.allowed).toBeGreaterThan(cheap.allowed);
  });

  it('MAX_PRICE_IMPACT is separate from MAX_SLIPPAGE', () => {
    // They bound different intervals and must not be tuned together. Merging
    // them is how a price guard turns back into a slippage setting.
    expect(config.strategy.MAX_PRICE_IMPACT).not.toBe(config.strategy.MAX_SLIPPAGE);
  });
});

describe('the gate is actually on the send path', () => {
  // The pure function above is thoroughly driven, and that proves nothing
  // about whether anything CALLS it. Neutering the refusal in jupiterSwap --
  // `if (false && !verdict.acceptable)` -- left every test above green, which
  // is the same shape of un-failable guard this repo has hit four times now.
  const fs = require('fs');
  const path = require('path');
  const client = fs
    .readFileSync(path.join(__dirname, '../../src/raydium/client.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const swap = (() => {
    const start = client.search(/private async jupiterSwap\(/);
    expect(start).toBeGreaterThan(-1);
    const rest = client.slice(start);
    const end = rest.slice(1).search(/\n {2}(?:private |public |async |static )?[a-zA-Z_]+[<(]/);
    return end === -1 ? rest : rest.slice(0, end + 1);
  })();

  it('jupiterSwap asks for a verdict', () => {
    expect(swap).toMatch(/const verdict = checkQuotePrice\(/);
  });

  it('an unacceptable verdict throws, with no condition in front of it', () => {
    // Anchored on the exact shape so `false &&` or any other short-circuit
    // fails. Anchored on CODE, because this file is read comment-stripped.
    expect(swap).toMatch(/if \(!verdict\.acceptable\) \{/);
    const at = swap.indexOf('if (!verdict.acceptable) {');
    expect(swap.slice(at, at + 400)).toMatch(/throw new SendBlockedError/);
  });

  it('the refusal comes BEFORE the swap is requested or sent', () => {
    const refuse = swap.indexOf('if (!verdict.acceptable) {');
    const build = swap.indexOf('/swap');
    const send = swap.indexOf('assertSendAllowed');

    expect(refuse).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(refuse);
    expect(send).toBeGreaterThan(refuse);
  });

  it('the reference comes from the caller, not from the router', () => {
    // Checking a quote against a number the same quote supplied would be
    // circular and would pass anything.
    expect(swap).toMatch(/referencePrice: priceGuard\?\.referencePrice/);
    expect(swap).not.toMatch(/referencePrice:[^,\n]*quote\./);
  });

  it('SwapToRatio supplies it on every branch that swaps', () => {
    const ratio = fs
      .readFileSync(path.join(__dirname, '../../src/orchestrator/components/SwapToRatio.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // Both the budgeted branch and the ratio branch swap. A guard on one of
    // them is the half-protection that reads as protection.
    const calls = ratio.match(/this\.(buySol|sellSol)\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const m of ratio.matchAll(/this\.(buySol|sellSol)\([^;]*\);/g)) {
      expect(m[0]).toMatch(/priceGuard/);
    }
  });
});
