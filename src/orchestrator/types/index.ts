// Export all types

export * from './Config';
/*
 * REMOVED: './PositionState' -- the shape of `.orchestrator-state/positions.json`.
 *
 * It described a position's lifecycle in a file: operationId, status
 * PENDING|ACTIVE|CLOSED, createdAt, history, accumulated fees. Every one of
 * those now lives in the `positions` table, and the two age sources its own
 * comment warned could disagree ("for the same position the two can disagree")
 * are down to one: `positions.opened_at`, which is nullable so unknown stays
 * unknown.
 *
 * Note `PositionStatus` was TWO unrelated types across the two generations --
 * this file's lifecycle enum, and the live read model in src/telegram/types.ts.
 * Only the latter remains, so a grep for that name no longer spans generations.
 */

// Common types

export interface CreatePositionResult {
  nftMint: string;
  txId: string;
  /** SOL actually deposited, after sizing. */
  solDeposited: number;
  /** USDC actually deposited, after sizing. */
  usdcDeposited: number;
}

// Full workflow result (for external callers like Telegram bot)
export interface PositionCreationResult {
  operationId: string;
  nftMint: string;
  txId: string;
  priceLower: number;
  priceUpper: number;
  solAmount: number;
  usdcAmount: number;
  solRatio: number;   // 0-100
  usdcRatio: number;  // 0-100
  /** Where the range came from: the fixed v0 range, or a computed fallback. */
  source: 'fixed' | 'fallback';
  /** USD value actually deposited. */
  valueUsd: number;
}

/**
 * What a close actually produced.
 *
 * It used to be `{ txId }` alone, which is why the Telegram bot closed
 * positions itself: the figures a close must record -- what came back, and what
 * the position had earned -- were not available through this path, so the one
 * caller that could measure them bypassed it.
 *
 * Every field but `txId` is nullable, and the nulls are not interchangeable:
 *
 * - `feesEarnedUsd: undefined` -- unreadable. Recorded as NULL, never 0, since
 *   0 means "earned nothing" in the column a P&L report sums.
 * - `valueBeforeUsd: null` -- the position could not be valued before the
 *   close. A rebalance REFUSES on this, because that value is the budget for
 *   the replacement.
 * - `solWithdrawn` / `usdcWithdrawn: null` -- balances could not be read. These
 *   are reported, never used to size anything, so they degrade rather than
 *   refuse. Note they are wallet DELTAS: net of the close's own gas.
 */
export interface ClosePositionResult {
  /** The NFT burn. Only RENT moves here -- see decreaseTxId. */
  txId: string;
  /**
   * The decreaseLiquidity that actually returned the SOL and USDC.
   *
   * Undefined when the send's signature was lost and the withdrawal was instead
   * verified by reading the position, which is a real path in client.closePosition.
   * The ledger reconciled `solWithdrawn`/`usdcWithdrawn` against `txId` alone
   * until this existed, and reported a $1019.35 USDC withdrawal as
   * `chain says 0.000000000` -- correctly, since no USDC moves in a burn.
   */
  decreaseTxId?: string;
  /**
   * Whether the close actually took liquidity out.
   *
   * False for an already-empty position, which the burn closes on its own. That
   * is NOT the same absence as a `decreaseTxId` we failed to capture, and the
   * ledger reconciliation treats them differently: nothing to reconcile versus
   * nothing to reconcile AGAINST.
   */
  withdrewLiquidity?: boolean;
  solWithdrawn: number | null;
  usdcWithdrawn: number | null;
  feesEarnedUsd: number | undefined;
  valueBeforeUsd: number | null;
  /**
   * The same fees, per token, for the ledger.
   *
   * `solWithdrawn` and `usdcWithdrawn` are wallet deltas and ALREADY CONTAIN
   * these -- a close returns principal and collected fees in one movement. So a
   * ledger that booked the full delta as `principal` AND the fees as `reward`
   * would count them twice. The rows are written as `delta - fee` principal plus
   * `fee` reward, which sums back to what actually arrived, and that subtraction
   * needs the fees in SOL and USDC rather than combined into USD.
   */
  feeSol: number | undefined;
  feeUsdc: number | undefined;
}


