/**
 * The sidebar.
 *
 * STILL HAND-WRITTEN, AND THAT IS THE RECOMMENDATION. shadcn's `sidebar` is 21
 * exports, 7 registry dependencies and a second colour namespace
 * (`--sidebar-background` and seven more) for four `<a href="#/…">` that have
 * no collapse requirement -- eight more places a colour is declared, which is
 * the one thing this migration exists to stop. What was worth taking is here:
 * the chrome is utilities against tokens, the toggle is the project `Button`,
 * and there is no bespoke CSS left.
 *
 * The earlier version of this comment said there was "nothing for a generated
 * component to do" over "forty lines of CSS". The verdict was right and the
 * figure was not: it was 105 lines across the rail, the responsive block and
 * the toggle, plus 33 for the shell around it. A file that undercounts its own
 * cost by 2.5x is how it talks itself out of a migration.
 *
 * Navigation is the URL hash, so a tab survives a refresh and can be linked to.
 * It also means a skip link cannot be an `<a href="#content">` here: setting the
 * hash is navigating, and `useHashRoute` would read `content`, fail to match a
 * route and send the reader to the Dashboard. Same shape as the `href="#"` that
 * disqualified shadcn's `pagination` in `07`. Recorded in `09-nav.md`.
 *
 * A `<div>` AND NOT AN `<aside>`: `<aside>` maps to `role="complementary"`,
 * which is for content tangential to the page. This is the page's primary
 * navigation, and the inner `<nav aria-label>` is the landmark that says so.
 */

import { Fragment } from 'react';
import {
  IconArrowsLeftRight,
  IconChartLine,
  IconDeviceDesktop,
  IconLayoutGrid,
  IconMoon,
  IconStack2,
  IconSun,
} from '@tabler/icons-react';
import type { Preference } from '@/lib/theme';
import { Button } from '@/components/ui/button';

export const ROUTES = ['dashboard', 'operations', 'transactions', 'predictions'] as const;
export type Route = (typeof ROUTES)[number];

const LABELS: Record<Route, string> = {
  dashboard: 'Dashboard',
  operations: 'Operations',
  transactions: 'Transactions',
  predictions: 'Ranges',
};

/*
 * WHAT THE DIGITS COUNT, for anyone who hears the rail rather than reads it.
 * "Operations 4" is a bare number with no unit; `sr-only` supplies the noun and
 * costs no pixels.
 *
 * `predictions` is deliberately NOT "predictions": the number is
 * `episodes.length`, one per POSITION, while the same page separately reports
 * "predictions the bot made and did not use". Naming it after its label would
 * make the rail state something the page contradicts. `dashboard` has no entry
 * because its count is permanently null.
 */
const COUNTED: Partial<Record<Route, string>> = {
  operations: 'operations',
  transactions: 'transactions',
  predictions: 'positions',
};

/*
 * `max-rail:` IS THE RAIL BECOMING A BAR, and it is a token rather than `md:`
 * because the flip is at 860px -- between Tailwind's `md` (768) and `lg`
 * (1024). `--breakpoint-rail` is 861px so `max-rail` compiles to
 * `width < 861px`, which is the same set of integer widths the old
 * `@media (max-width: 860px)` matched.
 */
const RAIL =
  'sticky top-0 flex h-screen w-sidebar shrink-0 flex-col gap-6 border-r border-border' +
  ' bg-surface-1 px-3.5 pt-5.5 pb-4.5' +
  ' max-rail:static max-rail:h-auto max-rail:w-auto max-rail:flex-row max-rail:items-center' +
  ' max-rail:gap-3.5 max-rail:overflow-x-auto max-rail:border-r-0 max-rail:border-b' +
  ' max-rail:px-3.5 max-rail:py-2.5';

/*
 * `aria-[current=page]:` AND NOT AN `isActive` PROP. The current page is stated
 * to assistive tech first and the styling hangs off that same attribute, so the
 * two cannot disagree -- which a boolean that paints a background can. v4 has
 * no built-in `aria-current` variant, hence the arbitrary one.
 */
const ITEM =
  'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-lg text-secondary-text no-underline' +
  ' outline-none hover:bg-surface-0 hover:text-primary-text' +
  /* `outline-none` + the ring, which is what the project `Button` does, and
     NOT `focus-visible:outline-1` beside it: `outline-none` compiles to
     `--tw-outline-style: none` and `outline-1` compiles to
     `outline-style: var(--tw-outline-style)`, so on one element the two cancel
     and the ring is all that is left anyway. Verified in the built CSS.
     `tabs.tsx` pairs `outline-1` with no `outline-none`, which is why it
     works there. */
  ' focus-visible:ring-[3px] focus-visible:ring-ring/50' +
  ' aria-[current=page]:bg-surface-0 aria-[current=page]:font-semibold' +
  ' aria-[current=page]:text-primary-text';

