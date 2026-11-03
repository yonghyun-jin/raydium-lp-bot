/**
 * A close must record what the position actually earned, and what it replaced.
 *
 * WHY, fees: the read was fixed (commit a659cf1) and the number was still
 * thrown away — none of the five `recordPositionClosed` call sites passed
 * `feesEarnedUsd`. So "how much have I earned in fees" stayed unanswerable
 * while the bot displayed a correct figure every 30 seconds. The capture has to
 * happen BEFORE the close: a successful close burns the position account, and
 * with it the only state the accrued figure can be derived from.
 *
 * WHY, prevPositionId: the column has existed since the v1 schema and nothing
 * ever wrote it. `recordPositionOpened` even declared the field on its input
 * type and silently dropped it — the same shape of bug as `tokenAddress` on the
 * ledger row: accepted by the compiler, absent from the database. Without the
 * link each position looks like an unrelated one-off and "how long did this
 * capital stay deployed across rebalances" is unrecoverable.
 *
 * Scope: docs/v1/scopes/B2-position-state.md.
 */

import * as fs from 'fs';
import * as path from 'path';

function codeOf(rel: string): string {
  return fs
    .readFileSync(path.join(__dirname, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

const bot = codeOf('../../src/telegram/bot.ts');
const recording = codeOf('../../src/recording/index.ts');
const dbPos = codeOf('../../src/db/position.ts');

/*
 * The "read before the close" invariants have MOVED, not gone.
 *
 * They used to be asserted here by slicing bot.ts and comparing string indices,
 * because the reads lived in the UI layer. They are now
 * ClosePosition.readBeforeClosing, and they are asserted BEHAVIOURALLY -- by
 * call order on an injected fake -- in tests/orchestrator/close-position.test.ts.
 * That is a strictly better guard and it survives the code moving again.
 *
 * What remains here is the bot's side of the boundary: that it delegates rather
 * than doing the reads itself.
 */
describe('the bot delegates the close instead of doing it', () => {
  it('/close calls the Orchestrator, not the raw client', () => {
    const fn = bot.slice(bot.indexOf('private async handleClosePosition'));
    const body = fn.slice(0, fn.indexOf('\n  private ', 1));
    expect(body).toMatch(/await this\.orchestrator\.closePosition\(mint\)/);
    expect(body).not.toMatch(/client\.closePosition/);
  });

  it('the rebalance does too, from inside the Orchestrator', () => {
    const orch = codeOf('../../src/orchestrator/Orchestrator.ts');
    const fn = orch.slice(orch.indexOf('async rebalance(params:'));
    expect(fn.slice(0, 2000)).toMatch(/await this\.closePosition\(mintToClose\)/);
  });

  it('the bot no longer reads a position in order to close it', () => {
    // readFeesUsd / readPositionForClose existed only because ClosePosition
    // returned `{ txId }` alone.
    expect(bot).not.toMatch(/private async readFeesUsd/);
    expect(bot).not.toMatch(/private async readPositionForClose/);
  });

  it('reports "unknown" rather than 0 when the withdrawal could not be read', () => {
    // An operator told they recovered 0.000000 SOL would conclude the close ate
    // the position.
    const fn = bot.slice(bot.indexOf('private async handleClosePosition'));
    const body = fn.slice(0, fn.indexOf('\n  private ', 1));
    expect(body).toMatch(/solWithdrawn === null \|\| result\.usdcWithdrawn === null/);
    expect(body).toMatch(/unknown/);
  });
});

describe('the Orchestrator records the close', () => {
  const orch = codeOf('../../src/orchestrator/Orchestrator.ts');

  /**
   * Bounded to the method itself. `codeOf` strips comments, so a slice that
   * stops at the next `/**` runs on to the end of the file — the first version
   * of this matched a `?? 0` in createNewPosition's `duration` and reported a
   * failure in code it was not looking at.
   */
  const closeBody = (() => {
    const fn = orch.slice(orch.indexOf('async closePosition(nftMint: string)'));
    const end = fn.slice(1).search(/\n  (async|private|public|[a-zA-Z]+\()/);
    return fn.slice(0, end + 1);
  })();

  it('records it itself, so a UI cannot forget', () => {
    const body = closeBody;
    expect(body).toMatch(/await recordPositionClosed\(nftMint, \{/);
  });

  it('records BEFORE returning, so a caller that throws next cannot skip it', () => {
    // If a rebalance's create throws, the old mint is already burned on-chain;
    // a row still marked open would outlive the incident.
    const body = closeBody;
    const record = body.indexOf('recordPositionClosed');
    const ret = body.indexOf('return result;');
    expect(record).toBeGreaterThan(-1);
    expect(ret).toBeGreaterThan(record);
  });

  it('passes undefined, not 0, for an unreadable figure', () => {
    const body = closeBody;
    expect(body).toMatch(/solWithdrawn: result\.solWithdrawn \?\? undefined/);
    expect(body).not.toMatch(/\?\? 0/);
  });
});

describe('a rebalance links the replacement to what it replaced', () => {
  it('the Orchestrator passes the closed mint as the predecessor', () => {
    // Moved with the rebalance; asserted behaviourally in
    // tests/orchestrator/rebalance.test.ts ("links the replacement to what it
    // replaced"). Here we only check the wiring exists.
    const orch = codeOf('../../src/orchestrator/Orchestrator.ts');
    expect(orch).toMatch(/prevPositionMint: mintToClose \?\? undefined/);
  });

  it('the recording facade forwards it instead of dropping it', () => {
    const fn = recording.slice(recording.indexOf('export async function recordPositionOpened'));
    const body = fn.slice(0, fn.indexOf('\nexport ', 1));
    expect(body).toMatch(/prevPositionId: input\.prevPositionId/);
  });

  it('the db layer persists it', () => {
    const fn = dbPos.slice(dbPos.indexOf('export async function createPosition'));
    const body = fn.slice(0, fn.indexOf('\nexport ', 1));
    expect(body).toMatch(/prevPositionId: input\.prevPositionId/);
  });

  it('a first open links to nothing rather than to itself', () => {
    // `mintToClose` is undefined when there was no position to close, and that
    // must reach the column as null, not as the new mint.
    expect(bot).not.toMatch(/prevPositionMint: result\.nftMint/);
  });
});
