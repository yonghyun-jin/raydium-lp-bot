/**
 * Monitoring is derived, not stored — except for the operator's decision.
 *
 * WHY: `isMonitoring` was a status flag in `.telegram-state`, which a redeploy
 * erases. That is exactly what made a redeploy stop the watching: the flag went
 * while the position stayed live on-chain, and the 30s loop returned early
 * forever. "A position exists" is a better reason to watch than a flag that
 * does not survive.
 *
 * So the split is:
 *   - whether the loop is RUNNING  -> the interval handle, a fact about this process
 *   - whether the operator WANTS it -> bot_states.is_monitoring, read once at boot
 *
 * Scope: docs/v1/scopes/B1-session-state.md, deploy 4.
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
const types = codeOf('../../src/telegram/types.ts');

describe('the status flag is gone', () => {
  it('is not a stored field anywhere', () => {
    expect(types).not.toMatch(/^\s*isMonitoring\s*:/m);
    // The file that held it is gone along with the rest of the JSON session.
    expect(fs.existsSync(path.join(__dirname, '../../src/telegram/state.ts'))).toBe(false);
  });

  it('nothing reads a stored monitoring status', () => {
    expect(bot).not.toMatch(/state\??\.isMonitoring/);
  });

  it('/start asks the process, not the database, whether it is already running', () => {
    const fn = bot.slice(bot.indexOf('private async handleStart'));
    const body = fn.slice(0, fn.indexOf('\n  private ', 1));
    // Still the process and never a stored flag -- but the interval alone is NOT
    // the question. A live loop with no position is the stranded state, where
    // /start is the one command that helps; guarding on the interval alone made
    // it refuse there, leaving /start and /status pointing at each other with
    // /stop (which also cancels the redeploy) as the only exit.
    expect(body).toMatch(/if \(this\.monitorInterval && \(await this\.resolveActiveMint\(\)\)\)/);
    expect(body).not.toMatch(/getMonitoringIntent|isMonitoring/);
  });

  it('the 30s loop no longer gates on a flag', () => {
    // Its only gate is whether a position resolves.
    const loop = bot.slice(bot.indexOf('private async checkPosition'));
    const body = loop.slice(0, loop.indexOf('\n  private ', 1));
    expect(body).not.toMatch(/isMonitoring/);
    expect(body).toMatch(/const nftMint = await this\.resolveActiveMint\(\)/);
  });
});

describe('only a real decision records "stop"', () => {
  it('/stop records it', () => {
    const fn = bot.slice(bot.indexOf('private async handleStop'));
    expect(fn.slice(0, fn.indexOf('\n  private ', 1))).toMatch(
      /recordMonitoringIntent\(false\)/
    );
  });

  it('closing the position records it', () => {
    // Anchored on /close specifically. There are now two sites that clear the
    // mint -- the other is the rebalance stopping after its close -- and both
    // must record it, so assert both rather than whichever `near` finds first.
    const fn = bot.slice(bot.indexOf('private async handleClosePosition'));
    const body = fn.slice(0, fn.slice(1).search(/\n  (private|async|public)/) + 1);
    expect(body).toMatch(/this\.setActiveMint\(null\)/);
    expect(body).toMatch(/recordMonitoringIntent\(false\)/);
  });

  it('a rebalance that stops after its close records it too', () => {
    // The position is gone at that point; leaving the intent true would have
    // boot recovery resume a watch over nothing. The DECISION is the
    // Orchestrator's `closed-only` outcome now; this is the bot's reaction.
    const fn = bot.slice(bot.indexOf('private async performRebalanceInner'));
    const body = fn.slice(0, fn.slice(1).search(/\n  (private|async|public)/) + 1);
    const arm = body.slice(body.indexOf("case 'closed-only'"), body.indexOf("case 'failed'"));
    expect(arm).toMatch(/recordMonitoringIntent\(false\)/);
  });

  it('the daily cap pauses without recording a stop', () => {
    // This used to assert the same thing about handleApprovalRequest, which
    // has been deleted -- it was unreachable, since the callback that set it
    // was invoked nowhere. The claim survives on the path that IS reachable:
    // the position is still live when the cap pauses, so recording "stopped"
    // would have a redeploy abandon it permanently.
    const fn = bot.slice(bot.indexOf('private async performRebalanceInner'));
    const body = fn.slice(0, fn.slice(1).search(/\n  (private|async|public)/) + 1);
    const arm = body.slice(body.indexOf("case 'capped'"), body.indexOf("case 'refused'"));
    expect(arm).toMatch(/stopMonitoring\(\)/);
    expect(arm).not.toMatch(/recordMonitoringIntent/);
  });


  it('the daily cap does NOT record it either', () => {
    const fn = bot.slice(bot.indexOf('private async performRebalanceInner'));
    const body = fn.slice(0, fn.slice(1).search(/\n  (private|async|public)/) + 1);
    const arm = body.slice(body.indexOf("case 'capped'"), body.indexOf("case 'refused'"));
    expect(arm).toMatch(/this\.stopMonitoring\(\)/);
    expect(arm).not.toMatch(/recordMonitoringIntent/);
  });
});

describe('boot recovery resumes unless explicitly told not to', () => {
  it('only an explicit false refuses', () => {
    // null means unknown -- no row, or an unreachable database. A live position
    // with no recorded objection gets watched, because silently abandoning it
    // is the failure this method exists to fix.
    const fn = bot.slice(bot.indexOf('recoverPosition'));
    expect(fn).toMatch(/\(await getMonitoringIntent\(\)\) === false/);
    expect(fn).not.toMatch(/if \(!\(await getMonitoringIntent\(\)\)\)/);
  });

  it('records intent once it has resumed', () => {
    const fn = bot.slice(bot.indexOf('recoverPosition'));
    expect(fn).toMatch(/recordMonitoringIntent\(true\)/);
  });
});
