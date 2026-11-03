/**
 * Send Guard
 *
 * A single choke point that every transaction-sending path must pass through.
 * The point is that spending money should require deliberate, explicit intent —
 * and that a test process should never be able to spend at all, by construction.
 *
 * Context: 19 consecutive mainnet position attempts failed with error 6017 between
 * 2026-09-12 and 2026-09-17, each one burning a priority fee and a Jito tip. The
 * code had no way to rehearse a transaction without paying for the attempt.
 */

import { SAFETY } from './config';

export class SendBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendBlockedError';
  }
}

/**
 * Throw unless this process is genuinely allowed to broadcast a transaction.
 *
 * @param what      Human-readable description of the send, used in the error.
 * @param valueUsd  Optional USD value at risk, checked against MAX_POSITION_USD.
 */
export function assertSendAllowed(what: string, valueUsd?: number): void {
  // A test process must never reach the chain, whatever the env says.
  if (process.env.JEST_WORKER_ID !== undefined || process.env.NODE_ENV === 'test') {
    throw new SendBlockedError(
      `[GUARD] Refusing to send from a test process: ${what}`
    );
  }

  if (SAFETY.DRY_RUN) {
    throw new SendBlockedError(`[GUARD] DRY_RUN is set, blocked: ${what}`);
  }

  if (!SAFETY.ALLOW_REAL_MONEY) {
    throw new SendBlockedError(
      `[GUARD] ALLOW_REAL_MONEY is not set, blocked: ${what}. ` +
        `Set ALLOW_REAL_MONEY=true to spend real funds.`
    );
  }

  if (valueUsd !== undefined && valueUsd > SAFETY.MAX_POSITION_USD) {
    throw new SendBlockedError(
      `[GUARD] $${valueUsd.toFixed(2)} exceeds MAX_POSITION_USD=$${SAFETY.MAX_POSITION_USD.toFixed(2)}: ${what}`
    );
  }
}

/** True when a send would be allowed, without throwing. Useful for branching. */
export function isSendAllowed(valueUsd?: number): boolean {
  try {
    assertSendAllowed('probe', valueUsd);
    return true;
  } catch {
    return false;
  }
}
