/**
 * What a completed cycle actually earned, and what it would have earned anyway.
 *
 * The guards here protect a conclusion, not an implementation: that the
 * headline P&L flatters the bot in a rising market, and that the number worth
 * reporting is the margin over simply holding the same tokens. Every assertion
 * runs on rows with the exact shape the bot writes.
 *
 * Design: docs/v1/scopes/C4-pnl-dashboard.md
 */

import { buildReport, decomposeOperations, sumOperation } from '../../src/pnl';
import {
  ADOPTED_CLOSE_ONLY,
  ALL_ROWS,
  POSITIONS,
  LARGE_COMPLETE,
  SMALL_COMPLETE,
  STILL_OPEN,
  row,
} from './fixtures';

describe('the $1,000 cycle, decomposed', () => {
  const [op] = decomposeOperations(LARGE_COMPLETE).completed;

  /**
   * This is the whole point of the scope.
   *
   * The three numbers below were derived by hand and written into
   * hand BEFORE this code existed, so agreement here is a check
   * against something other than the implementation itself. The recorded
   * figures are "+$35.87 headline, ~$29 of it the market, +$6.87 the strategy".
   */
  it('separates what the bot earned from what the market handed it', () => {
    expect(op.lpPnlUsd).toBeCloseTo(35.87, 2);
    expect(op.hodlPnlUsd!).toBeCloseTo(29.01, 2);
    expect(op.strategyUsd!).toBeCloseTo(6.86, 2);
  });

  it('the headline is 5x the strategy, which is why it is not reported alone', () => {
    expect(op.lpPnlUsd / op.strategyUsd!).toBeGreaterThan(5);
  });

  it('values the deposited basket at the CLOSE price, not the open price', () => {
    // 4.835403 SOL went in at $116.78 and the position closed at $122.78.
    // Using the open price would make the benchmark equal the cost basis and
    // report the entire $35.87 as skill.
    expect(op.hodlValueUsd!).toBeCloseTo(4.835403 * 122.78 + 428.838571, 4);
    expect(op.hodlValueUsd!).not.toBeCloseTo(op.costBasisUsd, 0);
  });

  it('the cost basis is what went in, positive, from the negative deposit rows', () => {
    expect(op.costBasisUsd).toBeCloseTo(993.52, 2);
    expect(op.deposited).toEqual([
      expect.objectContaining({ token: 'SOL', amount: expect.closeTo(4.835403, 6) }),
      expect.objectContaining({ token: 'USDC', amount: expect.closeTo(428.838571, 6) }),
    ]);
  });
});

describe('the $10 cycle: fixed costs sink a small position', () => {
  const [op] = decomposeOperations(SMALL_COMPLETE).completed;

  it('lost money while the benchmark barely moved', () => {
    expect(op.lpPnlUsd).toBeCloseTo(-1.89, 2);
    expect(op.hodlPnlUsd!).toBeCloseTo(-0.05, 2);
    // So the loss is not the market -- it is what the bot paid to trade.
    expect(op.strategyUsd!).toBeCloseTo(-1.84, 2);
  });
});

describe('an operation is only complete with BOTH an open and a close', () => {
  it('excludes an adopted position rather than booking returned principal as profit', () => {
    const { completed, excluded } = decomposeOperations(ADOPTED_CLOSE_ONLY);

    expect(completed).toHaveLength(0);
    expect(excluded).toEqual([
      expect.objectContaining({
        operationId: 'job_1699999990000',
        reason: 'no-open',
      }),
    ]);

    // The size of the mistake being avoided: counted naively, a position whose
    // capital was never booked reads as a $10 gain.
    expect(excluded[0].naiveValueUsd).toBeCloseTo(10.36, 2);
  });

  it('excludes a position that is still open', () => {
    const { completed, excluded } = decomposeOperations(STILL_OPEN);

    expect(completed).toHaveLength(0);
    expect(excluded[0]).toMatchObject({ reason: 'still-open' });
    // It would otherwise read as a $999 loss -- the capital is in the position,
    // not gone.
    expect(excluded[0].naiveValueUsd).toBeLessThan(-900);
  });

  it('excludes a swap that spent money and never opened anything', () => {
    const parked = [
      row('op_parked', '2026-09-26T05:02:27.720Z', 'swap', 'principal', 'USDC', -100, 1),
      row('op_parked', '2026-09-26T05:02:27.720Z', 'swap', 'principal', 'SOL', 0.82, 121),
      row('op_parked', '2026-09-26T05:02:27.720Z', 'swap', 'network_fee', 'SOL', -0.0001, 121),
    ];

    expect(decomposeOperations(parked).excluded[0]).toMatchObject({
      reason: 'never-opened',
    });
  });
});

