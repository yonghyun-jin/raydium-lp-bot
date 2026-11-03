/**
 * The ledger view: what actually happened, line by line.
 *
 * Separate from `operations.ts`, which answers "was the strategy worth it".
 * This answers "what moved, when, and what did it cost" -- and it answers it
 * for ANY operation, not only a complete LP cycle.
 *
 * THE RULE THIS FILE IS WRITTEN UNDER: nothing here branches on an action name.
 * `action`, `category`, `protocol` and `chain` are open strings by design, so a
 * lending borrow/repay or a staking claim has to render with no code change.
 * Everything LP-specific -- the range, the lifecycle dates -- arrives as
 * optional decoration from the `positions` join and is allowed to be absent.
 */

import type {
  LedgerOperation,
  LedgerTransaction,
  Movement,
  MovementKind,
  OperationStatus,
  PnlRow,
  PositionContext,
  PriceTrack,
  QuoteSummary,
} from './types';

/**
 * Category -> what it does to the money.
 *
 * The one place this mapping exists. Adding a category to the vocabulary means
 * adding it here; forgetting to leaves it as `movement`, which is visible in
 * the row list and simply absent from the summary split -- never miscounted.
 */
const KIND_BY_CATEGORY: Record<string, MovementKind> = {
  principal: 'movement',
  debt: 'movement',

  reward: 'earned',

  interest: 'paid',
  dex_fee: 'paid',
  platform_fee: 'paid',
  network_fee: 'paid',
  execution_slippage: 'paid',

  rent_deposit: 'recoverable',
  rent_reclaim: 'recoverable',

  // Superseded, still readable so rows written before C3 keep their meaning.
  fee: 'paid',
  slippage: 'paid',
  gas: 'paid',
  cost: 'paid',
};

export function kindOf(category: string): MovementKind {
  return KIND_BY_CATEGORY[category] ?? 'movement';
}

export interface LedgerOptions {
  positions?: readonly PositionContext[];
  excludeOperations?: readonly string[];
}

/**
 * Build the operation -> transaction -> movement tree.
 *
 * Every operation appears, whatever state it is in. Status is a field rather
 * than a filter, which is what lets the page show an open position and an
 * unfundable record in the same table instead of in a separate apology.
 */
export function buildLedger(rows: PnlRow[], options: LedgerOptions = {}): LedgerOperation[] {
  const setAside = new Set(options.excludeOperations ?? []);
  const positionByOperation = new Map<string, PositionContext>();
  for (const position of options.positions ?? []) {
    if (position.operationId) positionByOperation.set(position.operationId, position);
  }

  const byOperation = new Map<string, PnlRow[]>();
  for (const row of rows) {
    const existing = byOperation.get(row.operationId);
    if (existing) existing.push(row);
    else byOperation.set(row.operationId, [row]);
  }

  const operations: LedgerOperation[] = [];

  for (const [operationId, operationRows] of byOperation) {
    const sorted = [...operationRows].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    );
    const position = positionByOperation.get(operationId) ?? null;
    const transactions = groupTransactions(sorted);

    const capitalInUsd = lowWaterMark(transactions);
    const netUsd = sum(sorted.map((r) => r.valueUsd));

    const status = statusOf(operationId, position, setAside, capitalInUsd);
    const settled = status === 'closed' || status === 'incomplete' || status === 'set-aside';
    const netIsPnl = settled && capitalInUsd !== null;

    operations.push({
      operationId,
      status,
      position,
      firstAt: sorted[0].timestamp,
      lastAt: sorted[sorted.length - 1].timestamp,
      durationHours: durationOf(position, sorted, settled),

      capitalInUsd,
      capitalOutUsd: netIsPnl ? capitalInUsd! + netUsd : null,
      netUsd,
      netIsPnl,

      // Unfinished means unbooked, not zero. Fees are read from the chain
      // moments before the position is burned and become rows only then, so an
      // operation still running has genuinely earned nothing ON THE RECORD.
      feesEarnedUsd: settled ? sumKind(sorted, 'earned') : null,
      feesPaidUsd: sumKind(sorted, 'paid'),
      rentLockedUsd: sumCategory(sorted, 'rent_deposit'),
      rentReturnedUsd: sumCategory(sorted, 'rent_reclaim'),

      prices: trackPrices(transactions, settled),
      transactions,
    });
  }

  return operations.sort((a, b) => b.firstAt.getTime() - a.firstAt.getTime());
}

function statusOf(
  operationId: string,
  position: PositionContext | null,
  setAside: Set<string>,
  capitalInUsd: number | null
): OperationStatus {
  if (setAside.has(operationId)) return 'set-aside';
  if (position?.isOpen) return 'open';
  // No capital ever left in this record, so whatever came back has nothing to
  // be measured against -- an adopted position, opened before the ledger
  // existed. Counting its return as profit is the mistake this status prevents.
  if (capitalInUsd === null) return 'incomplete';
  return 'closed';
}

function durationOf(
  position: PositionContext | null,
  sorted: PnlRow[],
  settled: boolean
): number | null {
  const from = position?.openedAt ?? sorted[0].timestamp;
  const to = position?.closedAt ?? (settled ? sorted[sorted.length - 1].timestamp : null);
  if (!to) return null;
  return (to.getTime() - from.getTime()) / 3_600_000;
}

