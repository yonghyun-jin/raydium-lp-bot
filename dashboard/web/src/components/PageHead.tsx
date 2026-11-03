/**
 * The title block every route renders.
 *
 * `meta` is computed by the shell, not by the page, and the reason is in
 * `App.tsx`: the count under the title and the count in the pager have to come
 * from the same array or they disagree in front of the operator.
 */

import type { ReactNode } from 'react';

export function PageHead({ title, note, meta }: { title: string; note: string; meta?: ReactNode }) {
  return (
    <div className="mb-5">
      {/*
        `font-bold` STATES A WEIGHT THAT IS CURRENTLY THE BROWSER'S. Measured at
        700 today with no class setting it, because preflight is not imported
        and the UA's `h1 { font-weight: bold }` is the only rule in play. The
        day preflight lands, its `h1..h6 { font-weight: inherit }` resolves this
        to body's 400 -- on every route, with the size still correct, so it
        reads as a font bug rather than a missing declaration. Written down
        here, ahead of that commit, where it is provably a no-op.
      */}
      <h1 className="m-0 text-5xl leading-display font-bold tracking-display">{title}</h1>
      {meta && <p className="mt-1.25 mb-0 text-md text-muted-text tabular-nums">{meta}</p>}
      <p className="mt-2 mb-0 max-w-note text-lg text-secondary-text">{note}</p>
    </div>
  );
}
