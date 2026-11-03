/**
 * The ledger view: what happened, line by line.
 *
 * Two things are under guard here. The arithmetic -- capital in, fees, rent,
 * prices -- and the CONSTRAINT that none of it may branch on an action name.
 * The ledger schema is deliberately protocol-agnostic, and the lending test at
 * the bottom is what stops that being quietly traded away for a convenient
 * `if (action === 'create_lp')`.
 *
 * Design: docs/v1/scopes/C4-pnl-dashboard.md
 */

import { buildLedger, kindOf } from '../../src/pnl';
import { ALL_ROWS, LARGE_COMPLETE, POSITIONS, TX, row } from './fixtures';

const LARGE = 'op_1700000011000_94d730b0';
const OPEN = 'op_1700000012000_a65a3231';
const ADOPTED = 'job_1699999990000';

const find = (ops: ReturnType<typeof buildLedger>, id: string) =>
  ops.find((op) => op.operationId === id)!;

describe('the operation -> transaction -> movement tree', () => {
  const [op] = buildLedger(LARGE_COMPLETE, { positions: POSITIONS });

  it('groups rows into the transactions that actually produced them', () => {
    expect(op.transactions).toHaveLength(2);
    expect(op.transactions.map((t) => t.txId)).toEqual([TX.largeOpen, TX.largeClose]);
    expect(op.transactions.map((t) => t.movements.length)).toEqual([4, 6]);
  });

  it('every movement sums back to the operation total', () => {
    const fromMovements = op.transactions
      .flatMap((t) => t.movements)
      .reduce((total, m) => total + m.valueUsd, 0);

    expect(fromMovements).toBeCloseTo(op.netUsd, 6);
    expect(op.netUsd).toBeCloseTo(35.87, 2);
  });

  it('transactions carry their own net, and those sum to the operation too', () => {
    expect(op.transactions[0].netUsd).toBeCloseTo(-995.7, 2);
    expect(op.transactions[1].netUsd).toBeCloseTo(1031.57, 2);
    expect(
      op.transactions.reduce((total, t) => total + t.netUsd, 0)
    ).toBeCloseTo(op.netUsd, 6);
  });

  it('keeps each row description -- that is the ledger detail, already written', () => {
    const movements = op.transactions[0].movements;
    expect(movements.every((m) => 'description' in m)).toBe(true);
    expect(movements.map((m) => m.category)).toEqual([
      'principal',
      'principal',
      'network_fee',
      'rent_deposit',
    ]);
  });
});

describe('what an operation cost and earned', () => {
  const op = find(buildLedger(ALL_ROWS, { positions: POSITIONS }), LARGE);

  it('splits fees earned from fees paid and rent', () => {
    expect(op.feesEarnedUsd!).toBeCloseTo(23.33, 2);
    expect(op.feesPaidUsd).toBeCloseTo(-0.05, 2);
    expect(op.rentLockedUsd).toBeCloseTo(-2.14, 2);
    expect(op.rentReturnedUsd).toBeCloseTo(0.18, 2);
  });

  it('reports the price of the token that MOVED, and not the stablecoin', () => {
    expect(op.prices).toHaveLength(1);
    expect(op.prices[0]).toMatchObject({ token: 'SOL', openUsd: 116.78, closeUsd: 122.78 });
  });

  it('takes the LP range from the position join, since the ledger has none', () => {
    expect(op.position).toMatchObject({ rangeLower: 112.52, rangeUpper: 122.75 });
    // It closed at $122.78 against an upper bound of $122.75 -- out of range at
    // the top, which is why it came back almost entirely USDC.
    expect(op.prices[0].closeUsd!).toBeGreaterThan(op.position!.rangeUpper);
  });
});

describe('capital in is the low-water mark, not a sum of negatives', () => {
  const ledger = buildLedger(ALL_ROWS, { positions: POSITIONS });

  it('does not double-count a funding swap', () => {
    const op = find(ledger, OPEN);

    // The swap sends 545 USDC and receives 545 of SOL inside the operation.
    // Summing negative rows would call that ~$545 of capital on top of the
    // ~$999 actually deployed.
    const negatives = op.transactions
      .flatMap((t) => t.movements)
      .filter((m) => m.valueUsd < 0)
      .reduce((total, m) => total + m.valueUsd, 0);

    expect(Math.abs(negatives)).toBeGreaterThan(1500);
    expect(op.capitalInUsd!).toBeCloseTo(998.62, 2);
  });

  it('closes the loop: capital in + net = capital out', () => {
    const op = find(ledger, LARGE);
    expect(op.capitalInUsd!).toBeCloseTo(995.7, 2);
    expect(op.capitalOutUsd!).toBeCloseTo(1031.57, 2);
    expect(op.capitalInUsd! + op.netUsd).toBeCloseTo(op.capitalOutUsd!, 6);
  });

  it('is null when the record never saw money leave', () => {
    const op = find(ledger, ADOPTED);
    expect(op.capitalInUsd).toBeNull();
    expect(op.capitalOutUsd).toBeNull();
  });
});

