/**
 * The capital gap must REACH the operator.
 *
 * $4,000 was allocated and ~$3,000 was working, for weeks, with nothing broken
 * enough to raise an error. Every figure needed to say so was already being
 * read on every tick; nothing performed the subtraction out loud. These tests
 * are about the saying, not the arithmetic -- that is covered in
 * tests/orchestrator/capital-summary.test.ts.
 */

import * as fs from 'fs';
import * as path from 'path';

import { messages } from '../../src/telegram/messages';
import { summariseCapital } from '../../src/orchestrator/capital';
import type { PositionStatus } from '../../src/telegram/types';

const source = fs
  .readFileSync(path.join(__dirname, '../../src/telegram/bot.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const methodBody = (name: string) => {
  const start = source.indexOf(`private async ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf('\n  private ', start + 10);
  return source.slice(start, next > start ? next : undefined);
};

const status: PositionStatus = {
  inRange: true,
  currentPrice: 150,
  rangeLower: 140,
  rangeUpper: 160,
  feesEarned: 1.5,
  ageHours: 10,
  valueUsd: 3000,
  nftMint: 'Mint111',
};

describe('the drift notice says what happened and why', () => {
  const drifted = summariseCapital({
    allocatedUsd: 4000,
    positionValueUsd: 3000,
    idleWalletUsd: 0,
  });

  it('names all four figures, so the gap cannot be read as a loss by default', () => {
    const text = messages.capitalDrift(drifted);

    expect(text).toContain('$4000.00');
    expect(text).toContain('$3000.00');
    expect(text).toContain('$1000.00');
  });

  it('explains the MECHANISM, not just the number', () => {
    const text = messages.capitalDrift(drifted);

    // Without this, "gap $1,000" is indistinguishable from a $1,000 loss, and
    // those call for opposite responses from the operator.
    expect(text).toMatch(/gas reserve|slippage|swap/i);
    expect(text).toMatch(/wallet/i);
  });

  it('says a gap the wallet CANNOT cover is a real loss, not idle money', () => {
    const lost = summariseCapital({
      allocatedUsd: 4000,
      positionValueUsd: 3000,
      idleWalletUsd: 2,
    });

    const text = messages.capitalDrift(lost);
    expect(text).toMatch(/real loss/i);
    expect(text).toMatch(/NOT in the wallet/);
  });

  it('says the money is idle rather than gone', () => {
    expect(messages.capitalDrift(drifted)).toMatch(/not lost/i);
  });

  it('reports a surplus as a surplus, not as a leak', () => {
    const surplus = summariseCapital({
      allocatedUsd: 4000,
      positionValueUsd: 4300,
      idleWalletUsd: 100,
    });

    const text = messages.capitalDrift(surplus);
    expect(text).toContain('above the allocation');
    expect(text).toMatch(/worth more than was allocated/i);
  });

  it('never renders an unreadable figure as a dollar amount', () => {
    const unknown = summariseCapital({
      allocatedUsd: null,
      positionValueUsd: null,
      idleWalletUsd: null,
    });

    const text = messages.capitalDrift(unknown);
    expect(text).toContain('unknown');
    expect(text).not.toContain('$0.00');
  });
});

describe('/status carries the capital block', () => {
  it('shows allocated, deployed, idle and the gap when the figures are supplied', () => {
    const text = messages.positionStatus(
      status,
      summariseCapital({ allocatedUsd: 4000, positionValueUsd: 3000, idleWalletUsd: 500 })
    );

    expect(text).toContain('Allocated: $4000.00');
    expect(text).toContain('Deployed:  $3000.00');
    expect(text).toContain('Idle:      $500.00');
    // allocated - DEPLOYED, and the wallet covers it.
    expect(text).toContain('$1000.00 not deployed');
    expect(text).toContain('in the wallet');
  });

  it('still renders without them, so no caller is forced to read the chain', () => {
    const text = messages.positionStatus(status);

    expect(text).toContain('Position Status');
    expect(text).not.toContain('Allocated');
  });
});

describe('the drift latch is its own latch', () => {
  it('reports capital from the monitoring tick', () => {
    expect(methodBody('checkPosition')).toMatch(/this\.reportCapital\(/);
  });

  it('reports BEFORE the in-range branch, because an in-range position can still underrun', () => {
    const body = methodBody('checkPosition');
    const reportAt = body.indexOf('this.reportCapital(');
    const inRangeAt = body.indexOf('if (status.inRange)');

    expect(reportAt).toBeGreaterThan(-1);
    expect(inRangeAt).toBeGreaterThan(-1);
    expect(reportAt).toBeLessThan(inRangeAt);
  });

  /**
   * THE GUARD. Sharing `promptedForMint` would make a drift notice suppress the
   * out-of-range question, or the reverse: two unrelated things silencing each
   * other. Reintroduce the sharing and this goes red.
   */
  it('never touches the out-of-range prompt latch', () => {
    expect(methodBody('reportCapital')).not.toMatch(/promptedForMint/);
  });

  it('latches on its own field, keyed by mint', () => {
    expect(methodBody('reportCapital')).toMatch(/this\.driftNotifiedForMint = nftMint/);
  });

  it('latches only once the message was actually delivered', () => {
    // An unreachable operator must be told when they come back, not have the
    // single notice swallowed by a latch set on a dropped message.
    expect(methodBody('reportCapital')).toMatch(/if \(told\) this\.driftNotifiedForMint/);
  });

  it('logs on every tick even when it stays quiet', () => {
    const body = methodBody('reportCapital');
    const logAt = body.indexOf('capitalLogLine');
    const latchAt = body.indexOf('this.driftNotifiedForMint === nftMint');

    expect(logAt).toBeGreaterThan(-1);
    expect(latchAt).toBeGreaterThan(-1);
    expect(logAt).toBeLessThan(latchAt);
  });
});
