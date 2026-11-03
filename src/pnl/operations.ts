/**
 * One operation, decomposed into "what happened" and "what would have happened
 * anyway".
 *
 * The whole point of this file is one subtraction. `SUM(value_usd)` over a
 * cycle is the true P&L and it is also misleading on its own, because it
 * contains the underlying moving while the capital sat there. On the first
 * $1,000 position the headline was +$35.87 and the strategy's own contribution
 * was +$6.90; the other $29 was SOL going up. A rising market would otherwise
 * read as a working model.
 */

import type {
  DepositedToken,
  ExcludedOperation,
  ExclusionReason,
  OperationPnL,
  PnlRow,
} from './types';

const OPEN = 'create_lp';
const CLOSE = 'close_lp';
const PRINCIPAL = 'principal';
/** The volatile leg of the one pair this project runs. See valueAllSolAtClose. */
const SOL = 'SOL';

/**
 * Sum every row. No category filter, and that is load-bearing.
 *
 * The first version of the P&L query excluded `debt`, which is backwards: a
 * borrow writes `principal +1000` AND `debt -1000`, so removing the debt row
 * leaves the +1000 standing alone and reports $988 of profit on a loan. The
 * debt row exists precisely BECAUSE it cancels. This matches
 * `getOperationPnL` in src/db/ledger.ts, deliberately -- there must be exactly
 * one definition of P&L in the project.
 */
export function sumOperation(rows: PnlRow[]): number {
  return rows.reduce((total, row) => total + row.valueUsd, 0);
}

/** A token's identity for grouping. Address when there is one, symbol otherwise. */
function identity(row: PnlRow): string {
  return row.tokenAddress ?? `symbol:${row.token}`;
}

/**
 * Split rows into operations, then into the ones that can be charted and the
 * ones that cannot.
 *
 * An operation is complete only if it has BOTH a `create_lp` principal row and
 * a `close_lp` principal row. Anything else is excluded with a reason that
 * reaches the UI. This is not a defensive nicety: production holds an adopted
 * position (`job_1699999990000`) whose close rows sum to +$10.36 with no
 * matching open, and counting it would book returned principal as profit.
 */
export function decomposeOperations(
  rows: PnlRow[],
  options: { excludeOperations?: readonly string[] } = {}
): {
  completed: OperationPnL[];
  excluded: ExcludedOperation[];
} {
  const operatorExcluded = new Set(options.excludeOperations ?? []);

  const byOperation = new Map<string, PnlRow[]>();
  for (const row of rows) {
    const existing = byOperation.get(row.operationId);
    if (existing) existing.push(row);
    else byOperation.set(row.operationId, [row]);
  }

  const completed: OperationPnL[] = [];
  const excluded: ExcludedOperation[] = [];

  for (const [operationId, operationRows] of byOperation) {
    const sorted = [...operationRows].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    );

    const openPrincipal = sorted.filter(
      (r) => r.action === OPEN && r.category === PRINCIPAL
    );
    const closePrincipal = sorted.filter(
      (r) => r.action === CLOSE && r.category === PRINCIPAL
    );

    // The operator's exclusion is checked FIRST so a test run that is also
    // still open reads as "you excluded this", not as "it cannot be measured".
    // The more specific reason is the more useful one.
    if (operatorExcluded.has(operationId)) {
      excluded.push({
        operationId,
        reason: 'excluded-by-operator',
        firstSeen: sorted[0].timestamp,
        lastSeen: sorted[sorted.length - 1].timestamp,
        naiveValueUsd: sumOperation(sorted),
      });
      continue;
    }

    if (openPrincipal.length === 0 || closePrincipal.length === 0) {
      excluded.push({
        operationId,
        reason: exclusionReason(openPrincipal.length, closePrincipal.length),
        firstSeen: sorted[0].timestamp,
        lastSeen: sorted[sorted.length - 1].timestamp,
        naiveValueUsd: sumOperation(sorted),
      });
      continue;
    }

    completed.push(buildOperation(operationId, sorted, openPrincipal, closePrincipal));
  }

  completed.sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime());
  excluded.sort((a, b) => a.firstSeen.getTime() - b.firstSeen.getTime());

  return { completed, excluded };
}

