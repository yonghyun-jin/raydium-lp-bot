// Range selection: which range the next position opens at.
//
// Recording the prediction is NOT done here -- it stays in
// Orchestrator.getPrediction, which owns the prediction id.

import type { PriceMonitor } from './components';
import {
  RangePrediction,
  getRangePrediction,
  buildFallbackPrediction,
  validatePrediction,
} from './prediction';
import type { OrchestratorConfig } from './settings';

/**
 * Range for the next position.
 *
 * Throws when the model cannot produce one, unless `allowFallback` is set.
 * A wrong range is worse than no position: it costs fees and puts capital
 * into a range nobody chose.
 */
export async function selectRange(
  priceMonitor: PriceMonitor,
  poolId: string,
  config: Pick<OrchestratorConfig, 'usePrediction' | 'allowFallback' | 'defaultWidthPct'>
): Promise<RangePrediction> {
  const currentPrice = await priceMonitor.getCurrentPrice(poolId);

  let prediction: RangePrediction;

  if (config.usePrediction) {
    console.log('[Orchestrator] Setting the fixed v0 range...');
    try {
      prediction = await getRangePrediction(currentPrice);
    } catch (error: any) {
      const reason = error?.message ?? String(error);
      if (!config.allowFallback) {
        throw new Error(
          `Prediction unavailable: ${reason}. ` +
            `Refusing to create a position from a guessed range. ` +
            `Set allowFallback to override.`
        );
      }
      console.warn(`[Orchestrator] Prediction failed (${reason}); using fallback range`);
      prediction = buildFallbackPrediction(currentPrice, config.defaultWidthPct);
    }
  } else {
    prediction = buildFallbackPrediction(currentPrice, config.defaultWidthPct);
  }

  const validation = validatePrediction(prediction);
  if (!validation.valid) {
    throw new Error(
      `Prediction failed validation (${validation.errors.join(', ')}). ` +
        `Refusing to create a position.`
    );
  }

  if (prediction.source === 'fallback' && !config.allowFallback) {
    throw new Error('Refusing to create a position from a fallback range');
  }

  console.log(
    `[Orchestrator] Range [${prediction.source}]: ` +
      `$${prediction.lower.toFixed(2)} - $${prediction.upper.toFixed(2)}`
  );
  console.log(
    `[Orchestrator] Deposit ratio: ${(prediction.sol_ratio * 100).toFixed(1)}% SOL / ` +
      `${(prediction.usdc_ratio * 100).toFixed(1)}% USDC`
  );

  return prediction;
}