describe('status says which numbers may be read as profit', () => {
  const ledger = buildLedger(ALL_ROWS, { positions: POSITIONS });

  it('an open position is open, and its net is NOT a loss', () => {
    const op = find(ledger, OPEN);
    expect(op.status).toBe('open');
    expect(op.netUsd).toBeLessThan(-900);
    // The capital is deployed, not gone. Showing -$998 as a loss is the whole
    // reason this flag exists.
    expect(op.netIsPnl).toBe(false);
  });

  it('an adopted position is incomplete, and its net is NOT a profit', () => {
    const op = find(ledger, ADOPTED);
    expect(op.status).toBe('incomplete');
    expect(op.netUsd).toBeCloseTo(10.36, 2);
    expect(op.netIsPnl).toBe(false);
  });

  it('a finished cycle is closed, and its net IS profit', () => {
    const op = find(ledger, LARGE);
    expect(op.status).toBe('closed');
    expect(op.netIsPnl).toBe(true);
  });
});

describe('an unfinished operation reports unknown, never zero', () => {
  const op = find(buildLedger(ALL_ROWS, { positions: POSITIONS }), OPEN);

  it('has no fees earned yet, because none are booked until the close', () => {
    // Fees are read from the chain moments before the position is burned and
    // become rows only then. $0.00 would claim it earned nothing.
    expect(op.feesEarnedUsd).toBeNull();
  });

  it('has no closing price, because it has not closed', () => {
    expect(op.prices[0].openUsd).toBeCloseTo(120.66, 2);
    expect(op.prices[0].closeUsd).toBeNull();
  });

  it('but the costs it HAS paid are real and shown', () => {
    expect(op.rentLockedUsd).toBeCloseTo(-2.22, 2);
    expect(op.feesPaidUsd).toBeLessThan(0);
  });
});

describe('a position that never joined still renders', () => {
  it('keeps the operation, with a null range rather than dropping it', () => {
    const ledger = buildLedger(LARGE_COMPLETE, { positions: [] });

    expect(ledger).toHaveLength(1);
    expect(ledger[0].position).toBeNull();
    expect(ledger[0].netUsd).toBeCloseTo(35.87, 2);
  });
});

describe('nothing here branches on an action name', () => {
  /**
   * A lending cycle: borrow, pay interest, repay. No LP anywhere, no matching
   * position row, protocol 'aave'. If any of the tree, the cost split or the
   * status logic ever learns the word `create_lp`, this is what goes red.
   */
  const lending = [
    row('op_loan', '2026-09-01T00:00:00Z', 'borrow', 'principal', 'USDC', 1000, 1, null, 'tx_borrow'),
    row('op_loan', '2026-09-01T00:00:00Z', 'borrow', 'debt', 'USDC', -1000, 1, null, 'tx_borrow'),
    row('op_loan', '2026-09-02T00:00:00Z', 'repay', 'interest', 'USDC', -12, 1, null, 'tx_interest'),
    row('op_loan', '2026-09-03T00:00:00Z', 'repay', 'principal', 'USDC', -1000, 1, null, 'tx_repay'),
    row('op_loan', '2026-09-03T00:00:00Z', 'repay', 'debt', 'USDC', 1000, 1, null, 'tx_repay'),
  ];

  const [op] = buildLedger(lending);

  it('groups three transactions it has never seen before', () => {
    expect(op.transactions.map((t) => t.txId)).toEqual(['tx_borrow', 'tx_interest', 'tx_repay']);
    expect(op.transactions.map((t) => t.action)).toEqual(['borrow', 'repay', 'repay']);
  });

  it('nets the debt pair to zero and leaves only the interest', () => {
    expect(op.transactions[0].netUsd).toBeCloseTo(0, 6);
    expect(op.transactions[2].netUsd).toBeCloseTo(0, 6);
    expect(op.netUsd).toBeCloseTo(-12, 6);
  });

  it('classifies interest as paid and debt as a movement', () => {
    expect(kindOf('interest')).toBe('paid');
    expect(kindOf('debt')).toBe('movement');
    expect(op.feesPaidUsd).toBeCloseTo(-12, 6);
  });

  it('an unrecognised category is a movement, never a guessed cost', () => {
    // It still shows in the row list and still counts toward the net; it is
    // only absent from the summary split, which is the safe failure.
    expect(kindOf('some_future_category')).toBe('movement');

    const exotic = [
      row('op_x', '2026-09-01T00:00:00Z', 'stake', 'principal', 'USDC', -100, 1, null, 'tx_a'),
      row('op_x', '2026-09-02T00:00:00Z', 'claim', 'airdrop_bonus', 'USDC', 7, 1, null, 'tx_b'),
    ];
    const [staked] = buildLedger(exotic);

    expect(staked.netUsd).toBeCloseTo(-93, 6);
    expect(staked.transactions[1].movements[0].kind).toBe('movement');
  });
});

