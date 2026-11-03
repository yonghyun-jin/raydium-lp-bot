/**
 * Opening a position clears the stranded flag, whichever path opened it.
 *
 * WHY: `clearStranded()` was called only from inside `recoverStranded`, so a
 * strand recorded by a failed reopen survived every other way of deploying that
 * money. On 2026-10-13 a rebalance stranded $3,636.90, recovery never ran (the
 * operator's /stop had set deploy_intent IDLE), and the operator deployed it by
 * hand -- after which `bot_states.stranded_usd` still read 3636.90 with a live
 * position on chain.
 *
 * It sits quiet because the figure is only READ when no position resolves. That
 * is also precisely when it does damage: `/status` and `/stop` would report
 * "$3,636.90 is idle" about money that is in a position, which is the kind of
 * confident wrong number this project treats as worse than silence.
 *
 * The clear belongs in `handleNewPosition`, which the code documents as the ONE
 * funnel every create passes through -- `createNewPosition` and
 * `createPositionManual` both reach it via `process()` -- so one write covers
 * the manual open, the rebalance reopen and recovery alike.
 */

import * as fs from 'fs';
import * as path from 'path';

const orchestrator = fs.readFileSync(
  path.join(__dirname, '../../src/orchestrator/Orchestrator.ts'),
  'utf8'
);

/**
 * The body of a method, up to the next method DECLARATION.
 *
 * Not up to the next `/**`: these methods carry doc comments inside them, so
 * cutting there silently returns a fragment and the assertions below then pass
 * or fail for the wrong reason -- which is exactly what the first draft of this
 * file did.
 */
function bodyOf(marker: string): string {
  const start = orchestrator.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const rest = orchestrator.slice(start + marker.length);
  const next = rest.search(/\n {2}(async |private |public |get |set )/);
  return next === -1 ? rest : rest.slice(0, next);
}

const funnel = () => bodyOf('private async handleNewPosition(');

describe('the stranded flag is cleared by a successful open', () => {
  it('the create funnel clears it, not only recoverStranded', () => {
    expect(funnel()).toMatch(/clearStranded\(\)/);
  });

  it('is GATED on the transaction having landed', () => {
    // A DRY_RUN create returns a real SDK-derived nftMint with txId 'DRY_RUN'
    // while moving nothing. Clearing there would tell the reconciler that money
    // it has not deployed is no longer idle -- making the rehearsal this project
    // requires before a spend the thing that disables recovery of a live strand.
    // ASSERTED AS ONE ADJACENT SHAPE, not as "the body mentions `landed`
    // somewhere before the clear". The first version of this test did the
    // latter and stayed GREEN when the gate was mutated to `if (true)`,
    // because the position recording above uses `if (landed)` too -- a guard
    // that cannot fail, caught only by running the mutation.
    expect(funnel()).toMatch(
      /if \(landed\) \{\s*try \{\s*await clearStranded\(\);/
    );
  });

  it('a failed clear degrades to a warning rather than throwing', () => {
    // The position is already open and recorded by this point, so throwing here
    // would report a successful deployment as a failure.
    const body = funnel();
    const clear = body.indexOf('clearStranded()');
    const scope = body.slice(clear, clear + 400);
    expect(body.slice(Math.max(0, clear - 60), clear)).toMatch(/try \{/);
    expect(scope).toMatch(/console\.warn/);
  });

  it('recovery still clears it too', () => {
    // Belt and braces: the path that always did must keep doing it.
    expect(bodyOf('async recoverStranded(')).toMatch(/clearStranded\(\)/);
  });
});
