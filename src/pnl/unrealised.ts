/**
 * Where an OPEN position stands right now. A MARK, never a result.
 *
 * This file is deliberately separate from `operations.ts` and nothing in the
 * record imports it. `buildTotals` and `buildSeries` read settled operations
 * only, and the reason is not tidiness: these figures move every tick, and a
 * mark that leaks into a cumulative line turns "what the bot earned" into
 * "where SOL happens to be". There is no `strategyUsd` here for the same
 * reason -- an unsettled operation has no verdict.
 *
 * It reads MEASURED amounts (`positions.last_*`, written by the monitor loop
 * from what the chain reported) and never infers them. Inferring the
 * composition from the recorded range looks possible and is not: the stored
 * range is what the bot ASKED for, Raydium snaps it to tick boundaries, and
 * recovering the liquidity from the two token legs disagrees with itself by
 * ~1.5% -- which shows as a $0.61 loss at the open price of a $3,606 position,
 * where the true answer is exactly $0.
 */

import { collectDeposits } from './operations';
import type { PnlRow, PositionContext, UnrealisedPnL } from './types';

const OPEN = 'create_lp';
const CLOSE = 'close_lp';
const PRINCIPAL = 'principal';

/**
 * One entry per operation that has opened and not yet closed.
 *
 * An operation with no reading yet still gets an entry, with every figure null
 * and a reason. Omitting it would render as "no open position", which is a
 * different and wrong statement from "nobody has looked at it yet".
 */
export function buildUnrealised(
  rows: PnlRow[],
  positions: readonly PositionContext[] = []
): UnrealisedPnL[] {
  const byOperation = new Map<string, PnlRow[]>();
  for (const row of rows) {
    const existing = byOperation.get(row.operationId);
    if (existing) existing.push(row);
    else byOperation.set(row.operationId, [row]);
  }

  const context = new Map<string, PositionContext>();
  for (const position of positions) {
    if (position.operationId) context.set(position.operationId, position);
  }

  const out: UnrealisedPnL[] = [];

  for (const [operationId, operationRows] of byOperation) {
    const openPrincipal = operationRows.filter(
      (r) => r.action === OPEN && r.category === PRINCIPAL
    );
    const closePrincipal = operationRows.filter(
      (r) => r.action === CLOSE && r.category === PRINCIPAL
    );

    // Opened and not closed. An operation with no open principal has no cost
    // basis and is somebody else's problem (decomposeOperations excludes it).
    if (openPrincipal.length === 0 || closePrincipal.length > 0) continue;

    out.push(mark(operationId, openPrincipal, context.get(operationId)));
  }

  out.sort((a, b) => a.operationId.localeCompare(b.operationId));
  return out;
}

function mark(
  operationId: string,
  openPrincipal: PnlRow[],
  position: PositionContext | undefined
): UnrealisedPnL {
  const empty = {
    operationId,
    markedAt: null,
    priceUsd: null,
    inRange: null,
    positionValueUsd: null,
    hodlValueUsd: null,
    impermanentLossUsd: null,
    feesSoFarUsd: null,
  };

  if (!position) {
    return { ...empty, unknownReason: 'no position row for this operation' };
  }

  const { lastPrice, lastSolAmount, lastUsdcAmount, lastReadAt } = position;

  // All three or none. A price with no amounts cannot value anything, and
  // amounts with no price cannot either -- partial figures here would be
  // arithmetic on an unknown.
  if (lastPrice === null || lastSolAmount === null || lastUsdcAmount === null) {
    return {
      ...empty,
      // Fees do not depend on the amounts, so a readable fee is still shown.
      feesSoFarUsd: position.lastFeesUsd,
      markedAt: lastReadAt,
      unknownReason: 'the monitor has not recorded a reading yet',
    };
  }

  const positionValueUsd = lastSolAmount * lastPrice + lastUsdcAmount;

  // The same basket that went in, at the SAME price the position is marked
  // at. Using any other price would compare two different moments and call
  // the difference impermanent loss.
  const deposited = collectDeposits(openPrincipal);
  let hodlValueUsd = 0;
  for (const token of deposited) {
    // Only the pair this bot runs can be marked: a third token would need its
    // own live price and there is no source for one here.
    if (token.token === 'SOL') hodlValueUsd += token.amount * lastPrice;
    else if (token.token === 'USDC') hodlValueUsd += token.amount;
    else {
      return {
        ...empty,
        markedAt: lastReadAt,
        priceUsd: lastPrice,
        inRange: position.lastInRange,
        feesSoFarUsd: position.lastFeesUsd,
        unknownReason: `no live price for ${token.token}`,
      };
    }
  }

  return {
    operationId,
    markedAt: lastReadAt,
    priceUsd: lastPrice,
    inRange: position.lastInRange,
    positionValueUsd,
    hodlValueUsd,
    impermanentLossUsd: positionValueUsd - hodlValueUsd,
    feesSoFarUsd: position.lastFeesUsd,
    unknownReason: null,
  };
}