describe('double-entry: debit, credit and a running balance', () => {
  const ledger = buildLedger(ALL_ROWS, { positions: POSITIONS });
  const op = find(ledger, LARGE);
  const movements = op.transactions.flatMap((t) => t.movements);

  /**
   * THE SELF-PROVING PROPERTY, and the reason the balance is operation-scoped.
   *
   * Start at zero, follow every movement in order, and the last figure is the
   * operation's result. If a row is ever dropped from the display the two stop
   * agreeing, which is a far louder failure than a total that is quietly wrong.
   */
  it('the last balance IS the operation result', () => {
    expect(movements[movements.length - 1].balanceUsd).toBeCloseTo(op.netUsd, 9);
    expect(op.netUsd).toBeCloseTo(35.87, 2);
  });

  it('carries the balance ACROSS transactions rather than restarting', () => {
    const [opened, closed] = op.transactions;

    expect(opened.balanceUsd).toBeCloseTo(-995.7, 2);
    // The close picks up from where the open left off. Restarting at zero would
    // make each transaction self-consistent and the operation unprovable.
    expect(closed.movements[0].balanceUsd).toBeGreaterThan(-995.7);
    expect(closed.movements[0].balanceUsd).toBeLessThan(-995);
    expect(closed.balanceUsd).toBeCloseTo(op.netUsd, 9);
  });

  it('debit minus credit is the net, for every transaction and the operation', () => {
    for (const tx of op.transactions) {
      expect(tx.debitUsd - tx.creditUsd).toBeCloseTo(tx.netUsd, 9);
    }

    const debit = op.transactions.reduce((total, t) => total + t.debitUsd, 0);
    const credit = op.transactions.reduce((total, t) => total + t.creditUsd, 0);
    expect(debit - credit).toBeCloseTo(op.netUsd, 9);
  });

  it('debit and credit are never negative — the column carries the direction', () => {
    for (const tx of ledger.flatMap((o) => o.transactions)) {
      expect(tx.debitUsd).toBeGreaterThanOrEqual(0);
      expect(tx.creditUsd).toBeGreaterThanOrEqual(0);
    }
  });

  it('the open is pure credit and the close is mostly debit', () => {
    const [opened, closed] = op.transactions;

    // Nothing arrived when the position was opened.
    expect(opened.debitUsd).toBe(0);
    expect(opened.creditUsd).toBeCloseTo(995.7, 2);

    // The close returned principal and fees, and paid one network fee.
    expect(closed.debitUsd).toBeCloseTo(1031.59, 2);
    expect(closed.creditUsd).toBeCloseTo(0.02, 2);
  });

  it('balances a lending cycle the same way, with no LP anywhere', () => {
    const lending = [
      row('op_loan', '2026-09-01T00:00:00Z', 'borrow', 'principal', 'USDC', 1000, 1, null, 'tx_borrow'),
      row('op_loan', '2026-09-01T00:00:00Z', 'borrow', 'debt', 'USDC', -1000, 1, null, 'tx_borrow'),
      row('op_loan', '2026-09-02T00:00:00Z', 'repay', 'interest', 'USDC', -12, 1, null, 'tx_interest'),
    ];
    const [loan] = buildLedger(lending);
    const last = loan.transactions.flatMap((t) => t.movements).pop()!;

    expect(loan.transactions[0].debitUsd).toBeCloseTo(1000, 6);
    expect(loan.transactions[0].creditUsd).toBeCloseTo(1000, 6);
    expect(loan.transactions[0].balanceUsd).toBeCloseTo(0, 9);
    expect(last.balanceUsd).toBeCloseTo(loan.netUsd, 9);
    expect(loan.netUsd).toBeCloseTo(-12, 6);
  });
});
