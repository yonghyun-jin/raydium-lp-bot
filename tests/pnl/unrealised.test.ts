/**
 * Where an open position stands, and the wall between a mark and the record.
 *
 * The guard that matters most here is not an arithmetic one. A mark moves
 * every tick; the record is settled operations only. If a mark ever reaches
 * `totals` or `series`, "what the bot earned" silently becomes "where SOL
 * happens to be", and the loudest number on the page starts reporting the
 * market. The last test is that wall.
 */

import { buildReport, buildUnrealised } from '../../src/pnl';
import type { PnlRow, PositionContext } from '../../src/pnl';
import { ALL_ROWS, POSITIONS, row } from './fixtures';

const NO_READING = {
  lastReadAt: null,
  lastPrice: null,
  lastSolAmount: null,
  lastUsdcAmount: null,
  lastFeesUsd: null,
  lastInRange: null,
};

function position(overrides: Partial<PositionContext>): PositionContext {
  return {
    operationId: 'op_live',
    nftMint: 'MINT',
    poolId: 'POOL',
    rangeLower: 90,
    rangeUpper: 110,
    isOpen: true,
    openedAt: new Date('2026-10-01T00:00:00Z'),
    adoptedAt: null,
    closedAt: null,
    prevPositionId: null,
    ...NO_READING,
    ...overrides,
  };
}

/** 10 SOL at $100 plus 1,000 USDC in, never closed. Cost basis $2,000. */
const LIVE: PnlRow[] = [
  row('op_live', '2026-10-01T00:00:00Z', 'create_lp', 'principal', 'SOL', -10, 100, 'o'),
  row('op_live', '2026-10-01T00:00:00Z', 'create_lp', 'principal', 'USDC', -1000, 1, 'o'),
];

describe('marking an open position', () => {
  it('values the position and the same basket at ONE price, and subtracts', () => {
    // The pool sold SOL on the way up: 10 SOL became 8, plus $200 of USDC.
    const [mark] = buildUnrealised(LIVE, [
      position({
        lastReadAt: new Date('2026-10-07T03:00:00Z'),
        lastPrice: 120,
        lastSolAmount: 8,
        lastUsdcAmount: 1200,
        lastFeesUsd: 3.5,
        lastInRange: true,
      }),
    ]);

    expect(mark.positionValueUsd).toBeCloseTo(8 * 120 + 1200, 9); // 2160
    expect(mark.hodlValueUsd).toBeCloseTo(10 * 120 + 1000, 9); // 2200
    expect(mark.impermanentLossUsd).toBeCloseTo(-40, 9);
    expect(mark.feesSoFarUsd).toBe(3.5);
    expect(mark.markedAt).toEqual(new Date('2026-10-07T03:00:00Z'));
    expect(mark.unknownReason).toBeNull();
  });

  /**
   * The benchmark MUST use the marked price, not the open price. Marking the
   * held basket at the open price would make it equal the cost basis, and the
   * entire price move would be reported as impermanent loss.
   */
  it('marks the held basket at the READING price, not the open price', () => {
    const [mark] = buildUnrealised(LIVE, [
      position({
        lastReadAt: new Date('2026-10-07T03:00:00Z'),
        lastPrice: 120,
        lastSolAmount: 10,
        lastUsdcAmount: 1000,
        lastFeesUsd: null,
        lastInRange: true,
      }),
    ]);

    // Same tokens out as in, so the pool did nothing and IL is exactly zero --
    // which is only true if both sides were priced at $120.
    expect(mark.hodlValueUsd).toBeCloseTo(2200, 9);
    expect(mark.hodlValueUsd).not.toBeCloseTo(2000, 0);
    expect(mark.impermanentLossUsd).toBeCloseTo(0, 9);
  });

  it('is present with null figures, not absent, before the first reading', () => {
    const [mark] = buildUnrealised(LIVE, [position({})]);

    expect(mark.operationId).toBe('op_live');
    expect(mark.impermanentLossUsd).toBeNull();
    expect(mark.positionValueUsd).toBeNull();
    // Omitting it would render as "no open position", which is a different
    // and wrong statement from "nobody has looked at it yet".
    expect(mark.unknownReason).toMatch(/not recorded a reading/);
  });

  it('still reports fees when the amounts are missing: the two are independent', () => {
    const [mark] = buildUnrealised(LIVE, [position({ lastFeesUsd: 2.25 })]);

    expect(mark.impermanentLossUsd).toBeNull();
    expect(mark.feesSoFarUsd).toBe(2.25);
  });

  it('refuses rather than guesses when a deposited token has no live price', () => {
    // Built by hand: the fixture helper only knows this bot's pair, but
    // `PnlRow.token` is deliberately an open string so an operation from
    // another protocol renders without a code change. Marking is where that
    // openness has to stop -- there is no live price source here for a third
    // token, and inventing one is the failure this asserts against.
    const exotic: PnlRow[] = [
      ...LIVE,
      {
        ...row('op_live', '2026-10-01T00:00:00Z', 'create_lp', 'principal', 'SOL', -5, 2, 'o'),
        token: 'BONK',
        tokenAddress: 'BONKmint1111111111111111111111111111111111',
      },
    ];

    const [mark] = buildUnrealised(exotic, [
      position({
        lastReadAt: new Date('2026-10-07T03:00:00Z'),
        lastPrice: 120,
        lastSolAmount: 8,
        lastUsdcAmount: 1200,
        lastFeesUsd: null,
        lastInRange: true,
      }),
    ]);

    expect(mark.impermanentLossUsd).toBeNull();
    expect(mark.unknownReason).toMatch(/BONK/);
  });

  it('ignores operations that have already closed', () => {
    const marks = buildUnrealised(ALL_ROWS, POSITIONS);
    const ids = marks.map((m) => m.operationId);

    expect(ids).not.toContain('op_1700000011000_94d730b0'); // settled
    expect(ids).toContain('op_1700000012000_a65a3231'); // still open
  });
});

describe('the wall between a mark and the record', () => {
  const report = buildReport(ALL_ROWS, { positions: POSITIONS });

  it('marks never enter the totals, the series or the completed list', () => {
    const marked = new Set(report.unrealised.map((m) => m.operationId));

    expect(marked.size).toBeGreaterThan(0);
    for (const op of report.completed) expect(marked.has(op.operationId)).toBe(false);
    for (const point of report.series) {
      if (point.operationId) expect(marked.has(point.operationId)).toBe(false);
    }
    expect(report.totals.completedOperations).toBe(report.completed.length);
  });

  /**
   * Reintroduce the bug by having buildUnrealised accept operations with close
   * rows, or by summing marks into buildTotals: this goes red because the same
   * operation would appear on both sides.
   */
  it('an operation is either settled or marked, never both', () => {
    const settled = report.completed.map((o) => o.operationId);
    const marked = report.unrealised.map((m) => m.operationId);

    expect(settled.filter((id) => marked.includes(id))).toEqual([]);
  });
});
