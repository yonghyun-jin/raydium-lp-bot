// LP Auto Strategy Telegram Bot
//
// Many tests under tests/telegram and tests/orchestrator read THIS FILE AS TEXT:
// they slice method bodies by `private async <name>(` and assert on `this.`
// patterns inside them. Moving a guarded method body out of this file, or
// renaming it, silently turns those guards off -- re-point them in the same
// commit. Reply TEXT lives in ./messages; the decisions stay here.

import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import {
  BotConfig,
  WalletBalance,
  PositionStatus,
  RangeSuggestion,
  StrandSummary,
  UserStage,
  DEFAULT_CONFIG,
} from './types';
import { messages, CHOICES } from './messages';
import { LpClient } from '../raydium/LpClient';
import { getRangePrediction } from '../orchestrator/prediction';
import { Orchestrator } from '../orchestrator/Orchestrator';
import {
  summariseCapital,
  isDriftWorthReporting,
  capitalLogLine,
  DRIFT_THRESHOLDS,
  type CapitalSummary,
} from '../orchestrator/capital';
import { config } from '../raydium/config';
import {
  getOpenPositionForPool,
  resetRebalanceCount,
  recordOperatorChat,
  getOperatorChatId,
  recordInvestmentAmount,
  getInvestmentAmount,
  recordMonitoringIntent,
  getMonitoringIntent,
  recordDeployIntent,
  getRecoveryState,
} from '../recording';

export class LPBot {
  private bot: Telegraf;
  private config: BotConfig;
  private monitorInterval: NodeJS.Timeout | null = null;

  /**
   * The position already prompted about in the CURRENT out-of-range episode,
   * so the loop asks once instead of every tick. Cleared when it comes back in
   * range; keyed by mint so a replacement starts clean. Latch, never stop the
   * loop: an unanswered prompt must not leave a live position unwatched.
   */
  private promptedForMint: string | null = null;

  /**
   * Which position a capital-drift notice was already sent for. Deliberately
   * NOT `promptedForMint`: sharing one latch would let the drift notice and
   * the out-of-range question silence each other. Latches the MESSAGE only --
   * the reading is still logged every tick, because the logs are the only
   * history of this gap.
   */
  private driftNotifiedForMint: string | null = null;

  /**
   * Where to send unsolicited messages. Postgres is authoritative; this is a
   * read-through cache, refreshed from `ctx.chat.id` on every authenticated
   * update and loaded at boot (after a redeploy no update has arrived yet).
   */
  private operatorChatId: number | null = null;

  /**
   * The position being managed; a read-through cache of Postgres. ONLY a
   * positive result is cached: `getOpenPositionForPool` returns null for no
   * row, several rows AND an unreachable database, so caching a null could
   * convince the bot it has no position while one is live on-chain.
   */
  private activeMint: string | null = null;

  /**
   * Where the operator is in the conversation. IN MEMORY ON PURPOSE: both
   * readers fail closed when a restart loses it (/confirm refuses rather than
   * spends), so persisting it would only add something that can disagree.
   */
  private stage: UserStage = 'IDLE';

  /**
   * Single-flight guards. `setInterval` does not await, so an overrunning
   * tick is joined by the next and both could rebalance the same NFT.
   * `rebalanceInFlight` is broader: /approve and /rebalance also start a
   * rebalance, so it blocks the loop and the handlers against each other.
   */
  private checkInFlight = false;
  private rebalanceInFlight = false;
  /**
   * An OPEN is being attempted by /confirm or by stranded-funds recovery.
   * Both want to deploy the SAME idle dollars, and neither flag above covers
   * that pair; without this the window between one path sending and its
   * position becoming visible fits a second, double-funded position.
   */
  private deployInFlight = false;
  private orchestrator: Orchestrator;

  /**
   * @param config Bot configuration, including the Telegram token.
   * @param client Optional LpClient, passed straight to the Orchestrator.
   *               Tests inject a fake; production omits it.
   *
   *               THE BOT HOLDS NO CLIENT. A second, never-init()ed client
   *               here once made every monitoring tick fail silently. All
   *               chain reads go through the Orchestrator.
   */
  constructor(config: Partial<BotConfig> & { token: string }, client?: LpClient) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // NO HANDLER TIMEOUT. Telegraf's default 90s timeout rejects the wrapper
    // WITHOUT cancelling the work, so a slow /confirm reported a bogus timeout
    // error and then its real outcome. The send paths own their own deadlines
    // (JITO_TOTAL_BUDGET_MS, PYTHON_TIMEOUT_MS, RECORDING_TIMEOUT_MS).
    this.bot = new Telegraf(this.config.token, { handlerTimeout: Infinity });
    this.orchestrator = new Orchestrator(
      { failureLimitPerDay: this.config.failureLimitPerDay },
      client
    );

    // Global error handler: prevents any handler throw from crashing the polling loop.
    this.bot.catch((error: any, ctx) => {
      console.error(`[Bot] Unhandled error for update ${(ctx.update as any)?.update_id}:`, error);
      void ctx.reply(`❌ Error: ${error?.message ?? 'Something went wrong'}`).catch(() => {});
    });

