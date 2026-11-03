/**
 * A restart must not lose a live position, and must not adopt the wrong one.
 *
 * Nothing used to start monitoring at boot -- all six startMonitoring() calls
 * live inside handlers -- so after a Railway redeploy there was no interval at
 * all. Combined with `.telegram-state` not being on the volume, which erases
 * positionNftMint on every deploy, the bot forgot what it was holding and
 * nothing watched it until someone typed a command.
 *
 * Source-level: driving launch() needs a Telegram token, a wallet and an RPC.
 * What is pinned here is the decision structure, which is where the risk is --
 * resuming the WRONG position means eventually closing money that is not ours.
 */

import * as fs from 'fs';
import * as path from 'path';

const source = fs
  .readFileSync(path.join(__dirname, '../../src/telegram/bot.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

// B3 step 3 moved the chain reads into the Orchestrator. The PROPERTY these
// guard is unchanged -- the bot asks the chain, not just local state -- so the
// assertion follows the code rather than being loosened to fit.
const orchestrator = fs
  .readFileSync(path.join(__dirname, '../../src/orchestrator/Orchestrator.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const recovery = (() => {
  const start = source.indexOf('private async recoverPosition(');
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('\n  async launch(', start));
})();

describe('boot recovery', () => {
  it('is called from launch(), so a restart actually resumes', () => {
    const launch = source.slice(source.indexOf('async launch('));
    expect(launch.slice(0, launch.indexOf('\n  async '))).toMatch(/this\.recoverPosition\(\)/);
  });

  it('trusts only the intersection of the database and the chain', () => {
    // The DB says what we recorded; the chain says what exists. Either alone is
    // enough to resume a position that is gone, or miss one that is not.
    expect(recovery).toMatch(/getOpenPositionForPool/);
    expect(recovery).toMatch(/findOnChainPositions/);
    // ...and that is a real chain read, not a name that looks like one.
    expect(orchestrator).toMatch(/getMyPositions\(\)/);
  });

  it('does not resume a row that is recorded open but absent on-chain', () => {
    expect(recovery).toMatch(/onChain\.length === 0/);
    // Scan the branch body rather than to the first `}` -- the warning message
    // is a template literal, so `}` appears inside it before the block ends.
    const branch = recovery.slice(recovery.indexOf('onChain.length === 0'), 400 + recovery.indexOf('onChain.length === 0'));
    expect(branch).toMatch(/return;/);
    expect(branch).not.toMatch(/startMonitoring/);
  });

  it('depends on no local state at all', () => {
    // This used to assert `saveState({...})` was used rather than
    // `updateState`, because updateState writes NOTHING when no state file
    // exists -- precisely the post-redeploy case -- and would have silently
    // no-opped. The file is gone now, so the concern is answered structurally
    // instead: recovery reads Postgres and the chain, and writes neither.
    expect(recovery).not.toMatch(/loadState|saveState|updateState/);
    expect(recovery).toMatch(/getOpenPositionForPool/);
    expect(recovery).toMatch(/findOnChainPositions/);
    expect(orchestrator).toMatch(/getMyPositions/);
  });

  it('actually resumes: records intent and starts the loop', () => {
    // The post-redeploy case must not end in a no-op of any kind.
    expect(recovery).toMatch(/recordMonitoringIntent\(true\)/);
    expect(recovery).toMatch(/this\.startMonitoring\(\)/);
  });

  it('refuses to resume without an operator id to notify', () => {
    expect(recovery).toMatch(/TELEGRAM_ALLOWED_USER_IDS/);
    const guard = recovery.slice(recovery.indexOf('operatorId'));
    expect(guard).toMatch(/Number\.isFinite\(operatorId\)/);
  });

  it('never throws, so a failed recovery cannot stop the bot launching', () => {
    expect(recovery).toMatch(/catch \(error: any\) \{/);
    expect(recovery).toMatch(/\[Boot\] Position recovery failed/);
  });
});

describe('getOpenPositionForPool refuses to guess', () => {
  const rec = fs
    .readFileSync(path.join(__dirname, '../../src/recording/index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const fn = rec.slice(rec.indexOf('export async function getOpenPositionForPool'));

  it('returns null when more than one position is recorded open in the pool', () => {
    // Two open rows for one pool means our own bookkeeping is already wrong --
    // a close that never got recorded. Picking one would start managing a
    // position we may not own.
    expect(fn).toMatch(/inPool\.length > 1/);
    const many = fn.slice(fn.indexOf('inPool.length > 1'));
    expect(many.slice(0, many.indexOf('\n    }'))).toMatch(/return null;/);
  });

  it('is bounded by the same timeout as every other recording call', () => {
    expect(fn).toMatch(/Promise\.race/);
    expect(fn).toMatch(/RECORDING_TIMEOUT_MS/);
  });
});
