/**
 * A rehearsal must not leave a record of a position that was never opened.
 *
 * WHY: `handleNewPosition` saved the JSON state BEFORE the create and updated
 * it after, both unconditionally, while the Postgres write was gated on
 * `txId !== 'DRY_RUN'`. Every DRY_RUN rehearsal therefore wrote an ACTIVE row
 * for a position that does not exist, and every failed create left a PENDING
 * one.
 *
 * Measured before the fix: `.orchestrator-state/positions.json` held EIGHT rows
 * all marked ACTIVE, against ONE position on-chain — and that one position was
 * not among them. Postgres held two rows, one real and one for a position
 * burned days earlier.
 *
 * The invariant worth keeping even after the JSON store is deleted (scope B2):
 * every record of a position is written under the same condition, and that
 * condition is "it actually landed".
 */

import * as fs from 'fs';
import * as path from 'path';

const src = fs
  .readFileSync(path.join(__dirname, '../../src/orchestrator/Orchestrator.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

const fn = src.slice(src.indexOf('private async handleNewPosition'));
const body = fn.slice(0, fn.indexOf('\n  private ', 1));

describe('the create funnel', () => {
  it('decides "landed" once, from the transaction id', () => {
    expect(body).toMatch(/const landed = result\.txId !== 'DRY_RUN'/);
  });

  it('has no second, ungated record of a create', () => {
    // There used to be a `.orchestrator-state` write here, saved BEFORE the
    // create and unconditionally, alongside the DRY_RUN-gated Postgres write.
    // That store is deleted; the invariant it violated is what this asserts --
    // exactly one record of a create, and it is gated.
    expect(body).not.toMatch(/stateSaver|stateLoader/);
    const records = body.match(/recordPositionOpened\(/g) ?? [];
    expect(records.length).toBe(1);
  });

  it('records AFTER the create, never before it', () => {
    // Recording first is what left a PENDING row behind every failed create.
    const create = body.indexOf('await this.createPosition.execute(config)');
    const record = body.indexOf('recordPositionOpened(');
    expect(create).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(create);
  });

  it('gates the durable write on the same condition, not a second copy of it', () => {
    // Two separate `txId !== 'DRY_RUN'` checks could drift apart; one variable
    // cannot.
    const checks = body.match(/txId !== 'DRY_RUN'/g) ?? [];
    expect(checks.length).toBe(1);
    expect(body).toMatch(/if \(landed\) \{[\s\S]{0,400}recordPositionOpened/);
  });
});

describe('the reconcile script', () => {
  const rec = fs.readFileSync(
    path.join(__dirname, '../../scripts/reconcile-positions.ts'),
    'utf8'
  );

  it('is read-only unless --apply is passed', () => {
    expect(rec).toMatch(/const apply = process\.argv\.includes\('--apply'\)/);
    expect(rec).toMatch(/if \(apply\)/);
  });

  it('treats the chain as the source of truth for existence', () => {
    expect(rec).toMatch(/getMyPositions\(\)/);
    expect(rec).toMatch(/onChain\.has\(/);
  });

  it('does not adopt an unrecorded on-chain position automatically', () => {
    // Its open time is not recoverable from the chain, and inventing one makes
    // a mature position look fresh — which is the 24h auto-rebalance bug.
    expect(rec).toMatch(/UNRECORDED on-chain position/);
    expect(rec).not.toMatch(/recordPositionOpened/);
  });

  it('records no withdrawal figures when closing a phantom', () => {
    // Nothing was withdrawn; the position was never there. Zeros would assert a
    // settlement that did not happen.
    expect(rec).toMatch(/await recordPositionClosed\(row\.nftMint\);/);
  });
});
