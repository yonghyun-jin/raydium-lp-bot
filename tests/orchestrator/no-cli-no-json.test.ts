/**
 * The orchestrator CLI and its JSON store are gone. B2 is done when this stays
 * true.
 *
 * `npm run orchestrator` was a manual terminal command (start / monitor /
 * create / status / list) — the way the bot was driven before Telegram. It was
 * never deployed and never ran continuously. Everything that read
 * `.orchestrator-state/positions.json` was reachable only from it:
 * handleExistingPosition, checkAllPositions, forceRebalance, and PriceMonitor's
 * PositionState-shaped range checks.
 *
 * The store itself was the last JSON state in the project, it was the only one
 * on the Railway volume, and it held EIGHT rows marked ACTIVE against ONE
 * position on-chain — which was not among them.
 */

import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '../..');

function codeOf(rel: string): string {
  return fs
    .readFileSync(path.join(root, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

describe('the CLI is gone', () => {
  it.each([
    'src/orchestrator/cli.ts',
    'src/orchestrator/components/StateSaver.ts',
    'src/orchestrator/components/StateLoader.ts',
    'src/orchestrator/components/statePaths.ts',
    'src/orchestrator/types/PositionState.ts',
  ])('%s does not exist', (p) => {
    expect(fs.existsSync(path.join(root, p))).toBe(false);
  });

  it('npm run orchestrator is unregistered', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts.orchestrator).toBeUndefined();
  });

  it('no JSON position store is written anywhere', () => {
    const orch = codeOf('src/orchestrator/Orchestrator.ts');
    expect(orch).not.toMatch(/stateSaver|stateLoader|StateSaver|StateLoader/);
    expect(fs.existsSync(path.join(root, '.orchestrator-state'))).toBe(false);
  });
});

describe('what the CLI reached is gone with it', () => {
  const orch = codeOf('src/orchestrator/Orchestrator.ts');

  it.each([
    'handleExistingPosition',
    'checkAllPositions',
    'startMonitoring',
    'forceRebalance',
    'createPositionState',
  ])('%s is removed', (sym) => {
    expect(orch).not.toMatch(new RegExp(`\\b${sym}\\b`));
  });

  it('process() only creates — there is no second flow to fall into', () => {
    expect(orch).toMatch(/async process\(operationId: string, config: Config\)/);
    expect(orch).not.toMatch(/config\?: Config/);
  });

  it('exactly one record of a create remains, and it is gated', () => {
    const fn = orch.slice(orch.indexOf('private async handleNewPosition'));
    const body = fn.slice(0, fn.indexOf('\n  private ', 1));
    const records = body.match(/recordPositionOpened\(/g) ?? [];
    expect(records.length).toBe(1);
    expect(body).toMatch(/const landed = result\.txId !== 'DRY_RUN'/);
  });
});

describe('/rebalance points at the live path', () => {
  const bot = codeOf('src/telegram/bot.ts');

  it('no longer calls the orchestrator method that no longer exists', () => {
    expect(bot).not.toMatch(/orchestrator\.forceRebalance/);
  });

  it('runs the same rebalance the automatic path uses', () => {
    const fn = bot.slice(bot.indexOf('private async handleForceRebalance'));
    const body = fn.slice(0, fn.indexOf('\n  private ', 1));
    expect(body).toMatch(/await this\.performRebalance\(/);
  });

  it('does not bypass the daily cap', () => {
    // "Force" only ever meant "at the operator's request" — the bot passed
    // resetCounter:false. Bypassing is /resume, deliberately and separately.
    const fn = bot.slice(bot.indexOf('private async handleForceRebalance'));
    const body = fn.slice(0, fn.indexOf('\n  private ', 1));
    expect(body).not.toMatch(/resetRebalanceCount/);
  });
});
