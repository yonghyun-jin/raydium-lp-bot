/**
 * The daily rebalance cap is a SPEND limit, so it fails closed.
 *
 * It used to live in `.telegram-state`, which is not on the Railway volume --
 * so the 3-per-day cap reset on every redeploy and a deploy-heavy day had no
 * cap at all. There were also THREE implementations that could not see each
 * other: the JSON one, an unused Postgres one, and an in-memory field on
 * Orchestrator (worse still: that one reset on every process start).
 *
 * The distinction that matters is between "genuinely zero" and "unknown":
 *
 *   0     never rebalanced today          -> allow
 *   null  no operator id / db unreachable -> REFUSE
 *
 * The Postgres helper this replaced returned `false` whenever no row existed,
 * collapsing both into "allow" -- a spend limit that opens itself when the
 * database is down.
 */

import {
  getRebalanceCountToday,
  hasExceededRebalanceLimit,
  recordRebalance,
  resetRebalanceCount,
} from '../../src/recording';

describe('an unreadable count refuses to spend', () => {
  // Recording is inert in a test process, so every read here is "unknown" --
  // which is exactly the state being asserted on.
  it('reports null rather than 0 when the count cannot be established', async () => {
    await expect(getRebalanceCountToday()).resolves.toBeNull();
  });

  it('treats an unknown count as the limit being reached', async () => {
    await expect(hasExceededRebalanceLimit(3)).resolves.toBe(true);
    // Even with a generous limit: unknown is unknown, not low.
    await expect(hasExceededRebalanceLimit(9999)).resolves.toBe(true);
  });

  it('never reports "not exceeded" on a limit of zero', async () => {
    await expect(hasExceededRebalanceLimit(0)).resolves.toBe(true);
  });
});

describe('writes degrade', () => {
  it('recording a rebalance never throws', async () => {
    await expect(recordRebalance()).resolves.toBeUndefined();
  });

  it('resetting never throws', async () => {
    await expect(resetRebalanceCount()).resolves.toBeUndefined();
  });
});

describe('the limit has exactly one implementation', () => {
  const fs = require('fs');
  const path = require('path');
  const orchestrator = fs
    .readFileSync(path.join(__dirname, '../../src/orchestrator/Orchestrator.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('Orchestrator no longer keeps its own in-memory counter', () => {
    // An instance field resets on every process start, which is strictly worse
    // than the JSON file it sat beside.
    expect(orchestrator).not.toMatch(/private rebalancesToday/);
    expect(orchestrator).not.toMatch(/this\.rebalancesToday/);
    expect(orchestrator).not.toMatch(/this\.lastRebalanceDate/);
  });

  it('Orchestrator delegates to the durable counter', () => {
    expect(orchestrator).toMatch(/hasExceededRebalanceLimit/);
    expect(orchestrator).toMatch(/recordRebalance/);
  });

  it('the ORCHESTRATOR awaits the gate, and the bot no longer has its own', () => {
    // The cap moved with the rebalance. Two copies double-count; neither means
    // no cap at all, which is why it had to move and be removed in one change.
    const strip = (rel: string) =>
      fs
        .readFileSync(path.join(__dirname, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

    expect(strip('../../src/orchestrator/Orchestrator.ts')).toMatch(
      /await hasExceededRebalanceLimit\(/
    );
    expect(strip('../../src/telegram/bot.ts')).not.toMatch(/hasExceededRebalanceLimit/);
  });
});