describe('the operator can set an operation aside', () => {
  const TEST_RUN = 'op_1700000010000_ad4dc638';

  it('drops it from the headline without touching the ledger', () => {
    const before = buildReport(ALL_ROWS);
    const after = buildReport(ALL_ROWS, { excludeOperations: [TEST_RUN] });

    expect(before.totals.completedOperations).toBe(2);
    expect(after.totals.completedOperations).toBe(1);

    // The $1.89 the test run lost leaves the totals with it -- the figures are
    // recomputed, not adjusted.
    expect(after.totals.lpPnlUsd).toBeCloseTo(35.87, 2);
    expect(after.totals.strategyUsd!).toBeCloseTo(6.86, 2);
  });

  it('still appears in the ledger, marked set-aside, with its real numbers', () => {
    const { ledger } = buildReport(ALL_ROWS, { excludeOperations: [TEST_RUN] });
    const row = ledger.find((op) => op.operationId === TEST_RUN);

    expect(row).toMatchObject({ status: 'set-aside' });
    // Setting an operation aside is a presentation decision, so its figures
    // stay available and correct -- it is hidden from the headline, not erased.
    expect(row!.netUsd).toBeCloseTo(-1.89, 2);
    expect(row!.netIsPnl).toBe(true);
  });

  it('the chart drops it too, not just the totals', () => {
    const after = buildReport(ALL_ROWS, { excludeOperations: [TEST_RUN] });

    expect(after.series).toHaveLength(2);
    expect(after.series.some((p) => p.operationId === TEST_RUN)).toBe(false);
  });

  it('says set-aside even when the operation is also still open', () => {
    // Otherwise a test run that happens to be open reads as "open", which
    // hides the fact that a human made a decision about it.
    const { ledger } = buildReport(ALL_ROWS, {
      positions: POSITIONS,
      excludeOperations: ['op_1700000012000_a65a3231'],
    });

    expect(
      ledger.find((op) => op.operationId === 'op_1700000012000_a65a3231')
    ).toMatchObject({ status: 'set-aside' });
  });

  it('an unknown id excludes nothing rather than erroring', () => {
    const after = buildReport(ALL_ROWS, { excludeOperations: ['op_typo'] });
    expect(after.totals.completedOperations).toBe(2);
  });
});

describe('P&L sums every row, including debt', () => {
  /**
   * The borrow case from docs/v1-confidential/ledger-schema.md, verified there
   * against a real database: borrow 1000, pay 12 interest, repay 1000 -> the
   * only P&L impact is -12.
   *
   * Filtering `debt` out leaves the borrow's `principal +1000` unopposed and
   * reports $988 of profit on a loan. The debt row exists BECAUSE it cancels.
   */
  const borrowed = [
    row('op_loan', '2026-09-01T00:00:00Z', 'borrow', 'principal', 'USDC', 1000, 1),
    row('op_loan', '2026-09-01T00:00:00Z', 'borrow', 'debt', 'USDC', -1000, 1),
    row('op_loan', '2026-09-02T00:00:00Z', 'repay', 'interest', 'USDC', -12, 1),
  ];

  const repaid = [
    ...borrowed,
    row('op_loan', '2026-09-03T00:00:00Z', 'repay', 'principal', 'USDC', -1000, 1),
    row('op_loan', '2026-09-03T00:00:00Z', 'repay', 'debt', 'USDC', 1000, 1),
  ];

  /**
   * WHILE STILL BORROWED is the only state that discriminates, and the first
   * version of this test missed it: over a completed borrow-and-repay the two
   * `debt` rows cancel each OTHER, so filtering both still gives the right
   * answer and the guard cannot fail. Mid-cycle it is -12 against +988.
   */
  it('reports -12 while the loan is outstanding, not +988', () => {
    expect(sumOperation(borrowed)).toBeCloseTo(-12, 6);
  });

  it('still reports -12 once it is repaid', () => {
    expect(sumOperation(repaid)).toBeCloseTo(-12, 6);
  });

  it('the debt rows are what make the difference', () => {
    const withoutDebt = borrowed.filter((r) => r.category !== 'debt');
    expect(sumOperation(withoutDebt)).toBeCloseTo(988, 6);
  });
});

