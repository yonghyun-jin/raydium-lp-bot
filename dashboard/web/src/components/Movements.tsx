/**
 * The movements inside one transaction -- the third and last level.
 *
 * Its own module because two pages open it: the grouped Operations view and
 * the flat Transactions view. One copy means the two can never drift into
 * disagreeing about what a transaction contained.
 */

import { Help } from '@/components/Help';
import { movementLabel } from '@/lib/explain';
import type { LedgerTransaction, Movement } from '@/lib/types';
import { Dash, Money } from '@/components/Money';
import { MovementDot } from '@/components/MovementDot';
import { TokenMark } from '@/components/TokenMark';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { tokenAmount } from '@/lib/format';

export function Movements({ tx }: { tx: LedgerTransaction }) {
  return (
    <>
      {/* The name of a block is plain text ABOVE it, not a row inside it -- a
          title inside a bordered card reads as data, and this is not data. So
          never a `<caption>` and never a header row. */}
      <p className="mt-0 mr-0 mb-2 ml-3 text-base font-semibold text-secondary-text">Movements</p>

      {tx.quote && (
        <p className="m-0 border-b border-border px-3 py-2.25 text-base text-secondary-text">
          Router quoted: price impact{' '}
          {tx.quote.priceImpactPct === null
            ? '—'
            : `${(tx.quote.priceImpactPct * 100).toFixed(3)}%`}
          {tx.quote.slippageBps !== null && ` · slippage tolerance ${tx.quote.slippageBps} bps`}
          {tx.quote.routeLabels.length > 0 && ` · routed via ${tx.quote.routeLabels.join(' → ')}`}
        </p>
      )}

      <Table level="inner" aria-label="Movements in this transaction">
        <TableHeader>
          <TableRow>
            <TableHead>Movement</TableHead>
            <TableHead>Token</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">
              Price then <span className="font-normal text-unit tracking-unit text-muted-text">USD</span>
            </TableHead>
            <TableHead className="text-right">
              Debit <span className="font-normal text-unit tracking-unit text-muted-text">USD</span>
            </TableHead>
            <TableHead className="text-right">
              Credit <span className="font-normal text-unit tracking-unit text-muted-text">USD</span>
            </TableHead>
            <TableHead className="text-right">
              Balance <span className="font-normal text-unit tracking-unit text-muted-text">USD</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tx.movements.map((movement, i) => (
            <MovementRow key={i} movement={movement} />
          ))}
        </TableBody>
      </Table>
    </>
  );
}

function MovementRow({ movement }: { movement: Movement }) {
  const debit = movement.valueUsd > 0 ? movement.valueUsd : 0;
  const credit = movement.valueUsd < 0 ? -movement.valueUsd : 0;

  return (
    <TableRow>
      <TableCell className="flex items-center whitespace-nowrap">
        <MovementDot kind={movement.kind} />
        {movementLabel(movement.category)}
        <Help id={movement.category} />
      </TableCell>
      <TableCell className="font-medium">
        <TokenMark token={movement.token} />
      </TableCell>
      <TableCell className="text-right font-mono text-base text-secondary-text">
        {tokenAmount(movement.amount)}
      </TableCell>
      <TableCell className="text-right">
        {/* A price column keeps the em dash: in a column it reads as "nothing
            there", which is what an unpriced movement is. */}
        <Money
          value={movement.priceUsd}
          kind="price"
          unit="bare"
          tone="secondary"
          unknown={<Dash says="no price recorded" />}
        />
      </TableCell>
      <TableCell className="text-right">
        <Money value={debit} unit="bare" sign="none" />
      </TableCell>
      <TableCell className="text-right">
        <Money value={credit} unit="bare" sign="none" />
      </TableCell>
      <TableCell className="text-right">
        <Money value={movement.balanceUsd} unit="bare" tone="auto" />
      </TableCell>
    </TableRow>
  );
}
