// Telegram Message Templates

import { WalletBalance, PositionStatus, RangeSuggestion, StrandSummary } from './types';
import type { CapitalSummary } from '../orchestrator/capital';
import type { PositionCreationResult, RebalanceOutcome } from '../orchestrator/types';

/**
 * Render a USD figure, or the word for one that could not be read.
 *
 * Same rule as `formatFees`, hoisted because the capital block renders five of
 * them and a `$0.00` in any one of them would read as a settled fact.
 */
function formatUsd(value: number | null): string {
  if (value === null) return 'unknown';
  return `$${value.toFixed(2)}`;
}

/**
 * The capital block: allocated, deployed, idle, and the gap between them.
 *
 * Shown with the GAP NAMED rather than left for the operator to subtract. The
 * drift that cost $1,000 was arithmetically available the whole time -- what
 * was missing was anything that performed the subtraction out loud.
 */
function capitalBlock(capital: CapitalSummary): string {
  const lines = [
    '',
    '*Capital*',
    `Allocated: ${formatUsd(capital.allocatedUsd)}`,
    `Deployed:  ${formatUsd(capital.positionValueUsd)}`,
    `Idle:      ${formatUsd(capital.idleWalletUsd)}`,
  ];

  if (capital.gapUsd === null) {
    lines.push('Gap:       unknown');
  } else if (capital.gapUsd > 0) {
    // Idle and lost call for opposite responses, so they must not render the
    // same. `coveredByIdle` is the only thing that separates them.
    const where =
      capital.coveredByIdle === null
        ? ''
        : capital.coveredByIdle
          ? ' \u2014 in the wallet'
          : ' \u2014 NOT in the wallet';
    lines.push(`Gap:       ${formatUsd(capital.gapUsd)} not deployed${where}`);
  } else if (capital.gapUsd < 0) {
    lines.push(`Gap:       ${formatUsd(-capital.gapUsd)} above the allocation`);
  } else {
    lines.push('Gap:       none');
  }

  return lines.join('\n');
}

/**
 * Render a position age for the user.
 *
 * Coercing a null age to `0h 0m` would put the exact lie this nullability
 * exists to remove back into the text the operator reads -- and it is the most
 * convincing place to put it, because a freshly-opened position looks the same.
 */
function formatAge(ageHours: number | null): string {
  if (ageHours === null) return 'unknown';
  const hours = Math.floor(ageHours);
  const minutes = Math.floor((ageHours - hours) * 60);
  return `${hours}h ${minutes}m`;
}

/**
 * Render earned fees for the user.
 *
 * Null means the fee figure could not be computed, not that nothing was
 * earned. Printing `$0.00` there is the same class of lie as rendering an
 * unknown age as `0h 0m`, and worse here: an operator reading "$0.00" on a
 * position that is in range concludes the pool is dead and closes it.
 */
function formatFees(feesEarned: number | null): string {
  if (feesEarned === null) return 'unknown';
  return `$${feesEarned.toFixed(2)}`;
}

/**
 * What the operator can send in reply, per situation.
 *
 * The bot used to offer inline keyboard buttons. They are gone, so every
 * message that expects an answer has to NAME the command instead -- a prompt
 * with no buttons and no instructions is just a statement.
 *
 * Collected here rather than written at each call site so the names cannot
 * drift from the handlers: renaming a command should break in one place.
 */
export const CHOICES = {
  outOfRange:
    '*What now?*\n' +
    '/approve — rebalance now\n' +
    '/wait — keep it open, keep watching\n' +
    '/close — close the position',

  afterDailyCap:
    '*What now?*\n' +
    '/resume — resume now (risky)\n' +
    '/pause — stay paused until tomorrow\n' +
    '/close — close the position',

  confirmStart: '*Send* /confirm *to go ahead, or* /cancel *to stop here.*',

  manualCreate: '/done — I created the position\n/cancel — stop here',
} as const;

