/**
 * No number the bot spends on may be invented, and no reset may be claimed
 * that did not happen.
 *
 * WHY, for each:
 *
 * 1. `getCurrentPrice()` ended with `return 100; // Approximate SOL price as
 *    last resort`. It survived several audits because it is framed as
 *    crash-avoidance rather than as a fallback — but a fabricated $100 anchors
 *    a range prediction and sizes a real deposit. Look for arbitrary numbers
 *    justified by robustness, not only ones labelled "fallback".
 *
 * 2. `getWalletBalance()` returned all zeros on error. That happened to fail
 *    closed on the one spend gate reading it, but it told the operator their
 *    wallet was empty when the RPC had simply not answered.
 *
 * 3. `handleResumeNow` reset `rebalancesToday` in the dead v0 JSON file and
 *    never called `resetRebalanceCount()`, so the operator's "resume now"
 *    button after the daily cap did nothing and the next rebalance was refused
 *    again. A miss from the rebalance-cap consolidation: the Orchestrator path
 *    was fixed and this one was not.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Comments stripped, so these guards measure code and not their own prose.
 * Every file read here goes through it — the first version of this test applied
 * it to bot.ts only and then matched an explanatory comment in config.ts that
 * named the very symbol it was asserting absent.
 */
function codeOf(relPath: string): string {
  return fs
    .readFileSync(path.join(__dirname, relPath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

const src = codeOf('../../src/telegram/bot.ts');
// B3 step 3 moved the price resolver and the balance read into the
// Orchestrator. Concatenating keeps every assertion below unchanged rather
// than loosening one to fit the move.
const money = src + codeOf('../../src/orchestrator/Orchestrator.ts');

describe('no invented price', () => {
  it('has no hardcoded price constant anywhere in the bot', () => {
    expect(src).not.toMatch(/return\s+100\s*;/);
  });

  it('getCurrentPrice can return null', () => {
    expect(src).toMatch(/getCurrentPrice\(\)\s*:\s*Promise<number \| null>/);
    expect(src).toMatch(/getPoolPrice\(\)\s*:\s*Promise<number \| null>/);
  });

  it('reports every source that failed, not one collapsed message', () => {
    // A loop that collapses three failures into one error destroys the
    // evidence needed to tell a rate limit from a geo-block from DNS.
    expect(money).toMatch(/failures\.push\(`raydium pool/);
    expect(money).toMatch(/failures\.push\(`coingecko/);
    expect(money).toMatch(/failures\.join/);
  });

  it('refuses the deposit confirmation when the price is unknown', () => {
    // The next tap after this message spends the amount.
    expect(src).toMatch(/if \(solPrice === null\) \{/);
  });

  it('recommends no range when there is no live price to anchor on', () => {
    expect(src).toMatch(/if \(anchor === null\) \{/);
  });
});

describe('no invented balance', () => {
  it('getWalletBalance can return null', () => {
    expect(src).toMatch(/getWalletBalance\(\)\s*:\s*Promise<WalletBalance \| null>/);
  });

  it('no longer manufactures a zero balance on error', () => {
    expect(src).not.toMatch(/sol:\s*0,\s*usdc:\s*0/);
  });

  it('fails closed on the spend gate rather than comparing against a bad read', () => {
    const gate = src.indexOf('if (amount > balance.totalUsd)');
    const guard = src.indexOf('if (!balance) {');
    expect(guard).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(guard); // the refusal comes first
  });

  it('reads the wallet once, before validating', () => {
    // It used to be fetched twice, inside branches, so the gate could compare
    // against a different read than the one shown to the user.
    const reads = src.match(/await this\.getWalletBalance\(\)/g) ?? [];
    expect(reads.length).toBe(3); // /start, /balance, amount input — one each
  });
});

describe('resume actually resumes', () => {
  it('resets the durable counter, not the dead JSON one', () => {
    const fn = src.slice(src.indexOf('private async handleResumeNow'));
    const body = fn.slice(0, fn.indexOf('\n  private async', 1));
    expect(body).toMatch(/await resetRebalanceCount\(\)/);
    expect(body).not.toMatch(/updateState\(\{\s*rebalancesToday/);
  });

  it('does not claim a reset it could not perform', () => {
    const fn = src.slice(src.indexOf('private async handleResumeNow'));
    const body = fn.slice(0, fn.indexOf('\n  private async', 1));
    // On failure it must return BEFORE startMonitoring, or the operator walks
    // away believing automation is armed while the cap is still in force.
    const fail = body.indexOf('return;');
    const start = body.indexOf('this.startMonitoring()');
    expect(fail).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(fail);
  });
});

describe('MAX_SLIPPAGE is a constant, and says so', () => {
  const cfg = codeOf('../../src/raydium/config.ts');
  const env = fs.readFileSync(path.join(__dirname, '../../.env.example'), 'utf8');

  it('executes 0.3% and is not env-configurable', () => {
    expect(cfg).toMatch(/MAX_SLIPPAGE:\s*0\.003/);
    expect(cfg).not.toMatch(/process\.env\.MAX_SLIPPAGE/);
  });

  it('is no longer advertised as a settable 1%', () => {
    // The documented value was 3.3x the executed one, on a spend path.
    expect(env).not.toMatch(/^MAX_SLIPPAGE=/m);
  });
});
