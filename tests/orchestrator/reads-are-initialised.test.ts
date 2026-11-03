/**
 * A read that forgets init() fails every time, and looks healthy doing it.
 *
 * This is not hypothetical. The bot used to build its OWN RaydiumClient,
 * lazily, and three of its handlers called `client.init()` explicitly while
 * `getPositionStatus` -- the monitoring path -- did not. So every 30s tick
 * failed with `Raydium not initialized`, the error was caught and logged, the
 * bot reported itself healthy, and a live $993 position went unwatched.
 *
 * It was invisible under test because the fake needs no init, and invisible in
 * production because the failure was a log line in a loop nobody reads.
 *
 * Two clients was also two wallet loads and two RPC connections. There is one
 * now, it lives in the Orchestrator, and the bot holds none.
 */

import * as fs from 'fs';
import * as path from 'path';

const orchestrator = fs
  .readFileSync(path.join(__dirname, '../../src/orchestrator/Orchestrator.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const bot = fs
  .readFileSync(path.join(__dirname, '../../src/telegram/bot.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

function method(source: string, name: string): string {
  const start = source.search(new RegExp(`async ${name}\\(`));
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n {2}(?:private |public |async |static )?[a-zA-Z_]+[<(]/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

describe('every chain read initialises first', () => {
  it.each([
    ['getPositionStatus', 'the monitoring tick -- the one that actually broke'],
    ['getSolPriceUsd', 'gates a deposit'],
    ['getWalletBalance', 'gates a deposit'],
    ['findOnChainPositions', 'decides which position is ours'],
  ])('%s awaits init (%s)', (name) => {
    const body = method(orchestrator, name);

    // Before the first use of this.client, not merely somewhere in the file.
    const init = body.indexOf('await this.init()');
    const use = body.indexOf('this.client.');

    expect(init).toBeGreaterThan(-1);
    expect(use).toBeGreaterThan(-1);
    expect(init).toBeLessThan(use);
  });
});

describe('there is exactly one client', () => {
  it('the bot holds none', () => {
    expect(bot).not.toMatch(/private raydiumClient\b/);
    expect(bot).not.toMatch(/getRaydiumClient/);
    expect(bot).not.toMatch(/new RealClient/);
  });

  it('the bot never touches the chain directly', () => {
    // Every one of these used to be a call on the bot's own client.
    for (const call of ['getPositionDetails', 'getMyPositions', 'getSolBalance', 'getUsdcBalance']) {
      expect(bot).not.toMatch(new RegExp(`\\.${call}\\(`));
    }
  });

  it('the Orchestrator is the only place one is constructed', () => {
    const constructions = orchestrator.match(/new RealClient\(\)/g) ?? [];
    expect(constructions.length).toBe(1);
  });

  it('the bot goes through the Orchestrator for each read it lost', () => {
    expect(bot).toMatch(/this\.orchestrator\.getPositionStatus\(/);
    expect(bot).toMatch(/this\.orchestrator\.getWalletBalance\(/);
    expect(bot).toMatch(/this\.orchestrator\.getSolPriceUsd\(/);
    expect(bot).toMatch(/this\.orchestrator\.findOnChainPositions\(/);
  });
});
