/**
 * The UI holds transport, an address, and where the conversation is. Nothing else.
 *
 * Everything else it used to hold was policy or a shadow of job state:
 *
 * - `pendingApproval` and `handleApprovalRequest` were UNREACHABLE. The
 *   callback that set them was assigned and invoked nowhere — it fired only
 *   from the Orchestrator's own loop, deleted with the CLI in B2 — so forty
 *   lines that stop monitoring and pause automation had never once run, while
 *   reading as live.
 * - `stage` had seven values of which TWO were ever read. The other five were
 *   written twenty-one times and read zero: a copy of job state the Orchestrator
 *   owns. A stage the bot writes and never consults cannot go stale loudly; it
 *   just disagrees with the chain in silence, which is how `positionOpenedAt`
 *   made a 44h position look new.
 *
 * What legitimately stays is per-SURFACE: a dashboard has no chat id and no
 * "the next message is an amount". Both survivors also fail closed when lost.
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

const bot = codeOf('src/telegram/bot.ts');
const orch = codeOf('src/orchestrator/Orchestrator.ts');
const types = codeOf('src/telegram/types.ts');

describe('the unreachable approval channel is gone', () => {
  it.each(['pendingApproval', 'handleApprovalRequest', 'ApprovalRequest'])(
    '%s is removed from the bot',
    (sym) => {
      expect(bot).not.toMatch(new RegExp(`\\b${sym}\\b`));
    }
  );

  it.each(['onApprovalRequired', 'setApprovalCallback', 'OnApprovalRequired'])(
    '%s is removed from the Orchestrator',
    (sym) => {
      expect(orch).not.toMatch(new RegExp(`\\b${sym}\\b`));
    }
  );

  it('the prompt latch no longer consults it', () => {
    // Anchored on the DEFINITION. `bot.indexOf('hasOutstandingPrompt')` finds
    // the first CALL SITE, four hundred lines earlier.
    const fn = bot.slice(bot.indexOf('private hasOutstandingPrompt'));
    expect(fn.slice(0, 200)).toMatch(/return this\.promptedForMint !== null;/);
  });
});

describe('stage is only what the conversation needs', () => {
  it('has the two values that are read, and no more', () => {
    // Anchored on the semicolon. Without it, `| 'PAUSED'` can be appended and
    // the pattern still matches the prefix.
    expect(types).toMatch(
      /UserStage = 'IDLE' \| 'AWAITING_AMOUNT' \| 'AWAITING_CONFIRMATION';/
    );
  });

  it.each(['MONITORING', 'AWAITING_APPROVAL', 'PAUSED', 'CREATING_POSITION'])(
    'no longer writes %s, which nothing read',
    (value) => {
      expect(bot).not.toMatch(new RegExp(`this\\.stage = '${value}'`));
    }
  );

  it('every remaining write has a reader', () => {
    const writes = new Set(
      [...bot.matchAll(/this\.stage = '([A-Z_]+)'/g)].map((m) => m[1])
    );
    const reads = new Set(
      [...bot.matchAll(/this\.stage (?:===|!==) '([A-Z_]+)'/g)].map((m) => m[1])
    );
    for (const w of writes) expect([w, reads.has(w)]).toEqual([w, true]);
  });
});

describe('what the UI still holds, and why', () => {
  it.each([
    ['bot', 'the transport itself'],
    ['operatorChatId', 'the delivery address — a dashboard has none'],
    ['stage', 'where this conversation is'],
  ])('keeps %s (%s)', (field) => {
    expect(bot).toMatch(new RegExp(`private ${field}\\b`));
  });

  it('still holds policy that B3 has not moved yet', () => {
    // Named so this test reads as a checklist rather than as approval.
    // monitorInterval + the single-flight flags go in step 5, activeMint
    // alongside them, promptedForMint in step 4.
    for (const f of ['monitorInterval', 'activeMint', 'promptedForMint']) {
      expect(bot).toMatch(new RegExp(`private ${f}\\b`));
    }
  });

  it('holds NO chain client -- step 3 is done', () => {
    // It used to lazily build a second RaydiumClient and never init() it, so
    // the 30s monitoring tick failed with `Raydium not initialized` while the
    // bot reported itself healthy and a live position went unwatched. Two
    // clients was also two wallet loads and two RPC connections, invisible
    // under test because both took the same injected fake.
    expect(bot).not.toMatch(/private raydiumClient\b/);
    expect(bot).not.toMatch(/getRaydiumClient/);

    // And it reaches the chain only through the Orchestrator.
    expect(bot).not.toMatch(/\.getPositionDetails\(/);
    expect(bot).not.toMatch(/\.getMyPositions\(/);
  });
});
