/**
 * The categories execution costs get, and why each one is separate.
 *
 * This slice adds vocabulary and a column and nothing writes them yet, which
 * is deliberate -- a surface with no call sites ships safely on its own. What
 * these guards protect is the REASONING, because every one of these splits was
 * argued for and could be "simplified" back by someone who only sees four
 * similar-looking cost names.
 *
 * Design: docs/v1/scopes/C3-execution-costs.md
 */

import * as fs from 'fs';
import * as path from 'path';
import { KNOWN_CATEGORIES, LEGACY_CATEGORIES, checkVocabulary } from '../../src/recording/ledgerVocabulary';
import { verifyEffects, describeVerification } from '../../src/orchestrator/verifyEffects';

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, rel), 'utf8');
}

describe('costs are separated by who charged them', () => {
  it.each([
    ['dex_fee', 'the pools, summed across routePlan hops'],
    ['platform_fee', "Jupiter's own, separate from any pool's"],
    ['network_fee', 'the network, priority fee included'],
    ['execution_slippage', 'nobody -- quoted output against actual output'],
  ])('%s is its own category (%s)', (category) => {
    expect(KNOWN_CATEGORIES).toContain(category);
    expect(checkVocabulary({ action: 'swap', category })).toBeNull();
  });

  it('rent is two categories, because it is refundable', () => {
    // A single `rent` cost would overstate every completed cycle: the lamports
    // come back when the account closes, so over a lifecycle it nets to zero.
    expect(KNOWN_CATEGORIES).toContain('rent_deposit');
    expect(KNOWN_CATEGORIES).toContain('rent_reclaim');
  });

  it('there is no `rent` category, so the netting cannot be collapsed by accident', () => {
    // Compiler-backed: collapsing the pair into one `rent` breaks the Category
    // union and the build. Kept as documentation of WHY the pair exists, for
    // whoever sees two similar names and reaches for the simplification.
    expect(KNOWN_CATEGORIES).not.toContain('rent');
  });
});

describe('the residual is a verification result, not a category', () => {
  it('there is no `unexplained` category', () => {
    // An earlier draft of this scope made the residual a bookable cost. That
    // hands our own incomplete model of a transaction to the data and calls it
    // an expense -- and then a newly-introduced cost (a Token-2022 transfer
    // fee, an ATA creation, wSOL wrapping) arrives as a plausible line item
    // nobody questions, rather than as something that fails.
    expect(KNOWN_CATEGORIES).not.toContain('unexplained');
    expect(checkVocabulary({ action: 'swap', category: 'unexplained' })).toMatch(/unknown category/);
  });

  it('rows that do not account for the whole transaction fail verification', () => {
    const rows = [
      { token: 'SOL', amount: -1 },
      { token: 'USDC', amount: +149.95 },
    ] as any;

    // The chain says 0.006 USDC less arrived than the rows claim. Under the old
    // design that became an `unexplained` row and the ledger looked complete.
    const v = verifyEffects(rows, { SOL: -1, USDC: 149.944 });

    expect(v.verified).toBe(false);
    const usdc = v.perToken.find((t) => t.token === 'USDC')!;
    expect(usdc.difference).toBeCloseTo(-0.006, 9);
  });

  it('a fully accounted transaction verifies', () => {
    const rows = [
      { token: 'SOL', amount: -1 },
      { token: 'SOL', amount: -0.000005 },
      { token: 'USDC', amount: +149.95 },
      { token: 'USDC', amount: -0.03 },
    ] as any;

    const v = verifyEffects(rows, { SOL: -1.000005, USDC: 149.92 });
    expect(v.verified).toBe(true);
    expect(v.perToken.every((t) => Math.abs(t.difference) < 1e-9)).toBe(true);
  });

  it('a token the rows never mention is a failure, not an absence', () => {
    // Iterating only the rows would miss a movement we failed to model
    // entirely -- which is the exact case this check exists for.
    const v = verifyEffects([{ token: 'SOL', amount: -1 }] as any, { SOL: -1, USDC: 12 });

    expect(v.verified).toBe(false);
    expect(v.perToken.find((t) => t.token === 'USDC')!.difference).toBeCloseTo(12, 9);
  });

  it('the failure message sends the reader to instruction effects', () => {
    const v = verifyEffects([{ token: 'USDC', amount: 1 }] as any, { USDC: 0.9 });
    const message = describeVerification(v, 'TX_ABC');

    // A bare "amounts do not match" sends the next person to re-read
    // arithmetic that is probably fine.
    expect(message).toMatch(/innerInstructions/);
    expect(message).toMatch(/do not add a catch-all row/);
  });

  it('the tolerance is float dust, not room for a real cost', () => {
    const verify = read('../../src/orchestrator/verifyEffects.ts');
    const match = verify.match(/const DUST = ([0-9.e-]+);/);
    expect(match).not.toBeNull();

    // The cheapest thing on this chain is a bare transaction fee at 5e-6 SOL.
    // A tolerance anywhere near that would swallow one.
    expect(Number(match![1])).toBeLessThan(5e-6 / 100);
  });

  it('getOperationBreakdown initialises every known category', () => {
    // A breakdown that omits a category returns undefined for it, and a caller
    // adding those up gets NaN rather than a wrong-but-visible number.
    //
    // `Record<Category, number>` already forces this, so today the compiler is
    // the real guard -- verified by deleting a key, which does not build. This
    // becomes load-bearing the moment anyone widens that type to Partial<>.
    const ledger = read('../../src/db/ledger.ts');
    const start = ledger.indexOf('const breakdown: Record<Category, number> = {');
    expect(start).toBeGreaterThan(-1);
    const block = ledger.slice(start, ledger.indexOf('};', start));

    for (const category of KNOWN_CATEGORIES) {
      expect(block).toContain(`${category}: 0`);
    }
  });

  it('P&L still sums every row, with no exclusion list', () => {
    // Unrelated to the residual, and still the rule: filtering `debt` out once
    // reported a $1000 loan as $988 of income.
    const ledger = read('../../src/db/ledger.ts');
    expect(ledger).not.toMatch(/category:\s*\{\s*not(In)?:/);
  });
});

describe('quote-time estimates never become rows', () => {
  it('priceImpactPct is not a category', () => {
    // A pre-trade estimate is not a measured execution difference. Writing the
    // first where the second belongs makes the ledger assert a number nobody
    // measured. It lives in the `quote` JSON instead.
    expect(KNOWN_CATEGORIES).not.toContain('price_impact');
    expect(KNOWN_CATEGORIES).not.toContain('priceImpact');
  });

  it('the quote column exists, is nullable, and is JSONB', () => {
    const schema = read('../../prisma/schema.prisma');
    expect(schema).toMatch(/quote\s+Json\?/);

    const migration = read('../../prisma/migrations/20260920_ledger_quote/migration.sql');
    expect(migration).toMatch(/ADD COLUMN "quote" JSONB/);
  });
});

describe('superseded names still read back', () => {
  it.each([...LEGACY_CATEGORIES])('%s is still accepted', (category) => {
    // Rows written before C3 carry these. Refusing them at the boundary that
    // validates rows would make historical data unreadable.
    expect(checkVocabulary({ action: 'swap', category })).toBeNull();
  });

  it('an unknown category is still refused', () => {
    // `category` stays CLOSED. P&L sums by category, so a value with no defined
    // treatment would silently join the total.
    expect(checkVocabulary({ action: 'swap', category: 'vibes' })).toMatch(/unknown category/);
  });
});
