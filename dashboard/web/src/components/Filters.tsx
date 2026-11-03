/**
 * The date range control and the pager, shared by both tables.
 *
 * Both run in the BROWSER. The API returns the whole ledger in one response,
 * so filtering here costs nothing, needs no server round trip, and -- the part
 * that matters -- keeps the summary totals and the rows they describe derived
 * from the same array. A server-side filter would leave the Dashboard tiles
 * computed over a different set of rows than the page is showing, which is the
 * kind of disagreement nobody notices until it is in a tax return.
 *
 * It stops being the right answer somewhere past a few thousand transactions;
 * at that point `?from=&to=&page=` on /api/pnl is the move, and the tiles need
 * a stated scope before it is.
 *
 * The boundary rule itself lives in `range.ts`, where the root suite can reach
 * it without JSX.
 */

import { useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { ALL_TIME, type DateRange } from '@/lib/range';

export { ALL_TIME, inRange, isFiltered, type DateRange } from '@/lib/range';

/** `Date` -> `yyyy-mm-dd`, in UTC, which is what an <input type="date"> wants. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function DateFilter({
  range,
  onChange,
}: {
  range: DateRange;
  onChange: (range: DateRange) => void;
}) {
  const today = new Date();
  const daysAgo = (n: number) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - n);
    return isoDay(d);
  };

  const presets: { label: string; range: DateRange }[] = [
    { label: 'All time', range: ALL_TIME },
    { label: '30 days', range: { from: daysAgo(30), to: '' } },
    // A tax year is a UTC calendar year here, for the same reason every other
    // boundary on this page is.
    { label: `${today.getUTCFullYear()}`, range: { from: `${today.getUTCFullYear()}-01-01`, to: '' } },
  ];

  const active = (preset: DateRange) => preset.from === range.from && preset.to === range.to;
  /* Empty when a typed date matches no preset, which is how the strip shows
     "none of these" -- `active()` compares BOTH ends, so editing either field
     de-selects. */
  const selected = presets.find((p) => active(p.range))?.label ?? '';

  return (
    <div className="mb-1 flex flex-wrap items-center justify-between gap-3 border-b border-border px-1 pb-4">
      {/*
        A ToggleGroup rather than three independent buttons, for the keyboard:
        it is ONE tab stop with arrow keys between the presets, where before
        each was its own stop and nothing said they were alternatives. Radix
        derives the pressed state from `value`, so the three can no longer
        disagree -- which is what "pressed state, not a separate selected
        class" was always reaching for.

        `spacing` is what turns off the segmented-control styling: at 0 the
        generated item squares its inner corners and strips the border
        between neighbours, and these are separate pills with a 6px gap.
      */}
      <ToggleGroup
        type="single"
        value={selected}
        spacing={1.5}
        aria-label="Date range presets"
        onValueChange={(label) => {
          /* Radix hands back "" when the active item is pressed again. A
             preset is not a toggle -- there is no "no range" -- so re-pressing
             the active one keeps it rather than clearing the filter. */
          const next = presets.find((p) => p.label === label);
          if (next) onChange(next.range);
        }}
      >
        {presets.map((preset) => (
          <ToggleGroupItem
            key={preset.label}
            value={preset.label}
            className={cn(
              buttonVariants({ variant: 'pill', size: 'preset' }),
              /* `toggleVariants` brings a hover BACKGROUND and an on-state
                 one; this control has only ever changed its ink and its
                 border. */
              'hover:bg-transparent data-[state=on]:bg-surface-0'
            )}
          >
            {preset.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <div className="flex items-center gap-2.5">
        <DateField label="From" value={range.from} max={range.to || undefined} onChange={(from) => onChange({ ...range, from })} />
        <DateField label="To" value={range.to} min={range.from || undefined} onChange={(to) => onChange({ ...range, to })} />
      </div>
    </div>
  );
}

/**
 * A native `<input type="date">`, and it STAYS native.
 *
 * shadcn has no DatePicker -- only a recipe composing `popover` + `calendar`,
 * and `calendar` needs `react-day-picker`, which hands back local-time
 * `Date`s and reopens the UTC-boundary seam that `range.ts` exists to close.
 * It would also cost a new dependency, a hand-wired reimplementation of the
 * `min`/`max` cross-link the browser does for free, and a worse story on a
 * phone. The wrapper is tokens and nothing else.
 */
function DateField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: string;
  min?: string;
  max?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.75 text-base text-secondary-text">
      <span>{label}</span>
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-sm border border-border-strong bg-surface-0 px-2 py-1 text-base text-primary-text tabular-nums [font-family:inherit]"
      />
    </label>
  );
}

export const PAGE_SIZES = [25, 50, 100];

/**
 * Page state, with the page clamped rather than reset.
 *
 * Narrowing the filter while on page 3 must not land the operator on an empty
 * table wondering whether the rows are gone or merely elsewhere.
 */
export function usePaging(total: number) {
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [requested, setRequested] = useState(1);

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requested, pages);
  const start = (page - 1) * pageSize;

  return {
    page,
    pages,
    pageSize,
    slice: <T,>(rows: T[]) => rows.slice(start, start + pageSize),
    setPage: setRequested,
    setPageSize: (size: number) => {
      setPageSize(size);
      setRequested(1);
    },
    first: total === 0 ? 0 : start + 1,
    last: Math.min(start + pageSize, total),
  };
}

export function Pager({
  total,
  unit,
  paging,
}: {
  total: number;
  unit: string;
  paging: ReturnType<typeof usePaging>;
}) {
  const { page, pages, pageSize, setPage, setPageSize, first, last } = paging;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-1 pt-3 pb-1.5 text-base text-secondary-text">
      <span className="tabular-nums">
        {total === 0 ? `No ${unit}` : `${first}–${last} of ${total} ${unit}`}
      </span>

      {/*
        STILL A NATIVE `<select>`. shadcn's is a portalled popover, and this
        app has one scar from exactly that -- the help bubble, which `20`
        exists to fix -- so a second floating layer does not go in before it
        does. A native select is also the better control on a phone.
      */}
      <label className="flex items-center gap-1.75">
        <span>Rows</span>
        <select
          value={pageSize}
          onChange={(e) => setPageSize(Number(e.target.value))}
          className="rounded-sm border border-border-strong bg-surface-0 px-2 py-1 text-base text-primary-text tabular-nums [font-family:inherit]"
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>

      {/*
        A `<nav>` with a name, which is the half of shadcn's `pagination`
        worth having. The other half is `<a>` elements, and this pager is
        React state with no URL to point at -- an anchor cannot be
        `disabled`, and an `href="#"` would set the hash, which
        `useHashRoute` reads, so clicking Next would navigate off the page it
        was paging.
      */}
      <nav aria-label="Pagination" className="flex items-center gap-2.5">
        <Button
          variant="quiet"
          size="step"
          /*
           * `aria-disabled`, NOT `disabled`. A disabled button leaves the tab
           * order entirely, so on page 1 a keyboard user tabs straight past
           * Prev with nothing said about it — they cannot tell a control that
           * is unavailable from one that does not exist. This stays
           * focusable and announces itself as unavailable.
           *
           * `pointer-events-none` kills the hover and the click without
           * touching focus, which is why it is safe here; the handler
           * no-ops as well, because a keyboard press reaches it anyway.
           */
          aria-disabled={page <= 1}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
          onClick={() => page > 1 && setPage(page - 1)}
        >
          ← Prev
        </Button>
        <span className="tabular-nums" aria-current="page">
          Page {page} of {pages}
        </span>
        <Button
          variant="quiet"
          size="step"
          aria-disabled={page >= pages}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
          onClick={() => page < pages && setPage(page + 1)}
        >
          Next →
        </Button>
      </nav>
    </div>
  );
}
