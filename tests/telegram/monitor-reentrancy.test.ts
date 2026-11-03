/**
 * The 30s monitoring loop must never run two checks, or two rebalances, at once.
 *
 * `setInterval` does not await its callback. checkPosition() can exceed 30s
 * easily -- getPositionDetails makes 3+ RPC round trips on a rate-limited public
 * endpoint, and an out-of-range position then spawns Python for a prediction.
 * Two overlapping ticks both observe `!inRange`; on the 24h auto-rebalance
 * branch both call performRebalance(), which CLOSES the position first. The
 * second close then fails against a position the first already burned, after
 * the money has moved.
 *
 * This models the loop's guard rather than driving the real bot, which would
 * need a wallet and an RPC. What it pins down is the property that matters:
 * an overrunning tick is SKIPPED, not queued, and the flag is released even
 * when the body throws.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The guard as implemented in startMonitoring(), extracted to be executable. */
function makeLoop(body: () => Promise<void>) {
  let checkInFlight = false;
  let skipped = 0;
  let started = 0;

  return {
    async tick(): Promise<void> {
      if (checkInFlight) {
        skipped++;
        return;
      }
      checkInFlight = true;
      started++;
      try {
        await body();
      } catch {
        // swallowed by the loop's backstop
      } finally {
        checkInFlight = false;
      }
    },
    get stats() {
      return { skipped, started };
    },
  };
}

describe('monitoring loop is single-flight', () => {
  it('skips a tick while the previous check is still running', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const loop = makeLoop(() => blocked);

    // First tick starts and hangs, as a slow RPC would.
    const first = loop.tick();
    // Three more fire while it is still in flight.
    await Promise.all([loop.tick(), loop.tick(), loop.tick()]);

    expect(loop.stats.started).toBe(1);
    expect(loop.stats.skipped).toBe(3);

    release();
    await first;

    // Once it finishes, the next tick runs normally.
    await loop.tick();
    expect(loop.stats.started).toBe(2);
  });

  it('releases the flag when the check throws, so the loop cannot wedge', async () => {
    const loop = makeLoop(async () => {
      throw new Error('RPC exploded');
    });

    await loop.tick();
    await loop.tick();

    // Both ran: a throw must not leave the loop permanently blocked.
    expect(loop.stats.started).toBe(2);
    expect(loop.stats.skipped).toBe(0);
  });
});

describe('the guards are actually wired into bot.ts', () => {
  const source = fs
    .readFileSync(path.join(__dirname, '../../src/telegram/bot.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('the interval callback checks both flags before running', () => {
    const interval = source.slice(source.indexOf('this.monitorInterval = setInterval'));
    expect(interval).toMatch(/if \(this\.checkInFlight \|\| this\.rebalanceInFlight\)/);
  });

  it('both flags are released in a finally block', () => {
    expect(source).toMatch(/finally \{\s*\n\s*this\.checkInFlight = false;/);
    expect(source).toMatch(/finally \{\s*\n\s*this\.rebalanceInFlight = false;/);
  });

  it('performRebalance refuses a concurrent run rather than queueing', () => {
    const body = source.slice(source.indexOf('private async performRebalance('));
    expect(body).toMatch(/if \(this\.rebalanceInFlight\)/);
    // Must return, not await-and-continue.
    expect(body.slice(0, body.indexOf('this.rebalanceInFlight = true;'))).toMatch(/return;/);
  });
});
