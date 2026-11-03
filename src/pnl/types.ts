/**
 * What a P&L report is made of.
 *
 * Nothing here imports Prisma, a database client or an HTTP framework. The
 * whole module takes ledger rows in and returns numbers out, so it can be
 * tested against fixtures and could back a Telegram command as easily as it
 * backs the dashboard.
 */

/**
 * The shape this module needs from a ledger row.
 *
 * Declared structurally rather than imported from `@prisma/client` so the
 * arithmetic has no dependency on the storage layer. A Prisma `LedgerEntry`
 * satisfies it as-is.
 */
export interface PnlRow {
  operationId: string;
  /** On-chain signature. One transaction, many rows -- this is what groups them. */
  txId: string;
  timestamp: Date;
  /**
   * What caused the movement, and DELIBERATELY an open string: swap, create_lp,
   * close_lp, harvest, borrow, repay, stake... Nothing in this module may branch
   * on its value. See docs/v1-confidential/ledger-schema.md, "Reuse beyond this
   * bot" -- the whole point is that an operation from another protocol renders
   * here without a code change.
   */
  action: string;
  category: string;
  protocol: string;
  chain: string;
  description: string | null;
  /** The router's preserved quote, on a swap's first row. Shape is not ours. */
  quote?: unknown;
  /** Display label. NOT an identity -- see tokenAddress. */
  token: string;
  /**
   * Mint / contract address, and the only safe key to group a token by:
   * Solana USDC, Ethereum USDC and Arbitrum USDC share a symbol and are
   * different assets.
   */
  tokenAddress: string | null;
  amount: number;
  priceUsd: number;
  valueUsd: number;
  positionId: string | null;
}

/** One token that went into a position, and what it was worth going in. */
export interface DepositedToken {
  token: string;
  tokenAddress: string | null;
  amount: number;
  openPriceUsd: number;
}

/**
 * Why an operation is not in the headline.
 *
 * These are reported, never silently dropped. `no-open` in particular is the
 * one that matters: an adopted position's close rows read as pure profit
 * because the capital that funded it was never booked.
 *
 * `excluded-by-operator` is different in kind from the other three. Those are
 * operations that CANNOT be measured; this one can be measured perfectly well
 * and the operator has said it does not represent the strategy -- a test run, a
 * deliberate experiment. It is a presentation decision, so it lives in config
 * and never touches the ledger: the money really did move, and a P&L that can
 * be edited by deleting rows is not an accounting record.
 */
export type ExclusionReason =
  | 'no-open'
  | 'still-open'
  | 'never-opened'
  | 'excluded-by-operator';

export interface ExcludedOperation {
  operationId: string;
  reason: ExclusionReason;
  firstSeen: Date;
  lastSeen: Date;
  /**
   * What a naive `SUM(value_usd)` would have contributed had this operation
   * been counted. Carried so the page can show the size of the mistake it is
   * avoiding rather than just asserting one was avoided.
   */
  naiveValueUsd: number;
}

/**
 * A completed cycle, decomposed.
 *
 * `lpPnlUsd` is what happened. `hodlPnlUsd` is what would have happened had the
 * same tokens simply been held for the same window. `strategyUsd` is the
 * difference, and it is the only one of the three that says whether the bot is
 * worth running.
 */
export interface OperationPnL {
  operationId: string;
  positionId: string | null;
  openedAt: Date;
  closedAt: Date;
  durationHours: number;

  /** What the deposited tokens were worth at open. The denominator for a return. */
  costBasisUsd: number;
  /** Every row in the operation, summed. No category filter -- see sumOperation. */
  lpPnlUsd: number;

  deposited: DepositedToken[];
  /** The deposited basket revalued at this operation's close prices. */
  hodlValueUsd: number | null;
  hodlPnlUsd: number | null;
  strategyUsd: number | null;
  /** Set when the HODL figures are null, saying which token had no close price. */
  hodlUnknownReason: string | null;

