/**
 * With no position ceiling, the only thing left is saying the number twice.
 *
 * The operator removed MAX_POSITION_USD as a limit and asked for a second
 * check before the spend instead. `/confirm` therefore takes the amount as an
 * argument and refuses a bare one: a stray or half-remembered confirm cannot
 * open a position, and a typo has to be typed identically twice to get through.
 *
 * Deliberately NOT a new `stage`. This project spent a week removing UI state,
 * and an argument on the command carries the check without any -- and unlike a
 * stage, it survives a restart.
 */

import * as fs from 'fs';
import * as path from 'path';

const bot = fs
  .readFileSync(path.join(__dirname, '../../src/telegram/bot.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

function handler(name: RegExp): string {
  const start = bot.search(name);
  expect(start).toBeGreaterThan(-1);
  const rest = bot.slice(start);
  const end = rest.slice(1).search(/\n {2}(?:private |public |async |static )?[a-zA-Z_]+[<(]/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

describe('the confirm restates the amount', () => {
  const confirm = handler(/private async handleConfirmStart\(/);

  it('reads the recorded amount and refuses when it cannot', () => {
    // null means "deploy the whole wallet" downstream, so an unreadable budget
    // must stop the open rather than fall through to it.
    expect(confirm).toMatch(/getInvestmentAmount\(\)/);
    expect(confirm).toMatch(/recorded === null/);
  });

  it('asks rather than spends when no amount is given', () => {
    const ask = confirm.indexOf('isNaN(said)');
    const spend = confirm.indexOf('orchestrator.createNewPosition');
    expect(ask).toBeGreaterThan(-1);
    expect(spend).toBeGreaterThan(ask);
  });

  it('refuses an amount that does not match the record', () => {
    expect(confirm).toMatch(/Math\.abs\(said - recorded\)/);
  });

  it('both checks come before anything that spends', () => {
    const spend = confirm.indexOf('orchestrator.createNewPosition');
    expect(confirm.indexOf('isNaN(said)')).toBeLessThan(spend);
    expect(confirm.indexOf('Math.abs(said - recorded)')).toBeLessThan(spend);
  });

  it('adds no new stage to carry the check', () => {
    // An argument survives a restart; a stage does not. That is also what made
    // the last "Ready to Start" prompt go stale without saying so.
    const stages = bot.match(/this\.stage = '[A-Z_]+'/g) ?? [];
    expect(new Set(stages).size).toBeLessThanOrEqual(2);
  });
});

describe('an amount over the ceiling is refused at input', () => {
  const input = handler(/private async handleAmountInput\(/);

  it('checks MAX_POSITION_USD before recording the budget', () => {
    // It used to be checked only at the send, deep inside the swap, where the
    // throw never reaches the operator. A $1000 request passed validation, was
    // stored as the budget and shown back in a summary before dying silently.
    const check = input.indexOf('MAX_POSITION_USD');
    const record = input.indexOf('recordInvestmentAmount');
    expect(check).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(check);
  });
});

describe('a prompt that outlived its process says so', () => {
  const confirm = handler(/private async handleConfirmStart\(/);

  it('names the restart instead of only saying nothing is waiting', () => {
    // `stage` is in memory on purpose, so a restart clears it while the
    // "Ready to Start" message stays on screen looking live. "Nothing is
    // waiting to be confirmed" is true and useless when the operator is
    // looking at the thing that was waiting.
    expect(confirm).toMatch(/stale/i);
    expect(confirm).toMatch(/restarted/);
  });
});
