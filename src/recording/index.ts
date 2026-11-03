/**
 * Fail-soft recording facade over src/db.
 *
 * WHY THIS LAYER EXISTS, rather than calling src/db directly:
 *
 * 1. `src/db/index.ts` constructs `new PrismaClient()` at MODULE SCOPE. Importing
 *    it from the money path would pull @prisma/client into every test that
 *    touches Orchestrator, and tests must not need a database. Everything here
 *    loads it lazily, the same way the bot lazily requires RaydiumClient.
 *
 * 2. The failure policy is asymmetric, and putting it in one place is the only
 *    way to keep it consistent (docs/v1/database-schema.md):
 *
 *      WRITES DEGRADE. A ledger or position write that fails is logged loudly
 *      and dropped. The money has already moved on-chain; refusing to continue
 *      does not un-move it, and a bot that cannot trade because Postgres
 *      hiccuped is worse than one with a gap in its history.
 *
 *      READS THAT GATE SPENDING FAIL CLOSED. Position age decides whether to
 *      rebalance WITHOUT asking. If it cannot be established -- no row, DB
 *      unreachable, ambiguous -- the answer is null and the caller must ask.
 *      Unknown age is not young age.
 *
 * Nothing in this module throws. Callers on the money path are not expected to
 * handle failures, because they must not change behaviour based on them.
 */