describe('unknown stays unknown', () => {
  it('a deposited token with no close price yields null, never zero', () => {
    // A position that drifted fully to one side and wrote no rows at all for
    // the other token on the way out.
    const oneSided = [
      row('op_drift', '2026-09-01T00:00:00Z', 'create_lp', 'principal', 'SOL', -5, 100, 'p'),
      row('op_drift', '2026-09-01T00:00:00Z', 'create_lp', 'principal', 'USDC', -500, 1, 'p'),
      row('op_drift', '2026-09-02T00:00:00Z', 'close_lp', 'principal', 'USDC', 1010, 1, 'p'),
    ];

    const [op] = decomposeOperations(oneSided).completed;

    expect(op.lpPnlUsd).toBeCloseTo(10, 6);
    expect(op.hodlValueUsd).toBeNull();
    expect(op.hodlPnlUsd).toBeNull();
    expect(op.strategyUsd).toBeNull();
    expect(op.hodlUnknownReason).toMatch(/SOL/);
  });

  it('one unknown operation makes the TOTAL unknown, not smaller', () => {
    const unknownHodl = [
      row('op_drift', '2026-09-01T00:00:00Z', 'create_lp', 'principal', 'SOL', -5, 100, 'p'),
      row('op_drift', '2026-09-02T00:00:00Z', 'close_lp', 'principal', 'USDC', 510, 1, 'p'),
    ];

    const { totals } = buildReport([...LARGE_COMPLETE, ...unknownHodl]);

    expect(totals.lpPnlUsd).toBeGreaterThan(0);
    expect(totals.hodlPnlUsd).toBeNull();
    expect(totals.strategyUsd).toBeNull();
  });
});

