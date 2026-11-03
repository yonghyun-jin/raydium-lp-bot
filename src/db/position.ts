/**
 * Position Service (Prisma)
 *
 * Track LP positions in database.
 */

import { decideObservation } from './observationCadence';
import { prisma } from './index';
import type { Position } from '@prisma/client';

export interface CreatePositionInput {
  nftMint: string;
  poolId: string;
  rangeLower: number;
  rangeUpper: number;
  solDeposited: number;
  usdcDeposited: number;
  operationId?: string;  /**
   * The nft mint of the position this one replaced.
   *
   * The MINT, not the row id: `nftMint` is unique, so it identifies the
   * predecessor without a lookup and stays readable if the predecessor's row is
   * ever missing. Undefined on a first open, which is correct -- there is
   * nothing to link to.
   */
  prevPositionId?: string;
}

/**
 * All optional, matching the schema (these columns are nullable).
 *
 * Only `handleClosePosition` knows these figures -- it reads wallet balances
 * before and after. Every Orchestrator close returns `{txId}` alone, so
 * requiring them would force those sites either to fabricate zeros, which reads
 * as "withdrew nothing", or to skip recording the close entirely, which leaves
 * a row marked open forever. Recording the close with the amounts unknown is the
 * honest option.
 */
export interface ClosePositionInput {
  solWithdrawn?: number;
  usdcWithdrawn?: number;
  feesEarnedUsd?: number;
}

/**
 * Create a new position
 */
export async function createPosition(input: CreatePositionInput): Promise<Position> {
  return prisma.position.create({
    data: {
      nftMint: input.nftMint,
      poolId: input.poolId,
      rangeLower: input.rangeLower,
      rangeUpper: input.rangeUpper,
      solDeposited: input.solDeposited,
      usdcDeposited: input.usdcDeposited,
      operationId: input.operationId,
      prevPositionId: input.prevPositionId,
      isOpen: true,
      openedAt: new Date(),
    },
  });
}

/**
 * Get position by NFT mint
 */
export async function getPositionByMint(nftMint: string): Promise<Position | null> {
  return prisma.position.findUnique({
    where: { nftMint },
  });
}

/**
 * Get all open positions
 */
export async function getOpenPositions(): Promise<Position[]> {
  return prisma.position.findMany({
    where: { isOpen: true },
    orderBy: { openedAt: 'desc' },
  });
}

/**
 * Close a position
 */
export async function closePosition(
  nftMint: string,
  closeData: ClosePositionInput
): Promise<Position | null> {
  try {
    return await prisma.position.update({
      where: { nftMint },
      data: {
        isOpen: false,
        closedAt: new Date(),
        solWithdrawn: closeData.solWithdrawn,
        usdcWithdrawn: closeData.usdcWithdrawn,
        feesEarnedUsd: closeData.feesEarnedUsd,
      },
    });
  } catch (error) {
    return null;
  }
}

/**
 * The latest reading of a live position, overwritten in place.
 *
 * NOT a time series and NOT the observations table C2 removed: one row per
 * position, no history, and nothing in P&L reads it. A settled operation's
 * figures come from `ledger_entries` and from nowhere else, so this cannot
 * drift into the record.
 *
 * Every field is written exactly as measured, INCLUDING null. `feesUsd` is
 * null whenever either fee leg was unreadable, and writing 0 there would show
 * the operator a position earning nothing when the truth is that nobody knows.
 * `lastReadAt` is stamped by the caller's clock on the row it describes, so a
 * stale reading can be rendered as stale rather than as current.
 */
export async function recordPositionReading(
  nftMint: string,
  reading: {
    price: number;
    solAmount: number;
    usdcAmount: number;
    feesUsd: number | null;
    inRange: boolean;
    at: Date;
    /**
     * The position's total value, for the APPEND-ONLY observation row.
     *
     * Null skips the observation and keeps the latest-reading update: the
     * column is NOT NULL and a 0 there would read as a worthless position in
     * the one series a fee curve is computed from.
     */
    valueUsd?: number | null;
    /**
     * Whether the caller's heartbeat is due. A RANGE TRANSITION is detected
     * here instead, from the stored `lastInRange`, so it survives a restart --
     * an in-memory latch would emit a false transition on the first tick after
     * every redeploy, and a false transition is worse than a missing one
     * because it corrupts the time-in-range series this table exists for.
     */
    heartbeat?: boolean;
  }
): Promise<boolean> {
  try {
    const previous = await prisma.position.findUnique({
      where: { nftMint },
      select: { id: true, lastInRange: true },
    });
    if (!previous) return false;

    const decision = decideObservation({
      storedInRange: previous.lastInRange,
      inRange: reading.inRange,
      valueUsd: reading.valueUsd,
      heartbeat: reading.heartbeat,
    });

    await prisma.position.update({
      where: { nftMint },
      data: {
        lastReadAt: reading.at,
        lastPrice: reading.price,
        lastSolAmount: reading.solAmount,
        lastUsdcAmount: reading.usdcAmount,
        lastFeesUsd: reading.feesUsd,
        lastInRange: reading.inRange,
        ...(decision.write
          ? {
              observations: {
                create: {
                  observedAt: reading.at,
                  price: reading.price,
                  inRange: reading.inRange,
                  valueUsd: reading.valueUsd as number,
                  feesEarnedUsd: reading.feesUsd,
                  // 'transition' is what makes time-in-range exact; the
                  // heartbeats in between are the fee curve. Keeping them
                  // distinguishable is why the column exists.
                  reason: decision.reason,
                },
              },
            }
          : {}),
      },
    });
    return true;
  } catch {
    // A failed reading DEGRADES: the monitor loop is watching live money and
    // must not stop because a cosmetic column could not be written. The
    // dashboard renders the absence as "unknown", which is true.
    return false;
  }
}

/**
 * Position age in hours, or null when it cannot be established.
 *
 * NULL IS A REAL ANSWER, not an error to paper over. A position adopted via
 * /done was not created by this bot and its open time is not recoverable from
 * the chain -- position age is not stored on-chain. The old code answered
 * `Date.now()` there, turning "unknown" into "brand new", which routes a mature
 * position into the under-6h Early Exit branch instead of the 24h auto-rebalance
 * one.
 *
 * Age gates a decision to spend WITHOUT asking, so callers must treat null as
 * "ask the user", never as young. See the failure policy in
 * docs/v1/database-schema.md: writes degrade, reads that gate spending fail
 * closed.
 *
 * Subtraction happens HERE, in JS, on a Date the Prisma client has already
 * normalised to UTC. Do not compute this in SQL: `opened_at` is TIMESTAMP(3)
 * without a time zone, while `NOW()` is timestamptz in the server's zone, and
 * subtracting one from the other silently applies that offset -- measured at
 * exactly 7h off on a US-Pacific server, against a 24h threshold.
 */
export function getPositionAgeHours(position: Position): number | null {
  if (position.openedAt === null) {
    return null;
  }
  return (Date.now() - position.openedAt.getTime()) / (1000 * 60 * 60);
}
