/**
 * The bot answers slash commands, not inline buttons.
 *
 * WHY THIS NEEDED GUARDS: a button carried CONTEXT structurally. `confirm_start`
 * could only be tapped on the "Ready to Start" message, so the handler never had
 * to ask whether a confirmation was pending. A command can arrive at any moment
 * — from a scrollback tap, a typo, or a stale message — so every precondition a
 * button used to imply now has to be written down.
 *
 * `/confirm` is the sharp one: it is the last step before money moves.
 *
 * And a prompt with no buttons and no instructions is just a statement, so every
 * message that expects an answer must NAME the commands that answer it.
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
const msgs = codeOf('../../src/telegram/messages.ts');

describe('the buttons are gone', () => {
  it('no inline keyboards remain', () => {
    expect(bot).not.toMatch(/inlineKeyboard/);
    expect(bot).not.toMatch(/button\.callback/);
  });

  it('no callback-query handlers or acknowledgements remain', () => {
    expect(bot).not.toMatch(/bot\.action\(/);
    expect(bot).not.toMatch(/answerCbQuery/);
  });

  it('Markup is no longer imported', () => {
    expect(bot).not.toMatch(/\bMarkup\b/);
  });
});

describe('every offered command exists', () => {
  const handlers = new Set(
    [...bot.matchAll(/this\.bot\.command\('([a-z]+)'/g)].map((m) => m[1])
  );

  it('registers the replacements for each former button', () => {
    for (const c of [
      'confirm',
      'cancel',
      'approve',
      'wait',
      'close',
      'resume',
      'pause',
      'rebalance',
    ]) {
      expect(handlers.has(c)).toBe(true);
    }
  });

  it('/close exists — it was previously reachable ONLY by button', () => {
    // Removing the buttons without adding this would have left the operator
    // with no way to close a position at all.
    expect(handlers.has('close')).toBe(true);
  });

  it('every command the bot tells the operator to send is handled', () => {
    // A prompt naming a command nobody handles is worse than no prompt: the
    // operator sends it, nothing happens, and the bot looks hung.
    //
    // The pattern matches a command as the OPERATOR sees it -- at a line start,
    // after whitespace, or after a Markdown asterisk -- and NOT as part of a
    // path. A naive /\/([a-z]+)\b/ matches `./messages` and
    // `raydium.io/clmm/create-position`, which is how the first version of this
    // test reported `clmm` and `messages` as missing commands.
    const asCommand = /(?:^|[\s*]|\\n)\/([a-z]+)(?=[\s*,.`]|\\n|$)/gm;
    const offered = new Set([...(bot + '\n' + msgs).matchAll(asCommand)].map((m) => m[1]));
    const known = new Set([...handlers, 'start', 'stop', 'status', 'balance', 'done', 'help']);

    expect(offered.size).toBeGreaterThan(8); // the pattern actually found some
    for (const c of offered) {
      expect([c, known.has(c)]).toEqual([c, true]);
    }
  });
});

describe('the preconditions buttons used to imply', () => {
  function bodyOf(name: string): string {
    const fn = bot.slice(bot.indexOf(`private async ${name}(`));
    return fn.slice(0, fn.indexOf('\n  private ', 1));
  }

  it('/confirm refuses unless a confirmation is actually pending', () => {
    // It SPENDS. Without this a stray /confirm opens a position using whatever
    // budget happens to be on record.
    expect(bodyOf('handleConfirmStart')).toMatch(/this\.stage !== 'AWAITING_CONFIRMATION'/);
  });

  it('/approve refuses unless something is waiting on the operator', () => {
    expect(bodyOf('handleApproveRebalance')).toMatch(/!this\.hasOutstandingPrompt\(\)/);
  });

  it('/wait refuses unless something is waiting on the operator', () => {
    const cmd = bot.slice(bot.indexOf("this.bot.command('wait'"));
    expect(cmd.slice(0, 400)).toMatch(/!this\.hasOutstandingPrompt\(\)/);
  });

  it('/rebalance requires a position to rebalance', () => {
    // It used to gate on `pendingApproval`, which the deployed bot never set --
    // the Orchestrator approval path that sets it was reachable only from the
    // now-deleted CLI, so the command always answered "No pending approval".
    // It now runs the same path the automatic rebalance uses, and its
    // precondition is the one that can actually be true.
    const body = bodyOf('handleForceRebalance');
    expect(body).toMatch(/await this\.resolveActiveMint\(\)/);
    expect(body).toMatch(/if \(!nftMint\)/);
    expect(body).not.toMatch(/pendingApproval/);
  });
});

describe('prompts name the commands that answer them', () => {
  it('the choices are defined in one place, so they cannot drift', () => {
    expect(msgs).toMatch(/export const CHOICES/);
  });

  it('all three out-of-range prompts offer a choice', () => {
    const uses = bot.match(/CHOICES\.outOfRange/g) ?? [];
    expect(uses.length).toBe(3); // age-unknown, early-exit, normal
  });

  it('the deposit confirmation says how to confirm', () => {
    expect(bot).toMatch(/CHOICES\.confirmStart/);
  });

  it('the daily-cap message says how to resume', () => {
    expect(bot).toMatch(/CHOICES\.afterDailyCap/);
  });

  it('help does not advertise a command with no handler', () => {
    // /settings was listed for months and never had one.
    expect(msgs).not.toMatch(/\/settings/);
  });
});
