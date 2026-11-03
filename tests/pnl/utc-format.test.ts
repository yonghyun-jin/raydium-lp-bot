/**
 * Timestamps in the journal are UTC, and must be built from the ISO string.
 *
 * This guards a failure that looks like nothing: a locale formatter applies the
 * viewer's CALENDAR as well as their clock, so the $1,000 position's open --
 * 06:35:38 UTC on 09/22 -- renders as 23:35 on 09/21 in this operator's
 * timezone. A different day, perfectly plausible on screen, and no longer
 * matching Solscan or `ledger_entries.timestamp`.
 *
 * The assertions below are exact strings on purpose. Any timezone-sensitive
 * implementation fails them wherever TZ is not UTC.
 */

import { utcDate, utcTime } from '../../dashboard/web/src/lib/format';

const POSITION_OPENED = '2026-09-22T06:35:38.376Z';
const POSITION_CLOSED = '2026-09-25T20:39:43.389Z';

describe('journal timestamps are UTC', () => {
  it('renders MM/DD/YYYY', () => {
    expect(utcDate(POSITION_OPENED)).toBe('09/22/2026');
    expect(utcDate(POSITION_CLOSED)).toBe('09/25/2026');
  });

  it('renders HH:MM:SS, seconds included', () => {
    expect(utcTime(POSITION_OPENED)).toBe('06:35:38');
    expect(utcTime(POSITION_CLOSED)).toBe('20:39:43');
  });

  it('does not drift with the local timezone', () => {
    // Late-UTC-evening and early-UTC-morning instants are where a local
    // formatter crosses a date boundary.
    expect(utcDate('2026-09-22T00:00:01.000Z')).toBe('09/22/2026');
    expect(utcDate('2026-09-22T23:59:59.000Z')).toBe('09/22/2026');
    expect(utcTime('2026-09-22T00:00:01.000Z')).toBe('00:00:01');
  });

  it('accepts a Date as readily as an ISO string', () => {
    expect(utcDate(new Date(POSITION_OPENED))).toBe('09/22/2026');
    expect(utcTime(new Date(POSITION_OPENED))).toBe('06:35:38');
  });
});
