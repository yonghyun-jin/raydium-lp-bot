/**
 * The ladder exists to find the SMALLEST tip that lands.
 *
 * Paying a fixed 95th percentile lands reliably and overpays forever; paying the
 * median is a coin flip that cost a rebalance its reopen on 2026-09-25. Neither
 * is a policy. The ladder climbs in small steps from a learned starting point and
 * -- crucially -- probes BELOW the last winner, which is the only thing that
 * stops the estimate from ratcheting upward with every success.
 */

import {
  tipForRung,
  ladderTips,
  nextStart,
  DEFAULT_LADDER,
  TipLadderConfig,
} from '../../src/raydium/tipLadder';

const cfg = (over: Partial<TipLadderConfig> = {}): TipLadderConfig => ({
  startLamports: 10_000,
  ceilingLamports: 2_000_000,
  ...DEFAULT_LADDER,
  ...over,
});

describe('tipForRung', () => {
  it('starts exactly at the configured start', () => {
    expect(tipForRung(cfg(), 0)).toBe(10_000);
  });

  it('climbs in SMALL steps, not jumps', () => {
    const tips = ladderTips(cfg());
    // Each rung is a modest increase; the whole ladder spans the median-to-95th
    // gap rather than leaping over it.
    for (let i = 1; i < tips.length; i++) {
      expect(tips[i]).toBeGreaterThan(tips[i - 1]);
      expect(tips[i] / tips[i - 1]).toBeLessThan(1.5);
    }
  });

  it('is monotonic and never exceeds the ceiling', () => {
    const tips = ladderTips(cfg({ startLamports: 1_500_000, ceilingLamports: 2_000_000 }));
    for (let i = 1; i < tips.length; i++) {
      expect(tips[i]).toBeGreaterThanOrEqual(tips[i - 1]);
    }
    expect(Math.max(...tips)).toBeLessThanOrEqual(2_000_000);
  });

  it('repeats the ceiling rather than stopping short', () => {
    // A lost auction is NOT proof the bid was too small -- it can be the wrong
    // leader or a competition burst -- so retrying at the cap is legitimate.
    const tips = ladderTips(cfg({ startLamports: 2_000_000, ceilingLamports: 2_000_000 }));
    expect(new Set(tips)).toEqual(new Set([2_000_000]));
    expect(tips).toHaveLength(DEFAULT_LADDER.maxRungs);
  });

  it('never returns a zero or negative tip', () => {
    for (const start of [0, -5, 0.4]) {
      expect(tipForRung(cfg({ startLamports: start }), 0)).toBeGreaterThanOrEqual(1);
    }
  });

  it('survives an inverted configuration without inverting the ladder', () => {
    const tips = ladderTips(cfg({ startLamports: 500_000, ceilingLamports: 1_000 }));
    expect(Math.min(...tips)).toBeGreaterThan(0);
    for (let i = 1; i < tips.length; i++) {
      expect(tips[i]).toBeGreaterThanOrEqual(tips[i - 1]);
    }
  });

  it('one window makes real progress without leaping the whole gap', () => {
    // Deliberately NOT enough to cross the median-to-95th-percentile gap in one
    // window: that gap was ~39x on 2026-09-26 and leaping it is exactly the
    // overpaying this ladder exists to avoid. One window spans ~3x, which is
    // meaningful progress; the outer loop carries the climb across windows.
    const tips = ladderTips(cfg({ startLamports: 10_000 }));
    const span = Math.max(...tips) / Math.min(...tips);
    expect(span).toBeGreaterThan(2.5);
    expect(span).toBeLessThan(5);
  });

  it('a climb carried across windows reaches the 95th percentile', () => {
    // Each window resumes where the last one stopped, so the ladder is not
    // capped by maxRungs -- it is capped by the caller's time budget.
    let start = 10_000;
    let windows = 0;
    while (start < 389_930 && windows < 10) {
      start = Math.max(...ladderTips(cfg({ startLamports: start })));
      windows++;
    }
    expect(start).toBeGreaterThan(389_930);
    expect(windows).toBeLessThanOrEqual(4);
  });

  it('the cold-start floor already sits above a typical 95th percentile', () => {
    // JITO_TIP_SOL=0.0001 is 100_000 lamports; the 95th pct measured minutes
    // apart on 2026-09-26 was 389_930 and then 34_865. So a bot with no history
    // starts ABOVE the common case and the learning walks it DOWN -- converging
    // on the smallest viable tip from above, never bidding blind from zero.
    expect(tipForRung(cfg({ startLamports: 100_000 }), 0)).toBe(100_000);
    expect(nextStart({ floorLamports: 1_000, ceilingLamports: 2_000_000, winningLamports: 100_000 }))
      .toBeLessThan(100_000);
  });
});

