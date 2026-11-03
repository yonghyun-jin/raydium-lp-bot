/**
 * Every transaction, flat and newest first.
 *
 * The Operations page answers "how did this position do". This one answers
 * "what happened on this day", which is the question you have when you are
 * holding a wallet statement or a block explorer tab.
 *
 * It deliberately has NO balance column. `balanceUsd` is the running total
 * WITHIN one operation and it restarts at zero on the next one, so stacking
 * four operations' transactions into one list and printing that column would
 * show a balance that jumps backwards for no visible reason. The figure is
 * correct only under the grouping that produced it, and that grouping is the
 * Operations page.
 */

import { useState } from 'react';
import { DateFilter, Pager, inRange, usePaging, type DateRange } from '@/components/Filters';
import { Help } from '@/components/Help';
import { Movements } from '@/components/Movements';
import { Money } from '@/components/Money';
import { Button } from '@/components/ui/button';
import { NothingHere } from '@/components/Feedback';
import { RowToggle } from '@/components/RowToggle';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowButton,
} from '@/components/ui/table';
import { Panel } from '@/components/Surface';
import { TxLink } from '@/components/TxLink';
import { actionLabel } from '@/lib/explain';
import type { LedgerOperation, LedgerTransaction } from '@/lib/types';
import { statusLabel, shortOperation, shortTx, utcDate, utcTime } from '@/lib/format';

interface Row {
  tx: LedgerTransaction;
  op: LedgerOperation;
}

export function Transactions({
  operations,
  onOpenOperation,
  range,
  onRangeChange,
}: {
  operations: LedgerOperation[];
  onOpenOperation: (operationId: string) => void;
  range: DateRange;
  onRangeChange: (range: DateRange) => void;
}) {
  const all: Row[] = operations
    .flatMap((op) => op.transactions.map((tx) => ({ tx, op })))
    .sort((a, b) => new Date(b.tx.at).getTime() - new Date(a.tx.at).getTime());

  // Here a transaction IS the unit, so the range cuts individual rows -- unlike
  // the Operations page, where cutting inside an operation would strand its
  // running balance.
  const rows = all.filter(({ tx }) => inRange(tx.at, range));
  const paging = usePaging(rows.length);
  const page = paging.slice(rows);

  return (
    <Panel>
      <DateFilter range={range} onChange={onRangeChange} />
      {/* `level="nested"` on a table that is not nested, and the name is
          about the RECIPE rather than the DOM: this page has always worn the
          journal's quieter type and uppercase eyebrows, which is the same
          voice as the journal inside an operation row. `scroll` is what the
          outermost table on a route gets. */}
      <Table scroll level="nested" aria-label="Transactions">
        <TableHeader>
          <TableRow>
            {/* No width: `.ledger .caret` needed a `.ledger` ancestor, which this
                table has never had, so its first column has always sized
                itself. */}
            <TableHead aria-label="expand" />
            <TableHead>Date</TableHead>
            <TableHead>Time (UTC)</TableHead>
            <TableHead>Transaction</TableHead>
            <TableHead>Operation</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead className="text-right">
              Debit <span className="font-normal text-unit tracking-unit text-muted-text">USD</span> <Help id="debit" />
            </TableHead>
            <TableHead className="text-right">
              Credit <span className="font-normal text-unit tracking-unit text-muted-text">USD</span> <Help id="credit" />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.map(({ tx, op }) => (
            <Row key={tx.txId} tx={tx} op={op} />
          ))}
          {page.length === 0 && (
            <TableRow>
              <TableCell colSpan={8}>
                <NothingHere everHad={all.length > 0} subject="transactions" />
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <Pager total={rows.length} unit="transactions" paging={paging} />
    </Panel>
  );
}

function Row({ tx, op }: { tx: LedgerTransaction; op: LedgerOperation }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <TableRowButton onClick={() => setOpen((wasOpen) => !wasOpen)}>
        {/* Not the ledger's caret recipe: `.ledger .caret` needed a
            `.ledger` ancestor and this table never had one, so this cell has
            always been an ordinary one. Doc 12 decides whether that stays. */}
        <TableCell>
          <RowToggle
            open={open}
            controls={`tx-movements-${tx.txId}`}
            label={`${open ? 'Collapse' : 'Expand'} transaction ${shortTx(tx.txId)}`}
            onToggle={() => setOpen((wasOpen) => !wasOpen)}
          />
        </TableCell>
        <TableCell className="font-mono text-base text-secondary-text">{utcDate(tx.at)}</TableCell>
        <TableCell className="font-mono text-base text-secondary-text">{utcTime(tx.at)}</TableCell>
        <TableCell className="font-semibold leading-stacked" title={tx.action}>
          {actionLabel(tx.action)}
          <span className="block text-xs font-normal text-muted-text">
            {tx.protocol} · {tx.movements.length} movements
          </span>
        </TableCell>
        <TableCell>
          {/*
            A REAL LINK, which it was not. This navigates -- it set the hash
            through a callback -- but it was a `<button>`, so it could not be
            middle-clicked, copied, or opened in a new tab, and a screen
            reader announced "button" for something that moves you to another
            page. The href does what the callback did: `useHashRoute` listens
            for `hashchange`. `aria-label` carries the full id, because
            `title` is hover-only, keyboard-unreachable and absent on touch.
          */}
          {/* `inline-block`, because this replaced a `<button>` and that is
                  what a button is; the Solscan link beside it replaced an `<a>`
                  and stays `inline`. */}
          <Button variant="anchor" size="inline" asChild className="inline-block font-mono">
            <a
              href={`#/operations/${op.operationId}`}
              aria-label={op.operationId}
              title={op.operationId}
              onClick={(event) => event.stopPropagation()}
            >
              {shortOperation(op.operationId)}
            </a>
          </Button>
          <span className="block text-xs font-normal text-muted-text">{statusLabel(op.status)}</span>
        </TableCell>
        <TableCell>
          <TxLink txId={tx.txId} />
        </TableCell>
        <TableCell className="text-right">
          <Money value={tx.debitUsd} unit="bare" sign="none" />
        </TableCell>
        <TableCell className="text-right">
          <Money value={tx.creditUsd} unit="bare" sign="none" />
        </TableCell>
      </TableRowButton>

      {open && (
        <TableRow id={`tx-movements-${tx.txId}`} className="[&>td]:pt-3.5 [&>td]:pr-0 [&>td]:pb-4 [&>td]:pl-8.5">
          <TableCell colSpan={8}>
            <Movements tx={tx} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
