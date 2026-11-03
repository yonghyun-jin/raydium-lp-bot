/**
 * The manual open and the recovery open cannot both spend the same idle money.
 *
 * WHY THIS BECAME POSSIBLE: /start used to refuse whenever the 30s loop was
 * alive, which meant the operator could not start an open while the recovery
 * loop existed -- the exclusion was an accident of a guard that was wrong for
 * other reasons. Fixing that guard (a live loop with no position is the
 * STRANDED state, the one place /start is needed) removed the accident, so the
 * exclusion now has to be deliberate.
 *
 * WHAT IT COSTS IF IT FAILS: `recoverStranded` already refuses to redeploy while
 * a position is open on chain, so the window is only the gap between one path
 * sending and its position becoming visible. What fits through that gap is a
 * second four-figure position bought with money the first one already spent.
 */

import * as fs from 'fs';
import * as path from 'path';

const bot = fs.readFileSync(
  path.join(__dirname, '../../src/telegram/bot.ts'),
  'utf8'
);

function bodyOf(marker: string): string {
  const start = bot.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const rest = bot.slice(start);
  return rest.slice(0, rest.indexOf('\n  private ', 1));
}

describe('two paths, one wallet', () => {
  it('the flag exists and is not one of the loop guards', () => {
    // checkInFlight covers the loop against itself and rebalanceInFlight covers
    // the rebalance; NEITHER covers the manual open against the recovery open,
    // which is a different pair.
    expect(bot).toMatch(/private deployInFlight = false;/);
  });

  it('the manual open claims it, and releases it on every exit', () => {
    const body = bodyOf('private async handleConfirmStart');

    const claim = body.indexOf('this.deployInFlight = true;');
    const send = body.indexOf('this.orchestrator.createNewPosition(');
    expect(claim).toBeGreaterThan(-1);
    // Claimed BEFORE the send, or it is not a guard.
    expect(send).toBeGreaterThan(claim);

    // Released in a finally: a flag left set by a failed open would silence
    // recovery permanently, which is the failure this guard exists to prevent.
    expect(body).toMatch(/\} finally \{[\s\S]*this\.deployInFlight = false;/);
  });

  it('the manual open refuses rather than queueing behind a recovery attempt', () => {
    const body = bodyOf('private async handleConfirmStart');
    const refusal = body.indexOf('if (this.deployInFlight) {');
    const claim = body.indexOf('this.deployInFlight = true;');
    expect(refusal).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(refusal);
  });

  it('recovery checks it and claims it too', () => {
    const body = bodyOf('private async reconcileStranded');

    // Checked at the top: the tick's own guard is read up to 30s earlier and
    // /confirm can arrive in between.
    expect(body).toMatch(/if \(this\.deployInFlight\) \{/);
    const call = body.indexOf('this.orchestrator.recoverStranded(');
    const claim = body.indexOf('this.deployInFlight = true;');
    expect(claim).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(claim);
    expect(body).toMatch(/\} finally \{\s*this\.deployInFlight = false;/);
  });

  it('the 30s tick skips while an open is in flight', () => {
    const loop = bot.slice(bot.indexOf('private startMonitoring'));
    const body = loop.slice(0, loop.indexOf('\n  private ', 1));
    expect(body).toMatch(/if \(this\.deployInFlight\) \{/);
  });
});
