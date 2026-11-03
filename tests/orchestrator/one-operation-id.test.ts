/**
 * There is one name for the P&L grouping key, and one place that mints it.
 *
 * `jobCode` was v0 vocabulary — the primary key of the deleted
 * `.orchestrator-state` store, where a "job" was a CLI invocation. In v1 the
 * same value means `operation_id`: the key that groups the swap, the open and
 * the close of one position into one P&L cycle. Carrying both names meant
 * nobody reading `config.jobCode` could tell it was the ledger's grouping key.
 *
 * Two real defects came out with the rename:
 *
 * - `job_${Date.now()}` survived in TWO more places after the collision was
 *   "fixed" in one. An id that groups money must not be time-only: two cycles
 *   sharing one merge into a single wrong number, silently.
 * - `prevJobCode` was threaded through Config and RangeSetup and read by
 *   NOTHING. `positions.prev_position_id` (the mint) is the real link.
 */

import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '../..');

/** Comments stripped — a doc comment explaining the old id is not a use of it. */
function codeOf(rel: string): string {
  return fs
    .readFileSync(path.join(root, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

const SOURCES = [
  'src/orchestrator/types/Config.ts',
  'src/orchestrator/types/index.ts',
  'src/orchestrator/components/RangeSetup.ts',
  'src/orchestrator/Orchestrator.ts',
  'src/telegram/bot.ts',
  'src/recording/index.ts',
];

describe('one name', () => {
  it.each(SOURCES)('%s uses operationId, not jobCode', (rel) => {
    expect(codeOf(rel)).not.toMatch(/jobCode|JobCode/);
  });

  it('prevJobCode is gone — prev_position_id is the real link', () => {
    for (const rel of SOURCES) expect(codeOf(rel)).not.toMatch(/prevJobCode/);
  });
});

describe('one generator', () => {
  it('only Config.ts mints an operation id', () => {
    const minters = SOURCES.filter((rel) => /`op_\$\{/.test(codeOf(rel)));
    expect(minters).toEqual(['src/orchestrator/types/Config.ts']);
  });

  it('and it is not time-only', () => {
    // The collision was fixed in Config first and left standing in RangeSetup,
    // so "fixed" meant "fixed in one of three places" for a while.
    const cfg = codeOf('src/orchestrator/types/Config.ts');
    expect(cfg).toMatch(/randomBytes\(\d+\)/);
    expect(cfg).not.toMatch(/return `op_\$\{Date\.now\(\)\}`;/);
  });

  it('every site that needs one calls it rather than rolling its own', () => {
    const calls = SOURCES.map((rel) => (codeOf(rel).match(/newOperationId\(\)/g) ?? []).length)
      .reduce((a, b) => a + b, 0);
    expect(calls).toBeGreaterThanOrEqual(3); // two creates, plus the Config default
  });
});

describe('the unreachable v0 range entries are gone', () => {
  const rs = codeOf('src/orchestrator/components/RangeSetup.ts');

  it.each(['create(input', 'createFromPrevious'])('%s is removed', (sym) => {
    expect(rs).not.toContain(sym);
  });

  it('only the asymmetric entry remains', () => {
    // A symmetric range built from `rangePercent` is not what the model
    // produces, and picking a width by eye is the arbitrary-number failure
    // that cost 19 positions.
    expect(rs).toMatch(/createWithPrices\(input: \{/);
    expect(rs).not.toMatch(/rangePercent/);
  });
});
