/**
 * What kind of movement a row is, as a 6px circle.
 *
 * Not `components/ui/`: shadcn has no indicator primitive, and routing a
 * borderless dot through `badgeVariants` would mean overriding `border`,
 * `px-*`, `py-*`, `text-xs` and `gap-1` back off again -- more utilities to
 * fight the component than to write it.
 *
 * `aria-hidden` is new, and the stylesheet licensed it: "the word beside it
 * carries the same information, so this is never the only signal." Provably
 * redundant, so hiding it from assistive tech loses nothing -- and before
 * this it was an empty, unlabelled element announcing nothing. The same
 * sentence is the constraint that forbids ever shipping a dot without its
 * label.
 *
 * `data-kind` is a test hook, in the house style `data-slot` and
 * `data-variant` already set: a 6px circle changing colour is about 28
 * pixels, which is under the screenshot harness's floor, so its colour is
 * asserted against the computed token instead of photographed.
 */

import type { Movement } from '@/lib/types';

const FILL: Record<Movement['kind'], string> = {
  /* The most common row on the page, and grey on purpose. */
  movement: 'bg-border-strong',
  earned: 'bg-good',
  paid: 'bg-bad',
  recoverable: 'bg-series-hodl',
};

export function MovementDot({ kind }: { kind: Movement['kind'] }) {
  /* `mr-2.25`, not the parent's `gap`: `<Help>` shares that flex cell and
     carries its own margin, so a gap would space the help icon too. */
  return (
    <span
      aria-hidden="true"
      data-kind={kind}
      className={`inline-block size-1.5 shrink-0 rounded-full ${FILL[kind]} mr-2.25`}
    />
  );
}
