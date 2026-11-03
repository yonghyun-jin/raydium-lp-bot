// Orchestrator - owns the position lifecycle: prediction -> swap to ratio ->
// create, plus close, rebalance, stranded-funds recovery and the chain reads.
//
// Helpers live beside it: rangeSelection (which range), ledgerBooking (ledger
// rows per money event), openRetry (safe single retry), observations (the
// position series), capital (redeployable wallet), settings (config).
//
// Many guards in tests/ read THIS FILE's source text, so the money-path
// decisions (cap, close-before-reopen, record/gate/clear on create, operation
// id minting) must stay in this file, not in a helper.

import type { RaydiumClient } from '../raydium/client';
import { LpClient, TransactionEffects } from '../raydium/LpClient';
import {
  classifyFailure,
  mayRedeploy,
  recoveryBackoffMs,
  SETTLE_MS,
} from '../raydium/recoverability';
import {
  Config,
  validateConfig,
  PositionCreationResult,
  CreatePositionResult,
  ClosePositionResult,
  RebalanceOutcome,
  RecoveryOutcome,
} from './types';
import {
  PriceMonitor,
  RangeSetup,
  CreatePosition,
  ClosePosition,
  SwapToRatio,
} from './components';
import {
  recordPositionOpened,
  recordPositionClosed,
  hasExceededRebalanceLimit,
  recordRebalance,
  recordStranded,
  clearStranded,
  recordDeployIntent,
  getRecoveryState,
  recordRecoveryAttempt,
  getRebalanceCountToday,
  getPositionAgeHours,
  recordPrediction,
  linkPrediction,
  getInvestmentAmount,
  getOpenPositionForPool,
} from '../recording';
import type { RangePrediction } from './prediction';
import { getSolPrice } from '../price';
import type { PositionStatus } from '../telegram/types';
import type { PositionSummary } from '../raydium/LpClient';
import { newOperationId } from './types/Config';
import { OrchestratorConfig, DEFAULT_CONFIG } from './settings';
import { selectRange } from './rangeSelection';
import { bookSwap, bookOpen, bookClose, closeEffects as readCloseEffects } from './ledgerBooking';
import { retryOpenIfNothingSent } from './openRetry';
import { recordObservation } from './observations';
import { redeployableUsd } from './capital';

// There is deliberately no approval callback. The real ask/ack channel must
// report whether the question was delivered, which fire-and-forget cannot.

export class Orchestrator {
  private client: LpClient;
  private config: OrchestratorConfig;

  // Components
  private priceMonitor: PriceMonitor;
  private rangeSetup: RangeSetup;
  private createPosition: CreatePosition;
  private closePositionComponent: ClosePosition;
  private swapToRatio: SwapToRatio;

  // State
  private initialized: boolean = false;

  /**
   * The prediction row this run is opening from, if one was recorded.
   *
   * Cleared at the top of each getPrediction so a stale id can never be linked
   * to a later position.
   */
  private lastPredictionId: string | null = null;

  /** When each position last got a heartbeat observation (see observations.ts). */
  private lastObservationAt = new Map<string, Date>();

  // The daily rebalance count is durable (bot_states) and must not become an
  // instance field: that would reset on every process start.

  /**
   * @param config  Partial overrides for DEFAULT_CONFIG.
   * @param client  Optional LpClient. Tests inject a fake; production omits it
   *                and gets a real RaydiumClient, which loads a wallet and opens
   *                an RPC connection, so it must not be built when a fake is
   *                supplied.
   */
  constructor(config?: Partial<OrchestratorConfig>, client?: LpClient) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Required lazily so an injected client never loads the Solana SDK (whose
    // ESM-only dependencies Jest cannot require).
    if (client) {
      this.client = client;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const RealClient = require('../raydium/client').RaydiumClient as typeof RaydiumClient;
      this.client = new RealClient();
    }

    this.priceMonitor = new PriceMonitor(this.client);
    this.rangeSetup = new RangeSetup(this.client);
    this.createPosition = new CreatePosition(this.client);
    this.closePositionComponent = new ClosePosition(this.client);
    this.swapToRatio = new SwapToRatio(this.client, this.config.minSolReserve);
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    console.log('[Orchestrator] Initializing...');
    await this.client.init();
    this.initialized = true;
    console.log('[Orchestrator] Initialized');
  }

