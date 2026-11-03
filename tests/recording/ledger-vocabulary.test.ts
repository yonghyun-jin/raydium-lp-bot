/**
 * A ledger row's vocabulary is checked before it is booked.
 *
 * WHY: v0's `Action` was a closed TypeScript union, enforced on every row at
 * compile time. v1 widened it to `string` deliberately — no enum anticipates
 * every DeFi verb, and a closed union is exactly what blocked lending — but
 * nothing replaced the check, and the column is plain TEXT. A typo'd
 * `'create-lp'` is accepted silently and splits a P&L cycle in two, where the
 * query that groups by action finds neither half.
 *
 * The two halves are treated differently ON PURPOSE:
 *
 * - `category` is CLOSED and an unknown one is refused. P&L sums by category,
 *   so a value with no defined treatment would silently join the total.
 * - `action` stays OPEN and an unknown one is recorded with a loud warning.
 *   Refusing would mean a verb nobody anticipated could not be booked — the
 *   exact failure the open type was chosen to avoid.
 */

import { checkVocabulary, KNOWN_ACTIONS, KNOWN_CATEGORIES } from '../../src/recording/ledgerVocabulary';

describe('categories are closed', () => {
  it.each(KNOWN_CATEGORIES)('accepts %s', (category) => {
    expect(checkVocabulary({ action: 'swap', category })).toBeNull();
  });

  it('refuses an unknown category', () => {
    const reason = checkVocabulary({ action: 'swap', category: 'profit' });
    expect(reason).toMatch(/unknown category 'profit'/);
  });

  it('says why, and lists what is allowed', () => {
    // The refusal is read by whoever mistyped it, months later.
    const reason = checkVocabulary({ action: 'swap', category: 'nope' })!;
    expect(reason).toMatch(/P&L sums by category/);
    for (const c of KNOWN_CATEGORIES) expect(reason).toContain(c);
  });

  it('includes debt, which is summed rather than filtered', () => {
    // A borrow writes `principal +1000` AND `debt -1000`, which cancel.
    // Excluding debt reports a loan as income — an integration run caught that
    // returning $988 where the answer was -$12.
    expect(KNOWN_CATEGORIES).toContain('debt');
    expect(checkVocabulary({ action: 'borrow', category: 'debt' })).toBeNull();
  });

  it('keeps reward and fee apart', () => {
    // Fees EARNED on a position and fees PAID to a protocol move P&L in
    // opposite directions. v0 had only `reward`, so a paid fee was squeezed
    // into `cost` alongside rent.
    expect(KNOWN_CATEGORIES).toContain('reward');
    expect(KNOWN_CATEGORIES).toContain('fee');
  });
});

describe('actions stay open', () => {
  it.each(KNOWN_ACTIONS)('accepts the conventional action %s', (action) => {
    expect(checkVocabulary({ action, category: 'principal' })).toBeNull();
  });

  it('accepts an action nobody anticipated', () => {
    // Lending, staking, whatever comes next. Refusing here is what a closed
    // union did, and it is why v1 opened the type.
    expect(checkVocabulary({ action: 'flash_loan', category: 'principal' })).toBeNull();
  });

  it('warns about it, so a typo surfaces in the logs not in a P&L number', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      checkVocabulary({ action: 'create-lp', category: 'principal' }); // hyphen, not underscore
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/Unrecognised action 'create-lp'/);
      expect(warn.mock.calls[0][0]).toMatch(/splits a P&L cycle/);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn about a conventional one', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      checkVocabulary({ action: 'create_lp', category: 'principal' });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the surface that was missing', () => {
  const fs = require('fs');
  const path = require('path');
  const recording = fs
    .readFileSync(path.join(__dirname, '../../src/recording/index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  it('exposes a ledger write — there was previously none', () => {
    // src/db/ledger.ts had fourteen query functions and a migrated schema for
    // weeks. ledger_entries had zero rows because this facade exposed no way to
    // write one, so there was nothing for a call site to call.
    expect(recording).toMatch(/export async function recordLedgerRows/);
  });

  it('freezes valueUsd at amount * priceUsd rather than taking it from the caller', () => {
    // Recorded once, never recalculated: a later price change does not alter
    // what was true then. Letting callers pass it invites a third number.
    expect(recording).toMatch(/valueUsd: m\.amount \* m\.priceUsd/);
  });

  it('refuses the whole event when one row is unbookable', () => {
    // Half a movement pair is worse than none: the P&L would not balance and
    // nothing would say why.
    const fn = recording.slice(recording.indexOf('export async function recordLedgerRows'));
    const body = fn.slice(0, fn.indexOf('\nexport ', 1));
    expect(body).toMatch(/checkVocabulary\(m\)/);
    expect(body).toMatch(/Refusing/);
  });

  it('degrades rather than throwing, like every other write in the facade', () => {
    // A ledger that cannot be written must never stop a trade that already
    // happened on-chain. The row is bookkeeping; the position is real.
    const fn = recording.slice(recording.indexOf('export async function recordLedgerRows'));
    const body = fn.slice(0, fn.indexOf('\nexport ', 1));
    expect(body).toMatch(/await attempt\(/);
  });
});