  /**
   * What the PRINCIPAL did: withdrawn principal minus the cost basis. Computed
   * from the same rows as `costBasisUsd` and `hodlValueUsd`, so the three
   * cannot drift apart.
   */
  principalChangeUsd: number;
  /**
   * Everything in `lpPnlUsd` that the POSITION's principal did not do. Derived
   * by subtraction rather than by enumerating categories, so a category this
   * file has never heard of lands here visibly instead of vanishing.
   *
   * It is NOT only fees, and the name is a convenience. In 3 of the 4
   * operations production has settled it also carries the FUNDING SWAP's
   * execution gap -- a `swap` action writes `principal` rows, and those are
   * excluded from `principalChangeUsd` on purpose, because a conversion that
   * happened before any capital was deployed is not something the pool did.
   * That gap is real money (-$0.60, +$0.51, +$0.01 on the three) and it is a
   * cost of getting in, so it belongs on this side rather than in IL. Label it
   * for EVERY cost wherever it is rendered -- "fees" alone invites the reader
   * to add up Fees earned, Fees paid and Rent and find they do not reach it.
   *
   * OPEN QUESTION, pre-existing and NOT introduced here: net rent (about -$2
   * per cycle, 7-29% of each strategy headline) lands in this field as though
   * spent, while `kindOf()` in ./ledger.ts classifies rent as `recoverable`.
   * If that classification is right the money does not belong in a result at
   * all -- but it is already inside `lpPnlUsd`, so the fix is to the project's
   * one definition of P&L, not to this split, and it would move the headline
   * of every operation ever reported. Do not patch it here.
   */
  feesAndCostsUsd: number;
  /**
   * What the pool cost relative to doing nothing: `principalChangeUsd -
   * hodlPnlUsd`.
   *
   * A fee-free AMM position is worth less than holding at every price but the
   * entry, so a NEGATIVE value is the only physically meaningful one -- but
   * that is a property of rows that describe ONE position closed at ONE set of
   * prices, NOT something this arithmetic enforces. A positive value is an
   * ALARM, not an impermanent gain: rows that imply buying SOL far below the
   * market produce it. Two other shapes produce it too -- a partial withdrawal whose
   * closes land at different prices (the benchmark marks the whole basket at
   * the LAST close price while each withdrawal is marked at its own), and a
   * `debt` pair booked on a `create_lp` action, whose positive leg lands in
   * `openPrincipal` while its cancelling leg does not. Never clamp it at zero:
   * the sign is the detector.
   *
   * Null exactly when `hodlPnlUsd` is null. Zero would assert the pool cost
   * nothing, which is the one thing an unknown benchmark cannot establish.
   *
   * THE IDENTITY, and the reason these three fields exist:
   *
   *     strategyUsd === impermanentLossUsd + feesAndCostsUsd
   *
   * It holds exactly, and it is what makes a losing cycle readable. The same
   * -$30 means "the range was wrong" when IL dominates and "the position was
   * closed too early" when the fees simply had no time to accrue -- and those
   * two have opposite fixes. See tests/pnl/operations.test.ts.
   */
  impermanentLossUsd: number | null;
  /**
   * A SECOND benchmark: the whole cost basis converted to SOL at this
   * operation's open price and held to its close.
   *
   * ADDED alongside `hodlPnlUsd`, never substituted for it, and the
   * distinction is load-bearing. `hodlPnlUsd` is the DEPOSITED BASKET held,
   * which is what makes `impermanentLossUsd` mean anything at all -- IL is
   * defined against the basket the pool actually consumed, and the identity
   * above holds only against that basket. Swapping this field in for it would
   * silently delete the IL decomposition.
   *
   * It answers the different question an operator actually asks: "would I have
   * done better just buying SOL?" The two can disagree in SIGN, so showing
   * either one alone is misleading. Over the first six closed cycles the
   * strategy is -$73.61 against the deposited basket and +$59.13 against
   * all-SOL, because the basket is roughly half stablecoin while all-SOL is
   * full exposure and SOL fell ~8.6% across the period. Both are true. Show
   * them side by side.
   *
   * SOL/USDC-specific, like the mark in ./unrealised.ts: it needs a price for
   * the volatile leg at both ends and this project runs one pair.
   *
   * Null, never 0, when either SOL price is missing -- 0 would assert the
   * volatile leg did not move, which is the one thing this comparison exists
   * to measure.
   */
  allSolPnlUsd: number | null;
  /** Why the all-SOL benchmark is unknown. Null exactly when `allSolPnlUsd` is not. */
  allSolUnknownReason: string | null;
}

