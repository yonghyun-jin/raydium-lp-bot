/**
 * Ledger rows in, report out.
 *
 * The only place in this service that touches Postgres, and it only ever
 * SELECTs. The arithmetic lives in `src/pnl/` and is shared with the bot's test
 * suite, so the dashboard cannot drift into having its own opinion about what
 * P&L means.
 */

import { PrismaClient } from '@prisma/client';
import { buildReport } from '../../src/pnl';
import type { PnlReport, PositionContext } from '../../src/pnl';

export const prisma = new PrismaClient();

/**
 * Operations the operator has said do not represent the strategy — a test run,
 * a deliberate experiment. Comma-separated operation ids in
 * `PNL_EXCLUDE_OPERATIONS`.
 *
 * Config rather than a database flag, for two reasons. The dashboard is
 * read-only and adding a write path here to hide a number would be the first
 * crack in that; and this is a judgement about PRESENTATION, not a fact about
 * what happened. The rows stay exactly as written — the money did move — and
 * the page still lists what was set aside, so the decision is visible and
 * reversible by editing one variable.
 */
export function excludedOperations(env: NodeJS.ProcessEnv): string[] {
  return (env.PNL_EXCLUDE_OPERATIONS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * Every ledger row, oldest first.
 *
 * Deliberately unfiltered and unpaginated. `ledger_entries` holds a few rows
 * per position and a cumulative series is wrong if it starts partway through --
 * paginating this would silently change the answer rather than the page size.
 * Revisit when the table is large enough to matter, which is thousands of
 * positions away.
 */
export async function loadReport(): Promise<PnlReport> {
  const [rows, positions] = await Promise.all([
    prisma.ledgerEntry.findMany({
      select: {
        operationId: true,
        txId: true,
        timestamp: true,
        action: true,
        category: true,
        protocol: true,
        chain: true,
        description: true,
        quote: true,
        token: true,
        tokenAddress: true,
        amount: true,
        priceUsd: true,
        valueUsd: true,
        positionId: true,
      },
      orderBy: { timestamp: 'asc' },
    }),
    loadPositions(),
  ]);

  return buildReport(rows, {
    positions,
    excludeOperations: excludedOperations(process.env),
  });
}

/**
 * The LP range and lifecycle, which live on `positions` and never reach
 * `ledger_entries`.
 *
 * `operation_id` is the ONLY safe join between the two tables:
 * `ledger_entries.position_id` holds an NFT mint while `predictions.position_id`
 * holds a cuid, so neither of those is usable here.
 */
async function loadPositions(): Promise<PositionContext[]> {
  return prisma.position.findMany({
    select: {
      operationId: true,
      nftMint: true,
      poolId: true,
      rangeLower: true,
      rangeUpper: true,
      isOpen: true,
      openedAt: true,
      adoptedAt: true,
      closedAt: true,
      prevPositionId: true,
      lastReadAt: true,
      lastPrice: true,
      lastSolAmount: true,
      lastUsdcAmount: true,
      lastFeesUsd: true,
      lastInRange: true,
    },
    orderBy: { openedAt: 'asc' },
  });
}
