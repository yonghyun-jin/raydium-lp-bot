/**
 * A help icon that explains a figure.
 *
 * Shows on hover for a pointer, and toggles on click so it also works on
 * touch and for anyone who tabs to it. The click handler stops propagation
 * because every one of these sits inside something that expands when clicked.
 *
 * THE BUBBLE IS PORTALLED NOW, and that retires an invariant this component
 * used to impose on the whole stylesheet. It was `position: fixed` and placed
 * from JavaScript, because the tables scroll horizontally and an absolutely
 * positioned bubble is clipped by the scrolling ancestor -- which is what cut
 * every tooltip in half the first time this was built, and why `.card` and
 * `.table-scroll` both had to give up their `overflow`. A fixed element
 * escapes an `overflow` ancestor, but only while nothing sets `transform`,
 * `filter`, `will-change`, `contain` or `container-type` -- five properties
 * that nobody could be stopped from adding, and one of which `CardHeader`
 * sets by default. A portalled element is a child of `document.body` and no
 * ancestor of the trigger can reach it by any mechanism at all.
 *
 * What went with the positioning engine: `place()` and its centre-then-clamp,
 * the flip-above, the `WIDTH` constant that had to be kept in step with the
 * stylesheet by hand, the capture-phase `scroll`/`resize` listeners, the
 * capture-phase click-outside, and a `useLayoutEffect` with no dependency
 * array that ran after every render and converged by returning the previous
 * object. Floating UI does all of it, listens on the real scroll ancestors
 * rather than on `window` with `capture: true`, and adds `ResizeObserver` on
 * both elements.
 *
 * WHAT RADIX DOES NOT DO IS HOVER -- `Popover` is click-only. So the state
 * machine stays and the popover is CONTROLLED by it. That is also why
 * `onOpenAutoFocus` is prevented: Radix focuses the content when it opens,
 * which is right for a click and would steal focus from under the pointer on
 * every hover.
 */

import { useEffect, useState } from 'react';
import { EXPLAIN } from '@/lib/explain';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export function Help({ id }: { id: string }) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);

  const explanation = EXPLAIN[id];
  const shown = Boolean(explanation) && (pinned || hovered);

  /* A pinned bubble is dismissed by clicking anywhere else, which Radix's
     DismissableLayer now does -- but it also has to survive the layouts this
     component cannot observe: a row expands, a detail tab is switched, a page
     changes, a filter is set. Those move the icon without any pointer leaving
     it, so `hovered` can be stranded true with no `mouseleave` ever arriving. */
  useEffect(() => {
    if (!pinned) return;
    return () => setHovered(false);
  }, [pinned]);

  const dismiss = () => {
    setPinned(false);
    setHovered(false);
  };

  if (!explanation) return null;

  return (
    /*
     * `onOpenChange` IS A NO-OP ON PURPOSE. Radix calls it for three
     * different events -- Escape, an outside interaction, and a click on the
     * trigger -- and gives no reason. Honouring all three breaks the pointer
     * case: hovering opens the bubble, and the click that is meant to PIN it
     * then reads to Radix as a toggle of something already open, so it closed
     * on the press instead. Dismissal is handled on the content, where the
     * events arrive separately and a press on the trigger is excluded from
     * "outside" for free.
     */
    <Popover open={shown} onOpenChange={() => {}}>
      <span
        className="relative ml-1.5 inline-flex align-middle"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            /* 24x24, which is WCAG 2.2 SC 2.5.8's minimum for a target, and
               this one appears beside roughly forty figures as the ONLY
               route to any explanation — so it was the worst 15x15 in the
               app to leave alone. The ring stays 15px: the target grew, not
               the mark, so the dot still reads as punctuation beside a
               figure rather than as a button in a table cell.

               `text-2xs` is the 9px the scale rounds 10px to, taken here
               because this commit is already moving the element.

               `appearance-none border-0` because this is a raw `<button>`
               and not the project `Button`: with preflight skipped the UA
               hands it a 2px outset border, which is a square box around a
               round mark. Third time this has bitten.

               `cursor-help`, not `cursor-pointer`: this asks a question
               rather than doing a thing. `aria-expanded` arrives from
               `PopoverTrigger`, so the open state styles itself. */
            className="group flex size-6 cursor-help appearance-none items-center justify-center border-0 bg-transparent p-0 text-2xs leading-none text-muted-text [font-family:inherit]"
            data-help-target
            aria-label={`What does "${explanation.title}" mean?`}
            onFocus={() => setHovered(true)}
            onBlur={() => setHovered(false)}
            onClick={(event) => {
              event.stopPropagation();
              /* A tap fires a synthetic mouseenter alongside the click, so
                 `hovered` latches true on touch. Without clearing it here the
                 second tap un-pins a bubble that stays on screen, with
                 `aria-expanded` then reading false under a visible bubble. */
              const next = !pinned;
              setPinned(next);
              if (!next) setHovered(false);
            }}
          >
            {/* The visible mark, inside a target twice its size. */}
            <span className="flex size-[15px] items-center justify-center rounded-full border border-border-strong group-hover:border-secondary-text group-hover:text-primary-text group-aria-expanded:border-secondary-text group-aria-expanded:text-primary-text">
              ?
            </span>
          </button>
        </PopoverTrigger>
      </span>

      <PopoverContent
        role="note"
        side="bottom"
        align="center"
        sideOffset={8}
        collisionPadding={8}
        /* Radix focuses the content on open, which is right for a click and
           wrong for a hover -- it would pull focus out of whatever the reader
           was using to get here. */
        onOpenAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={dismiss}
        onInteractOutside={dismiss}
        className="z-(--z-popover) w-(--popover-width) max-w-[var(--radix-popover-content-available-width)] rounded-md border border-border-strong bg-surface-1 px-3.25 py-2.75 text-left text-base leading-normal font-normal tracking-normal normal-case text-secondary-text shadow-popover [font-variant-numeric:normal]"
      >
        <strong className="mb-1 block text-primary-text">{explanation.title}</strong>
        {explanation.body}
      </PopoverContent>
    </Popover>
  );
}
