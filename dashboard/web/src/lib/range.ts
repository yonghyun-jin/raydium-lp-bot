/**
 * The date range, as a value and a predicate.
 *
 * Deliberately NOT in `Filters.tsx`: the root Jest suite has no JSX in its
 * tsconfig, so anything it needs to test has to live in a plain `.ts` module.
 * That is also the right shape -- the boundary rule is arithmetic, and the
 * controls that set it are a separate concern.
 */

/** `yyyy-mm-dd` at each end; an empty string means open-ended. */
export interface DateRange {
  from: string;
  to: string;
}

export const ALL_TIME: DateRange = { from: '', to: '' };

/**
 * Boundaries are UTC, like every timestamp this page prints.
 *
 * A local-midnight boundary would drop the $1,000 position's 06:35 UTC open out
 * of a range that visibly contains its date -- the same calendar shift that
 * `utcDate` exists to avoid -- and, on a tax year, would move income across a
 * year boundary.
 */
export function inRange(at: string | Date, range: DateRange): boolean {
  const t = new Date(at).getTime();
  if (range.from && t < Date.parse(`${range.from}T00:00:00.000Z`)) return false;
  if (range.to && t > Date.parse(`${range.to}T23:59:59.999Z`)) return false;
  return true;
}

export function isFiltered(range: DateRange): boolean {
  return Boolean(range.from || range.to);
}