export interface SwapResult {
  txId: string;
  amountIn: number;
  amountOut: number;
}

/**
 * What a rebalance did. The UI renders it; it does not re-decide it.
 *
 * A discriminated union rather than a boolean and some optional fields, because
 * each outcome demands a DIFFERENT state transition from the caller and getting
 * one wrong is how a position ends up unwatched or double-deployed:
 *
 * - `rebalanced`     start watching the new mint, clear any prompt latch
 * - `capped`         pause; the operator must /resume
 * - `refused`        nothing happened; the position is untouched
 * - `closed-only`    the position IS GONE and there is no replacement. Stop
 *                    watching, forget the mint, tell the operator to /start.
 *                    Treating this like `refused` would leave the bot watching
 *                    a position that no longer exists.
 * - `closed-open-failed`
 *                    the close SUCCEEDED and the open then threw. Same
 *                    real-world state as `closed-only` -- no position, funds in
 *                    the wallet -- but reached with the budget known, so the
 *                    operator can be told how much is sitting idle. This used
 *                    to arrive as `failed`, which made the bot keep watching a
 *                    burned mint and told the operator to check /status, the one
 *                    command that cannot see this state.
 * - `failed`         an exception escaped BEFORE anything was closed; the
 *                    position, if any, is untouched.
 */
export type RebalanceOutcome =
  | {
      status: 'rebalanced';
      opened: PositionCreationResult;
      /** Absent when there was nothing to close -- a first open, not a rebalance. */
      closedMint?: string;
      /** What the closing position was worth, and therefore the budget redeployed. */
      redeployedUsd: number;
    }
  | { status: 'capped'; limit: number }
  | { status: 'refused'; reason: 'ambiguous-position'; openCount: number }
  | { status: 'refused'; reason: 'no-budget' }
  | { status: 'closed-only'; closedMint: string }
  | {
      status: 'closed-open-failed';
      closedMint: string;
      /** What the close returned, and therefore what is now idle in the wallet. */
      idleUsd: number;
      error: string;
      /**
       * True when the failure is the one kind KNOWN to have moved no money -- an
       * expired transaction cannot be included by anyone. The operator can be
       * told so plainly instead of being left to wonder.
       */
      nothingSent: boolean;
    }
  | { status: 'failed'; error: string };

/**
 * What a recovery tick did about stranded funds.
 *
 * Most outcomes are NON-EVENTS -- `not-wanted`, `nothing-stranded`, `waiting` --
 * because this runs on every monitoring tick and the normal answer is "nothing to
 * do". They are named rather than collapsed into a boolean so the loop can stay
 * silent without being unable to say why it stayed silent.
 *
 * - `unknown`           state could not be READ. Not the same as nothing being
 *                       stranded: an unreachable database must not look healthy.
 * - `not-wanted`        the operator does not want a position (intent is IDLE).
 * - `nothing-stranded`  intent is DEPLOYED and nothing is owed. The good case.
 * - `waiting`           a discrepancy exists but it is not yet safe or not yet
 *                       time to act -- settle window or backoff.
 * - `already-deployed`  a position turned up, so the strand was stale. Cleared.
 * - `recovered`         the funds are back in a position.
 * - `failed`            this attempt failed; the strand stands and will be
 *                       retried until the ceiling.
 * - `exhausted`         the ceiling is reached. Nothing further is attempted and
 *                       the operator has to be told, loudly.
 */
export type RecoveryOutcome =
  | { status: 'unknown' }
  | { status: 'not-wanted' }
  | { status: 'nothing-stranded' }
  | { status: 'waiting'; reason: string }
  | { status: 'already-deployed' }
  | { status: 'recovered'; opened: PositionCreationResult; redeployedUsd: number }
  | { status: 'failed'; error: string; idleUsd: number; attempts: number }
  | { status: 'exhausted'; idleUsd: number; attempts: number; since: Date | null };
