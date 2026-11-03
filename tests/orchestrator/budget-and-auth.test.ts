/**
 * Two guarantees that only matter once ALLOW_REAL_MONEY is true.
 *
 * 1. No path swaps or deploys the whole wallet.
 *    `SwapToRatio.execute()` and `getDeployable()` both fall back to the entire
 *    wallet when no budget is supplied. `createNewPosition` always passed one;
 *    `rebalance`, `forceRebalance` and `createPositionManual` did not. On a
 *    $1,000 wallet that meant a $10 position being rebalanced would swap
 *    hundreds of dollars through Jupiter and then have the position refused by
 *    MAX_POSITION_USD -- paying the slippage for nothing.
 *
 * 2. Every swap is bounded by MAX_POSITION_USD.
 *    The guard skips its ceiling when `valueUsd` is undefined, and both
 *    jupiterSwap call sites omitted it, so the cap applied to positions but
 *    never to the swaps that funded them.
 *
 * Source-level, because the regression is a call site losing an argument --
 * behaviour tests pass either way, since the whole-wallet path is a legitimate
 * code path, just not one any caller here wants.
 */

import * as fs from 'fs';
import * as path from 'path';

function read(rel: string): string {
  return fs
    .readFileSync(path.join(__dirname, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('no path deploys the whole wallet', () => {
  const orchestrator = read('../../src/orchestrator/Orchestrator.ts');

  it('every swapToRatio.execute call passes a budget', () => {
    const calls = orchestrator.match(/swapToRatio\.execute\([^;]*?\);/gs) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/budgetUsd/);
    }
  });

  it('no caller falls back to getBalances for deposit sizing', () => {
    // getDeployable(poolId, ratio, budgetUsd) is the bounded equivalent.
    // getBalances reports the entire wallet and must not size a deposit.
    expect(orchestrator).not.toMatch(/const balances = await this\.swapToRatio\.getBalances\(/);
  });

  it('createPositionManual accepts a budget', () => {
    expect(orchestrator).toMatch(/investmentUsd\?: number;/);
  });
});

describe('swaps are bounded by MAX_POSITION_USD', () => {
  const client = read('../../src/raydium/client.ts');
  const swapToRatio = read('../../src/orchestrator/components/SwapToRatio.ts');

  it('both jupiterSwap guards receive a valueUsd', () => {
    const guards = client.match(/assertSendAllowed\('jupiterSwap:[^)]*\)/g) ?? [];
    expect(guards.length).toBe(2);
    for (const guard of guards) {
      // `assertSendAllowed('...', valueUsd)` -- a second argument must be there.
      expect(guard).toMatch(/,\s*valueUsd\s*\)/);
    }
  });

  it('SwapToRatio tells the client what each swap is worth', () => {
    expect(swapToRatio).toMatch(/swapSolToUsdc\([^)]*,[^)]*\)/);
    expect(swapToRatio).toMatch(/swapUsdcToSol\([^)]*,[^)]*\)/);
  });
});

describe('Telegram authorization', () => {
  const bot = read('../../src/telegram/bot.ts');

  it('gates updates with middleware before any handler', () => {
    expect(bot).toMatch(/this\.bot\.use\(/);
    expect(bot).toMatch(/TELEGRAM_ALLOWED_USER_IDS/);
  });

  it('fails closed when no allowlist is configured', () => {
    // The middleware must only call next() for an allowed id. An unset
    // allowlist produces an empty Set, so nothing matches and nothing proceeds.
    const middleware = bot.slice(bot.indexOf('this.bot.use('));
    expect(middleware).toMatch(/allowed\.has\(String\(userId\)\)/);
    expect(middleware).toMatch(/return next\(\);/);
    // Exactly one next() call: no unconditional fall-through.
    expect((middleware.match(/next\(\)/g) ?? []).length).toBe(1);
  });

  it('is installed before the command handlers', () => {
    expect(bot.indexOf('this.setupAuthorization()')).toBeLessThan(
      bot.indexOf('this.setupHandlers()')
    );
  });
});
