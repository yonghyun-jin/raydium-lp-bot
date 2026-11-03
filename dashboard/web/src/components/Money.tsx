/**
 * A figure on screen, and the one place that decides how one looks.
 *
 * Before this, "money" was not a thing in the codebase -- it was a convention
 * re-applied by hand: a formatter from `format.ts`, a `signClass()` call
 * concatenated into a `className`, and `font-variant-numeric: tabular-nums`
 * declared sixteen times, once per place a number happened to appear.
 *
 * THE FORMATTING IS NOT HERE. `format.ts` is the only part of the frontend
 * with a root-suite regression test behind it, and that test is the written
 * record of two bugs that both looked fine on screen. This component CALLS
 * those functions; it must never re-implement one.
 *
 * What it does own: which formatter a given shape of figure gets, whether the
 * figure is coloured, and the fact that a figure is tabular.
 */

import type { ReactNode } from 'react';
import {
  balance,
  entry,
  percent,
  points,
  price as priceWithSymbol,
  priceEntry,
  signedUsd,
  usd,
} from '@/lib/format';

/**
 * `auto` derives the colour from the sign. Everything else ASSERTS one, and
 * that distinction is load-bearing: impermanent loss is red whatever its sign,
 * because a POSITIVE impermanent loss is impossible and therefore evidence the
 * rows do not describe one position. A figure that coloured itself green there
 * would delete the alarm.
 *
 * The default is `none`, not `auto`: every drawer figure wants no colour --
 * the colour is already on the row that was clicked -- and a default of `auto`
 * would silently paint twenty of them.
 */
export type Tone = 'none' | 'auto' | 'good' | 'bad' | 'muted' | 'secondary';

const TONE_CLASS = {
  good: 'text-good',
  bad: 'text-bad',
  muted: 'text-muted-text',
  secondary: 'text-secondary-text',
} as const;

/** `signClass`'s rule exactly, including that zero is a gain. */
function toneClass(tone: Tone, value: number | null): string {
  if (tone === 'none') return '';
  if (tone === 'auto') return value === null ? '' : value >= 0 ? TONE_CLASS.good : TONE_CLASS.bad;
  return TONE_CLASS[tone];
}

function isMissing(value: number | null | undefined): value is null | undefined {
  return value === null || value === undefined || !Number.isFinite(value);
}

/** A value nobody knows. Takes no number and cannot be given one. */
export function Unknown({ children = 'unknown' }: { children?: ReactNode }) {
  return <span className="text-muted-text">{children}</span>;
}

/**
 * An em dash, and the fact it stands for, said once for the eye and once for
 * a screen reader.
 *
 * Three absences share this glyph and they are three different facts: nothing
 * moved, nobody knows, and this figure is not a result. On screen the column
 * disambiguates them; aloud, `—` is announced as silence or as "dash", so a
 * zero-movement cell and an EMPTY cell become indistinguishable -- in a ledger
 * whose whole claim is that it checks itself. `says` is what the dash means
 * here, and there is no default, because the default would be a guess.
 */
export function Dash({ says }: { says: string }) {
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{says}</span>
    </>
  );
}

type MoneyProps = {
  /** Null is a real answer and is rendered as one. There is no default. */
  value: number | null | undefined;
  /** `bare` inside a column whose header carries USD; `symbol` standing alone. */
  unit?: 'bare' | 'symbol';
  /** `none` for a debit or credit cell -- the column already says which way. */
  sign?: 'none' | 'always';
  tone?: Tone;
  kind?: 'money' | 'price';
  /** What to print instead of a figure. Never a number, never zero. */
  unknown?: ReactNode;
};

/**
 * THE TRAP, stated where it would be introduced: `entry()` guards with
 * `!value`, so `entry(null)` is an em dash -- which in a money column reads as
 * "nothing moved", a settled figure. An unknown routed into `entry` therefore
 * becomes a confident lie with no type error and no failing test. The missing
 * check happens HERE, before a formatter is chosen, for every variant at once.
 */
export function Money({
  value,
  unit = 'symbol',
  sign = 'always',
  tone = 'none',
  kind = 'money',
  unknown,
}: MoneyProps) {
  if (isMissing(value)) return <Missing tone={tone}>{unknown}</Missing>;

  const isRunningBalance = kind === 'money' && unit === 'bare' && sign === 'always';
  /* The only path on which a formatter returns a bare em dash: `entry()`
     guards with `!value`, and every other falsy input was routed away above. */
  const nothingMoved = kind === 'money' && unit === 'bare' && sign === 'none' && value === 0;
  const text =
    kind === 'price'
      ? unit === 'bare'
        ? priceEntry(value)
        : priceWithSymbol(value)
      : unit === 'bare'
        ? sign === 'always'
          ? balance(value)
          : entry(value)
        : sign === 'always'
          ? signedUsd(value)
          : usd(value);

  /* A running balance is the answer its column was built to give, so it is
     the one figure in a table that carries weight. `font-semibold` rather
     than `--font-weight-figure`: that token is 650, the hero's weight, and
     600 already has a name on Tailwind's scale. */
  return (
    <span className={cx('tabular-nums', isRunningBalance && 'font-semibold', toneClass(tone, value))}>
      {nothingMoved ? <Dash says="nothing moved" /> : text}
    </span>
  );
}

type PctProps = {
  value: number | null | undefined;
  /**
   * No default. The gap between two percentages is percentage POINTS, not a
   * percentage of anything, and a call site that does not say which it means
   * is the bug this prop exists to prevent.
   */
  unit: 'percent' | 'points';
  decimals?: number;
  tone?: Tone;
  unknown?: ReactNode;
};

/** Four implementations of "render a percentage" existed and no two agreed. */
export function Pct({ value, unit, decimals = 2, tone = 'none', unknown }: PctProps) {
  if (isMissing(value)) return <Missing tone={tone}>{unknown}</Missing>;
  const text = unit === 'points' ? points(value, decimals) : percent(value, decimals);
  return <span className={cx('tabular-nums', toneClass(tone, value))}>{text}</span>;
}

/**
 * The absence, and it is NOT muted by default.
 *
 * Muting every absence looks tidy and is wrong: `unknown` in the chart legend
 * sits in the same sentence as the figure it replaces and is read at the same
 * weight, while `unknown` in a table cell is a hole in a column. The ones that
 * should recede say so by passing `<Unknown>`; a bare word inherits whatever
 * tone the figure would have had, which is how `—` keeps the price column's
 * colour. `auto` contributes nothing here -- there is no sign to derive from.
 */
function Missing({ tone, children }: { tone: Tone; children?: ReactNode }) {
  const cls = toneClass(tone, null);
  const node = children ?? 'unknown';
  return cls ? <span className={cls}>{node}</span> : <>{node}</>;
}

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
