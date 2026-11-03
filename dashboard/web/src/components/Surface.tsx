/**
 * The two raised surfaces this app actually has, over one `Card`.
 *
 * `.panel`, `.card` and `.tile` all declared the identical recipe --
 * `--surface-1`, a 1px `--border`, `var(--radius)` -- and differed only in
 * padding. So they are not three components; they are one `Card` and three
 * paddings, and padding is layout. A `variant` would re-encode page layout
 * into the component, but repeating three utilities at six call sites is
 * exactly how drift starts, so each becomes a named wrapper with no CSS of
 * its own.
 */

import { useId, type ReactNode } from 'react';
import { Card } from '@/components/ui/card';

/** The frame of every page. Six call sites across four of them. */
export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <Card className={`gap-0 px-4 pt-5 pb-2 ${className ?? ''}`}>{children}</Card>;
}

/**
 * A card whose children pad themselves -- the Summary and Journal surfaces
 * inside an expanded operation row.
 *
 * The old rule carried `margin-bottom: 12px` and a `:last-child` reset that
 * cancelled it. Both were inert: each is the only element child of its tab
 * panel, so `:last-child` always matched. Deleted rather than translated.
 */
export function Surface({ className, children }: { className?: string; children: ReactNode }) {
  return <Card className={`gap-0 py-0 ${className ?? ''}`}>{children}</Card>;
}

/**
 * A titled region inside a `Surface`.
 *
 * THE BANDS ARE THE FEATURE, in the words of the stylesheet they replace:
 * "The panel used to be one flat list of eight figures at identical weight,
 * so 'did this work' and 'what is the operation id' looked equally
 * important." So the eyebrow must not flatten into an ordinary label.
 *
 * It is a real `<section>` with a real `<h3>` now. The eyebrow was a `<div>`
 * wearing 11px/600/uppercase, which meant the three bands of the panel that
 * answers whether a position made money were invisible to a screen reader's
 * heading list. NOT `CardHeader`, which sets `container-type` -- see the
 * warning on `Card` itself.
 *
 * The rule BETWEEN bands lives on the parent as `divide-y` rather than as a
 * `border-bottom` on each plus a `:last-child` reset. Same picture, and it
 * cannot develop the bug its sibling rule has: `.episode:last-of-type` has
 * never matched anything, because the episodes' siblings include the toolbar
 * and the pager and those are `div`s too.
 */
export function Band({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    /*
     * A REAL `<section>`, WHICH IT COULD NOT BE UNTIL NOW. It was a
     * `role="group"` div because `styles.css` carried a bare
     * `section { margin-bottom: 32px }` — a page-layout rule on an element
     * selector, reaching into every component that ever used the tag, and
     * unoverridable by a `mb-0` utility because that sheet was unlayered and
     * unlayered beats layered whatever the specificity. The sheet is gone, so
     * the tag is free. A `<section>` with an accessible name is a landmark;
     * the group was only ever the nearest reachable thing to one.
     */
    <section
      aria-labelledby={headingId}
      className="[&:not(:last-child)]:border-b [&:not(:last-child)]:border-border"
    >
      <h3
        id={headingId}
        className="m-0 px-4 pt-3 pb-1 text-xs font-semibold tracking-caps-wide text-muted-text uppercase"
      >
        {title}
      </h3>
      {children}
    </section>
  );
}
