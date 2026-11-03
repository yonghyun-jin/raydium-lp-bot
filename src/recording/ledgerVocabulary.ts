/**
 * The vocabulary a ledger row may use, checked at the recording boundary.
 *
 * WHY THIS EXISTS: v0's `Action` was a closed TypeScript union, enforced on
 * every row at compile time. v1 widened it to `string` on purpose -- no enum
 * anticipates every DeFi verb, and a closed union is exactly what blocked
 * lending -- but nothing replaced the check. The column is plain TEXT, so a
 * typo'd `'create-lp'` is accepted silently and quietly splits a P&L cycle in
 * two: the query that groups by action finds neither half.
 *
 * So the vocabulary stays OPEN and becomes a runtime convention instead. An
 * unrecognised action is recorded, not refused -- refusing would mean a DeFi
 * verb nobody anticipated could not be booked, which is the failure the open
 * type was chosen to avoid -- but it is logged loudly, so a typo surfaces in
 * the logs rather than in a P&L number six weeks later.
 *
 * `category` is the opposite: it IS closed, because P&L arithmetic depends on
 * it. An unknown category would be summed into the total with no defined
 * meaning, so it is refused.
 */

import type { Category } from '../db/ledger';

/** Conventional actions. Not exhaustive by design -- see the note above. */
export const KNOWN_ACTIONS = [
  // swap
  'swap',
  // LP
  'create_lp',
  'close_lp',
  'harvest',
  // lending
  'supply',
  'withdraw',
  'borrow',
  'repay',
  // staking
  'stake',
  'unstake',
  'claim',
] as const;

/**
 * Every category the P&L arithmetic knows how to treat.
 *
 * `debt` is here and is SUMMED like everything else: a borrow writes
 * `principal +1000` AND `debt -1000`, which cancel. Filtering it out reports a
 * loan as income -- an integration run caught that returning $988 where the
 * answer was -$12.
 */
export const KNOWN_CATEGORIES: readonly Category[] = [
  'principal',
  'reward',
  'interest',
  'debt',

  // Execution costs, by who charged them (C3).
  'dex_fee',
  'platform_fee',
  'network_fee',
  'execution_slippage',

  // Refundable, so two events that net to zero over a lifecycle.
  'rent_deposit',
  'rent_reclaim',


  // Superseded by the four above. Still accepted because rows written before
  // C3 carry them, and refusing would make historical data unreadable at the
  // boundary that validates it. Do not write new rows with these.
  'fee',
  'slippage',
  'gas',
  'cost',
] as const;

/** Superseded names. New rows must not use them; old rows still contain them. */
export const LEGACY_CATEGORIES: readonly Category[] = ['fee', 'slippage', 'gas', 'cost'] as const;

/**
 * Check a row's vocabulary. Returns a reason to refuse, or null to proceed.
 *
 * Refuses an unknown CATEGORY, because P&L sums by category and a value with no
 * defined treatment would silently join the total. Merely warns about an
 * unknown ACTION, because the action vocabulary is deliberately open.
 */
export function checkVocabulary(row: { action: string; category: string }): string | null {
  if (!KNOWN_CATEGORIES.includes(row.category as Category)) {
    return (
      `unknown category '${row.category}' -- P&L sums by category, so a row with ` +
      `no defined treatment cannot be booked. Known: ${KNOWN_CATEGORIES.join(', ')}`
    );
  }

  if (!(KNOWN_ACTIONS as readonly string[]).includes(row.action)) {
    console.warn(
      `[Ledger] Unrecognised action '${row.action}'. Recording it anyway -- the ` +
        `action vocabulary is open -- but check for a typo: a misspelling splits ` +
        `a P&L cycle in two and neither half is found by the usual query.`
    );
  }

  return null;
}