  /**
   * Today's rebalance count. `today` is null when it could not be read -- do
   * not render that as 0.
   */
  async getRebalanceCount(): Promise<{ today: number | null; limit: number }> {
    return {
      today: await getRebalanceCountToday(),
      limit: this.config.failureLimitPerDay,
    };
  }

  /** Range for the next position (see selectRange), recorded before use. */
  private async getPrediction(poolId: string): Promise<RangePrediction> {
    this.lastPredictionId = null;
    const prediction = await selectRange(this.priceMonitor, poolId, this.config);

    // Record HERE, before anything is opened from it: predictions acted on and
    // failed are the set most worth studying. The write degrades and never
    // blocks the spend.
    this.lastPredictionId = await recordPrediction({
      poolId,
      source: prediction.source,
      anchorPrice: prediction.current_price,
      priceLower: prediction.lower,
      priceUpper: prediction.upper,
      widthPct: prediction.width_pct,
      solRatio: prediction.sol_ratio,
      features: prediction.features,
      neighborStats: prediction.neighbor_stats,
    });

    return prediction;
  }

  /**
   * Close a position, and record that it closed.
   *
   * Recording lives here so every caller gets it and no UI can forget. It
   * happens BEFORE returning: if a rebalance's create throws next, the old mint
   * is already burned and a row still marked open would outlive the incident.
   *
   * Returns every figure, and does not decide what an absent one means: a
   * rebalance refuses on a null `valueBeforeUsd` (it is the next budget), while
   * `/close` reports "unknown".
   */
  async closePosition(nftMint: string): Promise<ClosePositionResult> {
    await this.init();

    const result = await this.closePositionComponent.execute(nftMint);

    await recordPositionClosed(nftMint, {
      solWithdrawn: result.solWithdrawn ?? undefined,
      usdcWithdrawn: result.usdcWithdrawn ?? undefined,
      feesEarnedUsd: result.feesEarnedUsd,
    });

    await this.bookLedgerRows(nftMint, result);

    return result;
  }

  /**
   * Swap to the deposit ratio, and book what moved.
   *
   * The operation id is passed IN because the swap happens before the config
   * exists, and its rows must be booked now under the cycle they fund --
   * booking later would lose them whenever the create throws.
   */
  private async swapAndBook(
    poolId: string,
    solRatio: number,
    budgetUsd: number | undefined,
    operationId: string
  ): Promise<void> {
    const swap = await this.swapToRatio.execute(poolId, solRatio, undefined, { budgetUsd });
    if (!swap) return; // already at the ratio -- nothing moved, nothing to book

    await bookSwap(swap, operationId);
  }

