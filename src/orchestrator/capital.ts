// Capital: what the operator's money is doing, as numbers that always agree.

/**
 * The four figures that answer "is all of my capital working?".
 *
 * Kept as ONE pure module, and deliberately not computed at each surface, so
 * the tick log, `/status` and the dashboard cannot disagree about the same
 * dollars. Nothing here reads the chain or the database; the callers do that
 * and hand the readings in.
 *
 * WHY THIS EXISTS. The bot deployed $4,000, rebalanced for weeks, and ended up
 * working ~$3,000 without ever saying so. It could not say so: the rebalance
 * budget was the CLOSING POSITION's value, so every dollar the sizing left
 * behind -- the gas reserve, the ratio swap's cost, the non-binding leg's
 * excess, the SDK's slippage headroom -- landed in the wallet and dropped out
 * of the next budget permanently. Capital decayed every cycle even in a flat
 * market, and the one figure that could have revealed it
 * (`bot_states.investment_amount`) is written once at the first open and never
 * compared against anything again.
 */
export interface CapitalSummary {
  /** What the operator said to deploy. `bot_states.investment_amount`. */
  allocatedUsd: number | null;
  /** What the open position is worth right now, fees included. */
  positionValueUsd: number | null;
  /**
   * What the wallet could redeploy, net of the gas reserve.
   *
   * CONTEXT, NOT CAPITAL. This wallet is known to hold money that is not the
   * strategy's, so this figure must never be summed into what is working --
   * doing so asserts that every dollar in the wallet is the operator's
   * allocation, and the first version of this file did exactly that. On a
   * wallet holding $3,003 of unrelated USDC it reported a $3,003 surplus and
   * would have cried wolf on every single position.
   *
   * Its real job is to answer the follow-up question for a POSITIVE gap: is
   * the missing capital sitting right there, or is it actually gone?
   */
  idleWalletUsd: number | null;
  /**
   * allocated - deployed. The question the operator actually asked.
   *
   * POSITIVE means allocated capital is not in the position -- idle, or lost.
   * NEGATIVE means the POSITION ITSELF is worth more than was allocated, which
   * is real profit waiting for a decision, and is deliberately not inferred
   * from the wallet.
   */
  gapUsd: number | null;
  /**
   * Whether the redeployable wallet could cover a positive gap.
   *
   * The difference between "your money is idle" and "your money is gone", which
   * call for opposite responses. Null when either figure is unknown, and null
   * rather than false when there is no positive gap to cover.
   */
  coveredByIdle: boolean | null;
}

/**
 * Combine the readings.
 *
 * EVERY derived figure is null when any input it needs is null. This is the one
 * rule in the file and it is the whole point: the drift being invisible is what
 * cost the operator $1,000, and a `0` standing in for an unreadable wallet is a
 * drift of zero -- the single most reassuring wrong answer available. Unknown
 * has to arrive at the operator AS unknown.
 */
export function summariseCapital(input: {
  allocatedUsd: number | null;
  positionValueUsd: number | null;
  idleWalletUsd: number | null;
}): CapitalSummary {
  const { allocatedUsd, positionValueUsd, idleWalletUsd } = input;

  // DEPLOYED, not deployed-plus-wallet. Summing the wallet in would assert that
  // everything in it is the strategy's, which is false here and produces a
  // permanent phantom surplus on a wallet that holds the operator's own funds.
  const gapUsd =
    allocatedUsd === null || positionValueUsd === null ? null : allocatedUsd - positionValueUsd;

  const coveredByIdle =
    gapUsd === null || idleWalletUsd === null || gapUsd <= 0 ? null : idleWalletUsd >= gapUsd;

  return { allocatedUsd, positionValueUsd, idleWalletUsd, gapUsd, coveredByIdle };
}

/**
 * Is this gap worth interrupting the operator for?
 *
 * Two thresholds, because neither alone is right: a percentage lets a small
 * allocation leak unnoticed in absolute terms, and a flat dollar figure makes a
 * large allocation cry wolf over rounding. A gap must clear BOTH to count.
 *
 * An unknown gap is not reportable here -- it is not a drift, it is a failed
 * read, and the caller reports that as its own thing rather than as a number.
 */
export function isDriftWorthReporting(
  summary: CapitalSummary,
  thresholds: { minUsd: number; minFraction: number }
): boolean {
  const { gapUsd, allocatedUsd } = summary;
  if (gapUsd === null || allocatedUsd === null) return false;
  if (!(allocatedUsd > 0)) return false;

  const magnitude = Math.abs(gapUsd);
  return magnitude >= thresholds.minUsd && magnitude / allocatedUsd >= thresholds.minFraction;
}

/** The default thresholds: $5, or 1% of the allocation, whichever is larger. */
export const DRIFT_THRESHOLDS = { minUsd: 5, minFraction: 0.01 };

/**
 * One line for the console on every tick.
 *
 * Separate from the Telegram text because this one goes to the Railway logs,
 * where it is the only record that survives a restart and the only place a
 * history of the gap accumulates at all.
 */
export function capitalLogLine(summary: CapitalSummary): string {
  const usd = (value: number | null) => (value === null ? 'unknown' : `$${value.toFixed(2)}`);
  return (
    `[Capital] allocated=${usd(summary.allocatedUsd)} ` +
    `position=${usd(summary.positionValueUsd)} ` +
    `idle=${usd(summary.idleWalletUsd)} ` +
    `gap=${usd(summary.gapUsd)}` +
    (summary.coveredByIdle === null ? '' : ` coveredByIdle=${summary.coveredByIdle}`)
  );
}

/**
 * What the wallet could put into a position, net of the gas reserve.
 *
 * This is NOT `/balance` (which reports the whole wallet including the
 * reserve). NULL, NEVER ZERO, because this number caps a spend: a non-finite
 * result, or a SOL balance BELOW the reserve, is "cannot tell", and $0 would
 * read as "nothing to deploy".
 */
export function redeployableUsd(
  balance: { sol: number; usdc: number; solPrice: number },
  reserve: number
): number | null {
  if (!(balance.sol >= reserve)) {
    console.error(
      `[Capital] SOL balance ${balance.sol.toFixed(6)} is below the ${reserve} gas reserve; ` +
        'the redeployable amount is unknown, not zero.'
    );
    return null;
  }

  const redeployable = (balance.sol - reserve) * balance.solPrice + balance.usdc;
  if (!Number.isFinite(redeployable) || redeployable < 0) {
    console.error(`[Capital] Redeployable wallet computed as ${redeployable}; reporting unknown.`);
    return null;
  }

  return redeployable;
}
