/**
 * What the model said, against what the price did.
 *
 * Pure arithmetic over a predicted band and a run of candles. No database, no
 * HTTP, no dependencies -- the same shape as `src/pnl/`, and for the same
 * reason: the dashboard renders it, the root suite tests it, and neither can
 * develop its own opinion about whether a prediction was any good.
 *
 * The question it answers is the one a range model lives or dies by: was the
 * band too NARROW (the price left it and the position stopped earning) or too
 * WIDE (the capital was spread over ground the price never covered)? Both are
 * costly and they are opposite mistakes, so a single "accuracy" number would
 * hide which one was made.
 */

/** One candle of the underlying, in USD. `t` is the OPEN time, epoch ms. */
export interface Candle {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PredictedBand {
  lower: number;
  upper: number;
  /** The live price the band was anchored on, not a stale close. */
  anchor: number;
}

export type Verdict = 'too-narrow' | 'too-wide' | 'well-sized';

export interface PredictionReview {
  /** Band width as a percentage of the anchor price. */
  predictedWidthPct: number;

  /** Extremes the price actually reached inside the window. Null with no candles. */
  realisedLow: number | null;
  realisedHigh: number | null;
  realisedWidthPct: number | null;

  /**
   * Realised width over predicted width. 1.0 means the price used exactly the
   * ground the band covered; 0.3 means two thirds of the band was never
   * visited. This is the number to read -- the verdict below is only a label
   * put on it.
   */
  coverageRatio: number | null;

  /** Did the price trade above the upper bound, or below the lower one? */
  breachedUpper: boolean;
  breachedLower: boolean;
  /** Open time of the first candle that left the band, epoch ms. */
  firstBreachAt: number | null;

  /**
   * Share of candles that CLOSED inside the band.
   *
   * Not "time in range": a candle that pokes out and comes back was out of
   * range for part of its hour and this cannot see that. True time in range
   * needs the 30s loop to record it (scope C2). Named for what it measures.
   */
  closesInRangePct: number | null;

  verdict: Verdict | null;
  candleCount: number;
}

/**
 * Below this share of the band actually used, the band was wider than the move
 * that happened.
 *
 * A judgement, not a law: half the band unvisited is the point at which the
 * capital spread is doing visible harm. The ratio is reported alongside so the
 * reader can disagree with the line without recomputing anything.
 */
export const TOO_WIDE_BELOW = 0.5;

export function reviewPrediction(band: PredictedBand, candles: readonly Candle[]): PredictionReview {
  const predictedWidthPct = ((band.upper - band.lower) / band.anchor) * 100;

  // No candles is not a verdict of any kind. Every realised figure stays null
  // rather than defaulting to a number that would read as a finding.
  if (candles.length === 0) {
    return {
      predictedWidthPct,
      realisedLow: null,
      realisedHigh: null,
      realisedWidthPct: null,
      coverageRatio: null,
      breachedUpper: false,
      breachedLower: false,
      firstBreachAt: null,
      closesInRangePct: null,
      verdict: null,
      candleCount: 0,
    };
  }

  const realisedLow = Math.min(...candles.map((c) => c.low));
  const realisedHigh = Math.max(...candles.map((c) => c.high));
  const realisedWidthPct = ((realisedHigh - realisedLow) / band.anchor) * 100;

  const breachedUpper = realisedHigh > band.upper;
  const breachedLower = realisedLow < band.lower;

  const firstBreach = candles.find((c) => c.high > band.upper || c.low < band.lower);
  const insideCloses = candles.filter((c) => c.close >= band.lower && c.close <= band.upper);

  return {
    predictedWidthPct,
    realisedLow,
    realisedHigh,
    realisedWidthPct,
    coverageRatio: realisedWidthPct / predictedWidthPct,
    breachedUpper,
    breachedLower,
    firstBreachAt: firstBreach ? firstBreach.t : null,
    closesInRangePct: (insideCloses.length / candles.length) * 100,
    // A breach settles it: the band was too narrow, however little of it went
    // unused on the other side. Only a band the price never left can be judged
    // on how much of it was wasted.
    verdict: breachedUpper || breachedLower
      ? 'too-narrow'
      : realisedWidthPct / predictedWidthPct < TOO_WIDE_BELOW
        ? 'too-wide'
        : 'well-sized',
    candleCount: candles.length,
  };
}

/** Candles that fall inside a window, `to` exclusive. Both epoch ms. */
export function within(candles: readonly Candle[], from: number, to: number): Candle[] {
  return candles.filter((c) => c.t >= from && c.t < to);
}