export function Nav({
  route,
  counts,
  preference,
  onCycleTheme,
}: {
  route: Route;
  counts: Record<Route, number | null>;
  preference: Preference;
  onCycleTheme: () => void;
}) {
  return (
    /* `data-slot`, in the house style the generated components set. It is what
       lets a test name THIS rail. */
    <div data-slot="rail" className={RAIL}>
      <div className="flex items-center gap-2.25 px-2">
        {/* No component for a brand mark, so the gradient stays ours. `/srgb`
            is load-bearing: v4 interpolates `in oklab` by default, which moves
            the midpoint of a blue -> orange ramp visibly. */}
        <span
          data-slot="brand-mark"
          className="size-4.5 shrink-0 rounded-[5px] bg-linear-140/srgb from-series-lp to-series-hodl"
          aria-hidden="true"
        />
        <span className="text-[14.5px] font-semibold tracking-display">LP ledger</span>
      </div>

      <nav className="flex flex-col gap-0.5 max-rail:flex-row" aria-label="Pages">
        {ROUTES.map((item) => (
          <Fragment key={item}>

            <a
              className={ITEM}
              href={`#/${item}`}
              aria-current={route === item ? 'page' : undefined}
            >
              <Icon route={item} />
              {LABELS[item]}
              {/* Never `?? 0`. `dashboard` is permanently null and `predictions`
                  is null until that page has been opened; an unknown count that
                  renders as a zero is a count. */}
              {counts[item] !== null && (
                <span className="ml-auto text-sm font-normal text-muted-text tabular-nums">
                  {counts[item]}
                  <span className="sr-only"> {COUNTED[item]}</span>
                </span>
              )}
            </a>
          </Fragment>
        ))}
      </nav>

      <div className="mt-auto px-0.5 max-rail:mt-0 max-rail:ml-auto">
        {/*
          THREE STATES, NOT TWO, and the label names the one you are IN
          rather than the one you would get. A control that says "Dark mode"
          while the page is light is describing its own effect, which works
          for a switch and stops working the moment there is a third
          position: "System" would have to mean "go to system" while "Dark"
          meant "go to dark" from one place and "you are dark" from another.
          `aria-label` carries the effect, which is where a screen reader
          expects it.
        */}
        <Button
          variant="surface"
          size="toggle"
          className="flex-none gap-1.75"
          aria-label={`Theme: ${THEME_LABEL[preference]}. Switch to ${THEME_LABEL[NEXT[preference]]}.`}
          onClick={onCycleTheme}
        >
          {(() => {
            const Glyph = THEME_ICON[preference];
            return <Glyph size={14} stroke={1.4} aria-hidden className="shrink-0 opacity-85" />;
          })()}
          {THEME_LABEL[preference]}
        </Button>
      </div>
    </div>
  );
}

/*
 * Tabler, at the stroke this rail has always drawn at.
 *
 * `stroke={1.4}` and not the library's default 2: these sit at 15px beside
 * 13.5px text and a 2px stroke reads as a different weight of UI. And
 * `size={15}`, because Tabler's default is 24 and the rail's icons have
 * always matched their label's cap height.
 *
 * FOUR ICONS WHERE THERE WERE THREE. The hand-drawn set gave Transactions
 * and Predictions the same three-line glyph, so two of the four items were
 * distinguishable only by their word -- which is the thing an icon is there
 * to avoid needing.
 */
const THEME_ICON: Record<Preference, typeof IconLayoutGrid> = {
  system: IconDeviceDesktop,
  light: IconSun,
  dark: IconMoon,
};

const THEME_LABEL: Record<Preference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/** Must match `useTheme`'s own order, or the label lies about what is next. */
const NEXT: Record<Preference, Preference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

/*
 * `Record<Route, ...>` AND NOT A SWITCH, which is what makes adding a route a
 * compile error rather than a silent fall-through to whichever glyph came
 * last. The hand-drawn set it replaced gave Transactions and Predictions the
 * same three-line glyph, so two of four items were distinguishable only by
 * their word -- the thing an icon is there to avoid needing.
 */
const ICONS: Record<Route, typeof IconLayoutGrid> = {
  dashboard: IconLayoutGrid,
  operations: IconStack2,
  transactions: IconArrowsLeftRight,
  predictions: IconChartLine,
};


function Icon({ route }: { route: Route }) {
  const Glyph = ICONS[route];
  return <Glyph size={15} stroke={1.4} aria-hidden className="shrink-0 opacity-85" />;
}
