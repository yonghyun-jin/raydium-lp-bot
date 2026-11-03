// Is it safe to try again? -- asked of a FAILURE, and then of the CHAIN.
//
// THE POINT OF THIS FILE. On 2026-09-25 a rebalance closed a $1031.18 position
// and could not reopen it, and the money sat in the wallet doing nothing. Two
// specific causes were found and fixed. That is not enough: the next incident is
// by definition a failure nobody has classified yet, and a recovery path built
// out of `instanceof` checks against known errors cannot cover it.
//
// So the error class is NOT what authorises a retry. It only decides HOW LONG TO
// WAIT before asking the authoritative question, which is about STATE:
//
//   Is there a position on-chain? No. Does the wallet hold the funds? Yes.
//   Then nothing was deployed, whatever went wrong, and deploying now cannot
//   double-deploy.
//
// The one thing state cannot answer is whether a send is STILL IN FLIGHT -- a
// transaction submitted moments ago may yet land. That is a question of TIME, not
// of error type, and it has a definite answer: once a blockhash is older than its
// ~150-slot life, nothing carrying it can ever be included. Hence the settle
// window. An unrecognised error therefore still recovers; it just waits first.

import { BlockhashExpiredError } from './jito';
import { SendBlockedError } from './guard';

/**
 * How much is known about what a failed send actually did.
 *
 * `UNKNOWN` is the DEFAULT for anything unrecognised, on purpose: a new failure
 * mode must never be treated as safe to retry immediately. It is not a dead end
 * -- it waits out the settle window and is then resolved by reading the chain.
 */
export type Recoverability =
  /** Provably executed nothing. An expired transaction cannot be included. */
  | 'NOTHING_SENT'
  /** Executed and was rejected by the program. State unchanged but for the fee. */
  | 'LANDED_REVERTED'
  /** Cannot be told from the error alone. Settle, then read state. */
  | 'UNKNOWN';

/**
 * Nothing carrying a blockhash older than this can still be included.
 *
 * A blockhash lives ~150 slots. 90s is comfortably past that at any realistic
 * slot time, so once this has elapsed since the last send attempt, no in-flight
 * transaction from it can land and the chain's answer is final.
 */
export const SETTLE_MS = 90_000;

export function classifyFailure(error: unknown): Recoverability {
  // A policy refusal happens BEFORE anything is built, let alone sent.
  if (error instanceof SendBlockedError) return 'NOTHING_SENT';
  if (error instanceof BlockhashExpiredError) return 'NOTHING_SENT';

  const name = (error as any)?.name;
  if (name === 'TransactionRevertedError') return 'LANDED_REVERTED';
  if (name === 'TransactionExpiredBlockheightExceededError') return 'NOTHING_SENT';

  const message = String((error as any)?.message ?? error).toLowerCase();

  if (
    message.includes('expired blockhash') ||
    message.includes('blockhash not found') ||
    message.includes('block height exceeded') ||
    message.includes('nothing was sent that could land')
  ) {
    return 'NOTHING_SENT';
  }

  if (message.includes('landed and failed on-chain')) return 'LANDED_REVERTED';

  // Everything else, INCLUDING a bare timeout. A timeout is the canonical
  // unknown: the signature exists and may yet confirm.
  return 'UNKNOWN';
}

/**
 * May a redeploy be attempted now?
 *
 * Takes the failure's classification and OBSERVED STATE, and is deliberately
 * state-led: `positionsOnChain === 0` is what makes a retry safe, not the error.
 * The classification only buys the right to skip the settle wait.
 */
export function mayRedeploy(params: {
  classification: Recoverability;
  /** Open positions the wallet actually holds in the pool, read from the chain. */
  positionsOnChain: number;
  msSinceLastAttempt: number;
  settleMs?: number;
}): { allowed: boolean; reason: string } {
  const settleMs = params.settleMs ?? SETTLE_MS;

  // State first. A position already exists, so redeploying would be the
  // double-deploy this whole mechanism exists to prevent -- and if it is an
  // unexpected SECOND position, the caller's own ambiguity guard must handle it.
  if (params.positionsOnChain > 0) {
    return {
      allowed: false,
      reason: `${params.positionsOnChain} position(s) already open on-chain; nothing to redeploy`,
    };
  }

  // Provably nothing in flight, so the chain's answer is already final.
  if (params.classification === 'NOTHING_SENT') {
    return { allowed: true, reason: 'nothing was sent, so nothing can be in flight' };
  }

  // A revert executed and was rejected, so it changed nothing but the fee. The
  // chain read above already confirms no position came of it.
  if (params.classification === 'LANDED_REVERTED') {
    return { allowed: true, reason: 'the attempt reverted, so it deployed nothing' };
  }

  // UNKNOWN: a send may still be in flight. Wait until it provably cannot be.
  if (params.msSinceLastAttempt < settleMs) {
    const waitMs = settleMs - params.msSinceLastAttempt;
    return {
      allowed: false,
      reason:
        `outcome unknown and only ${Math.round(params.msSinceLastAttempt / 1000)}s has passed; ` +
        `waiting ${Math.round(waitMs / 1000)}s more so any in-flight send provably cannot land`,
    };
  }

  return {
    allowed: true,
    reason: 'outcome was unknown, but the settle window has passed and no position exists',
  };
}

/**
 * How long to wait before the next recovery attempt, in ms.
 *
 * Exponential, because a failure that repeats is usually an outage rather than
 * bad luck, and hammering it costs RPC quota this project is already being
 * 429'd on. Capped so recovery does not drift into never trying again.
 */
export function recoveryBackoffMs(attempts: number, baseMs = 30_000, capMs = 600_000): number {
  const raw = baseMs * Math.pow(2, Math.max(0, attempts));
  return Math.min(raw, capMs);
}
