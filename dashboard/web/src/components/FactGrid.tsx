/**
 * A label and a figure, in a grid that reflows.
 *
 * ONE COPY OF A COMPONENT THAT EXISTED TWICE, byte-identical in
 * `pages/Operations.tsx` and `Predictions.tsx`.
 *
 * It stays a real `<dl>`: the label and the figure are ASSOCIATED, not merely
 * adjacent, and a screen reader reads them as a pair. shadcn's `Item` is the
 * nearest thing in the registry and is the wrong shape -- a list row built
 * for something you click, with hover and focus affordances, its own padding,
 * gap, radius and border to override, and no way to produce the `auto-fit`
 * reflow that is the entire layout here.
 *
 * `border-b` is per item rather than `divide-y` on the grid, and that is
 * deliberate: the grid is `auto-fit`, so "last child" and "visually last" are
 * different elements at most widths.
 */

import type { ReactNode } from 'react';
import { Help } from '@/components/Help';

export function FactGrid({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <dl
      className={`m-0 grid grid-cols-[repeat(auto-fit,minmax(var(--fact-col-min),1fr))] gap-x-7 gap-y-0 px-4 pt-2 pb-3 ${className ?? ''}`}
    >
      {children}
    </dl>
  );
}

/**
 * `help` is an `explain.ts` key, not a node.
 *
 * Twenty call sites pass one, and keeping the lookup here means doc 20 can
 * swap the hand-rolled bubble for a portalled Popover by changing one import
 * instead of twenty call sites.
 */
export function Fact({
  label,
  help,
  value,
}: {
  label: ReactNode;
  help?: string;
  value: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 text-lg">
      {/*
       * NO `whitespace-nowrap` ON THE LABEL, and that is a fix rather than an
       * omission. With it, a label wider than its column sets the term's
       * min-content to the WHOLE STRING -- and a flex item never shrinks below
       * min-content -- so the value was pushed out of the grid cell and drawn
       * on top of the neighbouring fact. Without it, min-content is the
       * longest WORD, so a long label wraps instead and nothing overflows.
       * A long label wraps instead of overflowing.
       *
       * AND DELIBERATELY NO `min-w-0` BESIDE IT, which was the first attempt:
       * that lets the term shrink below its own content, and the value then
       * laps over the help dot at the end of the label. Two facts in the real
       * Summary panel moved, and both moved for the worse. `min-width: auto`
       * is already the behaviour wanted here.
       */}
      <dt className="flex items-center text-secondary-text">
        {label}
        {help && <Help id={help} />}
      </dt>
      <dd className="m-0 text-right tabular-nums">{value}</dd>
    </div>
  );
}
