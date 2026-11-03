// Retry policy for an open whose failure is known to have deployed nothing.

import { classifyFailure } from '../raydium/recoverability';
import type { PositionCreationResult } from './types';

/**
 * Open, and retry ONCE if the attempt provably sent nothing.
 *
 * Retries any failure classified as safe to repeat, not just a blockhash
 * expiry. UNKNOWN is deliberately NOT retried: in-process we cannot tell a lost
 * confirmation from a lost transaction, and retrying an unknown outcome is how
 * you deploy twice -- that case belongs to the reconciler. Once, not a ladder:
 * a second failure needs a live operator.
 */
export async function retryOpenIfNothingSent(
  open: () => Promise<PositionCreationResult>
): Promise<PositionCreationResult> {
  try {
    return await open();
  } catch (error: any) {
    const classification = classifyFailure(error);
    if (classification === 'UNKNOWN') throw error;

    console.warn(
      `[Orchestrator] The open failed but is known to have deployed nothing ` +
        `(${classification}). Retrying once against a fresh transaction.`
    );
    return await open();
  }
}