/** Recording is off when there is nowhere to record to, or in a test process. */
function isEnabled(): boolean {
  if (process.env.JEST_WORKER_ID !== undefined || process.env.NODE_ENV === 'test') {
    return false;
  }
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Lazily load the db layer. Returns null when recording is off, so callers turn
 * into no-ops without importing Prisma at all.
 */
function db(): typeof import('../db') | null {
  if (!isEnabled()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../db') as typeof import('../db');
  } catch (error: any) {
    console.error('[Recording] db layer unavailable:', error?.message ?? error);
    return null;
  }
}
import type { Category } from '../db/ledger';
import { checkVocabulary } from './ledgerVocabulary';
import { verifyEffects, describeVerification } from '../orchestrator/verifyEffects';

/**
 * Hard ceiling on how long recording may delay the money path.
 *
 * A try/catch bounds FAILURE, not SLOWNESS, and slowness is the worse of the
 * two here: every one of these calls sits between an on-chain action and the
 * code that reports it. Measured, a refused connection (Postgres down) fails in
 * ~158ms, which is nothing beside the multi-second RPC calls already on this
 * path. But a network partition -- packets dropped with no RST -- is not the
 * same thing, and an unbounded TCP connect can hang for the OS default.
 *
 * Prisma has its own connect timeout, so this is belt-and-braces. It is here
 * because the default belongs to a dependency, and this project has been bitten
 * repeatedly by trusting someone else's default on the money path.
 */
const RECORDING_TIMEOUT_MS = 5_000;

/** Run a write, swallowing any failure and bounding how long it can block. */
async function attempt(what: string, fn: () => Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${RECORDING_TIMEOUT_MS}ms`)),
          RECORDING_TIMEOUT_MS
        );
      }),
    ]);
  } catch (error: any) {
    // Loud, because a silent gap in the ledger is how you end up unable to say
    // whether you made money.
    console.error(`[Recording] FAILED to record ${what}:`, error?.message ?? error);
  } finally {
    // Without this the pending timer keeps the event loop alive for up to
    // RECORDING_TIMEOUT_MS after every successful write.
    if (timer) clearTimeout(timer);
  }
}

export interface PositionOpened {
  nftMint: string;
  poolId: string;
  rangeLower: number;
  rangeUpper: number;
  solDeposited: number;
  usdcDeposited: number;
  operationId?: string;
  /** The position this one replaced, when this open is part of a rebalance. */
  prevPositionId?: string;
}

/**
 * One token movement, as the money path describes it.
 *
 * Deliberately thinner than `LedgerRowInput` in `src/db/ledger.ts`: the fields
 * that are the same for every row of one event -- chain, protocol, operation id,
 * transaction -- are supplied once by `recordLedgerRows` rather than repeated on
 * each row, because repeating them is how they drift.
 */
export interface LedgerMovement {
  action: string;
  category: Category;
  /** Display label, e.g. 'SOL'. NOT the identity -- see tokenAddress. */
  token: string;
  /** Mint address. The real identity: the same symbol is a different asset per chain. */
  tokenAddress?: string;
  /** Positive into the wallet, negative out of it. */
  amount: number;
  priceUsd: number;
  /** Where priceUsd came from, e.g. 'raydium-pool'. */
  priceSource?: string;
  positionId?: string;
  description?: string;
}

/**
 * Book the rows for one money event.
 *
 * THE MISSING SURFACE. `src/db/ledger.ts` has had fourteen query functions and a
 * migrated schema for weeks; `ledger_entries` had zero rows because this facade
 * exposed no way to write one, so there was nothing for a call site to call.
 *
 * A WRITE, so it degrades. A ledger that cannot be written must never stop a
 * trade that already happened on-chain -- the row is bookkeeping, the position
 * is real. The asymmetry is the facade's whole contract: writes degrade, reads
 * that gate spending fail closed.
 *
 * `valueUsd` is computed here, once, as `amount * priceUsd`, and frozen. It is
 * never recalculated: a later price change does not alter what was true then.
 *
 * Callers must not call this for a DRY_RUN result, for the same reason
 * `recordPositionOpened` must not -- a simulated event never happened.
 */
export async function recordLedgerRows(input: {
  /** On-chain signature. Groups the rows of ONE transaction. */
  txId: string;
  /** Groups every transaction of one P&L cycle. The position's operationId. */
  operationId: string;
  /** Defaults to solana. */
  chain?: string;
  /** e.g. 'raydium' | 'jupiter'. */
  protocol: string;
  movements: LedgerMovement[];
  /**
   * What the transaction ACTUALLY did to the wallet, per token symbol.
   *
   * Supply it and the rows are checked against it before they are written:
   * every balance delta of a transaction has a cause, and one that our rows do
   * not account for is a MISSING INSTRUCTION EFFECT, never a cost to book.
   * There is deliberately no `unexplained` category to put it in.
   *
   * Omitting it skips the check, which is right only where the actual deltas
   * genuinely cannot be read. It is not a way to quiet a failure -- when this
   * complains, the fix is to find the cause, implement that effect and add a
   * test, never to stop passing the argument.
   */
  actualByToken?: Record<string, number>;
  /** Preserved verbatim on the first row, for swaps. What the router promised. */
  quote?: unknown;
}): Promise<void> {
  const layer = db();
  if (!layer) return;
  if (input.movements.length === 0) return;

  for (const m of input.movements) {
    const problem = checkVocabulary(m);
    if (problem) {
      // Refuse the whole event rather than book a partial one. Half of a
      // movement pair is worse than none: the P&L would not balance and
      // nothing would say why.
      console.error(`[Ledger] Refusing ${input.txId}: ${problem}`);
      return;
    }
  }

  if (input.actualByToken) {
    const verification = verifyEffects(input.movements, input.actualByToken);
    if (!verification.verified) {
      // LOUD, but not fatal. Money has already moved by the time we are here,
      // and recording nothing because a check failed is worse than recording
      // the rows plus this complaint -- reads that gate spending fail closed,
      // writes degrade. The rows still go in so the movement is not lost; the
      // complaint is what says they are incomplete.
      console.error(describeVerification(verification, input.txId));
    }
  }

  await attempt(`ledger rows for ${input.txId}`, async () => {
    const count = await layer.ledgerService.insertLedgerEntries(
      input.movements.map((m, i) => ({
        txId: input.txId,
        operationId: input.operationId,
        chain: input.chain ?? 'solana',
        protocol: input.protocol,
        action: m.action,
        category: m.category,
        token: m.token,
        tokenAddress: m.tokenAddress,
        amount: m.amount,
        priceUsd: m.priceUsd,
        valueUsd: m.amount * m.priceUsd,
        priceSource: m.priceSource,
        positionId: m.positionId,
        description: m.description,
        // The quote belongs to the transaction, not to a movement, and rows
        // have no other home for it. Putting it on every row would repeat a
        // blob; the first row carries it.
        quote: i === 0 ? (input.quote as never) : undefined,
      }))
    );
    console.log(`[Ledger] ${count} row(s) for ${input.protocol} ${input.movements[0].action}`);
  });
}

/**
 * Record what the model said, BEFORE anything is opened from it.
 *
 * Returns the row id so the caller can link it to the position that follows,
 * or null when nothing was written.
 *
 * WHY BEFORE. The prediction exists before the position does -- the same
 * ordering that forces `operation_id` to be minted before the funding swap.
 * Recording only after a successful create would lose every prediction that
 * was ACTED ON AND FAILED, which is precisely the set worth studying: a range
 * that could not be opened is a fact about the range, not an absence of one.
 *
 * Degrades like every other write here. A prediction that cannot be recorded
 * must never stop a position being opened; the range is already decided and
 * refusing to spend over a logging failure would be the wrong asymmetry.
 */
export async function recordPrediction(input: {
  poolId: string;
  source: string;
  anchorPrice: number;
  priceLower: number;
  priceUpper: number;
  widthPct: number;
  solRatio: number;
  features?: Record<string, number>;
  neighborStats?: Record<string, number>;
}): Promise<string | null> {
  const layer = db();
  if (!layer) return null;

  let id: string | null = null;
  await attempt(`prediction for ${input.poolId}`, async () => {
    const row = await layer.predictionService.createPrediction(input);
    id = row.id;
    console.log(
      `[Recording] prediction [${input.source}]: ` +
        `$${input.priceLower.toFixed(2)} - $${input.priceUpper.toFixed(2)}`
    );
  });

  return id;
}

/**
 * Attach a recorded prediction to the position it produced, BY NFT MINT.
 *
 * The caller has a mint, because that is the identity everything else in this
 * system uses -- `positions.nft_mint` is unique, `ledger_entries.position_id`
 * holds a mint, and it is the value the chain knows. But
 * `predictions.position_id` is a foreign key to `positions.id`, a cuid nothing
 * outside that table needs. So the mint is resolved here rather than leaking
 * the cuid to callers.
 *
 * Passing the mint straight through would not error loudly -- the FK would
 * reject it, `attempt` would swallow the rejection, and every prediction would
 * silently fail to link. Two identifiers sharing the name `position_id` is a
 * known inconsistency in this schema; unifying on the mint is the eventual
 * fix, and this is the seam that will make it a one-line change.
 *
 * A no-op when either id is missing, which is the normal case for a prediction
 * that never became a position.
 */
export async function linkPrediction(
  predictionId: string | null,
  nftMint: string | undefined
): Promise<void> {
  if (!predictionId || !nftMint) return;

  const layer = db();
  if (!layer) return;

  await attempt(`link prediction ${predictionId}`, async () => {
    const position = await layer.positionService.getPositionByMint(nftMint);
    if (!position) {
      console.warn(
        `[Recording] prediction ${predictionId} not linked: no position row for ${nftMint}.`
      );
      return;
    }
    await layer.predictionService.linkPredictionToPosition(predictionId, position.id);
  });
}

/**
 * Record a position that is confirmed on-chain.
 *
 * Callers MUST NOT call this for a DRY_RUN result. A simulated create returns a
 * real SDK-derived nftMint with `txId: 'DRY_RUN'`, and recording it would put a
 * position in the database that does not exist on-chain -- the same mistake that
 * filled .orchestrator-state with seven phantom ACTIVE rows.
 */
export async function recordPositionOpened(input: PositionOpened): Promise<void> {
  const layer = db();
  if (!layer) return;

  await attempt(`position opened ${input.nftMint}`, async () => {
    await layer.positionService.createPosition({
      nftMint: input.nftMint,
      poolId: input.poolId,
      rangeLower: input.rangeLower,
      rangeUpper: input.rangeUpper,
      solDeposited: input.solDeposited,
      usdcDeposited: input.usdcDeposited,
      operationId: input.operationId,
      // Was declared on PositionOpened and silently dropped here -- the same
      // shape of bug as tokenAddress on the ledger row: accepted by the
      // compiler, absent from the database.
      prevPositionId: input.prevPositionId,
    });
    console.log(`[Recording] position opened: ${input.nftMint}`);
  });
}

export interface PositionClosed {
  solWithdrawn?: number;
  usdcWithdrawn?: number;
  feesEarnedUsd?: number;
}

/**
 * Mark a position closed.
 *
 * Call this BEFORE creating any replacement. If the close lands and the create
 * then throws, the old mint is burned on-chain; a row still marked open is a lie
 * that outlives the incident, and the monitoring loop will keep querying a
 * position that no longer exists.
 *
 * Withdrawal figures are optional because only `handleClosePosition` knows them
 * -- every Orchestrator close returns `{txId}` alone.
 */
export async function recordPositionClosed(
  nftMint: string,
  data: PositionClosed = {}
): Promise<void> {
  const layer = db();
  if (!layer) return;

  await attempt(`position closed ${nftMint}`, async () => {
    // closePosition swallows its own errors and returns null, so a throw is not
    // the only failure mode -- checking the return value is the only way to
    // tell a real close from a no-op. Logging "position closed" for a row that
    // was never updated is the kind of false success this whole layer exists to
    // avoid; it was doing exactly that until an integration run caught it.
    const updated = await layer.positionService.closePosition(nftMint, data);
    if (updated === null) {
      console.error(
        `[Recording] FAILED to record position closed ${nftMint}: ` +
          `no such row (it may never have been recorded as opened)`
      );
      return;
    }
    console.log(`[Recording] position closed: ${nftMint}`);
  });
}

/**
 * The pool and operation a recorded position belongs to, or null.
 *
 * A READ, but not one that gates spending -- it exists so a close can book its
 * ledger rows under the same `operation_id` the open used, which is what makes
 * the two ends of one P&L cycle group together. Null means the ledger rows are
 * skipped and said so; the position row itself is recorded either way.
 */
export async function getPositionContext(
  nftMint: string
): Promise<{ poolId: string; operationId: string | null } | null> {
  const layer = db();
  if (!layer) return null;

  try {
    const row = await layer.positionService.getPositionByMint(nftMint);
    if (!row) return null;
    return { poolId: row.poolId, operationId: row.operationId };
  } catch (error: any) {
    console.error('[Recording] could not read position context:', error?.message ?? error);
    return null;
  }
}

/**
 * Persist the latest reading of a live position. Never throws, never blocks.
 *
 * This sits in the 30s monitoring loop, so it obeys the same ceiling as every
 * other recording call and DEGRADES on failure: the loop is watching real
 * money and must not stop because a display column could not be written. The
 * dashboard renders a missing reading as "unknown", which is the truth.
 *
 * `feesUsd` arrives already null-or-number from the caller and is written
 * through unchanged -- coercing an unreadable fee to 0 would show a position
 * that has earned nothing where the truth is that nobody knows.
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
    /** Total value, for the append-only observation. Null skips that row. */
    valueUsd?: number | null;
    /** The caller's heartbeat is due. Transitions are detected in the db layer. */
    heartbeat?: boolean;
  }
): Promise<boolean> {
  const layer = db();
  if (!layer) return false;

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      layer.positionService.recordPositionReading(nftMint, reading),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${RECORDING_TIMEOUT_MS}ms`)),
          RECORDING_TIMEOUT_MS
        );
      }),
    ]);
  } catch (error: any) {
    console.error(
      `[Recording] could not store reading for ${nftMint}:`,
      error?.message ?? error
    );
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Position age in hours, or null when it cannot be established.
 *
 * Null covers three different situations on purpose -- no row, an adopted
 * position with no known open time, and a database that could not be reached.
 * The caller's response to all three is identical and is the whole point: ask
 * the user rather than auto-rebalance. Distinguishing them would invite treating
 * one of them as "probably fine".
 */
export async function getPositionAgeHours(nftMint: string): Promise<number | null> {
  const layer = db();
  if (!layer) return null;

  let timer: NodeJS.Timeout | undefined;
  try {
    // Same ceiling as writes, and more important here: this read sits in the
    // 30s monitoring loop, so a hang would stall the loop that is watching a
    // live position. Timing out yields null, which the caller already handles
    // as "ask the user".
    const position = await Promise.race([
      layer.positionService.getPositionByMint(nftMint),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${RECORDING_TIMEOUT_MS}ms`)),
          RECORDING_TIMEOUT_MS
        );
      }),
    ]);
    if (!position) return null;
    return layer.positionService.getPositionAgeHours(position);
  } catch (error: any) {
    console.error(`[Recording] could not read age for ${nftMint}:`, error?.message ?? error);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The open position this bot recorded for a pool, or null.
 *
 * Used at boot: the process has just restarted, `.telegram-state` is gone, and
 * the only durable record of what we were holding is here. Returns null on
 * nothing-recorded, database-unreachable AND more-than-one-open, because the
 * caller's answer to all three is the same -- do not guess which position to
 * resume managing.
 *
 * More than one open row for a single pool means our own bookkeeping is already
 * inconsistent (a close that never got recorded, most likely). Picking one would
 * make the bot start managing a position it may not own.
 */
export async function getOpenPositionForPool(
  poolId: string
): Promise<{ nftMint: string; openedAt: Date | null } | null> {
  const layer = db();
  if (!layer) return null;

  let timer: NodeJS.Timeout | undefined;
  try {
    const open = await Promise.race([
      layer.positionService.getOpenPositions(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${RECORDING_TIMEOUT_MS}ms`)),
          RECORDING_TIMEOUT_MS
        );
      }),
    ]);

    const inPool = open.filter((p) => p.poolId === poolId);

    if (inPool.length === 0) return null;
    if (inPool.length > 1) {
      console.error(
        `[Recording] ${inPool.length} positions recorded open in ${poolId}. ` +
          `Refusing to pick one -- our bookkeeping is inconsistent.`
      );
      return null;
    }

    return { nftMint: inPool[0].nftMint, openedAt: inPool[0].openedAt };
  } catch (error: any) {
    console.error(`[Recording] could not read open positions:`, error?.message ?? error);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The operator this bot belongs to.
 *
 * The rebalance limit is a property of the BOT, not of a conversation, but
 * `bot_states` is keyed by telegram user id. After a restart there is no session
 * to read one from, so the authorization allowlist -- the only durable record of
 * who owns this bot -- is the source, exactly as boot recovery uses it.
 */
function operatorId(): number | null {
  const raw = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? '').split(',')[0]?.trim();
  const id = Number(raw);
  return Number.isFinite(id) && id !== 0 ? id : null;
}