/** One transaction's worth of rows, in the order the chain produced them. */
function groupTransactions(sorted: PnlRow[]): LedgerTransaction[] {
  const byTx = new Map<string, PnlRow[]>();
  for (const row of sorted) {
    const existing = byTx.get(row.txId);
    if (existing) existing.push(row);
    else byTx.set(row.txId, [row]);
  }

  // The balance is accumulated ACROSS transactions, in order, so the last
  // movement of the last transaction lands on the operation's net. Resetting
  // it per transaction would make each block self-consistent and the operation
  // unprovable, which is the opposite of the point.
  let balance = 0;

  return [...byTx.entries()].map(([txId, txRows]) => {
    let debitUsd = 0;
    let creditUsd = 0;

    const movements = txRows.map((row) => {
      if (row.valueUsd > 0) debitUsd += row.valueUsd;
      else creditUsd += -row.valueUsd;
      balance += row.valueUsd;
      return toMovement(row, balance);
    });

    return {
      txId,
      at: txRows[0].timestamp,
      action: txRows[0].action,
      protocol: txRows[0].protocol,
      chain: txRows[0].chain,
      debitUsd,
      creditUsd,
      netUsd: sum(txRows.map((r) => r.valueUsd)),
      balanceUsd: balance,
      movements,
      quote: readQuoteSummary(txRows.find((r) => r.quote)?.quote),
    };
  });
}

function toMovement(row: PnlRow, balanceUsd: number): Movement {
  return {
    category: row.category,
    kind: kindOf(row.category),
    token: row.token,
    tokenAddress: row.tokenAddress,
    amount: row.amount,
    priceUsd: row.priceUsd,
    valueUsd: row.valueUsd,
    description: row.description,
    balanceUsd,
  };
}

/**
 * How far into the red this operation went, following its transactions in order.
 *
 * Summing negative rows instead would double-count a funding swap: it sends
 * USDC and receives SOL inside the operation, so both legs look like money
 * leaving when the wallet is barely touched. The running total handles that and
 * every other internal transfer without knowing what any of them are called.
 */
function lowWaterMark(transactions: LedgerTransaction[]): number | null {
  let running = 0;
  let lowest = 0;

  for (const tx of transactions) {
    running += tx.netUsd;
    if (running < lowest) lowest = running;
  }

  return lowest < 0 ? -lowest : null;
}

/**
 * A token's price when the operation started and when it ended.
 *
 * Only tokens whose price actually MOVED are returned -- a stablecoin priced at
 * 1 throughout says nothing and would crowd out the one number that matters.
 */
function trackPrices(transactions: LedgerTransaction[], settled: boolean): PriceTrack[] {
  if (transactions.length === 0) return [];

  const first = new Map<string, Movement>();
  const last = new Map<string, Movement>();

  for (const tx of transactions) {
    for (const movement of tx.movements) {
      const key = movement.tokenAddress ?? `symbol:${movement.token}`;
      if (!first.has(key)) first.set(key, movement);
      last.set(key, movement);
    }
  }

  const tracks: PriceTrack[] = [];
  for (const [key, opening] of first) {
    const closing = last.get(key)!;
    if (opening.priceUsd === closing.priceUsd) continue;
    tracks.push({
      token: opening.token,
      tokenAddress: opening.tokenAddress,
      openUsd: opening.priceUsd,
      // An unfinished operation has no end price. The last row's price is just
      // the most recent thing that happened to it, not where it came to rest.
      closeUsd: settled ? closing.priceUsd : null,
    });
    void key;
  }

  return tracks;
}

/**
 * The few fields worth showing from a preserved router quote.
 *
 * The raw blob has ~20 keys and is kept verbatim in the ledger on purpose; this
 * picks the two that are readable at a glance plus the route, and returns null
 * rather than guessing when the shape is not what we expect.
 */
function readQuoteSummary(quote: unknown): QuoteSummary | null {
  if (!quote || typeof quote !== 'object') return null;
  const q = quote as Record<string, any>;

  const impact = Number(q.priceImpactPct);
  const slippage = Number(q.slippageBps);

  const routeLabels: string[] = [];
  if (Array.isArray(q.routePlan)) {
    for (const hop of q.routePlan) {
      const label = hop?.swapInfo?.label ?? hop?.label;
      if (typeof label === 'string') routeLabels.push(label);
    }
  }

  // Read back from the stored quote rather than from a flag written at record
  // time, so rows booked before that flag existed still answer correctly.
  let feesReported = false;
  if (Array.isArray(q.routePlan)) {
    for (const hop of q.routePlan) {
      const info = hop?.swapInfo ?? hop;
      if (info?.feeAmount !== undefined && info?.feeMint) feesReported = true;
    }
  }
  if (q.platformFee?.amount !== undefined && q.platformFee?.amount !== null) feesReported = true;

  return {
    priceImpactPct: Number.isFinite(impact) ? impact : null,
    slippageBps: Number.isFinite(slippage) ? slippage : null,
    routeLabels,
    feesReported,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sumKind(rows: PnlRow[], kind: MovementKind): number {
  return sum(rows.filter((r) => kindOf(r.category) === kind).map((r) => r.valueUsd));
}

function sumCategory(rows: PnlRow[], category: string): number {
  return sum(rows.filter((r) => r.category === category).map((r) => r.valueUsd));
}
