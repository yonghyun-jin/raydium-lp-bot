/**
 * The bot must know where to send a message after a redeploy.
 *
 * WHY: `chatId` lived in `.telegram-state/bot-state.json`, which is NOT on the
 * Railway volume. Every redeploy erased it, so `if (!state?.chatId) return`
 * dropped every unsolicited message — the approval prompt, the out-of-range
 * question, the auto-rebalance notice — while the bot went on monitoring a live
 * position. There is no error and nothing in the logs that looks wrong: it
 * simply stops speaking.
 *
 * It now lives in `bot_states.telegram_chat_id`, written from `ctx.chat.id` on
 * every authenticated update and read through `getOperatorChatId()`.
 *
 * Scope: docs/v1/scopes/B1-session-state.md, deploy 1.
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

describe('chatId has left the JSON', () => {
  it('is not a field on the v0 BotState', () => {
    expect(types).not.toMatch(/^\s*chatId\s*:/m);
  });

  it('there is no JSON session state left to hold one', () => {
    // createInitialState(userId, chatId) lived in src/telegram/state.ts. The
    // whole module is gone; the chat id is in bot_states.
    expect(fs.existsSync(path.join(__dirname, '../../src/telegram/state.ts'))).toBe(false);
    expect(bot).not.toMatch(/createInitialState/);
  });

  it('nothing reads state.chatId any more', () => {
    expect(bot).not.toMatch(/state\??\.chatId/);
  });

  it('boot recovery no longer guesses the chat id from the user id', () => {
    // True only because a PRIVATE chat's id equals the user's. A group
    // deployment would have sent every message to a chat that does not exist.
    expect(bot).not.toMatch(/chatId:\s*operatorId/);
  });
});

describe('chatId comes from Postgres', () => {
  it('is captured from ctx.chat.id on authenticated updates', () => {
    expect(bot).toMatch(/recordOperatorChat\(chatId\)/);
  });

  it('is resolved cache-first, database-second', () => {
    const fn = bot.slice(bot.indexOf('private async resolveChatId'));
    const body = fn.slice(0, fn.indexOf('\n  private async', 1));
    expect(body).toMatch(/if \(this\.operatorChatId !== null\) return this\.operatorChatId/);
    expect(body).toMatch(/await getOperatorChatId\(\)/);
  });
});

describe('an unreachable operator does not stop the bot acting', () => {
  it('notify reports delivery instead of throwing', () => {
    expect(bot).toMatch(/private async notify\(/);
    expect(bot).toMatch(/Promise<boolean>/);
  });

  it('the prompt latch is set ONLY when the question was delivered', () => {
    // Latching on an undelivered question would silence the whole episode —
    // the bot asks once into the void and never asks again. That is strictly
    // worse than the re-asking the latch exists to prevent.
    // The mint now comes from resolveActiveMint() rather than from the JSON,
    // so the expression is `nftMint`; the claim is unchanged.
    const latches = bot.match(/this\.promptedForMint = nftMint/g) ?? [];
    expect(latches.length).toBeGreaterThan(0);
    for (const m of bot.matchAll(/(.{0,40})this\.promptedForMint = nftMint/g)) {
      expect(m[1]).toMatch(/if \(asked\)\s*$/);
    }
  });

  it('a rebalance still happens when it cannot be narrated', () => {
    // The 24h branch acts WITHOUT asking, so an unreachable operator is a
    // reason to go unnarrated, not to leave a position un-rebalanced.
    expect(bot).toMatch(/performRebalance\(chatId: number \| null\)/);
    const say = bot.slice(bot.indexOf('performRebalance(chatId: number | null)'));
    expect(say.slice(0, 600)).toMatch(/if \(chatId === null\)[\s\S]{0,200}return Promise\.resolve\(\)/);
  });
});