    this.setupAuthorization();
    this.setupCommands();
    this.setupHandlers();
  }

  /**
   * Gate every update on an allowlist, before any handler runs. The bot is
   * ARMED, so an unauthorised update is a potential spend, not a disclosure.
   *
   * Fails CLOSED: an unset allowlist refuses everyone, and the refusal tells
   * the operator their own Telegram id so the variable can be filled in.
   */
  private setupAuthorization(): void {
    const raw = process.env.TELEGRAM_ALLOWED_USER_IDS ?? '';
    const allowed = new Set(
      raw
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
    );

    if (allowed.size === 0) {
      console.warn(
        'TELEGRAM_ALLOWED_USER_IDS is not set. Every update will be refused. ' +
          'Set it to a comma-separated list of Telegram user ids to enable the bot.'
      );
    } else {
      console.log(`Telegram authorization: ${allowed.size} allowed user id(s)`);
    }

    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;

      if (userId !== undefined && allowed.has(String(userId))) {
        // Ground truth for where the operator is reachable; persisted so it
        // survives a redeploy.
        const chatId = ctx.chat?.id;
        if (typeof chatId === 'number' && chatId !== this.operatorChatId) {
          this.operatorChatId = chatId;
          void recordOperatorChat(chatId);
        }
        return next();
      }

      // Audit trail for who tried to move funds.
      console.warn(`Refused Telegram update from unauthorized user id: ${userId ?? 'unknown'}`);

      try {
        await ctx.reply(
          allowed.size === 0
            ? `This bot has no authorized users configured, so it is refusing everything.\n\n` +
                `Your Telegram user id is: ${userId ?? 'unknown'}\n` +
                `Set TELEGRAM_ALLOWED_USER_IDS to enable it.`
            : 'Not authorized.'
        );
      } catch {
        // A reply can fail; the refusal itself already happened.
      }

      // Deliberately does not call next(): the update stops here.
    });
  }

  private setupCommands(): void {
    this.bot.telegram.setMyCommands([
      { command: 'start', description: 'Start or resume automation' },
      { command: 'stop', description: 'Pause monitoring' },
      { command: 'status', description: 'Check position status' },
      { command: 'balance', description: 'Show wallet balance' },
      { command: 'done', description: 'Confirm position created' },
      { command: 'confirm', description: 'Confirm and open — /confirm <amount>' },
      { command: 'approve', description: 'Approve the pending rebalance' },
      { command: 'wait', description: 'Keep the position, keep watching' },
      { command: 'close', description: 'Close the position now' },
      { command: 'rebalance', description: 'Force a rebalance' },
      { command: 'resume', description: 'Resume after the daily limit' },
      { command: 'cancel', description: 'Cancel the pending action' },
      { command: 'help', description: 'Show help' },
    ]);
  }

  private setupHandlers(): void {
    this.bot.command('start', async (ctx) => {
      await this.handleStart(ctx);
    });

    this.bot.command('stop', async (ctx) => {
      await this.handleStop(ctx);
    });

    this.bot.command('status', async (ctx) => {
      await this.handleStatus(ctx);
    });

    this.bot.command('balance', async (ctx) => {
      await this.handleBalance(ctx);
    });

    this.bot.command('done', async (ctx) => {
      await this.handleDone(ctx);
    });

    this.bot.command('help', async (ctx) => {
      await ctx.replyWithMarkdown(messages.help());
    });

    // Commands, not buttons. A button implied its context (it could only be
    // tapped on the message that offered it); a command can arrive at any
    // time, so each handler must check its own precondition. `/confirm` is the
    // important one -- it is the last step before money moves.
    this.bot.command('confirm', async (ctx) => {
      await this.handleConfirmStart(ctx);
    });

    this.bot.command('cancel', async (ctx) => {
      // Back to asking for an amount, so a later /confirm has nothing to spend.
      this.stage = 'AWAITING_AMOUNT';
      await ctx.reply('Cancelled. Nothing was opened. Send a new amount, or /start.');
    });

    this.bot.command('approve', async (ctx) => {
      await this.handleApproveRebalance(ctx);
    });

    this.bot.command('wait', async (ctx) => {
      if (!this.hasOutstandingPrompt()) {
        await ctx.reply('Nothing is waiting on you. Use /status to see the position.');
        return;
      }
      // An acknowledgement: make sure monitoring is on and LEAVE the latch set,
      // so the loop does not re-ask every tick. It clears on return to range.
      void recordMonitoringIntent(true);
      if (!this.monitorInterval) this.startMonitoring();
      await ctx.reply(
        '\u23f8\ufe0f Keeping the position open. Still watching \u2014 ' +
          "I'll tell you if it comes back in range."
      );
    });

    this.bot.command('close', async (ctx) => {
      await this.handleClosePosition(ctx);
    });

    this.bot.command('resume', async (ctx) => {
      await this.handleResumeNow(ctx);
    });

    this.bot.command('pause', async (ctx) => {
      // There is no timed pause. Say so rather than claim one.
      await ctx.reply('There is no timed pause. Use /stop to stop monitoring, and /start to resume.');
    });

    this.bot.command('rebalance', async (ctx) => {
      await this.handleForceRebalance(ctx);
    });

    // Plain text is only ever the amount input.
    this.bot.on(message('text'), async (ctx) => {
      await this.handleTextMessage(ctx);
    });
  }

  private async handleStart(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!userId || !chatId) {
      await ctx.reply('Error: Could not identify user.');
      return;
    }

    // Guard on whether a POSITION exists, not merely on the loop running. The
    // loop keeps running after a failed reopen to reconcile stranded funds;
    // guarding on the interval alone made /start unreachable in exactly that
    // state, leaving /stop (which also disables the redeploy) as the only exit.
    // The interval is checked in-process: a persisted flag would survive a
    // redeploy that killed the loop.
    if (this.monitorInterval && (await this.resolveActiveMint())) {
      await ctx.replyWithMarkdown('Already monitoring! Use /status to check position.');
      return;
    }

    await ctx.replyWithMarkdown(messages.welcome());

    const balance = await this.getWalletBalance();
    if (!balance) {
      // Do not advance to AWAITING_AMOUNT: the operator could not sanity-check
      // the figure they would type next.
      await ctx.replyWithMarkdown(messages.balanceUnavailable());
      return;
    }
    await ctx.replyWithMarkdown(messages.walletBalance(balance));

    this.stage = 'AWAITING_AMOUNT';
  }

  private async handleStop(ctx: Context): Promise<void> {
    if (!this.monitorInterval && !(await this.resolveActiveMint())) {
      await ctx.reply('Nothing is being monitored. Use /start to begin.');
      return;
    }

    // Recorded even when the interval is already stopped: boot recovery reads it.
    this.stopMonitoring();
    void recordMonitoringIntent(false);
    // The desired state too -- otherwise the reconciler keeps redeploying the
    // money after being told to stop.
    void recordDeployIntent('IDLE');

    // SAY that this also cancelled any pending redeploy: an off switch the
    // operator cannot see themselves throwing is not an off switch.
    const strand = await this.readStrand();
    const alsoCancelled = messages.stopRedeployNotice(strand);

    await ctx.replyWithMarkdown(messages.stopped() + alsoCancelled);
  }

  private async handleStatus(ctx: Context): Promise<void> {
    const nftMint = await this.resolveActiveMint();
    if (!nftMint) {
      // Report any stranded funds, not just "no position". This read DEGRADES
      // rather than failing closed -- it gates nothing, it only reports.
      await ctx.replyWithMarkdown(messages.noActivePosition(await this.readStrand()));
      return;
    }

    const status = await this.getPositionStatus(nftMint);
    if (!status) {
      await ctx.reply('Could not fetch position status. Please try again.');
      return;
    }

    // Asked for explicitly, so NOT latched and not thresholded.
    await ctx.replyWithMarkdown(messages.positionStatus(status, await this.readCapital(status)));
  }

  private async handleBalance(ctx: Context): Promise<void> {
    const balance = await this.getWalletBalance();
    await ctx.replyWithMarkdown(
      balance ? messages.walletBalance(balance) : messages.balanceUnavailable()
    );
  }

  /**
   * Adopt a position that exists on-chain but is not on record (e.g. opened
   * by hand after an auto-create failed). The wallet is asked, not the user.
   */
  private async handleDone(ctx: Context): Promise<void> {
    await ctx.reply('Looking for your position on-chain...');

    try {
      const inPool = await this.orchestrator.findOnChainPositions(this.config.poolId);

      if (inPool.length === 0) {
        await ctx.reply(
          'No open position found in this pool. If you just created one, give it ' +
            'a few seconds and try /done again.'
        );
        return;
      }

      if (inPool.length > 1) {
        await ctx.replyWithMarkdown(messages.adoptAmbiguous(inPool));
        return;
      }

      const position = inPool[0];
      this.setActiveMint(position.nftMint);
      void recordMonitoringIntent(true);
      void recordDeployIntent('DEPLOYED');
      this.startMonitoring();

      await ctx.replyWithMarkdown(messages.positionAdopted(position));
    } catch (error: any) {
      console.error('Failed to adopt position:', error);
      await ctx.reply(`Could not read positions: ${error?.message ?? 'Unknown error'}`);
    }
  }

  private async handleConfirmStart(ctx: Context): Promise<void> {
    // The precondition the button used to carry structurally. /confirm SPENDS,
    // so without this a stray one opens a position with whatever budget is on
    // record.
    if (this.stage !== 'AWAITING_CONFIRMATION') {
      // A budget on record with no conversation means a restart cleared the
      // in-memory stage while the old prompt still looks live. Name the restart.
      const recorded = await getInvestmentAmount();

      await ctx.replyWithMarkdown(
        recorded !== null
          ? `⚠️ *That prompt is stale.*\n\n` +
              `A budget of $${recorded.toFixed(2)} is still on record, but the bot ` +
              `restarted after it was offered, so the confirmation it belonged to ` +
              `is gone. **Nothing was created and nothing was spent.**\n\n` +
              `Send /start to set it up again.`
          : 'Nothing is waiting to be confirmed. Use /start and enter an amount first.'
      );
      return;
    }


    // RESTATE THE AMOUNT TO CONFIRM IT. There is no position ceiling, so the
    // only thing between a typo and the whole wallet is the operator typing
    // the number twice. A bare /confirm asks rather than spends. Carried as a
    // command argument, not a new `stage`, so it also survives a restart.
    const recorded = await getInvestmentAmount();
    if (recorded === null) {
      await ctx.replyWithMarkdown(
        '❌ *Cannot read back the amount.*\n\n' +
          'Refusing to open: an unset budget means depositing the whole wallet. ' +
          'Send /start and set it again.'
      );
      return;
    }

    const said = parseFloat(
      String((ctx.message as any)?.text ?? '').replace(/^\/confirm(@\S+)?/, '').replace(/[$,\s]/g, '')
    );

    if (isNaN(said)) {
      await ctx.replyWithMarkdown(messages.confirmAmountAsk(recorded));
      return;
    }

    if (Math.abs(said - recorded) > 0.005) {
      await ctx.replyWithMarkdown(messages.confirmAmountMismatch(said, recorded));
      return;
    }

    // One position per pool. The stage stays AWAITING_CONFIRMATION after an
    // open, so without this a second /confirm would open a second position
    // with the same budget.
    const alreadyOpen = await this.resolveActiveMint();
    if (alreadyOpen !== null) {
      await ctx.reply(
        `A position is already open (${alreadyOpen}). Nothing was opened. ` +
          'Use /status to see it, or /close it first.'
      );
      return;
    }

    await ctx.reply(messages.creatingPosition());

    try {
      // The budget is re-read and null-checked FIRST and never passed through
      // unchecked: `investmentUsd: undefined` means "deploy the whole wallet".
      const investmentUsd = await getInvestmentAmount();
      if (investmentUsd === null) {
        await ctx.replyWithMarkdown(
          '❌ *No deposit amount on record.*\n\n' +
            'I will not open a position without one — an unset budget deploys the ' +
            'whole wallet. Send /start and enter the amount again.'
        );
        return;
      }

      // Claimed around the SEND, released in the finally below, so a recovery
      // tick cannot deploy the same idle dollars concurrently.
      if (this.deployInFlight) {
        await ctx.replyWithMarkdown(
          '\u23f3 *An open is already in flight.*\n\n' +
            'Nothing was sent twice. Wait for the result, then /status.'
        );
        return;
      }
      this.deployInFlight = true;

      const result = await this.orchestrator.createNewPosition({
        poolId: this.config.poolId,
        investmentUsd,
        duration: 0, // unlimited
      });

      this.setActiveMint(result.nftMint);

      await ctx.replyWithMarkdown(messages.positionCreated(result));

      this.startMonitoring();
      void recordMonitoringIntent(true);
      // From here on a missing position is a DISCREPANCY the reconciler acts on.
      void recordDeployIntent('DEPLOYED');

      await ctx.replyWithMarkdown(messages.monitoringStarted());

    } catch (error: any) {
      console.error('Position creation failed:', error);

      // Recommend only the MODEL's range, never an invented band. No live
      // price or no model means no recommendation: this is read by someone
      // about to open a position by hand.
      let range: { lower: number; upper: number } | null = null;
      try {
        const anchor = await this.getCurrentPrice();
        if (anchor === null) {
          console.error('No range to recommend: no live price to anchor on');
        } else {
          const prediction = await getRangePrediction(anchor);
          if (prediction.source === 'fixed') {
            range = { lower: prediction.lower, upper: prediction.upper };
          }
        }
      } catch (predictionError: any) {
        console.error('No range to recommend:', predictionError?.message ?? predictionError);
      }

      await ctx.replyWithMarkdown(
        `❌ *Auto-creation failed:* ${error?.message || 'Unknown error'}\n\n` +
        `Please create manually:\n` +
        messages.createPositionLink(this.config.poolId, range) +
        `\n\n${CHOICES.manualCreate}`
      );
    } finally {
      // Released on EVERY path: a flag left set would silence recovery forever.
      this.deployInFlight = false;
    }
  }

  /**
   * Close the current position and open a new one at the model's range.
   * Shared by /approve, /rebalance and the automatic path.
   */
  private async performRebalance(chatId: number | null): Promise<void> {
    // A null chat id must not stop the rebalance: the auto branch acts without
    // asking, so an unreachable operator means unnarrated, not un-rebalanced.
    const say = (text: string): Promise<unknown> => {
      if (chatId === null) {
        console.log(`[Rebalance] (operator unreachable) ${text}`);
        return Promise.resolve();
      }
      return this.bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    };

    // A rebalance CLOSES first, so two concurrent runs would try to close the
    // same NFT after the first already moved the money. Refuse, never queue.
    // Checked here, not only in the loop, because handlers reach it too.
    if (this.rebalanceInFlight) {
      console.warn('[Rebalance] Already in progress, refusing a concurrent run');
      await say('A rebalance is already running. Ignoring this request.');
      return;
    }
    this.rebalanceInFlight = true;

    try {
      await this.performRebalanceInner(chatId, say);
    } finally {
      this.rebalanceInFlight = false;
    }
  }

  /**
   * Render a rebalance. The DECIDING is the Orchestrator's; each arm maps one
   * outcome to one message and one state transition. Arms move state
   * differently -- `closed-only` means the position is GONE, so rendering it
   * like `refused` would leave the bot watching nothing.
   */
  private async performRebalanceInner(
    chatId: number | null,
    say: (text: string) => Promise<unknown>
  ): Promise<void> {

    const outcome = await this.orchestrator.rebalance({
      poolId: this.config.poolId,
      onProgress: say,
    });

    switch (outcome.status) {
      case 'capped':
        await say(
          messages.tooManyRebalances(outcome.limit) + `\n\n${CHOICES.afterDailyCap}`
        );
        this.stopMonitoring();
        return;

      case 'refused':
        await say(messages.rebalanceRefused(outcome));
        return;

      case 'closed-only':
        // The position is closed and the funds are in the wallet.
        await say(messages.rebalanceClosedOnly());
        // Nothing left to watch; the recorded intent stops boot recovery from
        // resuming a watch over a position that is gone.
        this.setActiveMint(null);
        this.stopMonitoring();
        void recordMonitoringIntent(false);
        // IDLE, not DEPLOYED: with no readable budget the reconciler has
        // nothing to redeploy and must not spin on this.
        void recordDeployIntent('IDLE');
        return;

      case 'closed-open-failed': {
        // Same real-world state as 'closed-only', but with the budget known so
        // the operator can be told what is idle.
        console.error('Rebalance failed after the close:', outcome.error);
        await say(messages.rebalanceReopenFailed(outcome));
        // Forget the burned mint but DO NOT stop monitoring: the loop is what
        // reconciles the idle funds back into a position.
        this.setActiveMint(null);
        return;
      }

      case 'failed':
        console.error('Rebalance failed:', outcome.error);
        await say(messages.rebalanceFailed(outcome.error));
        // Drop the cached mint even though nothing closed: resolveActiveMint
        // trusts the cache before the database, so a stale value keeps /status
        // and the loop pointed at a position that may not exist.
        this.setActiveMint(null);
        return;

      case 'rebalanced': {
        const { opened } = outcome;
        this.setActiveMint(opened.nftMint);
        void recordMonitoringIntent(true);
        // New position, new episode: a replacement must never inherit a prompt.
        this.promptedForMint = null;
        this.startMonitoring();

        await say(messages.rebalanceComplete(opened));
        return;
      }
    }
  }

  private async handleApproveRebalance(ctx: Context): Promise<void> {
    // A rebalance spends real money, so /approve must answer an outstanding
    // question or do nothing -- never act on an in-range position.
    if (!this.hasOutstandingPrompt()) {
      await ctx.reply(
        'Nothing is waiting on you, so there is nothing to approve. ' +
          'Use /status to see the position, or /rebalance to force one.'
      );
      return;
    }

    await ctx.reply(
      '\u{1F504} Rebalancing: close, re-predict, swap to the new ratio, reopen.'
    );

    await this.performRebalance(await this.resolveChatId());
  }

  private async handleClosePosition(ctx: Context): Promise<void> {

    // If the database has no position, ask the chain before giving up: a
    // position opened outside the bot, or whose recording degraded, must still
    // be closable with the one command an operator reaches for. Refuse to guess
    // between several.
    let nftMint = await this.resolveActiveMint();

    if (!nftMint) {
      const open = await this.orchestrator.findOnChainPositions(this.config.poolId);

      if (open.length === 1) {
        nftMint = open[0].nftMint;
        await ctx.reply(
          `No position recorded for this pool, but found one on-chain: \`${nftMint.slice(0, 8)}...\`. Closing it.`,
          { parse_mode: 'Markdown' }
        );
      } else if (open.length > 1) {
        await ctx.reply(
          `${open.length} open positions in this pool and no record of which is yours. ` +
            `Close them manually — refusing to guess.`
        );
        return;
      } else {
        await ctx.reply('No position on record and none open on-chain. Use /start to open one.');
        this.stopMonitoring();
        void recordMonitoringIntent(false);
        void recordDeployIntent('IDLE');
        return;
      }
    }

    // Re-bound so the narrowing survives without a non-null assertion on a
    // path that CLOSES A POSITION.
    const mint: string = nftMint;

    await ctx.reply(`Closing position \`${mint.slice(0, 8)}...\``, { parse_mode: 'Markdown' });

    try {
      // The Orchestrator owns the close: pre-close reads, balance brackets and
      // the recording.
      const result = await this.orchestrator.closePosition(mint);

      this.stopMonitoring();
      this.setActiveMint(null);
      void recordMonitoringIntent(false);
      // Closing on purpose is not a strand: the operator wants to be out.
      void recordDeployIntent('IDLE');

      // "unknown", never 0, when balances could not be read: a 0 would read as
      // the close having eaten the position.
      const recovered =
        result.solWithdrawn === null || result.usdcWithdrawn === null
          ? 'unknown (balances could not be read)'
          : `${result.solWithdrawn.toFixed(6)} SOL + ${result.usdcWithdrawn.toFixed(2)} USDC`;

      await ctx.replyWithMarkdown(messages.positionClosed(result.txId, recovered));
    } catch (error: any) {
      // Do not clear the position on failure -- it is still open on-chain.
      console.error('Close failed:', error);
      await ctx.replyWithMarkdown(messages.closeFailed(error));
    }
  }

  private async handleResumeNow(ctx: Context): Promise<void> {

    // Reset the DURABLE counter (`bot_states.rebalances_today`, which the
    // limit is read from) -- resetting any other copy looks like it works and
    // the next rebalance is refused again.
    try {
      await resetRebalanceCount();
    } catch (error: any) {
      // Never claim a reset that did not happen: the operator would walk away
      // from a bot they believe is armed.
      console.error('[ResumeNow] Failed to reset the rebalance counter:', error?.message ?? error);
      await ctx.reply(
        'Could not reset the rebalance counter, so automation is still paused. ' +
          'Nothing was changed. Try again in a moment.'
      );
      return;
    }

    this.startMonitoring();

    await ctx.reply('Monitoring resumed. Be careful - high volatility detected!');
  }

  /**
   * `/rebalance` -- runs the SAME path as the automatic rebalance: budget
   * resolved before anything closes, daily cap respected, single-flight.
   * "Force" means "at the operator's request"; it does NOT bypass the cap
   * (use /resume for that, deliberately).
   */
  private async handleForceRebalance(ctx: Context): Promise<void> {
    const nftMint = await this.resolveActiveMint();
    if (!nftMint) {
      await ctx.reply('No position to rebalance. Use /status to check, or /start to open one.');
      return;
    }

    await ctx.reply('\u{1F504} Rebalancing: close, re-predict, swap to the new ratio, reopen.');
    await this.performRebalance(await this.resolveChatId());
  }

  private async handleTextMessage(ctx: Context): Promise<void> {
    const text = (ctx.message as any)?.text;
    if (!text) return;

    if (this.stage === 'AWAITING_AMOUNT') {
      await this.handleAmountInput(ctx, text);
    }
  }

  private async handleAmountInput(ctx: Context, text: string): Promise<void> {
    const amount = parseFloat(text.replace(/[$,]/g, ''));

    // Read the wallet ONCE, before validating, so the spend gate compares
    // against the same read the operator is shown.
    const balance = await this.getWalletBalance();
    if (!balance) {
      // FAIL CLOSED. An unreadable balance is not permission to spend.
      await ctx.replyWithMarkdown(messages.balanceUnavailable());
      return;
    }

    if (isNaN(amount) || amount < 10) {
      await ctx.replyWithMarkdown(messages.invalidAmount(balance.totalUsd));
      return;
    }

    if (amount > balance.totalUsd) {
      await ctx.replyWithMarkdown(messages.insufficientBalance(amount, balance.totalUsd));
      return;
    }

    // The SAME ceiling the send guard enforces, checked here so the operator
    // hears about it now -- a refusal deep in the swap never reaches Telegram.
    if (amount > config.safety.MAX_POSITION_USD) {
      await ctx.replyWithMarkdown(
        messages.overPositionCeiling(amount, config.safety.MAX_POSITION_USD)
      );
      return;
    }

    const solPrice = await this.getCurrentPrice();

    if (solPrice === null) {
      // Refuse rather than show a deposit plan in a price we do not have.
      await ctx.replyWithMarkdown(messages.cannotPriceDeposit());
      return;
    }

    // Persist BEFORE offering /confirm, and read it straight back: the facade
    // degrades silently on write failure, and a missing budget downstream
    // means "deploy the whole wallet".
    await recordInvestmentAmount(amount);
    if ((await getInvestmentAmount()) === null) {
      await ctx.replyWithMarkdown(messages.amountNotSaved());
      return;
    }

    this.stage = 'AWAITING_CONFIRMATION';

    await ctx.replyWithMarkdown(
      messages.readyToStart(amount, solPrice) +
      `${CHOICES.confirmStart}`
    );
  }

  // Monitoring loop
  private startMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }

    console.log('Starting monitoring loop...');

    this.monitorInterval = setInterval(async () => {
      // Skip, do not queue: a running check is fresher than this tick, and
      // queueing piles work up behind a slow RPC.
      if (this.checkInFlight || this.rebalanceInFlight) {
        console.log('[Monitor] Previous check still running, skipping this tick');
        return;
      }

      // An operator-driven open is already spending this money; the tick must
      // not reconcile the same strand concurrently.
      if (this.deployInFlight) {
        console.log('[Monitor] An open is in flight, skipping this tick');
        return;
      }

      this.checkInFlight = true;
      try {
        await this.checkPosition();
      } catch (error) {
        // Backstop so a throw can never leave the flag set and wedge the loop.
        console.error('[Monitor] Unhandled error in check:', error);
      } finally {
        this.checkInFlight = false;
      }
    }, this.config.monitorIntervalMs);
  }

  private stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    console.log('Monitoring stopped.');
  }

  /**
   * Converge on the desired state: if a position is owed and missing, deploy
   * it. Runs on every tick with no watched position, quiet in the normal case.
   *
   * Errors are swallowed on purpose: this is the recovery path, and the loop
   * must survive to retry on the next tick.
   */
  private async reconcileStranded(): Promise<void> {
    // Re-checked here as well as in the tick: /confirm can arrive between them.
    if (this.deployInFlight) {
      console.log('[Recovery] an open is in flight; leaving it to that path.');
      return;
    }

    let outcome;
    this.deployInFlight = true;
    try {
      outcome = await this.orchestrator.recoverStranded({
        poolId: this.config.poolId,
        onProgress: async text => {
          const chatId = await this.resolveChatId();
          if (chatId !== null) await this.notify(chatId, text, { parse_mode: 'Markdown' });
        },
      });
    } catch (error: any) {
      console.error('[Recovery] tick failed:', error?.message ?? error);
      return;
    } finally {
      this.deployInFlight = false;
    }

    switch (outcome.status) {
      // Non-events. Silent by design: this runs every 30s.
      case 'unknown':
      case 'not-wanted':
      case 'nothing-stranded':
        return;

      case 'waiting':
        console.log(`[Recovery] holding: ${outcome.reason}`);
        return;

      case 'already-deployed':
        console.log('[Recovery] a position exists after all; strand cleared.');
        return;

      case 'recovered': {
        this.setActiveMint(outcome.opened.nftMint);
        void recordMonitoringIntent(true);
        this.promptedForMint = null;
        const chatId = await this.resolveChatId();
        if (chatId !== null) {
          await this.notify(
            chatId,
            messages.strandRecovered(outcome.redeployedUsd, outcome.opened),
            { parse_mode: 'Markdown' }
          );
        }
        return;
      }

      case 'failed':
        // Quiet: retried on a backoff until the ceiling. Alerting every attempt
        // would train the operator to ignore alerts.
        console.error(
          `[Recovery] attempt ${outcome.attempts} failed ($${outcome.idleUsd.toFixed(2)} ` +
            `still idle): ${outcome.error}`
        );
        return;

      case 'exhausted': {
        // The ceiling: say so and stop the loop -- past here a human has to look.
        const chatId = await this.resolveChatId();
        const stuckFor = outcome.since
          ? `${Math.floor((Date.now() - outcome.since.getTime()) / 3600000)}h`
          : 'an unknown time';
        if (chatId !== null) {
          await this.notify(
            chatId,
            messages.recoveryExhausted(outcome.idleUsd, stuckFor, outcome.attempts),
            { parse_mode: 'Markdown' }
          );
        }
        console.error(
          `[Recovery] EXHAUSTED after ${outcome.attempts} attempts; ` +
            `$${outcome.idleUsd.toFixed(2)} parked.`
        );
        this.stopMonitoring();
        return;
      }
    }
  }

  private async checkPosition(): Promise<void> {
    try {
      const nftMint = await this.resolveActiveMint();
      if (!nftMint) {
        // NOT a silent return: "I should have a position and do not" is what
        // recovers stranded funds, whatever stranded them.
        await this.reconcileStranded();
        return;
      }

      const status = await this.getPositionStatus(nftMint);
      if (!status) {
        // On record but unreadable -- possibly gone from the chain. Reconcile
        // rather than wait forever on what may not be a transient error.
        await this.reconcileStranded();
        return;
      }

      // Null means the operator is unreachable: branches that only ASK are
      // skipped, the automatic ones still act.
      const chatId = await this.resolveChatId();

      // Before any range decision: an in-range position can still be running
      // on a fraction of the allocation.
      await this.reportCapital(chatId, nftMint, status);

      if (status.inRange) {
        // Back in range: clear the latch so a future exit asks again, and tell
        // the operator their pending decision is moot.
        if (this.promptedForMint === nftMint) {
          this.promptedForMint = null;
          await this.notify(
            chatId,
            messages.backInRange(status.currentPrice),
            { parse_mode: 'Markdown' }
          );
        }
        return;
      }

      {
        // Out of range. The auto-rebalance branch is exempt from the latch: it
        // acts rather than asks.
        const alreadyAsked = this.promptedForMint === nftMint;
        console.log(
          `Position out of range${alreadyAsked ? ' (already prompted, still watching)' : '! Notifying user...'}`
        );

        const age = status.ageHours;

        // Age gates a rebalance done WITHOUT asking, so an unknown age must go
        // to the operator -- never to the auto branch, never coerced to 0
        // (which made mature positions look brand new after a redeploy).
        if (age === null) {
          const asked = await this.notify(
            chatId,
            `\u26a0\ufe0f *Position out of range \u2014 age unknown*\n\n` +
              `I cannot establish how long this position has been open, so I will not ` +
              `rebalance it on my own.\n\n` +
              `This happens when the position was adopted with /done, or when the ` +
              `database is unreachable.\n\n${CHOICES.outOfRange}`,
            { parse_mode: 'Markdown' }
          );
          if (asked) this.promptedForMint = nftMint;
          return;
        }

        if (age >= this.config.targetPositionDurationHours) {
          await this.notify(
            chatId,
            messages.autoRebalancing(age, this.config.targetPositionDurationHours),
            { parse_mode: 'Markdown' }
          );
          // ...and actually rebalance (this branch once only sent the message).
          await this.performRebalance(chatId);
          return;
        }

        // Everything below ASKS, once per episode. The loop keeps running
        // either way.
        if (alreadyAsked) {
          return;
        }

        let asked: boolean;
        if (age < this.config.minPositionDurationHours) {
          asked = await this.notify(
            chatId,
            `⚠️ *Early Exit Warning*\n\nPosition only lasted ${Math.floor(age)}h (min: ${this.config.minPositionDurationHours}h).\n\nHigh volatility detected. Waiting for your decision.\n\n${CHOICES.outOfRange}`,
            { parse_mode: 'Markdown' }
          );
        } else {
          // The model runs HERE, after the latch, and not at the top of the
          // block: it spawns python3 (120s timeout) and would otherwise run on
          // every out-of-range tick for a prompt that is never sent.
          const suggestion = await this.getRangeSuggestion(status);
          asked = await this.notify(
            chatId,
            `${messages.outOfRange(status, suggestion)}\n${CHOICES.outOfRange}`,
            { parse_mode: 'Markdown' }
          );
        }

        // Latched, NOT stopped -- and only if DELIVERED: latching an
        // undelivered question would silence the whole episode.
        if (asked) this.promptedForMint = nftMint;
      }
    } catch (error) {
      console.error('Error checking position:', error);
    }
  }

  // External integrations


  /**
   * The wallet in USD, or null when it cannot be established. Never zeros:
   * unknown stays unknown all the way to the message, so no future gate
   * inherits a number that lies.
   */
  private async getWalletBalance(): Promise<WalletBalance | null> {
    return this.orchestrator.getWalletBalance(this.config.poolId);
  }

  /**
   * What is waiting to be redeployed, or null if that cannot be established.
   * NULL IS A REAL ANSWER: an unreadable row must not render as "nothing is
   * stranded". Nothing spends off this, so it degrades instead of refusing.
   */
  private async readStrand(): Promise<StrandSummary | null> {
    const state = await getRecoveryState();
    if (!state) return null;

    return {
      idleUsd: state.strandedUsd !== null && state.strandedUsd > 0 ? state.strandedUsd : null,
      wanted: state.deployIntent === 'DEPLOYED',
      attemptsUsed: state.recoveryAttempts,
      attemptLimit: this.orchestrator.recoveryAttemptLimit,
    };
  }

  /**
   * The capital picture: allocated, deployed, idle. Each reading fails
   * independently and each null travels, never collapsed into one number.
   */
  private async readCapital(status: PositionStatus | null): Promise<CapitalSummary> {
    const [allocatedUsd, idleWalletUsd] = await Promise.all([
      getInvestmentAmount(),
      this.orchestrator.readRedeployableWalletUsd(this.config.poolId),
    ]);

    return summariseCapital({
      allocatedUsd,
      positionValueUsd: status?.valueUsd ?? null,
      idleWalletUsd,
    });
  }

  /**
   * Log the capital picture every tick (the logs are its only history), and
   * tell the operator ONCE per position when it has drifted enough to matter.
   */
  private async reportCapital(chatId: number | null, nftMint: string, status: PositionStatus): Promise<void> {
    const capital = await this.readCapital(status);
    console.log(capitalLogLine(capital));

    if (this.driftNotifiedForMint === nftMint) return;
    if (!isDriftWorthReporting(capital, DRIFT_THRESHOLDS)) return;

    const told = await this.notify(chatId, messages.capitalDrift(capital), {
      parse_mode: 'Markdown',
    });

    // Latch only on a DELIVERED message.
    if (told) this.driftNotifiedForMint = nftMint;
  }


  private async getCurrentPrice(): Promise<number | null> {
    return this.orchestrator.getSolPriceUsd(this.config.poolId);
  }


  private async notify(
    chatId: number | null,
    text: string,
    extra?: Parameters<Telegraf['telegram']['sendMessage']>[2]
  ): Promise<boolean> {
    if (chatId === null) {
      console.warn(`[Notify] Operator unreachable, dropped: ${text.split('\n')[0]}`);
      return false;
    }
    await this.bot.telegram.sendMessage(chatId, text, extra);
    return true;
  }

  /**
   * Which position the bot is managing, or null if there is none: cache
   * first, then Postgres. `getOpenPositionForPool` refuses (null) when more
   * than one position is recorded open -- acting on a guess about which is
   * ours eventually closes money that is not.
   */
  private async resolveActiveMint(): Promise<string | null> {
    if (this.activeMint !== null) return this.activeMint;
    const recorded = await getOpenPositionForPool(this.config.poolId);
    if (recorded) this.activeMint = recorded.nftMint;
    return this.activeMint;
  }

  /** Record which position we are managing, or `null` once it is closed. */
  private setActiveMint(mint: string | null): void {
    this.activeMint = mint;
  }

  /**
   * Is the bot waiting on the operator? /approve and /wait answer a QUESTION;
   * without one, /approve would rebalance an in-range position.
   */
  private hasOutstandingPrompt(): boolean {
    return this.promptedForMint !== null;
  }

  private async resolveChatId(): Promise<number | null> {
    if (this.operatorChatId !== null) return this.operatorChatId;
    const stored = await getOperatorChatId();
    if (stored !== null) this.operatorChatId = stored;
    return stored;
  }

  private async getPositionStatus(nftMint: string): Promise<PositionStatus | null> {
    return this.orchestrator.getPositionStatus(nftMint);
  }


  private async getRangeSuggestion(status: PositionStatus): Promise<RangeSuggestion> {
    try {
      const prediction = await getRangePrediction(status.currentPrice);

      // DESCRIPTIVE: where the model's quantiles sit relative to the live
      // price. Not collapsed into a BULL/BEAR verdict.
      const lowerPct = (prediction.lower / status.currentPrice - 1) * 100;
      const upperPct = (prediction.upper / status.currentPrice - 1) * 100;

      return {
        available: true,
        rangeLower: prediction.lower,
        rangeUpper: prediction.upper,
        widthPct: prediction.width_pct,
        solRatioPct: prediction.sol_ratio * 100,
        reason:
          `Fixed range ${lowerPct.toFixed(2)}% / +${upperPct.toFixed(2)}% ` +
          `(${prediction.width_pct.toFixed(2)}% wide), needing ` +
          `${(prediction.sol_ratio * 100).toFixed(1)}% SOL.`,
      };
    } catch (error: any) {
      return {
        available: false,
        rangeLower: status.rangeLower,
        rangeUpper: status.rangeUpper,
        widthPct: 0,
        solRatioPct: 0,
        reason: `Prediction unavailable: ${error?.message ?? error}. No range suggested.`,
      };
    }
  }

  // Public methods

  /**
   * The live pool price, as the position path sees it. Exposed so the
   * boot-time prediction probe anchors on the same number as the Orchestrator.
   */
  async getPoolPrice(): Promise<number | null> {
    return this.getCurrentPrice();
  }

  /**
   * Resume managing a position that survived a restart (otherwise nothing
   * starts the loop until someone types a command).
   *
   * Trusts only the INTERSECTION of the database and the chain, and refuses on
   * anything ambiguous: resuming the wrong position means eventually closing
   * money that may not be ours.
   *
   * Never throws: a failed recovery must not stop the bot from launching.
   */
  private async recoverPosition(): Promise<void> {
    try {
      const recorded = await getOpenPositionForPool(this.config.poolId);
      if (!recorded) {
        console.log('[Boot] No open position recorded for this pool; nothing to resume.');
        return;
      }

      const onChain = (await this.orchestrator.findOnChainPositions(this.config.poolId)).filter(
        (p: any) => p.nftMint?.toString?.() === recorded.nftMint
      );

      if (onChain.length === 0) {
        // Recorded open but gone from the chain (likely an unrecorded close).
        console.warn(
          `[Boot] ${recorded.nftMint} is recorded open but not on-chain. ` +
            `Not resuming; the row is stale.`
        );
        return;
      }

      // The operator id identifies whose session this is; the chat id comes
      // from bot_states (see resolveChatId).
      const operatorId = Number(
        (process.env.TELEGRAM_ALLOWED_USER_IDS ?? '').split(',')[0]?.trim()
      );
      if (!Number.isFinite(operatorId) || operatorId === 0) {
        console.warn('[Boot] No operator id in TELEGRAM_ALLOWED_USER_IDS; cannot resume monitoring.');
        return;
      }

      // Set before the intent check: the mint is what /status and the loop
      // resolve, whether or not monitoring resumes.
      this.setActiveMint(recorded.nftMint);

      // Only an EXPLICIT stop prevents resuming. An unreadable intent (null)
      // resumes: silently abandoning a live position is the worse failure.
      if ((await getMonitoringIntent()) === false) {
        console.log('[Boot] Operator stopped monitoring; not resuming.');
        return;
      }

      void recordMonitoringIntent(true);

      this.startMonitoring();

      const age =
        recorded.openedAt === null
          ? 'age unknown'
          : `${((Date.now() - recorded.openedAt.getTime()) / 3_600_000).toFixed(1)}h old`;
      console.log(`[Boot] Resumed monitoring ${recorded.nftMint} (${age})`);
    } catch (error: any) {
      console.error('[Boot] Position recovery failed:', error?.message ?? error);
    }
  }

  async launch(): Promise<void> {
    console.log('Starting LP Auto Strategy Bot...');
    console.log('Connecting to Telegram...');

    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));

    // Not awaited: bot.launch() resolves only when polling stops.
    this.bot.launch({
      dropPendingUpdates: true,
    }).catch((error) => {
      console.error('Bot polling error:', error);
    });

    // Give it a moment to establish connection
    await new Promise((resolve) => setTimeout(resolve, 1000));

    console.log('Bot is running!');

    // After polling is up, so recovery's RPC round trips do not delay the bot
    // becoming reachable.
    await this.recoverPosition();
  }

  async stop(): Promise<void> {
    this.stopMonitoring();
    this.bot.stop();
  }
}

export default LPBot;