  /**
   * Close the current position and open a replacement at the model's range.
   *
   * THE ORDER IS THE SAFETY PROPERTY; do not reorder:
   *
   *   1. daily cap        -- fails CLOSED; an unreadable count counts as reached
   *   2. record the rebalance
   *   3. resolve the mint -- from the chain when no row records it, and
   *                          REFUSE on more than one: acting on a guess
   *                          eventually closes money that is not ours
   *   4. close            -- which reads the fees and the value BEFORE the send
   *   5. budget           -- what the closing position was worth, never the
   *                          configured amount
   *   6. settle, then create with a link back to what it replaced
   *
   * Returns what happened rather than acting on the UI; `closed-only` means the
   * position is GONE and must not be rendered as `refused`. `onProgress` is
   * one-way narration.
   */
  async rebalance(params: {
    poolId: string;
    onProgress?: (text: string) => Promise<unknown>;
  }): Promise<RebalanceOutcome> {
    await this.init();
    const say = params.onProgress ?? (async () => undefined);

    // Durable and fails CLOSED.
    if (await hasExceededRebalanceLimit(this.config.failureLimitPerDay)) {
      return { status: 'capped', limit: this.config.failureLimitPerDay };
    }

    await recordRebalance();

    try {
      let mintToClose = await this.resolveOpenPosition(params.poolId);

      if (mintToClose === 'ambiguous') {
        const open = await this.openPositionsInPool(params.poolId);
        return { status: 'refused', reason: 'ambiguous-position', openCount: open.length };
      }

      let investmentUsd: number;

      if (mintToClose) {
        await say('\u{1F4E4} Closing old position...');
        const closed = await this.closePosition(mintToClose);

        if (closed.valueBeforeUsd === null || !(closed.valueBeforeUsd > 0)) {
          // No fallback to the configured amount: substituting a number we did
          // not measure is the silent fallback the budget rule forbids. The
          // position is already closed, so say so.
          return { status: 'closed-only', closedMint: mintToClose };
        }

        investmentUsd = closed.valueBeforeUsd;
        await say(
          `\u2705 Old position closed (worth $${investmentUsd.toFixed(2)}, redeploying that).`
        );
        // Let the chain settle before reading balances for the new one.
        await this.sleep(2000);
      } else {
        // Nothing to close: a first open, so the configured amount applies,
        // and it still fails closed.
        const configured = await getInvestmentAmount();
        if (configured === null) return { status: 'refused', reason: 'no-budget' };
        investmentUsd = configured;
      }

      // Its own try: a throw HERE means the old position is already gone and
      // the money is idle in the wallet, which must not be reported as a
      // generic `failed`.
      let opened: PositionCreationResult;
      try {
        opened = await this.openWithExpiryRetry({
          poolId: params.poolId,
          investmentUsd,
          prevPositionMint: mintToClose ?? undefined,
        });
      } catch (error: any) {
        if (!mintToClose) throw error;

        // Persisted because nothing can recompute it: the source position is
        // burned, and a later attempt would fall back to the configured amount.
        await recordStranded(investmentUsd);

        return {
          status: 'closed-open-failed',
          closedMint: mintToClose,
          idleUsd: investmentUsd,
          error: error?.message ?? 'Unknown error',
          nothingSent: classifyFailure(error) === 'NOTHING_SENT',
        };
      }

      // Deployed again: clear the strand, or the reconciler redeploys money
      // that is already deployed.
      await clearStranded();
      await recordDeployIntent('DEPLOYED');

      return {
        status: 'rebalanced',
        opened,
        closedMint: mintToClose ?? undefined,
        redeployedUsd: investmentUsd,
      };
    } catch (error: any) {
      return { status: 'failed', error: error?.message ?? 'Unknown error' };
    }
  }

  /** Open, retrying once only when the failure provably sent nothing (see openRetry.ts). */
  private async openWithExpiryRetry(params: {
    poolId: string;
    investmentUsd: number;
    prevPositionMint?: string;
  }): Promise<PositionCreationResult> {
    return retryOpenIfNothingSent(() =>
      this.createNewPosition({
        poolId: params.poolId,
        investmentUsd: params.investmentUsd,
        duration: 0,
        prevPositionMint: params.prevPositionMint,
      })
    );
  }

