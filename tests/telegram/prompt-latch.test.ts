/**
 * Ask once per out-of-range episode, but never stop watching.
 *
 * The loop used to call stopMonitoring() immediately after prompting, "to pause
 * until the user responds". If the user did not respond, the bot stopped
 * looking at a LIVE position permanently -- it would not notice the price
 * drifting further, or coming back into range.
 *
 * Asking every 30 seconds and asking once-then-going-blind are both wrong. The
 * latch keeps the loop running while suppressing repeat prompts, and clears
 * itself when the position comes back in range so a later exit asks again.
 */

import * as fs from 'fs';
import * as path from 'path';

const source = fs
  .readFileSync(path.join(__dirname, '../../src/telegram/bot.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const checkPosition = (() => {
  const start = source.indexOf('private async checkPosition(');
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf('\n  private ', start + 10);
  return source.slice(start, next > start ? next : undefined);
})();

describe('the monitoring loop keeps watching after it asks', () => {
  it('never stops itself inside checkPosition', () => {
    // This is the regression: any stopMonitoring() here blinds the bot to a
    // live position the moment it asks a question about it.
    expect(checkPosition).not.toMatch(/stopMonitoring\(\)/);
  });

  it('latches on the position it prompted about', () => {
    expect(checkPosition).toMatch(/this\.promptedForMint = nftMint/);
  });

  it('returns early when it has already asked about this position', () => {
    expect(checkPosition).toMatch(/alreadyAsked/);
    const guard = checkPosition.slice(checkPosition.indexOf('if (alreadyAsked)'));
    expect(guard.slice(0, 60)).toMatch(/return;/);
  });

  it('clears the latch when the position comes back in range', () => {
    const inRange = checkPosition.slice(checkPosition.indexOf('if (status.inRange)'));
    expect(inRange.slice(0, inRange.indexOf('return;'))).toMatch(
      /this\.promptedForMint = null/
    );
  });

  it('still auto-rebalances past the target age, regardless of the latch', () => {
    // The auto branch acts rather than asks, so it must sit BEFORE the
    // alreadyAsked guard or a latched position could never rebalance itself.
    const autoAt = checkPosition.indexOf('targetPositionDurationHours');
    const guardAt = checkPosition.indexOf('if (alreadyAsked)');
    expect(autoAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(-1);
    expect(autoAt).toBeLessThan(guardAt);
  });
});

describe('a replacement position starts with a clean latch', () => {
  it('performRebalance clears promptedForMint', () => {
    const body = source.slice(source.indexOf('private async performRebalanceInner('));
    expect(body).toMatch(/this\.promptedForMint = null/);
  });
});
