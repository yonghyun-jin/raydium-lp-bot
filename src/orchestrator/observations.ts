// Position observations: the append-only series behind time-in-range and the
// fee curve.

import type { PositionDetails } from '../raydium/LpClient';
import { recordPositionReading } from '../recording';

/**
 * Heartbeat interval while nothing crosses. Transitions are written whenever
 * they happen; heartbeats only feed the fee curve, and writing every tick
 * would be ~1M rows a year per position for no extra answer.
 */
export const OBSERVATION_HEARTBEAT_MS = 5 * 60_000;

/**
 * Record a reading from a position read already in hand (no extra chain call).
 *
 * `lastObservationAt` is in-memory on purpose: losing it costs one early
 * heartbeat. The range state transitions are detected from must NOT be in
 * memory -- see `recordPositionReading`. The write degrades, so a failure here
 * cannot stop the loop watching live money.
 */
export async function recordObservation(
  lastObservationAt: Map<string, Date>,
  nftMint: string,
  details: PositionDetails,
  feesEarned: number | null
): Promise<void> {
  const now = new Date();
  const lastBeat = lastObservationAt.get(nftMint);
  const heartbeat =
    lastBeat === undefined || now.getTime() - lastBeat.getTime() >= OBSERVATION_HEARTBEAT_MS;

  const stored = await recordPositionReading(nftMint, {
    price: details.currentPrice,
    solAmount: details.amountA,
    usdcAmount: details.amountB,
    feesUsd: feesEarned,
    inRange: details.inRange,
    at: now,
    valueUsd: details.totalValueUsd,
    heartbeat,
  });

  // Advance only on a STORED heartbeat; advancing on a failed write would hide
  // a lost row by skipping the next five minutes.
  if (heartbeat && stored) lastObservationAt.set(nftMint, now);
}