  /**
   * Put stranded funds back into a position. THE GENERIC RECOVERY PATH.
   *
   * Called from the monitoring tick, not a failure handler: it compares DESIRED
   * state to ACTUAL state, so it covers failures nobody has classified. What
   * authorises a redeploy is STATE (no position on-chain), never the error;
   * only an in-flight send is a question of time, hence mayRedeploy's settle
   * window.
   */
  async recoverStranded(params: {
    poolId: string;
    onProgress?: (text: string) => Promise<unknown>;
  }): Promise<RecoveryOutcome> {
    await this.init();
    const say = params.onProgress ?? (async () => undefined);

    const state = await getRecoveryState();
    // Null is "cannot establish", never "nothing is stranded".
    if (!state) return { status: 'unknown' };
    if (state.deployIntent !== 'DEPLOYED') return { status: 'not-wanted' };
    if (state.strandedUsd === null || !(state.strandedUsd > 0)) {
      return { status: 'nothing-stranded' };
    }

    if (state.recoveryAttempts >= this.config.recoveryAttemptLimit) {
      return {
        status: 'exhausted',
        idleUsd: state.strandedUsd,
        attempts: state.recoveryAttempts,
        since: state.strandedSince ?? null,
      };
    }

    const msSinceLastAttempt = state.lastRecoveryAt
      ? Date.now() - state.lastRecoveryAt.getTime()
      : Number.POSITIVE_INFINITY;

    const backoff = recoveryBackoffMs(state.recoveryAttempts);
    if (msSinceLastAttempt < backoff) {
      return { status: 'waiting', reason: `backing off ${Math.round((backoff - msSinceLastAttempt) / 1000)}s` };
    }

    // The authoritative question.
    const open = await this.openPositionsInPool(params.poolId);
    const verdict = mayRedeploy({
      // UNKNOWN on purpose: the stranding error may be from a previous process,
      // and we must not re-derive confidence we no longer have.
      classification: 'UNKNOWN',
      positionsOnChain: open.length,
      msSinceLastAttempt:
        state.strandedSince ? Date.now() - state.strandedSince.getTime() : msSinceLastAttempt,
      settleMs: SETTLE_MS,
    });

    if (!verdict.allowed) {
      // A position exists after all, so the strand is stale (likely an earlier
      // attempt landed late). Resolve it rather than retry against it forever.
      if (open.length > 0) {
        console.log(
          `[Recovery] ${open.length} position(s) already open; clearing the stale strand.`
        );
        await clearStranded();
        return { status: 'already-deployed' };
      }
      return { status: 'waiting', reason: verdict.reason };
    }

    // Counted BEFORE the attempt so a hard crash still burns a try; otherwise
    // the ceiling never bites.
    await recordRecoveryAttempt();
    await say(
      `\u{1F504} Redeploying $${state.strandedUsd.toFixed(2)} that was left in the wallet ` +
        `(attempt ${state.recoveryAttempts + 1}/${this.config.recoveryAttemptLimit})...`
    );

    try {
      const opened = await this.openWithExpiryRetry({
        poolId: params.poolId,
        investmentUsd: state.strandedUsd,
      });
      await clearStranded();
      return { status: 'recovered', opened, redeployedUsd: state.strandedUsd };
    } catch (error: any) {
      return {
        status: 'failed',
        error: error?.message ?? 'Unknown error',
        idleUsd: state.strandedUsd,
        attempts: state.recoveryAttempts + 1,
      };
    }
  }

  /**
   * Which position in this pool is ours, from the record or from the chain.
   *
   * `'ambiguous'` (more than one open, none recorded) is an answer, not an
   * error: acting on it would eventually close money that is not ours.
   */
  private async resolveOpenPosition(poolId: string): Promise<string | null | 'ambiguous'> {
    const recorded = await getOpenPositionForPool(poolId);
    if (recorded) return recorded.nftMint;

    const open = await this.openPositionsInPool(poolId);
    if (open.length === 1) return open[0].nftMint;
    if (open.length > 1) return 'ambiguous';
    return null; // nothing to close; creating is safe
  }

  private async openPositionsInPool(poolId: string): Promise<any[]> {
    const all = await this.client.getMyPositions();
    return all.filter((p: any) => p.poolId?.toString?.() === poolId);
  }

  /** What a close did to the wallet, or null when unknowable (see ledgerBooking.ts). */
  private async closeEffects(
    nftMint: string,
    result: ClosePositionResult
  ): Promise<TransactionEffects | null> {
    return readCloseEffects(this.client, nftMint, result);
  }

  /** Book the ledger rows for a close (see ledgerBooking.ts). */
  private async bookLedgerRows(nftMint: string, result: ClosePositionResult): Promise<void> {
    return bookClose(this.priceMonitor, nftMint, result, (mint, closed) =>
      this.closeEffects(mint, closed)
    );
  }

  /**
   * Create a position. The single funnel every create passes through. The
   * operationId parameter is kept because callers pass both it and the Config.
   */
  async process(operationId: string, config: Config): Promise<CreatePositionResult> {
    await this.init();
    return await this.handleNewPosition(config);
  }

