/**
 * Money in a column is bare; money standing alone carries its symbol.
 *
 * The unit is printed once, in the header (`Debit  USD`), so a cell holds
 * nothing but digits and the decimal points line up down the column. Two
 * failures this guards, both of which look fine on screen:
 *
 *  - a `$` creeping back into a column formatter, which re-ragged the numbers
 *    the moment one figure was longer than its neighbour;
 *  - `balance(null)` rendering as `0.00`, which would state that an operation
 *    came out flat when the truth is that nobody knows what it came out at.
 *
 * `usd()` and `price()` are the OTHER family -- tiles, summary facts, the range
 * -- where there is no header to carry the unit. They must keep their symbol,
 * so both directions are asserted here.
 */

import {
  balance,
  capitalOutMissing,
  entry,
  percent,
  points,
  price,
  priceEntry,
  usd,
} from '../../dashboard/web/src/lib/format';

describe('column formatters print no currency symbol', () => {
  it('debit and credit are bare magnitudes at two decimals', () => {
    expect(entry(995.7)).toBe('995.70');
    expect(entry(1031.59)).toBe('1,031.59');
    expect(entry(-11.84)).toBe('11.84');
  });

  it('nothing moved is an em dash, not a zero', () => {
    expect(entry(0)).toBe('—');
  });

  it('a balance keeps its sign, because no header can carry direction', () => {
    expect(balance(-995.7)).toBe('-995.70');
    expect(balance(35.87)).toBe('+35.87');
    expect(balance(0)).toBe('0.00');
  });

  it('an unknown balance says so and never reads as break-even', () => {
    expect(balance(null)).toBe('unknown');
    expect(balance(undefined)).toBe('unknown');
    expect(balance(Number.NaN)).toBe('unknown');
  });

  it('a price in a column is bare, and an unknown one is an em dash', () => {
    expect(priceEntry(122.78)).toBe('122.78');
    expect(priceEntry(1)).toBe('1.00');
    expect(priceEntry(null)).toBe('—');
  });

  it('no column formatter emits a currency symbol', () => {
    const columns = [
      entry(995.7),
      entry(0),
      balance(-995.7),
      balance(35.87),
      balance(null),
      priceEntry(122.78),
      priceEntry(null),
    ];
    for (const rendered of columns) expect(rendered).not.toContain('$');
  });
});

describe('standalone formatters keep their symbol', () => {
  it('a figure with no column header above it carries the unit itself', () => {
    expect(usd(995.7)).toBe('$995.70');
    expect(price(122.78)).toBe('$122.78');
  });

  it('and an unknown one still refuses to invent a number', () => {
    expect(usd(null)).toBe('unknown');
  });

  /*
   * The em dash is a COLUMN glyph and borrows its meaning from the column it
   * sits in. `price()` renders into a sentence, a fact grid or a range, where
   * there is nothing to lend it that meaning -- so an absent standalone price
   * says the word. `priceEntry()`, four lines up, keeps the dash because it
   * does have a column.
   */
  it('an absent standalone price says unknown, where its column form dashes', () => {
    expect(price(null)).toBe('unknown');
    expect(price(undefined)).toBe('unknown');
    expect(price(Number.NaN)).toBe('unknown');
    expect(priceEntry(null)).toBe('—');
  });
});

/*
 * An absent capital-out figure has two causes and they are not interchangeable.
 *
 * An OPEN position's capital is in the pool: it has not come back, and it has
 * not been lost either. An operation with no opening record (a position this
 * bot closed but never opened) has no cost basis, so what came back cannot be
 * added to anything -- the +$10.36 case that `netIsPnl` exists to stop being
 * read as profit. Printing one word where the other is true states something
 * false about money, and an em dash states a third thing again: that nothing
 * came back.
 */
describe('why a capital-out figure is missing', () => {
  it('says an open position is still deployed, never unknown', () => {
    expect(capitalOutMissing('open')).toBe('still deployed');
  });

  it('says unknown for a record with no opening side', () => {
    expect(capitalOutMissing('incomplete')).toBe('unknown');
  });

  it('never answers with an em dash, which in a money column means zero', () => {
    for (const status of ['open', 'closed', 'incomplete', 'set-aside']) {
      expect(capitalOutMissing(status)).not.toBe('—');
      expect(capitalOutMissing(status).trim()).not.toBe('');
    }
  });
});

/*
 * Percentages, after four implementations of them became one.
 *
 * The four disagreed: one printed zero as `0.00%` and the others as `+0.00%`,
 * two skipped the finite check, and the fourth -- written inline in a template
 * literal rather than here -- rendered the EMPTY STRING when it had nothing,
 * silently dropping the last clause of the sentence it was in. These pin the
 * convention the live code paths already shared, so the next person to need a
 * percentage finds one answer instead of four.
 */
describe('a percentage', () => {
  it('always carries a sign, and zero is a gain like everywhere else', () => {
    expect(percent(2.91)).toBe('+2.91%');
    expect(percent(-3.66)).toBe('-3.66%');
    expect(percent(0)).toBe('+0.00%');
  });

  it('is fixed at two decimals unless the call site asks for more', () => {
    expect(percent(0.1234)).toBe('+0.12%');
    expect(percent(0.1234, 3)).toBe('+0.123%');
  });

  it('never renders an absence as a number, and never as nothing at all', () => {
    for (const absent of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(percent(absent)).toBe('unknown');
    }
  });
});

/*
 * `pp` is not `%`. The gap between two percentages is percentage POINTS, and
 * writing `%` there invites the reader to divide it by something.
 */
describe('a gap between two percentages', () => {
  it('is measured in points and never emits a percent sign', () => {
    expect(points(2.41)).toBe('+2.41 pp');
    expect(points(-0.88)).toBe('-0.88 pp');
    expect(points(0)).toBe('+0.00 pp');
    for (const v of [2.41, -0.88, 0]) expect(points(v)).not.toContain('%');
  });

  it('refuses an absence the same way, and still does not say pp', () => {
    expect(points(null)).toBe('unknown');
    expect(points(undefined)).toBe('unknown');
    expect(points(Number.NaN)).toBe('unknown');
  });
});
