/**
 * Which position the bot manages comes from Postgres, not from a file.
 *
 * WHY: `positionNftMint` lived in `.telegram-state`, which a redeploy erases
 * while the position it names is still live on-chain. Three things broke at
 * once and none of them looked like an error: the 30s loop returned early and
 * watched nothing, `/status` reported no position, and a rebalance skipped the
 * close and opened a SECOND position on the same capital.
 *
 * Scope: docs/v1/scopes/B1-session-state.md, deploy 3.
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

describe('the mint has left the JSON', () => {
  it('is not a field on the v0 BotState', () => {
    expect(types).not.toMatch(/^\s*positionNftMint\s*\??\s*:/m);
  });

  it('nothing reads state.positionNftMint', () => {
    expect(bot).not.toMatch(/state\??\.positionNftMint/);
  });

  it('every consumer resolves it instead', () => {
    // NAMED, not counted. This asserted `uses.length === 5` and went red the
    // moment /start had to ask whether a position exists -- a sixth caller is
    // not a regression, and a test that cannot tell the two apart just gets its
    // number bumped until it means nothing. Each consumer below is one that must
    // never read the mint from anywhere else.
    const consumers = [
      'private async handleStart',
      'private async handleStop',
      'private async handleStatus',
      'private async handleClosePosition',
      'private async handleForceRebalance',
      'private async checkPosition',
    ];

    for (const marker of consumers) {
      const fn = bot.slice(bot.indexOf(marker));
      expect(bot.indexOf(marker)).toBeGreaterThan(-1);
      const body = fn.slice(0, fn.indexOf('\n  private ', 1));
      expect(body).toMatch(/await this\.resolveActiveMint\(\)/);
    }
  });
});

describe('a failed lookup is not remembered as "no position"', () => {
  it('only a positive result is cached', () => {
    // getOpenPositionForPool returns null for no-row, several-rows (it refuses
    // to guess) and unreachable-database alike. Caching that null would let one
    // failed query convince the bot permanently that it has no position while
    // the position sits live on-chain.
    const fn = bot.slice(bot.indexOf('private async resolveActiveMint'));
    const body = fn.slice(0, fn.indexOf('\n  private ', 1));
    expect(body).toMatch(/if \(recorded\) this\.activeMint = recorded\.nftMint/);
    expect(body).not.toMatch(/this\.activeMint = recorded \? /);
  });

  it('the loop re-resolves every tick rather than trusting a stale miss', () => {
    const loop = bot.slice(bot.indexOf('private async checkPosition'));
    const body = loop.slice(0, loop.indexOf('\n  private ', 1));
    expect(body).toMatch(/const nftMint = await this\.resolveActiveMint\(\)/);
  });
});

describe('the cache tracks the position', () => {
  it('is set wherever a position starts being managed', () => {
    // create, rebalance-create, force-rebalance-create, /done adoption,
    // boot recovery.
    const sets = bot.match(/this\.setActiveMint\([^)]*\)/g) ?? [];
    expect(sets.length).toBeGreaterThanOrEqual(5);
  });

  it('is cleared when the position is closed', () => {
    expect(bot).toMatch(/this\.setActiveMint\(null\)/);
  });

  it('boot recovery sets it before it starts the loop', () => {
    // There is no longer a has-state-file branch to get wrong -- the JSON is
    // gone -- but the ordering still matters: the loop must not start watching
    // before it knows which position it is watching.
    const fn = bot.slice(bot.indexOf('recoverPosition'));
    const set = fn.indexOf('this.setActiveMint(recorded.nftMint)');
    const start = fn.indexOf('this.startMonitoring()');
    expect(set).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(set);
  });
});