describe('the report over everything production holds', () => {
  const report = buildReport(ALL_ROWS);

  it('charts the two complete cycles', () => {
    expect(report.totals.completedOperations).toBe(2);
  });

  it('totals the two lines and the gap between them', () => {
    expect(report.totals.lpPnlUsd).toBeCloseTo(33.99, 2);
    expect(report.totals.hodlPnlUsd!).toBeCloseTo(28.96, 2);
    expect(report.totals.strategyUsd!).toBeCloseTo(5.02, 2);
  });

  it('seeds the series at zero and steps once per completed cycle', () => {
    expect(report.series).toHaveLength(3);
    expect(report.series[0]).toMatchObject({ operationId: null, lpCumUsd: 0, hodlCumUsd: 0 });
    expect(report.series[2].lpCumUsd).toBeCloseTo(33.99, 2);
  });

  it('the series is ordered by close time', () => {
    const times = report.series.map((p) => new Date(p.t).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });



});

/**
 * The decomposition that makes a losing cycle readable.
 *
 * `strategyUsd` alone says the bot lost to holding; it never says WHICH force
 * lost. Production holds both shapes: op_1700000012000 beat holding by $23.66
 * with only $2.83 of impermanent loss over 136 hours, and op_1700000013000
 * lost $30.23 in 7.2 hours while earning fees FASTER per hour than any other
 * position this bot has run -- the IL simply arrived all at once and the fees
 * had no time to cover it. Those two have opposite fixes, and the headline
 * cannot tell them apart.
 *
 * WHAT IS NOT TESTED HERE, AND WHY. The relation
 *
 *     strategyUsd === impermanentLossUsd + feesAndCostsUsd
 *
 * is an algebraic TAUTOLOGY: (pc - hodl) + (lp - pc) === lp - hodl, and
 * `principalChangeUsd` cancels. It holds for any definition of principal
 * whatsoever -- set it to 42 and it still reconciles to 1e-16. Asserting it
 * would be a guard that cannot fail, which this project forbids outright. The
 * guards below pin the two addends to VALUES instead, because only a value can
 * go red when the split moves.
 */
describe('impermanent loss: which force lost, not just that one did', () => {
  /**
   * Derived from the fixtures, which are a snapshot -- these do NOT
   * equal today's production figures for the same operation and are not meant
   * to. What they pin is the SPLIT: move one dollar between the two addends
   * and both numbers move, while their sum does not.
   */
  it('splits the $1,000 cycle into the pool cost and everything else', () => {
    const [op] = decomposeOperations(LARGE_COMPLETE).completed;

    expect(op.impermanentLossUsd!).toBeCloseTo(-14.4523, 3);
    expect(op.feesAndCostsUsd).toBeCloseTo(21.3116, 3);
    expect(op.principalChangeUsd).toBeCloseTo(14.5601, 3);
  });

  /**
   * THE GUARD THAT MATTERS, and the one the first implementation failed.
   *
   * A funding swap writes `principal` rows under the `swap` action, and they
   * must NOT reach `principalChangeUsd`: the conversion happens before any
   * capital is deployed, so its execution gap is a cost of getting in, not
   * something the pool did to the position. Including them moves real money
   * out of fees-and-costs and into "impermanent loss" -- in production that
   * mislabels $0.60, $0.51 and $0.01 across three of four settled operations.
   *
   * No fixture covers this: the only operation carrying a swap/principal pair
   * (op_1700000012000) is still open in the fixtures, so it never
   * reaches buildOperation. Hence the constructed rows.
   *
   * Reintroduce the bug by adding 'swap' to the action filters in
   * decomposeOperations and this goes red; the identity does not.
   */
  it('keeps a funding swap OUT of the pool cost and IN the cost of getting in', () => {
    const withSwap = [
      // $1,000 of USDC converted to 9.90 SOL at a recorded $100: a $10 gap
      // between what was sent and what the oracle says arrived.
      row('op_swap', '2026-09-01T00:00:00Z', 'swap', 'principal', 'USDC', -1000, 1, 's'),
      row('op_swap', '2026-09-01T00:00:00Z', 'swap', 'principal', 'SOL', 9.9, 100, 's'),
      // The position itself: in and out at the same price, so the pool did
      // nothing and IL must be exactly zero.
      row('op_swap', '2026-09-01T00:01:00Z', 'create_lp', 'principal', 'SOL', -9.9, 100, 'o'),
      row('op_swap', '2026-09-02T00:00:00Z', 'close_lp', 'principal', 'SOL', 9.9, 100, 'c'),
    ];

    const [op] = decomposeOperations(withSwap).completed;

    expect(op.impermanentLossUsd!).toBeCloseTo(0, 9);
    expect(op.principalChangeUsd).toBeCloseTo(0, 9);
    // The whole $10 lands here, where a reader can see it cost something.
    expect(op.feesAndCostsUsd).toBeCloseTo(-10, 9);
  });

  /**
   * A fee-free AMM position is worth less than holding at every price but the
   * entry, so a NEGATIVE value is the only physically meaningful one -- for
   * rows that describe one position closed at one set of prices.
   */
  it('is not positive for the cycle whose rows are internally consistent', () => {
    const [big] = decomposeOperations(LARGE_COMPLETE).completed;

    expect(big.impermanentLossUsd!).toBeLessThanOrEqual(0);
  });

  /**
   * The alarm, fired by real recorded rows.
   *
   * The small test cycle in the fixtures. Its principal rows say
   * the position GAINED 0.008086 SOL while SPENDING 0.753411 USDC -- $93.17
   * per SOL, over a window in which SOL traded $117.56 to $118.53. No AMM buys
   * 21% under the market, so its open and close rows do not describe the same
   * position: about 0.0017 SOL ($0.20) of the close principal is unaccounted
   * for, and that $0.20 IS the positive IL below.
   *
   * Pinned rather than fixed: the operation is gone from production and the
   * fixture is kept for its SHAPE. What matters is that the sign is
   * load-bearing. If a LIVE operation ever reports positive impermanent loss,
   * its rows are wrong and `costBasisUsd`, `hodlPnlUsd` and `strategyUsd` are
   * all wrong with them. Do NOT clamp IL at zero -- that hides the detector.
   */
  it('goes POSITIVE on the $10 cycle, which proves its rows are inconsistent', () => {
    const [small] = decomposeOperations(SMALL_COMPLETE).completed;

    expect(small.impermanentLossUsd!).toBeCloseTo(0.1972, 3);
    expect(small.feesAndCostsUsd).toBeCloseTo(-2.0352, 3);

    // The impossible average price, stated so the next reader does not have to
    // re-derive why this is an alarm and not a windfall.
    const solIn = small.deposited.find((d) => d.token === 'SOL')!.amount;
    const usdcIn = small.deposited.find((d) => d.token === 'USDC')!.amount;
    const impliedPrice = (usdcIn - 3.364077) / (0.057451 - solIn);

    expect(impliedPrice).toBeLessThan(100);
  });

  it('goes null, never zero, when the benchmark is unknown', () => {
    const unknownHodl = [
      row('op_drift', '2026-09-01T00:00:00Z', 'create_lp', 'principal', 'SOL', -5, 100, 'p'),
      row('op_drift', '2026-09-02T00:00:00Z', 'close_lp', 'principal', 'USDC', 510, 1, 'p'),
    ];

    const [op] = decomposeOperations(unknownHodl).completed;

    expect(op.hodlPnlUsd).toBeNull();
    expect(op.impermanentLossUsd).toBeNull();
    // Zero would read as "the pool cost nothing", which is a claim, not an
    // absence. The costs side does not depend on the benchmark, so it stays a
    // real number and the panel can still show it.
    expect(op.impermanentLossUsd).not.toBe(0);
    expect(Number.isFinite(op.feesAndCostsUsd)).toBe(true);
  });
});

/**
 * The SECOND benchmark, and why one benchmark was not enough.
 *
 * `hodlPnlUsd` answers "the basket I put in, held" -- the only comparison
 * against which impermanent loss is even defined. The operator's question is
 * usually a different one: "would I have been better off just buying SOL?"
 * These can disagree in SIGN, so reporting either alone misleads. Every
 * figure below is derived from the fixture by hand, not read off the
 * implementation.
 */
describe('the all-SOL benchmark sits beside the basket, never replaces it', () => {
  const [op] = decomposeOperations(LARGE_COMPLETE).completed;

  /**
   * basis 4.835403 x 116.78 + 428.838571 = $993.517
   * all-SOL = 993.517 x (122.78 / 116.78 - 1) = +$51.05
   */
  it('values the whole stake in SOL at the open price, held to the close', () => {
    expect(op.allSolPnlUsd!).toBeCloseTo(51.05, 2);
    expect(op.allSolUnknownReason).toBeNull();
  });

  /**
   * THE REASON BOTH SHIP. This cycle BEAT the basket it deposited (+$6.86) and
   * LOST to full SOL exposure (-$15.18), because the basket was roughly half
   * stablecoin while SOL rose 5.1%. A dashboard showing only one of these
   * tells the operator the opposite of what the other says.
   */
  it('disagrees in SIGN with the basket benchmark on the same cycle', () => {
    expect(op.strategyUsd!).toBeGreaterThan(0);
    expect(op.lpPnlUsd - op.allSolPnlUsd!).toBeLessThan(0);
    // 1dp: the hand figure is 35.87 - 51.05, and both inputs were rounded.
    expect(op.lpPnlUsd - op.allSolPnlUsd!).toBeCloseTo(-15.2, 1);
  });

  /**
   * It is about the SIZE of the stake, not its composition -- that is what
   * makes it a different question from `hodlPnlUsd`. Two cycles with the same
   * basis and the same prices must agree here even with opposite mixes.
   */
  it('depends on the cost basis, not on the deposited mix', () => {
    const solHeavy = [
      row('op_a', '2026-09-01T00:00:00Z', 'create_lp', 'principal', 'SOL', -9, 100, 'p'),
      row('op_a', '2026-09-01T00:00:00Z', 'create_lp', 'principal', 'USDC', -100, 1, 'p'),
      row('op_a', '2026-09-02T00:00:00Z', 'close_lp', 'principal', 'SOL', 9, 110, 'p'),
      row('op_a', '2026-09-02T00:00:00Z', 'close_lp', 'principal', 'USDC', 100, 1, 'p'),
    ];
    const usdcHeavy = [
      row('op_b', '2026-09-01T00:00:00Z', 'create_lp', 'principal', 'SOL', -1, 100, 'p'),
      row('op_b', '2026-09-01T00:00:00Z', 'create_lp', 'principal', 'USDC', -900, 1, 'p'),
      row('op_b', '2026-09-02T00:00:00Z', 'close_lp', 'principal', 'SOL', 1, 110, 'p'),
      row('op_b', '2026-09-02T00:00:00Z', 'close_lp', 'principal', 'USDC', 900, 1, 'p'),
    ];

    const [a] = decomposeOperations(solHeavy).completed;
    const [b] = decomposeOperations(usdcHeavy).completed;

    // Both staked $1,000 and SOL rose 10%: all-SOL is +$100 for each.
    expect(a.allSolPnlUsd!).toBeCloseTo(100, 6);
    expect(b.allSolPnlUsd!).toBeCloseTo(100, 6);
    // ...while the baskets they actually held are nothing like each other.
    expect(a.hodlPnlUsd!).toBeCloseTo(90, 6);
    expect(b.hodlPnlUsd!).toBeCloseTo(10, 6);
  });

  it('is unknown, never zero, for a cycle with no SOL leg at all', () => {
    const usdcOnly = [
      row('op_c', '2026-09-01T00:00:00Z', 'create_lp', 'principal', 'USDC', -500, 1, 'p'),
      row('op_c', '2026-09-02T00:00:00Z', 'close_lp', 'principal', 'USDC', 505, 1, 'p'),
    ];

    const [op2] = decomposeOperations(usdcOnly).completed;

    expect(op2.allSolPnlUsd).toBeNull();
    expect(op2.allSolUnknownReason).toMatch(/SOL/);
    // The basket benchmark is perfectly computable here, which is the point of
    // the next test: these two must fail independently.
    expect(op2.hodlPnlUsd!).toBeCloseTo(0, 6);
  });

  it('is unknown when the close wrote no SOL price', () => {
    const noSolClose = [
      row('op_d', '2026-09-01T00:00:00Z', 'create_lp', 'principal', 'SOL', -5, 100, 'p'),
      row('op_d', '2026-09-01T00:00:00Z', 'create_lp', 'principal', 'USDC', -500, 1, 'p'),
      row('op_d', '2026-09-02T00:00:00Z', 'close_lp', 'principal', 'USDC', 1010, 1, 'p'),
    ];

    const [op2] = decomposeOperations(noSolClose).completed;

    expect(op2.allSolPnlUsd).toBeNull();
    expect(op2.allSolUnknownReason).toMatch(/close price for SOL/);
  });

  /**
   * One null must not drag the other down. A cycle with no SOL leg has a
   * KNOWN basket benchmark and an UNKNOWN all-SOL one; collapsing both would
   * throw away a figure the rows fully support.
   */
  it('an unknown all-SOL total leaves the basket total intact', () => {
    const usdcOnly = [
      row('op_c', '2026-09-01T00:00:00Z', 'create_lp', 'principal', 'USDC', -500, 1, 'p'),
      row('op_c', '2026-09-02T00:00:00Z', 'close_lp', 'principal', 'USDC', 505, 1, 'p'),
    ];

    const { totals } = buildReport([...LARGE_COMPLETE, ...usdcOnly]);

    expect(totals.allSolPnlUsd).toBeNull();
    expect(totals.vsAllSolUsd).toBeNull();
    expect(totals.hodlPnlUsd!).toBeCloseTo(29.01, 2);
    expect(totals.strategyUsd!).toBeCloseTo(11.86, 2);
  });
});

/**
 * The index series: the same strategies as $100 compounded, not as dollars.
 *
 * The dollar lines weight each cycle by its own size, and this bot's size
 * jumped ~4x mid-record, so the dollar chart's slope changes meaning partway
 * along. These guards protect the property that makes the index worth having
 * -- that it is a RETURN, so the size of a cycle cannot move it on its own.
 */
describe('the return series: compounded percent, not dollars', () => {
  it('starts every line at zero', () => {
    const { series } = buildReport(LARGE_COMPLETE);
    expect(series[0]).toMatchObject({ lpReturnPct: 0, allSolReturnPct: 0, mixReturnPct: 0 });
  });

  /**
   * LARGE_COMPLETE: basis $993.52, lpPnl +$35.87 -> +3.61%.
   * Derived by hand from the fixture, not read off the implementation.
   */
  it('compounds each cycle by its RETURN on the cost basis', () => {
    const { series, completed } = buildReport(LARGE_COMPLETE);
    const [op] = completed;
    expect(op.lpPnlUsd / op.costBasisUsd).toBeCloseTo(0.0361, 4);
    expect(series[1].lpReturnPct).toBeCloseTo(3.61, 2);
    expect(series[1].mixReturnPct!).toBeCloseTo(2.92, 2);
    expect(series[1].allSolReturnPct!).toBeCloseTo(5.14, 2);
  });

  /**
   * THE WHOLE POINT. Ten identical cycles scaled 100x apart must give the same
   * index, while the dollar line differs by 100x. If a size change can move
   * this chart, it is measuring deposits rather than skill.
   */
  it('is unmoved by the SIZE of a cycle, which the dollar line is not', () => {
    const cycle = (id: string, scale: number) => [
      row(id, '2026-09-01T00:00:00Z', 'create_lp', 'principal', 'SOL', -5 * scale, 100, 'p'),
      row(id, '2026-09-01T00:00:00Z', 'create_lp', 'principal', 'USDC', -500 * scale, 1, 'p'),
      row(id, '2026-09-02T00:00:00Z', 'close_lp', 'principal', 'SOL', 5 * scale, 110, 'p'),
      row(id, '2026-09-02T00:00:00Z', 'close_lp', 'principal', 'USDC', 500 * scale, 1, 'p'),
    ];

    const small = buildReport(cycle('op_s', 1)).series;
    const large = buildReport(cycle('op_l', 100)).series;

    expect(large[1].lpReturnPct).toBeCloseTo(small[1].lpReturnPct, 9);
    expect(large[1].allSolReturnPct!).toBeCloseTo(small[1].allSolReturnPct!, 9);
    // ...and the dollar line is 100x apart, which is why the return was added.
    expect(large[1].lpCumUsd / small[1].lpCumUsd).toBeCloseTo(100, 6);
  });

  it('multiplies across cycles instead of adding them', () => {
    const cycle = (id: string, day: string) => [
      row(id, `2026-09-0${day}T00:00:00Z`, 'create_lp', 'principal', 'USDC', -1000, 1, 'p'),
      row(id, `2026-09-0${day}T00:00:00Z`, 'create_lp', 'principal', 'SOL', -1, 100, 'p'),
      row(id, `2026-09-0${Number(day) + 1}T00:00:00Z`, 'close_lp', 'principal', 'USDC', 1210, 1, 'p'),
      row(id, `2026-09-0${Number(day) + 1}T00:00:00Z`, 'close_lp', 'principal', 'SOL', 0, 100, 'p'),
    ];
    // Two cycles of +10%: +10% then +21%, not +20%.
    const { series } = buildReport([...cycle('op_1', '1'), ...cycle('op_2', '3')]);
    expect(series[1].lpReturnPct).toBeCloseTo(10, 6);
    expect(series[2].lpReturnPct).toBeCloseTo(21, 6);
  });

  /**
   * A zero cost basis is an operation whose SIZE nobody can establish, not an
   * operation that returned nothing. Dividing by it puts Infinity or NaN on a
   * chart axis. The LP line is the exception: it carries forward rather than
   * going null, because it is the subject and a gap in it would hide the bot
   * entirely -- the BENCHMARKS go null, which is what makes the cycle
   * uncomparable rather than invisible.
   */
  it('a zero cost basis is unknown, never a flat cycle and never Infinity', () => {
    const noBasis = [
      // priceUsd 0 on both legs, so every deposit row values at $0.
      row('op_z', '2026-09-01T00:00:00Z', 'create_lp', 'principal', 'SOL', -5, 0, 'p'),
      row('op_z', '2026-09-02T00:00:00Z', 'close_lp', 'principal', 'SOL', 5, 0, 'p'),
    ];

    const { series, completed } = buildReport(noBasis);

    // -0, because the basis is the negation of a sum of negative rows. It
    // still fails `> 0`, which is what the guard tests.
    expect(completed[0].costBasisUsd).toBeCloseTo(0, 10);
    expect(series[1].lpReturnPct).toBe(0);
    expect(Number.isFinite(series[1].lpReturnPct)).toBe(true);
    expect(series[1].allSolReturnPct).toBeNull();
    expect(series[1].mixReturnPct).toBeNull();
  });

  it('an unknown benchmark nulls its own line and leaves the others alone', () => {
    const noSolClose = [
      row('op_x', '2026-09-01T00:00:00Z', 'create_lp', 'principal', 'SOL', -5, 100, 'p'),
      row('op_x', '2026-09-01T00:00:00Z', 'create_lp', 'principal', 'USDC', -500, 1, 'p'),
      row('op_x', '2026-09-02T00:00:00Z', 'close_lp', 'principal', 'USDC', 1010, 1, 'p'),
    ];

    const { series } = buildReport(noSolClose);

    expect(series[1].allSolReturnPct).toBeNull();
    expect(series[1].mixReturnPct).toBeNull();
    expect(series[1].lpReturnPct).not.toBeNull();
  });

  /**
   * Null must STAY null. Resuming from the last known value would draw a line
   * that silently skips a cycle and understates the benchmark -- the same rule
   * `hodlCumUsd` already follows.
   */
  it('a null index never recovers on a later cycle', () => {
    const broken = [
      row('op_x', '2026-09-01T00:00:00Z', 'create_lp', 'principal', 'SOL', -5, 100, 'p'),
      row('op_x', '2026-09-01T00:00:00Z', 'create_lp', 'principal', 'USDC', -500, 1, 'p'),
      row('op_x', '2026-09-02T00:00:00Z', 'close_lp', 'principal', 'USDC', 1010, 1, 'p'),
    ];
    const fine = [
      row('op_y', '2026-09-03T00:00:00Z', 'create_lp', 'principal', 'SOL', -5, 100, 'p'),
      row('op_y', '2026-09-03T00:00:00Z', 'create_lp', 'principal', 'USDC', -500, 1, 'p'),
      row('op_y', '2026-09-04T00:00:00Z', 'close_lp', 'principal', 'SOL', 5, 110, 'p'),
      row('op_y', '2026-09-04T00:00:00Z', 'close_lp', 'principal', 'USDC', 500, 1, 'p'),
    ];

    const { series } = buildReport([...broken, ...fine]);

    expect(series[1].allSolReturnPct).toBeNull();
    expect(series[2].allSolReturnPct).toBeNull();
  });
});
