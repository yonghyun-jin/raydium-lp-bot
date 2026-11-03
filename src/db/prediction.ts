/**
 * Prediction Service (Prisma)
 *
 * What the model said, and when — so a range can be scored against what
 * actually happened to it.
 *
 * WHY THIS DID NOT EXIST. The `predictions` table has been in the schema since
 * the v1 migration and had zero writers of any kind, because there was no
 * service here for `src/recording/` to wrap. So every range the bot ever
 * produced is gone, and "were the predictions any good?" is unanswerable from
 * production data. The one that opened the live $993 position is known only
 * from a Railway log line that will age out.
 */

import { prisma } from './index';
import type { Prediction } from '@prisma/client';

export interface CreatePredictionInput {
  poolId: string;
  /**
   * 'ml' | 'fallback'. Stored so a fallback can never be mistaken for a model
   * output after the fact, which is the same reason the runtime tags it.
   */
  source: string;
  /** The price the bounds were anchored on — the live pool price, not a stale close. */
  anchorPrice: number;
  priceLower: number;
  priceUpper: number;
  widthPct: number;
  solRatio: number;
  /** The volatility features the K-NN matched on. */
  features?: Record<string, number>;
  /** Its neighbours' HIGH/LOW medians and stds, and the average distance. */
  neighborStats?: Record<string, number>;
  /**
   * The position this prediction produced, if one followed.
   *
   * Null when a prediction was made and no position came of it — which is
   * itself worth keeping: a model that is right about ranges nobody acts on
   * looks identical in the data to one nobody consulted.
   */
  positionId?: string;
}

export async function createPrediction(input: CreatePredictionInput): Promise<Prediction> {
  return prisma.prediction.create({
    data: {
      poolId: input.poolId,
      source: input.source,
      anchorPrice: input.anchorPrice,
      priceLower: input.priceLower,
      priceUpper: input.priceUpper,
      widthPct: input.widthPct,
      solRatio: input.solRatio,
      // `as never` because Prisma types Json as a union that does not accept a
      // plain Record without a cast. Undefined is stored as NULL, which is
      // right: a fallback has no features, and an empty object would claim it
      // matched on nothing rather than that it never matched.
      features: (input.features ?? undefined) as never,
      neighborStats: (input.neighborStats ?? undefined) as never,
      positionId: input.positionId,
    },
  });
}

/**
 * Attach a prediction to the position it produced.
 *
 * Separate from the insert because the prediction is made BEFORE the position
 * exists — the same ordering that forces `operation_id` to be minted before
 * the funding swap. Recording the prediction only after a successful create
 * would lose every prediction that was acted on and failed, which is exactly
 * the set worth studying.
 */
export async function linkPredictionToPosition(
  predictionId: string,
  positionId: string
): Promise<Prediction | null> {
  try {
    return await prisma.prediction.update({
      where: { id: predictionId },
      data: { positionId },
    });
  } catch {
    return null;
  }
}