/**
 * One point on the chart.
 *
 * `hodlCumUsd` goes null the moment any operation's HODL value is unknown and
 * stays null afterwards: a cumulative total with a hole in it is not a smaller
 * number, it is an unknown one.
 */
export interface SeriesPoint {
  t: string;
  /** Null on the origin point that seeds the line at zero. */
  operationId: string | null;
  lpCumUsd: number;
  hodlCumUsd: number | null;
  /**
   * The same three strategies as a cumulative RETURN in percent, compounded
   * cycle by cycle: `r = (r + 1) * (1 + pnlUsd / costBasisUsd) - 1`.
   *
   * PERCENT AND NOT A DOLLAR INDEX, and the distinction is presentational but
   * it was a real misread: a "$100 -> $96.87" index makes a reader look for a
   * $100 deposit that never happened. The quantity is a return; say so.
   *
   * WHY NOT CUMULATIVE DOLLARS, which `lpCumUsd` already gives. Dollars weight
   * each cycle by its own size, and this bot's size jumped ~4x mid-record (two
   * cycles at ~$1k, four at ~$3.7k) -- so the dollar chart's slope changes
   * meaning partway along and reads as performance when part of it is just
   * more capital. A return cannot be moved by deposit size at all, which is
   * the property `operations.test.ts` pins by scaling a cycle 100x.
   *
   * `costBasisUsd` is the denominator for ALL THREE lines. Not `capitalInUsd`
   * for any of them: the two differ (it is a low-water mark that includes the
   * funding swap) and mixing them stops the ratio being apples-to-apples.
   *
   * MATCHED WINDOWS, deliberately: every line moves only while a position was
   * actually live, and nothing moves in the gaps between cycles. The gaps are
   * the operator not having pressed confirm yet, not a decision the strategy
   * made, so charging them to any line measures reaction time. Revisit this
   * if D1's `/wait` ever parks the bot deliberately for days -- that WOULD be
   * a strategy choice.
   *
   * `allSolReturnPct` is the question the operator actually asks ("would I
   * have done better just buying SOL"); `mixReturnPct` holds the SAME exposure
   * as the LP, so it is the only one that isolates what the POOL did. The two
   * routinely disagree -- never ship the first without the second. A null
   * propagates and stays null, like `hodlCumUsd`.
   */
  lpReturnPct: number;
  allSolReturnPct: number | null;
  mixReturnPct: number | null;
}

export interface PnlTotals {
  completedOperations: number;
  lpPnlUsd: number;
  hodlPnlUsd: number | null;
  strategyUsd: number | null;
  /**
   * The second benchmark, summed: every cycle's stake held as SOL instead.
   * See `OperationPnL.allSolPnlUsd` for why this is additive to `hodlPnlUsd`
   * and must never replace it.
   */
  allSolPnlUsd: number | null;
  /** `lpPnlUsd - allSolPnlUsd`. The all-SOL twin of `strategyUsd`. */
  vsAllSolUsd: number | null;
  /** Sum of the cost bases. This is turnover, NOT capital -- the same dollars recur. */
  costBasisUsd: number;
  firstOpenedAt: Date | null;
  lastClosedAt: Date | null;
}

export interface ReportOptions {
  /** Joined on operationId. Decoration -- an operation without one still renders. */
  positions?: readonly PositionContext[];
  /** Operations the operator has set aside; see PNL_EXCLUDE_OPERATIONS. */
  excludeOperations?: readonly string[];
}

