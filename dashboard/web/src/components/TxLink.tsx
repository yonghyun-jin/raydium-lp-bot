/**
 * A transaction signature, linked to Solscan.
 *
 * Lives here rather than in `pages/Operations.tsx` because `Transactions.tsx`
 * imports it: a page reaching into another page is exactly what the `pages/`
 * split exists to prevent, and it blocked both page units until it moved.
 */

import { Button } from '@/components/ui/button';
import { shortTx } from '@/lib/format';

const SOLSCAN = 'https://solscan.io/tx/';

export function TxLink({ txId }: { txId: string }) {
  return (
    /* `asChild`, so the ANCHOR stays the element and keeps `rel` and
       `target`. A `Button` that became the anchor would be a button that
       navigates, which is the defect this variant exists to stop repeating. */
    <Button variant="anchor" size="inline" asChild className="font-mono">
      <a
        href={`${SOLSCAN}${txId}`}
        target="_blank"
        rel="noreferrer noopener"
        /* The row this sits in toggles on click; a link that opened Solscan
           AND expanded the row would do two things on one press. */
        onClick={(e) => e.stopPropagation()}
      >
        {shortTx(txId)} ↗
      </a>
    </Button>
  );
}
