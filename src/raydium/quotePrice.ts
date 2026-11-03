/**
 * Is this quote a fair price, or just a quote we could fill exactly?
 *
 * THE GAP THIS CLOSES. `slippageBps` bounds the distance between the QUOTED
 * output and the FILLED output. It says nothing about whether the quote was
 * any good. A route quoting 20% below the market, filled to the lamport, is a
 * perfect zero-slippage execution as far as every other check in this codebase
 * can tell — and an audit of the swap path found that every limit in it
 * answers "how much" or "how often", and none answers "at what price".
 *
 * So this compares the quote's IMPLIED RATE against a reference price the
 * caller already holds, and refuses when the gap is bigger than the trade can
 * honestly justify.
 *
 * WHY THE BAND IS NOT A CONSTANT. This project's standing rule is zero
 * arbitrary numbers in trading logic, and it exists because arbitrary numbers
 * cost 19 positions. Two of the three terms below are properties of the trade
 * itself:
 *
 *   poolFeeRate   the pool's own fee. Read from the pool, per pool. This one
 *                 is not a choice at all -- it is what trading there costs.
 *   slippageRate  the quote-to-fill allowance already sent to the router. The
 *                 fill may legitimately land this far below the quote, so the
 *                 band has to admit it or a good trade is refused for a reason
 *                 that already has its own guard.
 *   maxImpactRate POLICY, and the only judgement here: how much price impact
 *                 the operator is willing to pay. It is not derivable, because
 *                 it is a preference, not a fact -- but naming it as policy is
 *                 what stops it from being smuggled in as a magic 0.003.
 *
 * Note what is deliberately NOT in the band: the router's own
 * `priceImpactPct`. Adding it would let a bad route excuse itself -- "this is
 * 5% off because I said it would be 5% off". The impact shows up as a bad
 * implied rate, and that is exactly what gets measured here.
 */

export interface QuotePriceCheck {
  /** What the route actually offers: output per unit of input, in the reference's units. */
  impliedPrice: number;
  /** Fair price from somewhere that is not the router. Null means unknown. */
  referencePrice: number | null;
  /** The pool's fee, as a rate (0.0004 = 0.04%). */
  poolFeeRate: number;
  /** The quote-to-fill allowance already given to the router. */
  slippageRate: number;
  /** How much price impact is acceptable. The one policy number here. */
  maxImpactRate: number;
  /** For the message: which way the trade runs. */
  direction: 'SOL_TO_USDC' | 'USDC_TO_SOL';
}

export interface QuotePriceVerdict {
  acceptable: boolean;
  /** How far the quote sits from the reference, as a signed rate. Negative is worse for us. */
  deviation: number;
  /** The band the deviation had to fit inside. */
  allowed: number;
  reason: string;
}

/**
 * @returns a verdict. The caller throws; this decides.
 *
 * FAILS CLOSED on a missing reference price. An unreadable reference is not
 * permission to accept any rate -- it is the one case where we know nothing,
 * and this gates a spend.
 */
export function checkQuotePrice(input: QuotePriceCheck): QuotePriceVerdict {
  const allowed = input.poolFeeRate + input.slippageRate + input.maxImpactRate;

  if (input.referencePrice === null || !Number.isFinite(input.referencePrice) || input.referencePrice <= 0) {
    return {
      acceptable: false,
      deviation: NaN,
      allowed,
      reason:
        'no reference price, so the quote cannot be checked against anything. ' +
        'Refusing: an unreadable price is not permission to accept any rate.',
    };
  }

  if (!Number.isFinite(input.impliedPrice) || input.impliedPrice <= 0) {
    return {
      acceptable: false,
      deviation: NaN,
      allowed,
      reason: `the quote implies a price of ${input.impliedPrice}, which is not a price.`,
    };
  }

  // WHICH DIRECTION IS "WORSE" DEPENDS ON THE TRADE, and getting it backwards
  // would refuse good fills while waving through bad ones.
  //
  // Both sides are expressed as USDC per SOL. Selling SOL, we want a HIGH
  // price and a low one hurts. Buying SOL, we want a LOW price and a high one
  // hurts. The deviation below is signed so that NEGATIVE always means worse
  // for us, whichever way the trade runs.
  const raw = (input.impliedPrice - input.referencePrice) / input.referencePrice;
  const deviation = input.direction === 'SOL_TO_USDC' ? raw : -raw;

  if (deviation >= -allowed) {
    return {
      acceptable: true,
      deviation,
      allowed,
      reason: 'within the band',
    };
  }

  const pct = (n: number) => `${(n * 100).toFixed(3)}%`;

  return {
    acceptable: false,
    deviation,
    allowed,
    reason:
      `the route is ${pct(-deviation)} worse than the reference price, and the most ` +
      `this trade can justify is ${pct(allowed)} ` +
      `(pool fee ${pct(input.poolFeeRate)} + fill allowance ${pct(input.slippageRate)} + ` +
      `impact budget ${pct(input.maxImpactRate)}). ` +
      `Refusing: slippage tolerance bounds the fill against the QUOTE, not the quote against the MARKET.`,
  };
}

/**
 * The quote's implied price, in USDC per SOL, or null if it cannot be computed.
 *
 * Both amounts are base units and the decimals differ (SOL 9, USDC 6), so the
 * scaling is not optional -- getting it wrong is a 1000x error that would make
 * every quote look catastrophic or free.
 */
export function impliedPriceFromQuote(
  inAmount: string | number | undefined,
  outAmount: string | number | undefined,
  direction: 'SOL_TO_USDC' | 'USDC_TO_SOL'
): number | null {
  const toNumber = (v: string | number | undefined) =>
    v === undefined || v === null ? NaN : typeof v === 'string' ? Number(v) : v;

  const inRaw = toNumber(inAmount);
  const outRaw = toNumber(outAmount);
  if (!Number.isFinite(inRaw) || !Number.isFinite(outRaw) || inRaw <= 0 || outRaw <= 0) {
    return null;
  }

  const SOL = 1e9;
  const USDC = 1e6;

  if (direction === 'SOL_TO_USDC') {
    return outRaw / USDC / (inRaw / SOL);
  }
  return inRaw / USDC / (outRaw / SOL);
}