  /**
   * The create funnel: createNewPosition and createPositionManual both reach it
   * via process(), so the records below cover every create (but not scripts,
   * which drive the client directly).
   */
  private async handleNewPosition(config: Config): Promise<CreatePositionResult> {
    console.log('\n[Orchestrator] === New Position Flow ===');
    console.log(`[Orchestrator] OperationId: ${config.operationId}`);

    const validation = validateConfig(config);
    if (!validation.valid) {
      throw new Error(`Invalid config: ${validation.errors.join(', ')}`);
    }

    const result = await this.createPosition.execute(config);

    // ONE record of a create, AFTER it, gated on `landed`. A DRY_RUN create
    // returns a real SDK-derived nftMint with txId 'DRY_RUN' while moving
    // nothing; recording it (or recording before the create) writes phantom
    // positions. recordPositionOpened cannot throw, so a database problem
    // cannot fail a position that exists on-chain.
    const landed = result.txId !== 'DRY_RUN';

    if (!landed) {
      console.log('[Orchestrator] DRY_RUN: not recording a position that was never opened.');
    }

    if (landed) {
      await recordPositionOpened({
        nftMint: result.nftMint,
        poolId: config.poolId,
        rangeLower: config.priceLower,
        rangeUpper: config.priceUpper,
        solDeposited: result.solDeposited ?? config.coin1Amount,
        usdcDeposited: result.usdcDeposited ?? config.coin2Amount,
        operationId: config.operationId,
        // Undefined on a first open: there is nothing to link to.
        prevPositionId: (config as any).prevPositionMint,
      });

      // Linked after the position row exists, by NFT MINT.
      await linkPrediction(this.lastPredictionId, result.nftMint);

      await bookOpen(this.client, this.priceMonitor, config, result);
    }

    // A POSITION EXISTS, SO NOTHING IS STRANDED, whichever path opened it --
    // otherwise /status and /stop report deployed money as idle. GATED on
    // `landed` for the same DRY_RUN reason as above: clearing on a rehearsal
    // would disable recovery of a live strand. Degrades to a warning, since the
    // position is already open and recorded.
    if (landed) {
      try {
        await clearStranded();
      } catch (error: any) {
        console.warn(
          `[Orchestrator] Position created but the stranded flag could not be ` +
            `cleared (${error?.message ?? error}). /status may over-report idle funds.`
        );
      }
    }

    console.log(`[Orchestrator] New position created: ${result.nftMint}`);

    return result;
  }

  /*
   * THE READ LAYER. Every chain read here must `await this.init()` before
   * touching the client: an uninitialised client fails every read while the
   * caller's catch makes the bot look healthy. There is exactly one client.
   */

  /**
   * A position as the chain has it, plus the age only Postgres knows.
   *
   * Null for "cannot say", never a fabricated reading.
   */
  async getPositionStatus(nftMint: string): Promise<PositionStatus | null> {
    try {
      await this.init();
      const details = await this.client.getPositionDetails(nftMint);
      if (!details) {
        console.warn(`[Monitor] Position ${nftMint} not found on-chain`);
        return null;
      }

      // Age is not on-chain. Null propagates and routes to asking the operator;
      // never coerce it to 0 (that made a 44h position read as brand new).
      const ageHours = await getPositionAgeHours(nftMint);

      // Both legs or nothing -- half a fee figure is not a fee figure.
      const feesEarned =
        details.feeA === null || details.feeB === null
          ? null
          : details.feeA * details.currentPrice + details.feeB;

      await recordObservation(this.lastObservationAt, nftMint, details, feesEarned);

      return {
        inRange: details.inRange,
        currentPrice: details.currentPrice,
        rangeLower: details.priceLower,
        rangeUpper: details.priceUpper,
        feesEarned,
        // Not nulled when a fee leg is unreadable: principal dominates and is
        // known, and `feesEarned: null` already discloses the gap.
        valueUsd: details.totalValueUsd,
        ageHours,
        nftMint,
      };
    } catch (error) {
      console.error('[Monitor] Failed to read position:', error);
      return null;
    }
  }