/**
 * Today's rebalance count, or null when it cannot be established.
 *
 * NULL AND ZERO ARE DIFFERENT and the caller must not conflate them:
 *
 *   0     the operator genuinely has not rebalanced today -> allow
 *   null  we could not find out (no operator id, database unreachable) -> refuse
 *
 * The Postgres helper this replaces returned `false` from
 * hasExceededFailureLimit whenever no row existed, which collapsed both cases
 * into "allow" -- a spend limit that opens itself when the database is down.
 */
export async function getRebalanceCountToday(): Promise<number | null> {
  const layer = db();
  const id = operatorId();
  if (!layer || id === null) return null;

  let timer: NodeJS.Timeout | undefined;
  try {
    const state = await Promise.race([
      layer.botStateService.getBotState(id),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${RECORDING_TIMEOUT_MS}ms`)),
          RECORDING_TIMEOUT_MS
        );
      }),
    ]);

    // No row: this operator has never rebalanced. That is a real zero, not an
    // unknown -- refusing here would block the first rebalance forever.
    if (!state) return 0;

    const today = new Date().toISOString().split('T')[0];
    return state.lastRebalanceDate === today ? state.rebalancesToday : 0;
  } catch (error: any) {
    console.error('[Recording] could not read rebalance count:', error?.message ?? error);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Whether today's rebalances have hit the limit.
 *
 * FAILS CLOSED. This gates spending, so an unknown count is treated as "limit
 * reached" and the rebalance is refused. A bot that will not rebalance is
 * recoverable; one that rebalances without a cap is not -- and the cap
 * previously lived in `.telegram-state`, which Railway erases on every
 * redeploy, so on a deploy-heavy day there was effectively no limit at all.
 */
export async function hasExceededRebalanceLimit(limit: number): Promise<boolean> {
  const count = await getRebalanceCountToday();
  if (count === null) {
    console.warn(
      '[Recording] rebalance count unavailable; treating the limit as reached ' +
        '(a spend gate must fail closed)'
    );
    return true;
  }
  return count >= limit;
}

/**
 * Count a rebalance that has happened.
 *
 * A WRITE, so it degrades: the rebalance already occurred on-chain and refusing
 * to continue does not undo it. A dropped increment under-counts, which is the
 * failure direction worth accepting -- the read side fails closed and will
 * refuse once it cannot see a count at all.
 */
export async function recordRebalance(): Promise<void> {
  const layer = db();
  const id = operatorId();
  if (!layer || id === null) return;

  await attempt('rebalance count', async () => {
    const today = new Date().toISOString().split('T')[0];
    const existing = await layer.botStateService.getBotState(id);
    const next =
      existing && existing.lastRebalanceDate === today ? existing.rebalancesToday + 1 : 1;

    await layer.botStateService.upsertBotState({
      telegramUserId: id,
      telegramChatId: existing ? Number(existing.telegramChatId) : id,
      rebalancesToday: next,
      lastRebalanceDate: today,
    });
    console.log(`[Recording] rebalance count today: ${next}`);
  });
}

/**
 * Remember whether the operator wants the bot watching.
 *
 * This is INTENT, not status. Whether the loop is currently running is the
 * interval in memory; what has to survive a restart is the operator's decision,
 * because `/stop` must not be undone by a redeploy.
 *
 * Consulted at BOOT only (see recoverPosition), never per tick -- a flag read
 * every 30 seconds would be a database round trip to learn something that has
 * not changed since the process started.
 */
export async function recordMonitoringIntent(watching: boolean): Promise<void> {
  const layer = db();
  const id = operatorId();
  if (!layer || id === null) return;

  await attempt('monitoring intent', async () => {
    const existing = await layer.botStateService.getBotState(id);
    await layer.botStateService.upsertBotState({
      telegramUserId: id,
      telegramChatId: existing ? Number(existing.telegramChatId) : id,
      isMonitoring: watching,
      rebalancesToday: existing?.rebalancesToday ?? 0,
      lastRebalanceDate:
        existing?.lastRebalanceDate ?? new Date().toISOString().split('T')[0],
    });
    console.log(`[Recording] monitoring intent: ${watching}`);
  });
}

/**
 * Does the operator want the bot watching? Null when it cannot be established.
 *
 * Null is NOT "no". The caller is boot recovery, which has already found a
 * position recorded open AND present on-chain -- and a live position with no
 * recorded objection should be watched, because the alternative is silently
 * abandoning it, which is the failure this whole migration exists to fix.
 * Only an explicit `false` stops the resume.
 *
 * Note this is not a fail-open spend gate: watching is read-only, and every
 * branch that spends from the loop has its own gate that fails closed (the
 * rebalance cap, the deposit budget, and an unknown position age).
 */
export async function getMonitoringIntent(): Promise<boolean | null> {
  const layer = db();
  const id = operatorId();
  if (!layer || id === null) return null;

  try {
    const state = await layer.botStateService.getBotState(id);
    return state ? state.isMonitoring : null;
  } catch (error: any) {
    console.error('[Recording] FAILED to read monitoring intent:', error?.message ?? error);
    return null;
  }
}

/**
 * Remember how much the operator asked to deploy.
 *
 * A WRITE, so it degrades -- but note the read side does NOT, and that
 * asymmetry is the point: losing this write means the next open refuses and
 * asks again, which is an inconvenience. Treating a lost value as "no budget"
 * would mean deploying the whole wallet.
 */
export async function recordInvestmentAmount(amountUsd: number): Promise<void> {
  const layer = db();
  const id = operatorId();
  if (!layer || id === null) return;

  await attempt('investment amount', async () => {
    const existing = await layer.botStateService.getBotState(id);
    await layer.botStateService.upsertBotState({
      telegramUserId: id,
      telegramChatId: existing ? Number(existing.telegramChatId) : id,
      investmentAmount: amountUsd,
      rebalancesToday: existing?.rebalancesToday ?? 0,
      lastRebalanceDate:
        existing?.lastRebalanceDate ?? new Date().toISOString().split('T')[0],
    });
    console.log(`[Recording] investment amount: $${amountUsd.toFixed(2)}`);
  });
}

/**
 * How much to deploy, or null if it cannot be established.
 *
 * FAILS CLOSED, and this is the most consequential read in the facade.
 * `createNewPosition({ investmentUsd })` treats `undefined` as "deploy the
 * WHOLE WALLET" -- that is its documented historical behaviour, and it is why
 * the bot captured "$10" from the operator for months while depositing
 * everything. So a database hiccup must not look like an omitted budget.
 *
 * Null therefore means REFUSE, never "no limit". Callers must not pass the
 * result straight through: `investmentUsd: await getInvestmentAmount()` would
 * turn a failed read into a whole-wallet deposit, which is exactly the bug this
 * function exists to prevent. Check for null first, and on the rebalance path
 * check BEFORE closing anything.
 */
export async function getInvestmentAmount(): Promise<number | null> {
  const layer = db();
  const id = operatorId();
  if (!layer || id === null) return null;

  try {
    const state = await layer.botStateService.getBotState(id);
    const amount = state?.investmentAmount ?? null;
    if (amount === null || !Number.isFinite(amount) || amount <= 0) return null;
    return amount;
  } catch (error: any) {
    console.error('[Recording] FAILED to read investment amount:', error?.message ?? error);
    return null;
  }
}

/**
 * Remember which Telegram chat the operator is reachable at.
 *
 * A WRITE, so it degrades. Called on every authenticated update, which is both
 * cheap (an upsert on one row) and the only moment the value is certain --
 * `ctx.chat.id` is ground truth and nothing else in the system knows it.
 */
export async function recordOperatorChat(chatId: number): Promise<void> {
  const layer = db();
  const id = operatorId();
  if (!layer || id === null) return;

  await attempt('operator chat id', async () => {
    const existing = await layer.botStateService.getBotState(id);
    if (existing && Number(existing.telegramChatId) === chatId) return; // no-op
    await layer.botStateService.upsertBotState({
      telegramUserId: id,
      telegramChatId: chatId,
      rebalancesToday: existing?.rebalancesToday ?? 0,
      lastRebalanceDate:
        existing?.lastRebalanceDate ?? new Date().toISOString().split('T')[0],
    });
    console.log(`[Recording] operator chat id recorded`);
  });
}

/**
 * Where to send an unsolicited message, or null if we do not know.
 *
 * This is the field that used to live in `.telegram-state`, which is not on the
 * Railway volume -- so after a redeploy the bot had no chat id, `if
 * (!state?.chatId) return` dropped the approval prompt, and it went on
 * monitoring a live position while never speaking again. Silently: there is no
 * error, no retry, and nothing in the logs that looks wrong.
 *
 * A READ, but NOT one that gates spending -- it gates TELLING. Returning null
 * is therefore correct on failure: the caller skips a message it cannot
 * deliver. Never substitute the operator's user id here; a private chat happens
 * to share that number and a group chat does not, so the guess works until the
 * day it silently sends nothing.
 */
export async function getOperatorChatId(): Promise<number | null> {
  const layer = db();
  const id = operatorId();
  if (!layer || id === null) return null;

  try {
    const state = await layer.botStateService.getBotState(id);
    if (!state) return null;
    return Number(state.telegramChatId);
  } catch (error: any) {
    console.error('[Recording] FAILED to read operator chat id:', error?.message ?? error);
    return null;
  }
}

/**
 * Reset today's rebalance count to zero.
 *
 * Only for the operator's explicit "resume now (risky)" choice after the daily
 * limit has stopped the bot. Not automatic, and not a way around the cap: the
 * cap exists because repeated rebalancing in a volatile hour loses money to
 * swap fees faster than the position earns it.
 */
export async function resetRebalanceCount(): Promise<void> {
  const layer = db();
  const id = operatorId();
  if (!layer || id === null) return;

  await attempt('rebalance count reset', async () => {
    const existing = await layer.botStateService.getBotState(id);
    await layer.botStateService.upsertBotState({
      telegramUserId: id,
      telegramChatId: existing ? Number(existing.telegramChatId) : id,
      rebalancesToday: 0,
      lastRebalanceDate: new Date().toISOString().split('T')[0],
    });
    console.log('[Recording] rebalance count reset to 0');
  });
}

// ============================================
// Recovery state: desired state, a stranded budget, and the learned tip
// ============================================

/**
 * What the reconciler needs to know, read in one go.
 *
 * READS ON THIS PATH FAIL CLOSED. Null means "cannot establish", which the
 * reconciler treats as "do not act" -- never as "nothing is stranded". Getting
 * that backwards would let an unreachable database look like healthy state and
 * silence the very alarm this exists to raise.
 */
export interface RecoveryState {
  deployIntent: 'IDLE' | 'DEPLOYED';
  strandedUsd: number | null;
  strandedSince: Date | null;
  recoveryAttempts: number;
  lastRecoveryAt: Date | null;
}

export async function getRecoveryState(): Promise<RecoveryState | null> {
  const layer = db();
  const id = operatorId();
  if (!layer || id === null) return null;

  try {
    const state = await layer.botStateService.getBotState(id);
    if (!state) return null;
    return {
      deployIntent: state.deployIntent === 'DEPLOYED' ? 'DEPLOYED' : 'IDLE',
      strandedUsd: state.strandedUsd ?? null,
      strandedSince: state.strandedSince ?? null,
      recoveryAttempts: state.recoveryAttempts ?? 0,
      lastRecoveryAt: state.lastRecoveryAt ?? null,
    };
  } catch (error: any) {
    console.error('[Recording] FAILED to read recovery state:', error?.message ?? error);
    return null;
  }
}

/** The operator wants a position to exist (or explicitly does not). */
export async function recordDeployIntent(intent: 'IDLE' | 'DEPLOYED'): Promise<void> {
  const layer = db();
  const id = operatorId();
  if (!layer || id === null) return;

  await attempt('deploy intent', async () => {
    const existing = await layer.botStateService.getBotState(id);
    await layer.botStateService.upsertBotState({
      telegramUserId: id,
      telegramChatId: existing ? Number(existing.telegramChatId) : id,
      deployIntent: intent,
      rebalancesToday: existing?.rebalancesToday ?? 0,
      lastRebalanceDate:
        existing?.lastRebalanceDate ?? new Date().toISOString().split('T')[0],
    });
    console.log(`[Recording] deploy intent: ${intent}`);
  });
}

/**
 * A close succeeded and the money is in the wallet with nowhere to go.
 *
 * The AMOUNT is the reason this is written down rather than recomputed. Recovery
 * runs as a later invocation, by which time the position it came from is burned,
 * so `resolveOpenPosition` finds nothing and the budget silently falls back to
 * the configured INVESTMENT_AMOUNT. That happened for real on 2026-09-25: the
 * retry read `Budget $1000.00` against $1031.18 actually withdrawn, and would
 * have left $31 behind on every attempt.
 */
export async function recordStranded(usd: number): Promise<void> {
  const layer = db();
  const id = operatorId();
  if (!layer || id === null) return;

  await attempt('stranded funds', async () => {
    const existing = await layer.botStateService.getBotState(id);
    await layer.botStateService.upsertBotState({
      telegramUserId: id,
      telegramChatId: existing ? Number(existing.telegramChatId) : id,
      deployIntent: 'DEPLOYED',
      strandedUsd: usd,
      strandedSince: existing?.strandedSince ?? new Date(),
      // NOT reset: a fresh strand during a recovery run is the same episode, and
      // zeroing here would defeat the attempt ceiling and loop forever.
      recoveryAttempts: existing?.recoveryAttempts ?? 0,
      rebalancesToday: existing?.rebalancesToday ?? 0,
      lastRebalanceDate:
        existing?.lastRebalanceDate ?? new Date().toISOString().split('T')[0],
    });
    console.log(`[Recording] stranded $${usd.toFixed(2)} awaiting redeploy`);
  });
}

/** The funds are deployed again; the episode is over. */
export async function clearStranded(): Promise<void> {
  const layer = db();
  const id = operatorId();
  if (!layer || id === null) return;

  await attempt('stranded cleared', async () => {
    const existing = await layer.botStateService.getBotState(id);
    await layer.botStateService.upsertBotState({
      telegramUserId: id,
      telegramChatId: existing ? Number(existing.telegramChatId) : id,
      strandedUsd: null,
      strandedSince: null,
      recoveryAttempts: 0,
      lastRecoveryAt: null,
      rebalancesToday: existing?.rebalancesToday ?? 0,
      lastRebalanceDate:
        existing?.lastRebalanceDate ?? new Date().toISOString().split('T')[0],
    });
    console.log('[Recording] stranded funds cleared');
  });
}

/**
 * Count a recovery attempt BEFORE it runs.
 *
 * Before, deliberately: an attempt that crashes hard still has to count, or the
 * ceiling never bites and a persistent failure retries forever. This is the same
 * ordering as `recordRebalance`, for the same reason -- but against a SEPARATE
 * counter, because `rebalances_today` is checked by a cap that fails closed, and
 * sharing it would let three failures block the retries meant to undo them.
 */
export async function recordRecoveryAttempt(): Promise<void> {
  const layer = db();
  const id = operatorId();
  if (!layer || id === null) return;

  await attempt('recovery attempt', async () => {
    const existing = await layer.botStateService.getBotState(id);
    const attempts = (existing?.recoveryAttempts ?? 0) + 1;
    await layer.botStateService.upsertBotState({
      telegramUserId: id,
      telegramChatId: existing ? Number(existing.telegramChatId) : id,
      recoveryAttempts: attempts,
      lastRecoveryAt: new Date(),
      rebalancesToday: existing?.rebalancesToday ?? 0,
      lastRebalanceDate:
        existing?.lastRebalanceDate ?? new Date().toISOString().split('T')[0],
    });
    console.log(`[Recording] recovery attempt ${attempts}`);
  });
}

/**
 * The tip the ladder last landed at, in lamports. Null for a cold start.
 *
 * Persisted so the search for the smallest viable tip COMPOUNDS across restarts.
 * Railway redeploys often; without this the ladder re-derives its start every
 * process and can never walk the tip down. A failed read is a cold start, which
 * bids from the configured floor -- safe, just not yet cheap.
 */
export async function getLearnedTipLamports(): Promise<number | null> {
  const layer = db();
  const id = operatorId();
  if (!layer || id === null) return null;

  try {
    const state = await layer.botStateService.getBotState(id);
    return state?.lastTipLamports ?? null;
  } catch (error: any) {
    console.error('[Recording] FAILED to read learned tip:', error?.message ?? error);
    return null;
  }
}

export async function recordLearnedTipLamports(lamports: number): Promise<void> {
  const layer = db();
  const id = operatorId();
  if (!layer || id === null) return;

  await attempt('learned tip', async () => {
    const existing = await layer.botStateService.getBotState(id);
    await layer.botStateService.upsertBotState({
      telegramUserId: id,
      telegramChatId: existing ? Number(existing.telegramChatId) : id,
      lastTipLamports: Math.max(1, Math.floor(lamports)),
      rebalancesToday: existing?.rebalancesToday ?? 0,
      lastRebalanceDate:
        existing?.lastRebalanceDate ?? new Date().toISOString().split('T')[0],
    });
  });
}

/**
 * Every ledger row (oldest first) and every position's context: the inputs to
 * `buildReport`, read the same way dashboard/server/pnl.ts reads them.
 *
 * Not used by the money path.
 * Null when recording is off, the read fails, or it exceeds the recording
 * timeout.
 */
export async function loadPnlInputs(): Promise<{
  rows: import('../pnl').PnlRow[];
  positions: import('../pnl').PositionContext[];
} | null> {
  const layer = db();
  if (!layer) return null;

  let timer: NodeJS.Timeout | undefined;
  try {
    const read = Promise.all([
      layer.prisma.ledgerEntry.findMany({
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
      layer.prisma.position.findMany({
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
      }),
    ]);
    const [rows, positions] = await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${RECORDING_TIMEOUT_MS}ms`)), RECORDING_TIMEOUT_MS);
      }),
    ]);
    return { rows: rows as import('../pnl').PnlRow[], positions };
  } catch (error: any) {
    console.error('[Recording] could not read the ledger for publishing:', error?.message ?? error);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
