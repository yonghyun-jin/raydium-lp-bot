/**
 * The four things the page says when it has nothing to show.
 *
 * They were one CSS class between them -- `.state`, 64px of centred muted
 * text -- so a FAILURE and an EMPTY RESULT were the same rendering. They are
 * different answers: one says the request did not land, the other says it
 * landed and there was nothing in it, and a reader who cannot tell them apart
 * does not know whether to retry or to stop looking.
 *
 * `failure.ts` is untouched and stays untouched. It is a pure decision module
 * with its own regression test in the root suite, and it holds the rule that
 * the browser may not guess WHY a request failed. `Failed` renders a
 * `Failure`; it does not get to produce one.
 */

import type { ReactNode } from 'react';
import { Alert } from '@/components/ui/alert';
import type { Failure } from '@/lib/failure';

/** 64px of centred, quiet type. The shape all four of these share. */
const STATE = 'px-4 py-16 text-center text-secondary-text';

/**
 * A fetch in flight.
 *
 * `role="status"` on the live region and `aria-hidden` on the ring: the
 * sentence is the announcement, the spinner is decoration.
 */
export function Waiting({ children }: { children: string }) {
  return (
    <div className={`${STATE} flex items-center justify-center gap-2.5`} role="status">
      <Spinner />
      {children}
    </div>
  );
}

/**
 * A ring drawn in borders rather than an asset: three sides in the line the
 * panels are drawn with, one side in the bot's own colour, turning. Both
 * themes fall out of the tokens, so dark needs no second rule.
 *
 * NOT shadcn's `spinner`, which is a lucide glyph, and `lucide-react` is not
 * a dependency of this project yet. `--animate-spin` is already a token: the
 * ring has always turned at 720ms rather than Tailwind's 1s.
 *
 * ASKED FOR LESS MOTION the ring holds still and drops its coloured arc. The
 * sentence next to it already says the page is waiting, so the only thing
 * lost is the spin -- nothing substitutes a pulse for it.
 */
export function Spinner({ small }: { small?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={
        small
          ? 'inline-block size-2.75 shrink-0 animate-spin rounded-full border-[1.5px] border-border-strong border-t-series-lp align-[-1px] motion-reduce:animate-none motion-reduce:border-t-border-strong motion-reduce:opacity-55'
          : 'size-4.5 shrink-0 animate-spin rounded-full border-2 border-border-strong border-t-series-lp motion-reduce:animate-none motion-reduce:border-t-border-strong motion-reduce:opacity-55'
      }
    />
  );
}

/**
 * A request that did not come back, and what is known about why.
 *
 * `role="alert"` ARRIVES WITH THE COMPONENT, and it is the defect this unit
 * exists to close: the loading state has always announced itself with
 * `role="status"` while the two failure panels announced nothing at all, so
 * a screen-reader user watching a page load was told it was loading and then
 * never told it had failed.
 *
 * `whitespace-pre-wrap` on the detail is load-bearing. It is the one place
 * in the app that prints a server's own words, which is the one place a line
 * break carries meaning.
 */
export function Failed({ failure, children }: { failure: Failure; children: ReactNode }) {
  /*
   * `block`, not `Alert`'s own `grid grid-cols-[0_1fr]`. That grid exists to
   * put an icon in a gutter and the text beside it; this panel is a centred
   * column with no icon, and leaving the grid in place collapsed every line
   * to the width of one word. `AlertTitle` and `AlertDescription` are left
   * out for the same reason -- they are `col-start-2` and `text-sm`, and the
   * three paragraphs below are the markup that already reads correctly.
   * What `Alert` is here for is the one attribute it sets on the container.
   */
  return (
    <Alert className={`block rounded-none border-0 bg-transparent text-2xl ${STATE}`}>
      {/*
        THESE THREE MARGINS ARE THE BROWSER'S `margin-block: 1em` WRITTEN DOWN,
        in the same units the browser used. Measured first: 15px, 12.5px, 15px
        -- one em of each paragraph's own size, which is why the middle one
        differs, and why `1em` is the honest spelling rather than three
        pixel constants that would drift apart the next time a size moves.
        It is also the only spelling that compiles: `my-3.125` (12.5px at the
        4px spacing step) produces NOTHING, because Tailwind's bare spacing
        multiplier takes at most two decimals -- and because the value it was
        meant to replace was identical, the missing class was invisible until
        preflight removed the default that was standing in for it. Preflight's
        `* { margin: 0 }` removes all three, and this panel is three bare
        paragraphs with no `gap` and no `space-y` above them, so it would
        collapse into a solid block of text on the one screen an operator
        reads when the dashboard is down. Stated here, where it is a no-op,
        rather than discovered in the preflight diff.
      */}
      <p className="my-[1em]">
        <strong>{failure.heading}</strong>
      </p>
      <p className="my-[1em] font-mono text-base whitespace-pre-wrap text-secondary-text">
        {failure.detail}
      </p>
      <p className="my-[1em]">{children}</p>
    </Alert>
  );
}

/**
 * A result that came back empty, which is not a failure.
 *
 * `everHad` is the distinction and it is a domain fact a UI library cannot
 * know: "nothing recorded yet" and "nothing in this date range" send the
 * reader to two different places, and one of them is the date filter.
 *
 * BOTH SENTENCES NAME THEIR SUBJECT, which is the operator's decision and the
 * reason this takes no `never` prop any more. The three sites used to
 * disagree -- Operations and Transactions said "Nothing recorded yet." while
 * Predictions said "No predictions recorded yet." -- and the prop existed
 * only to carry that disagreement until someone settled it. Naming the
 * subject is what makes the two states differ in their TAIL and nowhere else
 * ("...in this date range" against "...recorded yet"), so a reader who has
 * seen one can read the other without re-reading the noun. It also means
 * neither string can be written at a call site, which is how they drifted
 * apart in the first place.
 */
export function NothingHere({ everHad, subject }: { everHad: boolean; subject: string }) {
  return (
    <div className="p-5.5 text-center text-muted-text">
      {everHad ? `No ${subject} in this date range.` : `No ${subject} recorded yet.`}
    </div>
  );
}

/** A chart with no line in it would read as the price sitting still. */
export function NoData({ children }: { children: ReactNode }) {
  return <div className={STATE}>{children}</div>;
}