export interface PnlReport {
  /** Completed cycles only -- see buildReport. */
  series: SeriesPoint[];
  totals: PnlTotals;
  /**
   * The completed operations `series` and `totals` were computed FROM.
   *
   * On the wire so a reader can recompute both over a subset -- the dashboard's
   * date filter does exactly that, with these same two functions. Without it a
   * filtered chart would have to slice a CUMULATIVE line, which starts the
   * result partway up the axis at a number nothing explains.
   */
  completed: OperationPnL[];
  /** Every operation, whatever state it is in. */
  ledger: LedgerOperation[];
  /**
   * Where each STILL-OPEN operation stands at its last reading.
   *
   * Separate from everything above and read by nothing above: `series`,
   * `totals` and `completed` are settled operations only, and a mark that
   * leaked into them would turn the record into a quote for SOL.
   */
  unrealised: UnrealisedPnL[];
}

/* ------------------------------------------------------------------ *
 * The ledger view: operation -> transaction -> movement.
 *
 * This is the schema's own hierarchy, stated in
 * docs/v1-confidential/ledger-schema.md: one transaction produces many rows
 * (grouped by tx_id); one P&L cycle produces many transactions (grouped by
 * operation_id). Nothing below branches on an action name, so a lending or
 * staking operation groups here exactly as an LP one does.
 * ------------------------------------------------------------------ */

/**
 * What the `positions` table knows and the ledger does not.
 *
 * `range_lower`/`range_upper` never reach `ledger_entries`, and `operation_id`
 * is the ONLY safe join between the two tables -- `ledger_entries.position_id`
 * holds an NFT mint while `predictions.position_id` holds a cuid.
 *
 * Every field here is DECORATION. An operation with no matching position still
 * renders; it simply has no range and no lifecycle dates.
 */
export interface PositionContext {
  operationId: string | null;
  nftMint: string;
  poolId: string;
  rangeLower: number;
  rangeUpper: number;
  isOpen: boolean;
  openedAt: Date | null;
  adoptedAt: Date | null;
  closedAt: Date | null;
  prevPositionId: string | null;

  /**
   * The latest MEASURED reading, from the monitor loop. All null until a tick
   * has run, and null forever on positions closed before the columns existed.
   * These are amounts the chain reported, not amounts inferred from the range:
   * the recorded range is the REQUESTED one and Raydium snaps it to ticks, so
   * recovering the composition analytically disagrees with itself by ~1.5% and
   * reports a non-zero loss at the open price, where it must be exactly zero.
   */
  lastReadAt: Date | null;
  lastPrice: number | null;
  lastSolAmount: number | null;
  lastUsdcAmount: number | null;
  lastFeesUsd: number | null;
  lastInRange: boolean | null;
}

/**
 * Where an OPEN position stands right now, from the last reading taken.
 *
 * Deliberately NOT an `OperationPnL`. A settled operation's figures are final
 * and come from `ledger_entries`; these move every tick, are a mark rather
 * than a result, and must never reach `buildTotals`, `buildSeries` or the
 * record. There is no `strategyUsd` here for exactly that reason -- an
 * unsettled operation has no verdict, and giving it one invites the mark to be
 * read as performance.
 *
 * Every field is null when the reading is missing, because a position that has
 * not been read is not a position worth zero.
 */
export interface UnrealisedPnL {
  operationId: string;
  /** When the reading was taken. Render it: a stale mark must look stale. */
  markedAt: Date | null;
  priceUsd: number | null;
  inRange: boolean | null;
  /** Principal only, at the marked price. Fees are separate and may be null. */
  positionValueUsd: number | null;
  /** The deposited basket at the same marked price. */
  hodlValueUsd: number | null;
  /** `positionValueUsd - hodlValueUsd`. The pool's cost so far. */
  impermanentLossUsd: number | null;
  /** Unclaimed fees the chain reported. Null when either leg was unreadable. */
  feesSoFarUsd: number | null;
  /** Why the figures are null, when they are. */
  unknownReason: string | null;
}

/**
 * How a category affects the money, keyed by category and nothing else.
 *
 * An UNKNOWN category maps to `movement`, not to a cost. That is deliberate:
 * the operation's net is the sum of every row regardless, so nothing can hide
 * from the bottom line by failing to be recognised here -- only from the
 * summary breakdown, where a wrong guess would be worse than an unclassified
 * one.
 */
