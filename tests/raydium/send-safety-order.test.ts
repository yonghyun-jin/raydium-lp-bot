import * as fs from 'fs';
import * as path from 'path';
import { SAFETY } from '../../src/raydium/config';

describe('MAX_POSITION_USD fails closed', () => {
  const saved = process.env.MAX_POSITION_USD;
  afterEach(() => {
    if (saved === undefined) delete process.env.MAX_POSITION_USD;
    else process.env.MAX_POSITION_USD = saved;
  });

  it.each(['unlimited', 'NaN', '-5', '0', ''])('an unreadable value %p keeps the default cap', (raw) => {
    process.env.MAX_POSITION_USD = raw;
    expect(SAFETY.MAX_POSITION_USD).toBe(25);
  });

  it('a real number is honoured', () => {
    process.env.MAX_POSITION_USD = '1500';
    expect(SAFETY.MAX_POSITION_USD).toBe(1500);
  });
});

describe('every send site guards before it signs', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/raydium/client.ts'), 'utf8');

  it('no wallet signature precedes the next guard', () => {
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!/\.sign\(\[this\.wallet/.test(line)) return;
      const before = lines.slice(Math.max(0, i - 4), i).join('\n');
      expect({ line: i + 1, guarded: /assertSendAllowed\(/.test(before) }).toEqual({ line: i + 1, guarded: true });
    });
  });
});

describe('/confirm opens at most one position', () => {
  const bot = fs.readFileSync(path.join(__dirname, '../../src/telegram/bot.ts'), 'utf8');

  it('checks for an open position before it starts creating one', () => {
    const start = bot.indexOf('private async handleConfirmStart');
    const body = bot.slice(start, bot.indexOf('\n  private async ', start + 10));
    const guard = body.indexOf('await this.resolveActiveMint()');
    const create = body.indexOf('messages.creatingPosition()');
    expect(guard).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(guard);
  });
});