function exclusionReason(openRows: number, closeRows: number): ExclusionReason {
  if (openRows === 0 && closeRows === 0) return 'never-opened';
  if (openRows === 0) return 'no-open';
  return 'still-open';
}

function buildOperation(
  operationId: string,
  sorted: PnlRow[],
  openPrincipal: PnlRow[],
  closePrincipal: PnlRow[]
): OperationPnL {
  // Stated rather than assumed. Loosening the completeness check in
  // decomposeOperations would otherwise reach here and fail as an undefined
  // property read, which says nothing about what went wrong -- and the thing
  // that went wrong is that a cycle with no cost basis was about to be valued.
  if (openPrincipal.length === 0 || closePrincipal.length === 0) {
    throw new Error(
      `operation ${operationId} has ${openPrincipal.length} open and ` +
        `${closePrincipal.length} close principal rows. An operation missing ` +
        'either side has no cost basis and must be EXCLUDED, not valued: ' +
        'counting one reports returned principal as profit.'
    );
  }

  const openedAt = openPrincipal[0].timestamp;
  const closedAt = closePrincipal[closePrincipal.length - 1].timestamp;

  // Deposits are negative -- the ledger's sign convention is the WALLET's, so
  // money going into a position is money leaving. Flip it for a cost basis.
  const costBasisUsd = -openPrincipal.reduce((total, r) => total + r.valueUsd, 0);
  const lpPnlUsd = sumOperation(sorted);

  const deposited = collectDeposits(openPrincipal);

  // Close prices come from EVERY close row, not just the principal ones. A
  // position that drifted fully to one side withdraws nothing of the other
  // token and writes no principal row for it -- but the close still books its
  // network fee and rent in SOL, so the price is there.
  const closePrices = new Map<string, number>();
  for (const row of sorted) {
    if (row.action !== CLOSE) continue;
    closePrices.set(identity(row), row.priceUsd);
  }

  const { hodlValueUsd, hodlUnknownReason } = valueAtClose(deposited, closePrices);

  const hodlPnlUsd = hodlValueUsd === null ? null : hodlValueUsd - costBasisUsd;

  // What the principal itself did, read from the SAME rows that produced the
  // cost basis and the benchmark. Deriving it from the ledger's fee/cost
  // categories instead would give a second definition of principal that could
  // drift from this one.
  const principalOutUsd = closePrincipal.reduce((total, r) => total + r.valueUsd, 0);
  const principalChangeUsd = principalOutUsd - costBasisUsd;

  // The remainder of the operation: fees earned, less fees paid and rent. By
  // subtraction, not by enumerating categories -- a category this file does
  // not know about has to land somewhere a reader can see it, and silently
  // dropping it would break the identity below rather than hide in it.
  const feesAndCostsUsd = lpPnlUsd - principalChangeUsd;

  // The pool's cost against doing nothing. Null, never 0, when the benchmark
  // is unknown: 0 would assert the pool cost nothing.
  //
  //     strategyUsd === impermanentLossUsd + feesAndCostsUsd
  //
  // holds exactly, which is what lets a reader see WHICH force lost. A 7-hour
  // cycle lost $30 with the best fee rate of any position this bot has run --
  // visible only once IL and fees sit on separate lines.
  const impermanentLossUsd =
    hodlPnlUsd === null ? null : principalChangeUsd - hodlPnlUsd;

  // The SECOND benchmark, and it is a different question from the one above:
  // not "the basket I put in, held" but "the whole stake in SOL, held". It is
  // ADDITIVE to hodlPnlUsd, never a replacement -- see types.ts. The two
  // disagree in sign in a falling market, which is exactly why both ship.
  //
  // Read from the SAME rows as the cost basis and the same closePrices map as
  // the basket benchmark, so the three cannot silently describe different
  // moments.
  const { allSolPnlUsd, allSolUnknownReason } = valueAllSolAtClose(
    costBasisUsd,
    openPrincipal,
    closePrices
  );

  return {
    operationId,
    positionId: openPrincipal.find((r) => r.positionId)?.positionId ?? null,
    openedAt,
    closedAt,
    durationHours: (closedAt.getTime() - openedAt.getTime()) / 3_600_000,
    costBasisUsd,
    lpPnlUsd,
    deposited,
    hodlValueUsd,
    hodlPnlUsd,
    strategyUsd: hodlPnlUsd === null ? null : lpPnlUsd - hodlPnlUsd,
    hodlUnknownReason,
    principalChangeUsd,
    feesAndCostsUsd,
    impermanentLossUsd,
    allSolPnlUsd,
    allSolUnknownReason,
  };
}