export type MovementKind = 'movement' | 'earned' | 'paid' | 'recoverable';

export interface Movement {
  category: string;
  kind: MovementKind;
  token: string;
  tokenAddress: string | null;
  amount: number;
  priceUsd: number;
  valueUsd: number;
  description: string | null;
  /**
   * The operation's running total after this movement, in USD.
   *
   * OPERATION-scoped, not transaction-scoped: it carries across every
   * transaction in the cycle, so the last movement's balance IS the
   * operation's result. That is what makes the ledger prove itself -- a
   * balance that does not land on `netUsd` means a row was lost.
   */
  balanceUsd: number;
}

/** What a router promised, pulled out of the preserved quote for display. */
export interface QuoteSummary {
  priceImpactPct: number | null;
  slippageBps: number | null;
  routeLabels: string[];
  /**
   * Whether the route stated any fee of its own.
   *
   * False means the pool's cut is inside the quoted amount with nothing naming
   * it, so the swap's cost cannot be read off the rows. Shown, because "no fee
   * row" and "the router did not say" look identical otherwise.
   */
  feesReported: boolean;
}

export interface LedgerTransaction {
  txId: string;
  at: Date;
  action: string;
  protocol: string;
  chain: string;
  /**
   * Double-entry, from the WALLET's point of view. The wallet is an asset
   * account, so money arriving is a debit and money leaving is a credit --
   * the opposite of a bank statement, which is written from the bank's side.
   *
   * Both are reported POSITIVE. The column a figure sits in carries the
   * direction; a sign as well would say the same thing twice and disagree the
   * moment one of them is wrong.
   */
  debitUsd: number;
  creditUsd: number;
  /** Every movement in this transaction, summed. Always `debitUsd - creditUsd`. */
  netUsd: number;
  /** The operation's running total after this transaction. */
  balanceUsd: number;
  movements: Movement[];
  quote: QuoteSummary | null;
}

/** A token's price at the start and end of an operation, when it moved. */
export interface PriceTrack {
  token: string;
  tokenAddress: string | null;
  openUsd: number;
  /** Null while the operation is unfinished -- there is no "end" price yet. */
  closeUsd: number | null;
}

/**
 * - `open`        a joined position says it is still open
 * - `closed`      finished, and the record is complete enough to be a P&L
 * - `incomplete`  finished, but the capital that funded it was never booked
 * - `set-aside`   the operator excluded it (a test run); see PNL_EXCLUDE_OPERATIONS
 */
export type OperationStatus = 'open' | 'closed' | 'incomplete' | 'set-aside';

export interface LedgerOperation {
  operationId: string;
  status: OperationStatus;
  position: PositionContext | null;

  firstAt: Date;
  lastAt: Date;
  durationHours: number | null;

  /**
   * The deepest this operation was ever out of pocket, in USD.
   *
   * NOT a sum of negative rows -- that double-counts a funding swap, which
   * moves money WITHIN the operation before any of it is deployed. Taking the
   * low-water mark of the running total gives one number that is true of any
   * shape of operation, including ones with several internal transfers.
   *
   * Null when the running total never went negative, which is exactly the
   * adopted-position case: money came back that this record never saw leave.
   */
  capitalInUsd: number | null;
  /** What came back. Null unless capital in is known and the operation settled. */
  capitalOutUsd: number | null;
  /** Every row summed. Only a profit figure when `netIsPnl`. */
  netUsd: number;
  /**
   * Whether `netUsd` may be read as profit.
   *
   * False for an open operation (the capital is deployed, not lost) and for an
   * incomplete record (returned principal would read as pure profit -- the
   * +$10.36 case).
   */
  netIsPnl: boolean;

  /** Null while unfinished: fees are realised at the close and are not booked before it. */
  feesEarnedUsd: number | null;
  feesPaidUsd: number;
  rentLockedUsd: number;
  rentReturnedUsd: number;

  prices: PriceTrack[];
  transactions: LedgerTransaction[];
}
