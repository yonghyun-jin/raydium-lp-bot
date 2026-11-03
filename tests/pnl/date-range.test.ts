/**
 * The dashboard's date filter cuts on UTC boundaries.
 *
 * Same trap as `utc-format.test.ts`, one layer up: an <input type="date"> hands
 * back `2026-09-22`, and turning that into a moment with `new Date('2026-09-22')`
 * plus local hours puts the boundary nine hours out in this operator's
 * timezone. The $1,000 position opened at 06:35:38 UTC on 09/22, so a
 * local-midnight boundary silently pulls the previous evening's transactions
 * into a range that visibly begins the next day -- and, for a tax year, moves
 * income across a year boundary.
 *
 * The assertions are written so a local-midnight implementation fails them
 * wherever TZ is not UTC. Verified red under `TZ=Asia/Seoul` -- and note the
 * corollary: under `TZ=UTC` the same bug passes all seven. A green run in a
 * UTC container proves nothing here, which is why the mutation was checked in
 * the operator's own timezone.
 */

import { ALL_TIME, inRange, isFiltered } from '../../dashboard/web/src/lib/range';

const OPEN = '2026-09-22T06:35:38.376Z';
const NIGHT_BEFORE = '2026-09-21T20:00:00.000Z';

describe('the date filter', () => {
  it('keeps everything when neither end is set', () => {
    expect(inRange(OPEN, ALL_TIME)).toBe(true);
    expect(isFiltered(ALL_TIME)).toBe(false);
  });

  it('includes a transaction on the first day of the range', () => {
    expect(inRange(OPEN, { from: '2026-09-22', to: '' })).toBe(true);
  });

  it('includes a transaction on the last day of the range', () => {
    expect(inRange(OPEN, { from: '', to: '2026-09-22' })).toBe(true);
  });

  it('excludes the evening BEFORE the range, in UTC and not in local time', () => {
    expect(inRange(NIGHT_BEFORE, { from: '2026-09-22', to: '' })).toBe(false);
  });

  it('excludes what falls after the range', () => {
    expect(inRange(OPEN, { from: '', to: '2026-09-21' })).toBe(false);
  });

  it('a closed range keeps only what is inside it', () => {
    const range = { from: '2026-09-22', to: '2026-09-25' };
    expect(inRange(OPEN, range)).toBe(true);
    expect(inRange('2026-09-25T20:39:43.389Z', range)).toBe(true);
    expect(inRange('2026-09-26T05:02:31.000Z', range)).toBe(false);
    expect(inRange(NIGHT_BEFORE, range)).toBe(false);
  });

  it('knows when it is doing something, so the page can say so', () => {
    expect(isFiltered({ from: '2026-01-01', to: '' })).toBe(true);
    expect(isFiltered({ from: '', to: '2026-01-01' })).toBe(true);
    expect(isFiltered(ALL_TIME)).toBe(false);
  });
});