describe('nextStart: the estimate must be able to go DOWN', () => {
  const bounds = { floorLamports: 1_000, ceilingLamports: 2_000_000 };

  it('probes below the tip that just won', () => {
    // THE mechanism for converging on the smallest viable tip. Without it, every
    // success cements the price paid and the tip can only ratchet up.
    const next = nextStart({ ...bounds, winningLamports: 100_000 });
    expect(next).toBeLessThan(100_000);
    expect(next).toBe(85_000);
  });

  it('walks the tip down over repeated calm-market wins', () => {
    let start = 100_000;
    for (let i = 0; i < 8; i++) {
      start = nextStart({ ...bounds, winningLamports: start });
    }
    expect(start).toBeLessThan(40_000);
  });

  it('never probes below the floor', () => {
    const next = nextStart({ ...bounds, winningLamports: 1_100 });
    expect(next).toBe(1_000);
  });

  it('resets to the floor when nothing landed', () => {
    // REVERSED on 2026-10-13, and the old expectation was `250_000` -- keep the
    // highest rung tried, so the next send would not re-walk the climb. An
    // exhausted ladder is evidence about ROOM, not about PRICE: nothing landed,
    // so nothing was learned about what a winning tip costs, and remembering the
    // top rung only removes the mechanism that could discover the tip was never
    // the constraint. Re-walking costs TIME and not money -- an unselected
    // bundle pays neither tip nor network fee.
    expect(nextStart({ ...bounds, highestTriedLamports: 250_000 })).toBe(1_000);
  });

  it('a failed climb cannot pin the next ladder flat against the ceiling', () => {
    // THE LIVE FAILURE this guard exists for. A climb that exhausted at the
    // ceiling remembered the ceiling, `tipForRung` clamps every rung to it, and
    // the next send bid one price five times over:
    //
    //   [Jito] Window 1/3: climbing from 6000000 lamports, ceiling 6000000
    //   [Jito] Rung 1: 6000000 ... Rung 5: 6000000
    //
    // Thirty bundles went out over two attempts at 25-87x the 99th percentile of
    // landed tips, none included, while a $3,636.90 close sat undeployed.
    const exhausted = nextStart({
      ...bounds,
      highestTriedLamports: bounds.ceilingLamports,
    });

    const tips = ladderTips({
      startLamports: exhausted,
      ceilingLamports: bounds.ceilingLamports,
      stepFactor: 1.35,
      maxRungs: 5,
    });

    // A ladder, not a flat line: the rungs must differ from each other.
    expect(new Set(tips).size).toBeGreaterThan(1);
    expect(tips[0]).toBeLessThan(bounds.ceilingLamports);
  });

  it('prefers a win over a failed climb when both are present', () => {
    const next = nextStart({
      ...bounds,
      winningLamports: 50_000,
      highestTriedLamports: 250_000,
    });
    expect(next).toBe(42_500);
  });

  it('falls back to the floor with no history at all', () => {
    expect(nextStart(bounds)).toBe(1_000);
  });

  it('clamps a win above the ceiling', () => {
    expect(nextStart({ ...bounds, winningLamports: 99_000_000 })).toBe(2_000_000);
  });

  it('treats a nonsense win as no information', () => {
    for (const bad of [0, -1]) {
      expect(nextStart({ ...bounds, winningLamports: bad })).toBe(1_000);
    }
  });
});
