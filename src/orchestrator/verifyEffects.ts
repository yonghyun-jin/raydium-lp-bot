/**
 * Did the rows we are about to write account for everything the transaction did?
 *
 * THE RESIDUAL IS A VERIFICATION RESULT, NOT A LEDGER ROW.
 *
 * An earlier draft of C3 made it a bookable `unexplained` category. That is
 * the wrong shape, and the reason is worth keeping: it takes our own
 * incomplete model of a transaction and files it in the data as though it were
 * an expense. Every balance change in a transaction has a cause. The goal is
 * to name all of them, not to have a drawer for the ones we have not named yet
 * -- because a drawer means a newly-introduced cost (a Token-2022 transfer
 * fee, an ATA creation, wSOL wrapping, dust) arrives as a plausible line item
 * nobody questions, instead of as something that fails.
 *
 * So: rows that do not sum to the transaction's real per-token delta are a
 * BUG. This module finds that out and says so loudly.
 *
 * What it does NOT do is refuse the write. Money has already moved by the time
 * we are checking, and a ledger that records nothing because the check failed
 * is strictly worse than one that records rows plus a loud complaint -- the
 * same asymmetry as everywhere else here: reads that gate spending fail
 * closed, writes degrade.
 */

import type { LedgerMovement } from '../recording';

/**
 * Tolerance for one token's comparison, in that token's own units.
 *
 * NOT a fudge factor for unexplained costs -- it exists only because these
 * numbers arrive as IEEE doubles after passing through base-unit conversions
 * at 9 and 6 decimals. A real missing cost is orders of magnitude larger than
 * this: the cheapest thing on this chain, a bare transaction fee, is 5e-6 SOL,
 * a thousand times the ceiling below.
 */
const DUST = 1e-9;

export interface TokenVerification {
  token: string;
  /** What the rows we built claim moved. */
  expectedDelta: number;
  /** What the transaction actually did to this wallet. */
  actualDelta: number;
  difference: number;
  verified: boolean;
}

export interface EffectsVerification {
  verified: boolean;
  perToken: TokenVerification[];
}

/**
 * Compare built rows against what the transaction actually did.
 *
 * `tokenAmounts` maps each token symbol to the wallet's real delta for it --
 * SOL from `effects.solDelta`, SPL tokens from `effects.tokenDeltas` keyed by
 * mint. The caller supplies the mapping because only it knows which symbol
 * goes with which mint.
 *
 * Rows are summed by TOKEN, not by USD. Token amounts are the fact;
 * `value_usd` is a valuation laid over them, and verifying in dollars would
 * let a price error hide an amount error.
 */
export function verifyEffects(
  movements: LedgerMovement[],
  actualByToken: Record<string, number>
): EffectsVerification {
  const expected: Record<string, number> = {};
  for (const m of movements) {
    expected[m.token] = (expected[m.token] ?? 0) + m.amount;
  }

  // Every token named on EITHER side. A token that appears only in the rows is
  // a movement we invented; one that appears only in the transaction is a
  // movement we missed. Both are failures, and iterating one side alone would
  // see just half of them.
  const tokens = new Set([...Object.keys(expected), ...Object.keys(actualByToken)]);

  const perToken: TokenVerification[] = [];
  for (const token of tokens) {
    const expectedDelta = expected[token] ?? 0;
    const actualDelta = actualByToken[token] ?? 0;
    const difference = actualDelta - expectedDelta;

    perToken.push({
      token,
      expectedDelta,
      actualDelta,
      difference,
      verified: Math.abs(difference) <= DUST,
    });
  }

  return {
    verified: perToken.every((t) => t.verified),
    perToken,
  };
}

/**
 * Report a failed verification in terms someone can act on.
 *
 * Deliberately says what to go looking for. A bare "amounts do not match" sends
 * the next person to re-read arithmetic that is probably correct, when the
 * actual answer is almost always an instruction effect nobody has modelled.
 */
export function describeVerification(v: EffectsVerification, txId: string): string {
  const failures = v.perToken.filter((t) => !t.verified);

  const lines = failures.map(
    (t) =>
      `  ${t.token}: rows say ${t.expectedDelta.toFixed(9)}, ` +
      `the chain says ${t.actualDelta.toFixed(9)} ` +
      `(off by ${t.difference.toFixed(9)})`
  );

  return (
    `[Ledger] ${txId} does not reconcile -- the rows do not account for ` +
    `everything the transaction did:\n${lines.join('\n')}\n` +
    `  This is a MISSING INSTRUCTION EFFECT, not a rounding problem. Look for ` +
    `an ATA being created or closed, wSOL wrapping or unwrapping, a Token-2022 ` +
    `transfer fee on the mint, or rent on an account this transaction touched. ` +
    `Read innerInstructions for the transaction and name the cause; do not add ` +
    `a catch-all row.`
  );
}
