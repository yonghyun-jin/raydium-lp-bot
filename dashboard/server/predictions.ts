/**
 * What the model said, paired with what the price did.
 *
 * ONE EPISODE PER POSITION. A prediction that no position was ever opened from
 * is not shown: the bot makes one on every rebalance check and most are
 * discarded, so listing them buries the handful of ranges that actually held
 * money under a pile of ranges that never did. They stay in the database --
 * `predictions.position_id` is null on purpose and the row is still a record of
 * what the model proposed -- this page just is not where they are read.
 *
 * Two kinds do reach it, labelled rather than blended:
 *
 *  - `position`     the position's range came from a recorded prediction.
 *  - `unpredicted`  the position predates predictions being recorded. There is
 *                   no model claim to score, but the range that was actually
 *                   live still gets held against the price.
 *
 * One operation has one prediction, so each episode carries its operation id
 * and links back to the ledger.
 */

import { reviewPrediction, within, type Candle, type PredictionReview } from '../../src/predictions';
import { loadCandles } from './prices';
import { prisma } from './pnl';

const PRICE_SOURCE = 'Binance.US SOLUSDT, hourly';

export type EpisodeKind = 'position' | 'unpredicted';

export interface Episode {
  id: string;
  kind: EpisodeKind;
  /** 'ml' | 'fallback' for a recorded prediction; null when there was none. */
  source: string | null;
  predictedAt: string | null;

  band: { lower: number; upper: number; anchor: number };
  /**
   * How the anchor was arrived at. A recorded prediction carries its own; an
   * unpredicted position has none, so the first candle of its window stands in
   * -- stated here rather than passed off as the model's number.
   */
  anchorFrom: 'prediction' | 'first candle';

  positionId: string;
  /** The ledger operation this position belongs to. Links the two pages. */
  operationId: string | null;
  openedAt: string | null;
  closedAt: string | null;
  /** Still running, so its review moves until it closes. */
  live: boolean;

  window: { from: string; to: string };
  candles: Candle[];
  review: PredictionReview;
}

export interface PredictionsResponse {
  episodes: Episode[];
  /** Where the price path came from, so the page can say so out loud. */
  priceSource: string;
  /**
   * Predictions the model made that no position followed. Counted, not listed
   * -- the number is worth knowing, the rows are not worth the space.
   */
  unusedPredictions: number;
}

export async function loadEpisodes(now = Date.now()): Promise<PredictionsResponse> {
  const [predictions, positions] = await Promise.all([
    prisma.prediction.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.position.findMany({ orderBy: { openedAt: 'desc' } }),
  ]);

  /*
   * One prediction per position. If a position somehow carries more than one --
   * a retry that recorded twice -- the LAST one wins, because that is the range
   * the position was actually opened at.
   */
  const byPosition = new Map<string, (typeof predictions)[number]>();
  for (const p of predictions) {
    if (p.positionId) byPosition.set(p.positionId, p);
  }

  const unusedPredictions = predictions.filter((p) => !p.positionId).length;

  const planned = positions
    .filter((position) => position.openedAt !== null)
    .map((position) => {
      const prediction = byPosition.get(position.id);
      const openedAt = position.openedAt as Date;

      return {
        id: prediction ? prediction.id : `position:${position.id}`,
        kind: (prediction ? 'position' : 'unpredicted') as EpisodeKind,
        source: prediction?.source ?? null,
        predictedAt: prediction?.createdAt ?? null,
        band: {
          lower: prediction?.priceLower ?? position.rangeLower,
          upper: prediction?.priceUpper ?? position.rangeUpper,
          anchor: prediction?.anchorPrice ?? null,
        },
        positionId: position.id,
        operationId: position.operationId,
        openedAt,
        closedAt: position.closedAt,
        from: openedAt.getTime(),
        to: Math.min(position.closedAt?.getTime() ?? now, now),
      };
    });

  if (planned.length === 0) {
    return { episodes: [], priceSource: PRICE_SOURCE, unusedPredictions };
  }

  // One fetch for the whole span; every window below is a slice of it, and
  // hours that have already closed come from the cache rather than the wire.
  const all = await loadCandles(
    Math.min(...planned.map((e) => e.from)),
    Math.max(...planned.map((e) => e.to)),
    now
  );

  const episodes = planned
    .map((e): Episode => {
      const candles = within(all, e.from, e.to);
      const anchor = e.band.anchor ?? candles[0]?.open ?? e.band.lower;

      return {
        id: e.id,
        kind: e.kind,
        source: e.source,
        predictedAt: e.predictedAt?.toISOString() ?? null,
        band: { lower: e.band.lower, upper: e.band.upper, anchor },
        anchorFrom: e.band.anchor === null ? 'first candle' : 'prediction',
        positionId: e.positionId,
        operationId: e.operationId,
        openedAt: e.openedAt.toISOString(),
        closedAt: e.closedAt?.toISOString() ?? null,
        live: e.closedAt === null,
        window: { from: new Date(e.from).toISOString(), to: new Date(e.to).toISOString() },
        candles,
        review: reviewPrediction({ lower: e.band.lower, upper: e.band.upper, anchor }, candles),
      };
    })
    .sort((a, b) => new Date(b.window.from).getTime() - new Date(a.window.from).getTime());

  return { episodes, priceSource: PRICE_SOURCE, unusedPredictions };
}
