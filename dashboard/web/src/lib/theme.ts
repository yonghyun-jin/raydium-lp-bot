import { useCallback, useEffect, useState } from 'react';

/**
 * The theme preference, and the chart palette as CSS references.
 *
 * IT USED TO READ SIX CUSTOM PROPERTIES BACK OUT OF THE DOM with
 * `getComputedStyle`, because Recharts draws with inline attributes rather
 * than CSS. That worked and cost a `useState`, a re-read on every theme
 * change, and a prop threaded through six components to thirty-nine call
 * sites -- and it failed SILENTLY: a renamed token returned `''`, so the
 * chart drew with no stroke and nothing said why.
 *
 * SVG presentation attributes take `var()`. So the palette below is a set of
 * REFERENCES, resolved by the browser at paint against whichever palette is
 * live. The chart follows a theme change with no JavaScript at all, and a
 * renamed token is now an invalid value on one element, visible in devtools
 * against a single selector instead of absent everywhere.
 */

export type Mode = 'light' | 'dark';

/**
 * The chart palette, as references rather than resolved values.
 *
 * `--series-mix` is the third line's own token as of this unit. It borrowed
 * `--text-muted` before, which meant the axis LABELS and a data SERIES could
 * not be changed independently; it ships at today's muted values, so nothing
 * moved and the coupling is gone.
 */
export const CHART = {
  lp: 'var(--series-lp)',
  hodl: 'var(--series-hodl)',
  mix: 'var(--series-mix)',
  grid: 'var(--border)',
  axis: 'var(--text-muted)',
  text: 'var(--text-secondary)',
  zero: 'var(--border-strong)',
} as const;

/**
 * WHAT IS STORED IS THE PREFERENCE, NOT THE RESOLVED MODE, and that is the
 * whole bug this replaces.
 *
 * The old version seeded its state with `preferredMode()`, which resolves the
 * OS setting to a literal `'light'` or `'dark'`, and then its effect wrote
 * that literal to storage. So the dashboard stopped following the OS on the
 * FIRST PAINT of the first visit -- not on the first click, which is what
 * made it look like a toggle bug rather than a default one. There was no
 * third state to go back to, either: `toggle` flipped between two.
 */
export type Preference = Mode | 'system';

const KEY = 'lp-dashboard-theme';
const ORDER: Preference[] = ['system', 'light', 'dark'];

function storedPreference(): Preference {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    /* a blocked read is not a reason to render the wrong theme */
  }
  return 'system';
}

function systemMode(): Mode {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme(): { mode: Mode; preference: Preference; cycle: () => void } {
  const [preference, setPreference] = useState<Preference>(storedPreference);
  const [system, setSystem] = useState<Mode>(() => {
    try {
      return systemMode();
    } catch {
      return 'light';
    }
  });

  const mode: Mode = preference === 'system' ? system : preference;

  /* Only while following the OS. Stop listening the moment a choice is made,
     so a system change cannot repaint a dashboard that was pinned. */
  useEffect(() => {
    if (preference !== 'system') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setSystem(query.matches ? 'dark' : 'light');
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, [preference]);

  useEffect(() => {
    /* NO ATTRIBUTE WHILE FOLLOWING THE OS. `styles.css` scopes its dark
       branch to `:root:not([data-theme='light'])` inside the media query, so
       an absent attribute is what lets the media query govern -- writing
       `data-theme="dark"` would pin it just as firmly as a click did. */
    if (preference === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', preference);
    }
    try {
      localStorage.setItem(KEY, preference);
    } catch {
      // A blocked storage write is not a reason to render the wrong theme.
    }
  }, [preference, mode]);

  const cycle = useCallback(() => {
    setPreference((p) => ORDER[(ORDER.indexOf(p) + 1) % ORDER.length]);
  }, []);

  return { mode, preference, cycle };
}
