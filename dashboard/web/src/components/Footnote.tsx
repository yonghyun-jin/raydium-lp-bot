/**
 * The standing disclaimer, on every route including the error and loading
 * screens -- which is why it belongs to the shell and not to a page.
 */

import { Separator } from '@/components/ui/separator';

export function Footnote() {
  return (
    <>
      {/* The one rule in the app that is genuinely BETWEEN two blocks rather
          than the edge of one, and it also closes the page -- so a node of
          its own reads to a screen reader as the boundary it is. Every other
          line here stays a border on the element that owns the padding
          spacing it; splitting those would mean moving the padding too. */}
      <Separator className="mt-10" />
      {/* `mb-3.125` is the browser's trailing `1em` at this 12.5px size,
          written down before preflight removes it. It is the last thing on
          every ledger route, so losing it changes the height of every
          full-page capture as well as the page's own bottom edge. */}
      <p className="mt-4 mb-[1em] text-base text-muted-text">
        Fees are booked once, at the close. Jito tips are not booked at all. Prices are frozen at
        the moment each row was written.
      </p>
    </>
  );
}