  /**
   * SOL price, or null when no source can supply one.
   *
   * Callers depend on "refuse honestly" rather than an exception, and a failed
   * price REFUSES a deposit rather than guessing one.
   */
  async getSolPriceUsd(poolId: string): Promise<number | null> {
    const failures: string[] = [];

    try {
      await this.init();
      const poolPrice = await this.client.getCurrentPrice(poolId);
      if (poolPrice > 0) return poolPrice;
      failures.push(`raydium pool: returned ${poolPrice}`);
    } catch (error: any) {
      failures.push(`raydium pool: ${error?.message ?? error}`);
    }

    try {
      const price = await getSolPrice();
      if (price > 0) return price;
      failures.push(`coingecko: returned ${price}`);
    } catch (error: any) {
      failures.push(`coingecko: ${error?.message ?? error}`);
    }

    console.error(`[Price] No source could supply a SOL price:\n  ${failures.join('\n  ')}`);
    return null;
  }

  /**
   * The wallet in USD, or null when it cannot be established. An unreadable
   * price refuses the whole thing rather than reporting a wrong total.
   */
  async getWalletBalance(poolId: string): Promise<{
    sol: number;
    usdc: number;
    solUsd: number;
    usdcUsd: number;
    totalUsd: number;
    /**
     * The price the dollar figures were computed at, so a caller that
     * re-denominates part of the wallet uses the SAME price instead of a
     * second read that would not reconcile.
     */
    solPrice: number;
  } | null> {
    try {
      await this.init();
      const [sol, usdc, solPrice] = await Promise.all([
        this.client.getSolBalance(),
        this.client.getUsdcBalance(),
        this.getSolPriceUsd(poolId),
      ]);

      if (solPrice === null) {
        console.error('[Balance] Have balances but no SOL price; reporting unknown.');
        return null;
      }

      const solUsd = sol * solPrice;
      return { sol, usdc, solUsd, usdcUsd: usdc, totalUsd: solUsd + usdc, solPrice };
    } catch (error) {
      console.error('Failed to fetch wallet balance:', error);
      return null;
    }
  }

  /**
   * How many automatic redeploys a strand gets before a human has to look.
   * Exposed so operator-facing text uses the same number the ceiling enforces.
   */
  get recoveryAttemptLimit(): number {
    return this.config.recoveryAttemptLimit;
  }

  /**
   * What the wallet could put into a position, net of the gas reserve; null,
   * never zero, when unknown (see capital.ts redeployableUsd). This reclaims
   * what each rebalance's sizing leaves behind in the wallet.
   */
  async readRedeployableWalletUsd(poolId: string): Promise<number | null> {
    const balance = await this.getWalletBalance(poolId);
    if (balance === null) return null;

    return redeployableUsd(balance, this.config.minSolReserve);
  }

  /**
   * Which position in this pool is ours, according to the CHAIN. Reports
   * rather than decides; compare with `resolveOpenPosition` (the database).
   */
  async findOnChainPositions(poolId: string): Promise<PositionSummary[]> {
    await this.init();
    const positions = await this.client.getMyPositions();
    return positions.filter(
      (p) => p.poolId?.toString?.() === poolId && p.liquidity !== '0'
    );
  }

  stop(): void {
    console.log('[Orchestrator] Stopping...');
  }

