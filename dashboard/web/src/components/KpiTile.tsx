/**
 * One headline figure, labelled.
 *
 * A `<dl>`, which it was not. The three parts were three sibling `<p>`s, so a
 * screen reader read "Net P&L", "-$128.48" and "settled operations only · 3"
 * as three unrelated paragraphs -- the label and the figure were adjacent and
 * nothing said they belonged together. That is the one accessibility win a
 * styling unit can pay for, and it costs nothing.
 *
 * `value` is a node, not a number: the tile must be able to say "nothing
 * settled" instead of inventing `$0.00`, and only the caller knows how many
 * rows produced the sum. NOT `CardHeader` -- see the warning on `Card`.
 */

import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';

export function KpiTile({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <Card className="gap-0 p-4">
      <dl className="m-0">
        <dt className="mb-1.5 flex items-center gap-1.75 text-md text-secondary-text">{label}</dt>
        <dd className="m-0 text-4xl font-semibold tracking-display tabular-nums">{value}</dd>
        {note && <dd className="mt-1 mb-0 ml-0 text-base text-muted-text">{note}</dd>}
      </dl>
    </Card>
  );
}
