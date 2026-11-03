/**
 * Prediction review.
 *
 * Pure arithmetic comparing what the model said to what the price did. Same
 * contract as `src/pnl/`: no database, no HTTP, no dependencies.
 */

export { reviewPrediction, within, TOO_WIDE_BELOW } from './review';
export type { Candle, PredictedBand, PredictionReview, Verdict } from './review';