/**
 * The second counterfactual: every dollar of the cost basis bought SOL at the
 * open and held it to the close.
 *
 * Not `deposited`-derived, deliberately. This benchmark is about the SIZE of
 * the stake, not its composition -- the composition is what `valueAtClose`
 * already measures, and the whole reason this exists is that an operator who
 * sees "-$73.61 against holding" wants to know whether full exposure would
 * have been better, which the basket cannot answer.
 *
 * Both prices come from rows this operation already wrote: the open price from
 * the `create_lp` principal SOL row that helped form `costBasisUsd`, the close
 * price from the same map the basket benchmark reads. An operation with no SOL
 * leg at either end is UNKNOWN, not zero.
 */
function valueAllSolAtClose(
  costBasisUsd: number,
  openPrincipal: PnlRow[],
  closePrices: Map<string, number>
): { allSolPnlUsd: number | null; allSolUnknownReason: string | null } {
  const openSol = openPrincipal.find((r) => r.token === SOL);
  if (!openSol) {
    return { allSolPnlUsd: null, allSolUnknownReason: 'no SOL leg was deposited' };
  }

  const closeSolPrice = closePrices.get(identity(openSol));
  if (closeSolPrice === undefined) {
    return { allSolPnlUsd: null, allSolUnknownReason: 'no close price for SOL' };
  }

  // A zero or negative open price cannot be divided by, and silently returning
  // 0 here would read as "SOL did not move".
  if (!(openSol.priceUsd > 0)) {
    return { allSolPnlUsd: null, allSolUnknownReason: 'no open price for SOL' };
  }

  const held = costBasisUsd * (closeSolPrice / openSol.priceUsd);
  return { allSolPnlUsd: held - costBasisUsd, allSolUnknownReason: null };
}

export function collectDeposits(openPrincipal: PnlRow[]): DepositedToken[] {
  const byToken = new Map<string, DepositedToken>();

  for (const row of openPrincipal) {
    const key = identity(row);
    const existing = byToken.get(key);
    if (existing) {
      existing.amount += -row.amount;
    } else {
      byToken.set(key, {
        token: row.token,
        tokenAddress: row.tokenAddress,
        amount: -row.amount,
        openPriceUsd: row.priceUsd,
      });
    }
  }

  return [...byToken.values()];
}

/**
 * The counterfactual: the exact basket that went in, revalued at the prices
 * this operation closed at.
 *
 * A token with no close price makes the whole figure unknown, not smaller.
 * Substituting the open price would quietly assert the token did not move,
 * which is the one thing this comparison exists to measure.
 */
function valueAtClose(
  deposited: DepositedToken[],
  closePrices: Map<string, number>
): { hodlValueUsd: number | null; hodlUnknownReason: string | null } {
  let total = 0;

  for (const token of deposited) {
    const key = token.tokenAddress ?? `symbol:${token.token}`;
    const price = closePrices.get(key);
    if (price === undefined) {
      return {
        hodlValueUsd: null,
        hodlUnknownReason: `no close price for ${token.token}`,
      };
    }
    total += token.amount * price;
  }

  return { hodlValueUsd: total, hodlUnknownReason: null };
}
