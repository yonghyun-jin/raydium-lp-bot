/**
 * A range model is judged on WHICH mistake it made, not on one accuracy score.
 *
 * Too narrow and too wide are opposite failures with opposite fixes: a breached
 * band stops earning, a band nobody visits spreads the capital over ground the
 * price never covered. Collapsing them into a single number would hide the one
 * thing the operator has to know in order to change anything.
 *
 * The real figures below are the $1,000 cycle: anchor $116.78, band
 * $112.52-$122.75, closed at $122.78 -- out of range at the top by three cents,
 * which is why that position came back almost entirely USDC.
 */

import { reviewPrediction, within, type Candle } from '../../src/predictions';

const HOUR = 3_600_000;

/** Candles with an explicit high/low so a breach can be placed on one of them. */
function candles(...spec: [number, number, number][]): Candle[] {
  return spec.map(([low, high, close], i) => ({
    t: i * HOUR,
    open: low,
    low,
    high,
    close,
  }));
}

const BAND = { lower: 112.52, upper: 122.75, anchor: 116.78 };

describe('reviewPrediction', () => {
  it('reports the predicted width against the anchor, not against the midpoint', () => {
    const review = reviewPrediction(BAND, []);
    expect(review.predictedWidthPct).toBeCloseTo(8.76, 2);
  });

  it('with no candles, every realised figure is null and there is no verdict', () => {
    const review = reviewPrediction(BAND, []);

    expect(review.realisedLow).toBeNull();
    expect(review.realisedHigh).toBeNull();
    expect(review.coverageRatio).toBeNull();
    expect(review.closesInRangePct).toBeNull();
    expect(review.verdict).toBeNull();
    expect(review.candleCount).toBe(0);
  });

  it('calls a band the price left TOO NARROW, and says which edge', () => {
    const review = reviewPrediction(BAND, candles([116, 118, 117], [120, 122.9, 122.8]));

    expect(review.breachedUpper).toBe(true);
    expect(review.breachedLower).toBe(false);
    expect(review.verdict).toBe('too-narrow');
    expect(review.realisedHigh).toBe(122.9);
  });

  it('places the first breach on the candle that made it', () => {
    const review = reviewPrediction(
      BAND,
      candles([116, 118, 117], [117, 119, 118], [120, 123.4, 123.2])
    );

    expect(review.firstBreachAt).toBe(2 * HOUR);
  });

  it('a breach at the bottom counts too', () => {
    const review = reviewPrediction(BAND, candles([110.1, 117, 112], [113, 118, 117]));

    expect(review.breachedLower).toBe(true);
    expect(review.breachedUpper).toBe(false);
    expect(review.verdict).toBe('too-narrow');
  });

  it('calls a band the price barely used TOO WIDE', () => {
    // 116.0-118.0 is 1.71% of the anchor against a predicted 8.76% -- a fifth
    // of the band was visited.
    const review = reviewPrediction(BAND, candles([116, 118, 117], [116.5, 117.5, 117]));

    expect(review.verdict).toBe('too-wide');
    expect(review.coverageRatio).toBeLessThan(0.5);
  });

  it('calls a band the price filled without leaving WELL SIZED', () => {
    const review = reviewPrediction(BAND, candles([113, 122, 121], [114, 122.5, 122]));

    expect(review.breachedUpper).toBe(false);
    expect(review.breachedLower).toBe(false);
    expect(review.coverageRatio).toBeGreaterThan(0.5);
    expect(review.verdict).toBe('well-sized');
  });

  it('a breach outranks an unused band: the verdict is still too narrow', () => {
    // Barely any of the band used, but the price still got out at the top.
    const review = reviewPrediction(BAND, candles([122.6, 123.0, 122.9]));

    expect(review.coverageRatio).toBeLessThan(0.5);
    expect(review.verdict).toBe('too-narrow');
  });

  it('counts closes inside the band, and says so rather than claiming time in range', () => {
    const review = reviewPrediction(
      BAND,
      candles([116, 118, 117], [120, 123.5, 123.4], [118, 120, 119], [117, 119, 118])
    );

    expect(review.closesInRangePct).toBe(75);
  });
});

describe('within', () => {
  it('keeps candles from the start of the window up to but not including its end', () => {
    const all = candles([1, 2, 1], [1, 2, 1], [1, 2, 1], [1, 2, 1]);

    expect(within(all, HOUR, 3 * HOUR).map((c) => c.t)).toEqual([HOUR, 2 * HOUR]);
  });
});
