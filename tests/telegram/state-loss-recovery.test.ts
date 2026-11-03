/**
 * Losing local state must never cause a double-deploy or an abandoned position.
 *
 * `.telegram-state` is not on the Railway volume, so every redeploy erases
 * `positionNftMint` while the position it named stays live on-chain. Two
 * handlers read that field and used to treat "not in local state" as "does not
 * exist":
 *
 *   performRebalance   the close was `if (state?.positionNftMint)` but the
 *                      create was UNCONDITIONAL -- so an approved rebalance
 *                      after a redeploy skipped the close and opened a SECOND
 *                      position on top of the first. The same capital deployed
 *                      twice, with nothing recording either.
 *
 *   handleClosePosition  replied "No position on record", set IDLE and closed
 *                      nothing -- abandoning a live position with the one
 *                      command a user would reach for to deal with it.
 *
 * Both now recover the mint from the chain, and REFUSE when it is ambiguous.
 * Source-level, because driving these handlers needs a wallet and an RPC.
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

function bodyOf(name: string): string {
  const start = source.indexOf(`private async ${name}(`);
  expect(start).toBeGreaterThan(-1);
  // Up to the next private method, which is enough to contain the handler.
  const next = source.indexOf('\n  private ', start + 10);
  return source.slice(start, next > start ? next : undefined);
}

/*
 * The rebalance's recovery behaviour MOVED to Orchestrator.rebalance().
 *
 * "recovers the mint from the chain", "refuses when ambiguous" and "never
 * creates unconditionally after a conditional close" are now asserted by
 * observing calls in tests/orchestrator/rebalance.test.ts, which is a better
 * guard than the string indices used here: it fails if the ORDER changes, not
 * merely if the text does.
 *
 * The incident they encode is unchanged. Local state did not survive a Railway
 * redeploy while the position it named stayed on-chain, so a rebalance approved
 * after a redeploy skipped the close and opened a SECOND position on top of the
 * first -- the same capital deployed twice, with nothing recording either.
 */

describe('handleClosePosition survives lost local state', () => {
  const body = bodyOf('handleClosePosition');

  it('looks on-chain before declaring there is no position', () => {
    expect(body).toMatch(/findOnChainPositions/);
    expect(orchestrator).toMatch(/getMyPositions\(\)/);
  });

  it('only gives up when nothing is open on-chain either', () => {
    // It used to assert the position of `this.stage = 'IDLE'`. That write was
    // one of twenty-one nobody read and is gone; the CLAIM is unchanged -- the
    // bot must consult the chain before concluding there is nothing to close.
    const giveUp = body.indexOf('No position on record and none open on-chain');
    const chain = body.indexOf('findOnChainPositions');
    expect(giveUp).toBeGreaterThan(-1);
    expect(chain).toBeGreaterThan(-1);
    expect(chain).toBeLessThan(giveUp);
  });


  it('refuses to guess between multiple open positions', () => {
    expect(body).toMatch(/open\.length > 1/);
  });
});