  /**
   * Create a new position at the model's range.
   *
   * ORDER: mint operation id -> record prediction -> swap (booked under that
   * id) -> size from the budget -> create -> book. The id is minted before the
   * swap so the swap's rows survive a failed create.
   */
  async createNewPosition(params: {
    poolId: string;
    /**
     * USD value to deploy. Omit to deploy the whole wallet (the historical
     * behaviour).
     */
    investmentUsd?: number;
    duration?: number;
    /**
     * The nft mint this position replaces when this create is the second half
     * of a rebalance; recorded as `positions.prev_position_id`. Omit on a first
     * open.
     */
    prevPositionMint?: string;
  }): Promise<PositionCreationResult> {
    await this.init();

    console.log('[Orchestrator] Getting range prediction...');
    const prediction = await this.getPrediction(params.poolId);

    console.log(`[Orchestrator] Swapping to ${(prediction.sol_ratio * 100).toFixed(1)}% SOL ratio...`);
    const operationId = newOperationId();
    await this.swapAndBook(params.poolId, prediction.sol_ratio, params.investmentUsd, operationId);

    // Size the deposit from the budget, not the whole wallet.
    const balances = await this.swapToRatio.getDeployable(
      params.poolId,
      prediction.sol_ratio,
      params.investmentUsd
    );
    console.log(
      `[Orchestrator] Deploying $${balances.valueUsd.toFixed(2)}: ` +
        `${balances.sol.toFixed(6)} SOL + ${balances.usdc.toFixed(2)} USDC`
    );

    const config = this.rangeSetup.createWithPrices({
      poolId: params.poolId,
      priceLower: prediction.lower,
      priceUpper: prediction.upper,
      coin1Amount: balances.sol,
      coin2Amount: balances.usdc,
      duration: params.duration ?? 0,
      // The same id the swap booked under, so the cycle groups together.
      operationId,
    });

    console.log(`[Orchestrator] Creating position: $${prediction.lower.toFixed(2)} - $${prediction.upper.toFixed(2)}`);

    const result = await this.process(config.operationId, {
      ...config,
      prevPositionMint: params.prevPositionMint,
    });

    if (!result) {
      throw new Error('Position creation failed - no result returned');
    }

    return {
      operationId: config.operationId,
      nftMint: result.nftMint,
      txId: result.txId,
      priceLower: prediction.lower,
      priceUpper: prediction.upper,
      solAmount: result.solDeposited,
      usdcAmount: result.usdcDeposited,
      solRatio: prediction.sol_ratio * 100,
      usdcRatio: prediction.usdc_ratio * 100,
      source: prediction.source,
      valueUsd: result.solDeposited * prediction.current_price + result.usdcDeposited,
    };
  }

  /** Create a position with manual price bounds (bypasses prediction). */
  async createPositionManual(params: {
    poolId: string;
    priceLower: number;
    priceUpper: number;
    duration?: number;
    /** Budget in USD. Omit and the WHOLE WALLET is swapped and deployed. */
    investmentUsd?: number;
  }): Promise<PositionCreationResult> {
    await this.init();

    const currentPrice = await this.priceMonitor.getCurrentPrice(params.poolId);

    const { solRatio, usdcRatio } = SwapToRatio.calculateDepositRatio(
      currentPrice,
      params.priceLower,
      params.priceUpper
    );

    console.log(`[Orchestrator] Manual range: $${params.priceLower.toFixed(2)} - $${params.priceUpper.toFixed(2)}`);
    console.log(`[Orchestrator] Calculated ratio: ${(solRatio * 100).toFixed(1)}% SOL`);

    const operationId = newOperationId();
    await this.swapAndBook(params.poolId, solRatio, params.investmentUsd, operationId);

    // Bounded by the same budget as the swap.
    const balances = await this.swapToRatio.getDeployable(
      params.poolId,
      solRatio,
      params.investmentUsd
    );

    const config = this.rangeSetup.createWithPrices({
      poolId: params.poolId,
      priceLower: params.priceLower,
      priceUpper: params.priceUpper,
      coin1Amount: balances.sol,
      coin2Amount: balances.usdc,
      duration: params.duration ?? 0,
      // The same id the swap booked under, so the cycle groups together.
      operationId,
    });

    const result = await this.process(config.operationId, config);

    if (!result) {
      throw new Error('Position creation failed - no result returned');
    }

    return {
      operationId: config.operationId,
      nftMint: result.nftMint,
      txId: result.txId,
      priceLower: params.priceLower,
      priceUpper: params.priceUpper,
      solAmount: result.solDeposited,
      usdcAmount: result.usdcDeposited,
      solRatio: solRatio * 100,
      usdcRatio: usdcRatio * 100,
      source: 'fallback',
      valueUsd: result.solDeposited * currentPrice + result.usdcDeposited,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