export const messages = {
  welcome: () => `
👋 *Welcome to LP Auto Strategy!*

I'll help you automate your SOL-USDC liquidity position.

Let me check your wallet balance...
`,

  walletBalance: (balance: WalletBalance) => `
💰 *Your Wallet Balance*

SOL:  ${balance.sol.toFixed(4)} ($${balance.solUsd.toFixed(2)})
USDC: ${balance.usdc.toFixed(2)} ($${balance.usdcUsd.toFixed(2)})
─────────────────────
Total: $${balance.totalUsd.toFixed(2)}

How much would you like to invest in LP?

_Reply with a dollar amount (e.g. "500" or "1000")_
`,

  /**
   * Shown when the wallet cannot be priced at all.
   *
   * `walletBalance` takes a real balance only. Rendering nulls as `0.00` would
   * tell the operator their wallet is empty when the truth is that a price
   * source did not answer -- and an empty wallet is a conclusion people act on.
   */
  balanceUnavailable: () => `
⚠️ *Cannot read your wallet right now*

The RPC or the price source did not answer, so the balance cannot be shown.
Nothing has changed. Try /balance again in a moment.
`,

  invalidAmount: (available: number) => `
❌ *Invalid Amount*

Please enter a number between $10 and $${available.toFixed(0)}.

Example: \`500\` or \`1000\`
`,

  insufficientBalance: (requested: number, available: number) => `
❌ *Insufficient Balance*

You requested: $${requested.toFixed(0)}
Available: $${available.toFixed(0)}

Please enter a smaller amount or deposit more funds.
`,

  /**
   * The manual-creation fallback.
   *
   * `range` is nullable on purpose. It used to be called with
   * `currentPrice * 0.95 / 1.05` -- an invented +/-5% band shown to the user as
   * a "Recommended Range" with no provenance, which is the same arbitrary
   * number the old prediction fallback returned and the reason 19 positions
   * failed. If the model cannot be reached, say so; never fill the gap with a
   * plausible-looking guess the user might act on.
   */
  createPositionLink: (
    poolId: string,
    range: { lower: number; upper: number } | null
  ) => `
🔗 *Create Your Position*

Click the link below to create your LP position on Raydium:

[Open Raydium CLMM](https://raydium.io/clmm/create-position/?pool_id=${poolId})

${
  range
    ? `*Recommended Range* (fixed v0 range):
Lower: $${range.lower.toFixed(2)}
Upper: $${range.upper.toFixed(2)}`
    : `⚠️ *No range recommendation* — no live price was available, so there is
no range to suggest. Do NOT pick one by eye. Retry once the price is available.`
}

Once you've created the position, send me the transaction link or type /done.
`,

  monitoringStarted: () => `
✅ *Monitoring Started*

I'm now watching your position every 30 seconds.

*Commands:*
/status - Check position
/stop - Pause monitoring
/help - Show all commands

I'll notify you when:
• Position goes out of range
• Rebalance is recommended
• Any issues detected
`,

  positionStatus: (status: PositionStatus, capital?: CapitalSummary) => {
    const rangeStatus = status.inRange ? '✅ IN RANGE' : '⚠️ OUT OF RANGE';
    const age = formatAge(status.ageHours);

    return `
📊 *Position Status*

${rangeStatus}

Current Price: $${status.currentPrice.toFixed(2)}
Range: $${status.rangeLower.toFixed(2)} - $${status.rangeUpper.toFixed(2)}
Age: ${age}
Fees Earned: ${formatFees(status.feesEarned)}
${capital ? capitalBlock(capital) : ''}
`;
  },

  /**
   * Unprompted: capital is not all working, and here is why.
   *
   * SENT RATHER THAN LOGGED, because the whole failure this guards against is a
   * figure that was computable but never said. The operator ran $3,000 of a
   * $4,000 allocation for weeks; nothing was broken enough to raise an error,
   * which is exactly why it needed a message.
   *
   * The explanation is included every time, not linked or abbreviated: an
   * operator reading "gap $1,000" without the mechanism has no way to tell a
   * loss from idle money, and those call for opposite responses.
   */
  capitalDrift: (capital: CapitalSummary) => {
    const idleIsKnown = capital.gapUsd !== null && capital.gapUsd > 0;

    const why = idleIsKnown
      ? capital.coveredByIdle === false
        ? 'The wallet cannot cover it either, so this is a real loss rather ' +
          'than idle money \u2014 impermanent loss, swap costs and gas across ' +
          'the rebalances so far.'
        : 'Anything the sizing leaves behind -- the gas reserve, the ratio ' +
          'swap, the leg that is not binding, the deposit slippage headroom -- ' +
          'stays in the wallet. The next rebalance counts it again and puts it ' +
          'back to work.'
      : 'The POSITION is worth more than was allocated. The budget stops at the ' +
        'allocation, so the surplus stays idle until you raise it.';

    return `
⚠️ *Capital drift*
${capitalBlock(capital)}

_${why}_

This money is in the wallet, not lost. \`/balance\` shows the wallet.
`;
  },

  outOfRange: (status: PositionStatus, suggestion: RangeSuggestion) => {
    const age = formatAge(status.ageHours);

    // No directional verdict and no confidence score. The model reports where
    // similar historical hours went, and the operator decides.
    const body = suggestion.available
      ? `\u{1F4D0} *Suggested new range*
$${suggestion.rangeLower.toFixed(2)} - $${suggestion.rangeUpper.toFixed(2)}  (${suggestion.widthPct.toFixed(2)}% wide)
Deposit ratio: ${suggestion.solRatioPct.toFixed(1)}% SOL

_${suggestion.reason}_`
      : `\u26a0\ufe0f _${suggestion.reason}_`;

    return `
⚠️ *Position Out of Range*

Current Price: $${status.currentPrice.toFixed(2)}
Your Range: $${status.rangeLower.toFixed(2)} - $${status.rangeUpper.toFixed(2)}
Position Age: ${age}
Fees Earned: ${formatFees(status.feesEarned)}

${body}
`;
  },

  tooManyRebalances: (count: number) => `
🛑 *Automation Paused*

${count} rebalances in 24 hours detected.
This indicates high volatility.

Continuing would likely lose money on swap fees.

_Counter resets at midnight UTC_
`,

  stopped: () => `
⏹️ *Monitoring Stopped*

Your position remains open but not monitored.

/start - Resume monitoring
/status - Check position status
`,

  help: () => `
📖 *LP Auto Strategy Help*

*Commands:*
/start - Start or resume automation
/stop - Pause monitoring
/status - Check position status
/balance - Show wallet balance
/help - Show this message

*Answering a prompt:*
/confirm - Confirm and open the position
/approve - Approve the pending rebalance
/wait - Keep the position, keep watching
/close - Close the position now
/rebalance - Force a rebalance
/resume - Resume after the daily limit
/cancel - Cancel the pending action
/done - I created the position myself

*How it works:*
1. /start and set an amount, then /confirm it
2. I open the position on a fixed range: live price ±4%
3. I check it every 30 seconds
4. Out of range: under 24h I ask you, 24h or more I rebalance and tell you
5. At most 3 rebalances a day
`,

  /**
   * No position -- and WHY there is none, when the state can say.
   *
   * Three different situations used to print the same four lines: nothing has
   * ever been deployed, the operator closed on purpose, and a close whose
   * reopen failed with four figures sitting in the wallet and a redeploy
   * pending. The third one is the only one where "Use /start to begin" is
   * actively misleading, and it is the one where it was read.
   *
   * `null` means the state could not be read, which is NOT the same as nothing
   * being stranded and must not render as it.
   */
  noActivePosition: (strand: StrandSummary | null) => {
    if (strand === null) {
      return `
ℹ️ *No Active Position*

You don't have an active position being monitored.

I could not read whether anything is waiting to be redeployed — so treat that
as unknown, not as "nothing". Check /balance before deciding.
`;
    }

    if (strand.idleUsd === null) {
      return `
ℹ️ *No Active Position*

You don't have an active position being monitored.

Use /start to begin.
`;
    }

    const retry =
      strand.attemptsUsed >= strand.attemptLimit
        ? `No further automatic attempts — ${strand.attemptsUsed} were made and all failed.`
        : strand.wanted
          ? `Automatic redeploy is armed: attempt ${strand.attemptsUsed + 1} of ${strand.attemptLimit}.`
          : `Automatic redeploy is OFF (you sent /stop, or a close was deliberate).`;

    return `
⚠️ *No Active Position — $${strand.idleUsd.toFixed(2)} is idle*

A close completed and the money is in your wallet, NOT in a position.

${retry}

/start deploys it now · /balance shows the wallet
`;
  },

  // ---- Replies rendered by bot.ts handlers. Text only: every decision about
  // ---- WHEN to send one stays in bot.ts, next to the guard it reports.

  /** Appended to /stop: says whether it also switched off the auto-redeploy. */
  stopRedeployNotice: (strand: StrandSummary | null) =>
    strand === null
      ? '\n\nI could not read whether a redeploy was pending, so if money is ' +
        'idle in your wallet, check /balance \u2014 nothing will put it back ' +
        'automatically now.'
      : strand.idleUsd !== null
        ? `\n\n\u26a0\ufe0f This also cancelled the automatic redeploy of ` +
          `$${strand.idleUsd.toFixed(2)} still sitting in your wallet. ` +
          `Nothing will put it back until you /start.`
        : '',

  adoptAmbiguous: (inPool: Array<{ nftMint: string; priceLower: number; priceUpper: number }>) => {
    const list = inPool
      .map((p: any) => `  \u2022 \`${p.nftMint.slice(0, 8)}...\` $${p.priceLower.toFixed(2)}-$${p.priceUpper.toFixed(2)}`)
      .join('\n');
    return (
      `Found ${inPool.length} open positions in this pool:\n${list}\n\n` +
      `Close the ones you do not want the bot to manage, then run /done again.`
    );
  },

  positionAdopted: (position: { nftMint: string; priceLower: number; priceUpper: number }) =>
    `\u2705 *Position adopted*\n\n` +
    `NFT: \`${position.nftMint.slice(0, 8)}...\`\n` +
    `Range: $${position.priceLower.toFixed(2)} - $${position.priceUpper.toFixed(2)}\n\n` +
    `Monitoring started.`,

  confirmAmountAsk: (recorded: number) =>
    `❓ *Is this the right amount?*\n\n` +
    `On record: *$${recorded.toFixed(2)}*\n\n` +
    `Type it back to confirm:\n` +
    `\`/confirm ${recorded.toFixed(2)}\`\n\n` +
    `Or /cancel to stop here.`,

  confirmAmountMismatch: (said: number, recorded: number) =>
    `❌ *That does not match.*\n\n` +
    `You typed: $${said.toFixed(2)}\n` +
    `On record: $${recorded.toFixed(2)}\n\n` +
    `Nothing has been opened. Send /start to set a different amount, or ` +
    `\`/confirm ${recorded.toFixed(2)}\` to go ahead with the recorded one.`,

  creatingPosition: () =>
    `🔄 Creating position on the fixed v0 range...\n\n` +
    `The Orchestrator will:\n` +
    `1. Set the range: live price ±4%\n` +
    `2. Swap to correct deposit ratio\n` +
    `3. Create LP position`,

  positionCreated: (result: PositionCreationResult) =>
    `✅ *Position Created!*\n\n` +
    `Operation: \`${result.operationId}\`\n` +
    `NFT: \`${result.nftMint.slice(0, 8)}...\`\n` +
    `Range: $${result.priceLower.toFixed(2)} - $${result.priceUpper.toFixed(2)}\n` +
    `Ratio: ${result.solRatio.toFixed(1)}% SOL / ${result.usdcRatio.toFixed(1)}% USDC\n` +
    `Deposited: $${result.valueUsd.toFixed(2)}\n` +
    `Range from: ${result.source === 'fixed' ? 'fixed v0 range' : '\u26a0\ufe0f fallback'}\n\n` +
    `Starting monitoring...`,

  rebalanceRefused: (outcome: Extract<RebalanceOutcome, { status: 'refused' }>) =>
    outcome.reason === 'ambiguous-position'
      ? `\u274c *Rebalance refused.* ${outcome.openCount} open positions in this pool ` +
          `and no record of which one to close. Close them manually before rebalancing.`
      : '\u274c *Refused.* Nothing to close and no deposit amount on record, ' +
          'and an unset budget would deploy the whole wallet. ' +
          'Send /start and enter the amount again.',

  rebalanceClosedOnly: () =>
    '\u274c *Rebalance stopped after the close.* The old position is ' +
    'closed and the funds are in your wallet, but I could not read ' +
    'what it was worth, so there is no budget to size a replacement. ' +
    'Nothing further was attempted \u2014 send /start to reopen.',

  rebalanceReopenFailed: (outcome: Extract<RebalanceOutcome, { status: 'closed-open-failed' }>) =>
    `\u274c *Rebalance stopped after the close.*\n\n` +
    `The old position is closed and about $${outcome.idleUsd.toFixed(2)} is ` +
    `sitting in your wallet, NOT in a position.\n\n` +
    `The reopen failed: ${outcome.error}\n\n` +
    (outcome.nothingSent
      ? `Nothing was sent that could land, so no money moved beyond the close.\n\n`
      : '') +
    `I will keep trying to redeploy it automatically. /balance shows it meanwhile.`,

  rebalanceFailed: (error: string) =>
    `\u274c *Rebalance failed:* ${error}\n\n` +
    `Nothing further was attempted. Check /status, then retry or close.`,

  rebalanceComplete: (opened: PositionCreationResult) =>
    `\u2705 *Rebalance Complete*\n\n` +
    `Operation: \`${opened.operationId}\`\n` +
    `NFT: \`${opened.nftMint.slice(0, 8)}...\`\n` +
    `Range: $${opened.priceLower.toFixed(2)} - $${opened.priceUpper.toFixed(2)}\n` +
    `Ratio: ${opened.solRatio.toFixed(1)}% SOL / ${opened.usdcRatio.toFixed(1)}% USDC\n` +
    `Deposited: $${opened.valueUsd.toFixed(2)} (range from ${opened.source})\n\n` +
    `Monitoring resumed.`,

  positionClosed: (txId: string, recovered: string) =>
    `\u2705 *Position Closed*\n\n` +
    `Tx: \`${txId.slice(0, 16)}...\`\n` +
    `Recovered: ${recovered}\n\n` +
    `Use /start to open a new position.`,

  closeFailed: (error: any) =>
    `\u274c *Close failed:* ${error?.message ?? 'Unknown error'}\n\n` +
    `The position is still open. Retry, or close it manually at ` +
    `https://raydium.io/portfolio/`,

  strandRecovered: (redeployedUsd: number, opened: PositionCreationResult) =>
    `\u2705 *Recovered.* $${redeployedUsd.toFixed(2)} is back in a ` +
    `position.\n\nRange: $${opened.priceLower.toFixed(2)} - ` +
    `$${opened.priceUpper.toFixed(2)}`,

  recoveryExhausted: (idleUsd: number, stuckFor: string, attempts: number) =>
    `\u{1F6A8} *Recovery gave up.*\n\n` +
    `$${idleUsd.toFixed(2)} has been sitting in your wallet for ` +
    `${stuckFor}, and ${attempts} attempts to redeploy it all failed.\n\n` +
    `Nothing further will be tried automatically. Check /balance, then ` +
    `/start to deploy it manually once the cause is understood.`,

  backInRange: (currentPrice: number) =>
    `\u2705 *Back in range* at $${currentPrice.toFixed(2)}.\n\n` +
    `No action needed. Still monitoring.`,

  autoRebalancing: (age: number, targetHours: number) =>
    `✅ *Auto-Rebalancing*\n\nPosition lasted ${Math.floor(age)}h (target: ${targetHours}h).\n\nRebalancing now — the new range is computed as part of it.`,

  overPositionCeiling: (amount: number, ceiling: number) =>
    `❌ *That is over the position ceiling.*\n\n` +
    `Requested: $${amount.toFixed(2)}\n` +
    `Ceiling:   $${ceiling.toFixed(2)} (MAX_POSITION_USD)\n\n` +
    `Nothing has been set up. Send a smaller amount, or raise the ceiling ` +
    `in the environment first — it is the last thing standing between a ` +
    `typo and the whole wallet.`,

  cannotPriceDeposit: () =>
    '❌ *Cannot price the deposit right now.*\n\n' +
    'Neither the Raydium pool nor CoinGecko returned a SOL price, so the ' +
    'split cannot be calculated. Nothing has been set up. Try again in a moment.',

  amountNotSaved: () =>
    '❌ *Could not save the amount.*\n\n' +
    'Nothing has been set up, and I will not offer to start with a figure ' +
    'I cannot read back — an unset budget means depositing the whole wallet. ' +
    'Try again in a moment.',

  /** Followed by `CHOICES.confirmStart`, which bot.ts appends. */
  readyToStart: (amount: number, solPrice: number) =>
    `📋 *Ready to Start*\n\n` +
    `Investment: $${amount.toFixed(2)}\n` +
    `Current SOL: $${solPrice.toFixed(2)}\n\n` +
    `*The Orchestrator will:*\n` +
    `1. Set the range: live price ±4%\n` +
    `2. Calculate CLMM deposit ratio\n` +
    `3. Swap to correct ratio if needed\n` +
    `4. Create LP position\n\n`,
};

export default messages;
