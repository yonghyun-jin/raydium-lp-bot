/**
 * The ledger, as a journal. The `operations` route.
 *
 * NAMED FOR ITS ROUTE, not for what it renders -- it was `LedgerTable.tsx` at
 * the root of `web/src/`. One file per route is the whole point of `pages/`,
 * and a reader looking for the Operations page should not have to know that
 * the table is the page.
 *
 * Three levels: operations, the transactions inside one, and the movements
 * inside one of those. Every level carries the same three accounting columns --
 * debit, credit, and a running balance that starts at zero on the operation and
 * ends on its result, so the last figure you read is the answer.
 *
 * Nothing here knows what `create_lp` means. Actions and categories go through
 * a label LOOKUP with a fallback to the raw string, and debit/credit fall out
 * of the sign, so an operation from a protocol nobody has written labels for
 * still renders and still balances.
 */

import { Fragment, useEffect, useState } from 'react';
import { DateFilter, Pager, inRange, usePaging, type DateRange } from '@/components/Filters';
import { Help } from '@/components/Help';
import { Movements } from '@/components/Movements';
import { actionLabel } from '@/lib/explain';
import type { Benchmark, LedgerOperation, LedgerTransaction, Mark } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NothingHere } from '@/components/Feedback';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowButton,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dash, Money, Pct, Unknown } from '@/components/Money';
import { RowToggle } from '@/components/RowToggle';
import { Band, Panel, Surface } from '@/components/Surface';
import { Fact, FactGrid } from '@/components/FactGrid';
import { Separator } from '@/components/ui/separator';
import { TxLink } from '@/components/TxLink';
import {
  statusLabel,
  capitalOutMissing,
  duration,
  price,
  range as priceRange,
  shortDate,
  shortOperation,
  shortTx,
  usd,
  utcDate,
  utcTime,
} from '@/lib/format';

export function Operations({
  operations,
  focusId,
  range,
  onRangeChange,
  benchmarks,
  marks,
}: {
  operations: LedgerOperation[];
  /** An operation to open on arrival, from `#/operations/<id>`. */
  focusId?: string | null;
  range: DateRange;
  onRangeChange: (range: DateRange) => void;
  /** Per settled operation: what holding the same basket would have returned. */
  benchmarks?: Map<string, Benchmark>;
  marks?: Map<string, Mark>;
}) {
  const [expanded, setExpanded] = useState<string | null>(
    focusId ?? operations.find((op) => op.status === 'closed')?.operationId ?? null
  );

  // A link from the Transactions page names the operation it wants open. It
  // arrives after the first render, so this cannot be a useState initialiser.
  useEffect(() => {
    if (focusId) setExpanded(focusId);
  }, [focusId]);

  /*
   * An operation is in range when ANY of its transactions is, and it is then
   * shown WHOLE.
   *
   * The alternative -- dropping the out-of-range transactions from inside it --
   * would leave the summary, the capital-in figure and the running balance
   * describing rows the operator cannot see, and a balance that no longer walks
   * to the Net beside it. The operation is the atomic unit on this page.
   */
  const shown = operations.filter((op) => op.transactions.some((tx) => inRange(tx.at, range)));
  const paging = usePaging(shown.length);
  const page = paging.slice(shown);

  return (
    <Panel>
      <DateFilter range={range} onChange={onRangeChange} />
      <Table scroll aria-label="Operations">
        <TableHeader>
          <TableRow>
            <TableHead aria-label="expand" className="w-5.5" />
            <TableHead>Opened</TableHead>
            <TableHead>Closed</TableHead>
            <TableHead>
              Status <Help id="status" />
            </TableHead>
            <TableHead>
              Prediction range <Help id="range" />
            </TableHead>
            <TableHead className="text-right">
              Capital in <span className="font-normal text-unit tracking-unit text-muted-text">USD</span> <Help id="capitalIn" />
            </TableHead>
            <TableHead className="text-right">
              Capital out <span className="font-normal text-unit tracking-unit text-muted-text">USD</span> <Help id="capitalOut" />
            </TableHead>
            <TableHead className="text-right">
              Net P&L <span className="font-normal text-unit tracking-unit text-muted-text">USD</span>{' '}
              <Help id="net" />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
            {page.map((op) => {
              const isOpen = expanded === op.operationId;

              return [
                <TableRowButton
                  key={op.operationId}
                  onClick={() => setExpanded(isOpen ? null : op.operationId)}
                >
                  <TableCell className="w-5.5 text-center">
                    <RowToggle
                      open={isOpen}
                      controls={`detail-${op.operationId}`}
                      label={`${isOpen ? 'Collapse' : 'Expand'} operation ${shortOperation(op.operationId)}`}
                      onToggle={() => setExpanded(isOpen ? null : op.operationId)}
                    />
                  </TableCell>
                  <TableCell>
                    {op.position?.openedAt ? shortDate(op.position.openedAt) : '—'}
                  </TableCell>
                  <TableCell>
                    {op.position?.closedAt ? shortDate(op.position.closedAt) : '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={op.status}>{statusLabel(op.status)}</Badge>
                  </TableCell>
                  <TableCell>
                    {op.position ? priceRange(op.position.rangeLower, op.position.rangeUpper) : '—'}
                  </TableCell>
                  {/* Unknown must not collapse into the em dash that means
                      zero, so a null says so in words. */}
                  <TableCell className="text-right">
                    <Money value={op.capitalInUsd} unit="bare" sign="none" unknown={<Unknown />} />
                  </TableCell>
                  {/* Capital in plus the net result, so the pair reads as the
                      cycle: what went out, and what came back. Absent for two
                      unrelated reasons, and the cell says which. */}
                  <TableCell className="text-right">
                    <Money
                      value={op.capitalOutUsd}
                      unit="bare"
                      sign="none"
                      unknown={<Unknown>{capitalOutMissing(op.status)}</Unknown>}
                    />
                  </TableCell>
                  {/* Net is shown ONLY when it is really a result. An open
                      position's −$998 is capital at work, and an unfunded
                      record's +$10 is principal coming back. */}
                  <TableCell className="text-right">
                    {op.netIsPnl ? (
                      <Money value={op.netUsd} unit="bare" tone="auto" />
                    ) : (
                      <Unknown>
                        <Dash says="not a result" />
                      </Unknown>
                    )}
                  </TableCell>
                </TableRowButton>,
                isOpen && (
                  <TableRow
                    key={`${op.operationId}-detail`}
                    id={`detail-${op.operationId}`}
                    /* No `bg-surface-1`: the old rule painted this row
                       `--surface-1` and the Panel it sits in is already that
                       colour, so the declaration has been invisible since
                       `04-card`. Deleted rather than carried, because an
                       invisible declaration is how `.hero*` and
                       `.episode-facts` survived for months. A later unit that
                       changes the panel's surface adds it back with a
                       visible reason. */
                    className="[&>td]:p-0"
                  >
                    <TableCell colSpan={8}>
                      <div className="px-3.5 pt-5.5 pb-6.5">
                        {/* Keyed by operation, so collapsing a row and opening
                            another starts on Summary rather than inheriting
                            whichever tab the last one was left on. */}
                        <OperationDetail
                          key={op.operationId}
                          op={op}
                          benchmark={benchmarks?.get(op.operationId)}
                          mark={marks?.get(op.operationId)}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ),
              ];
            })}
          {page.length === 0 && (
            <TableRow>
              <TableCell colSpan={8}>
                <NothingHere everHad={operations.length > 0} subject="operations" />
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <Pager total={shown.length} unit="operations" paging={paging} />
    </Panel>
  );
}

/**
 * What an expanded row shows: Summary first, Transactions behind a tab.
 *
 * REPLACES A "View detail" BUTTON. That button was a second thing to find
 * after the row had already been clicked, and the summary -- the only part
 * that answers "did this work" -- was the half hidden behind it while the raw
 * journal showed unasked. Clicking the row now opens the answer, and the
 * journal is one tab away.
 *
 * shadcn's Tabs over Radix rather than two buttons and a `useState`, because
 * the part that is easy to get wrong by hand is the keyboard: arrow keys to
 * move between tabs, Home/End to jump, roving tabindex so Tab leaves the strip
 * instead of walking it, and the `aria-controls`/`aria-labelledby` pair that
 * makes a screen reader announce the panel. Radix brings all of that; the
 * styling is this dashboard's own tokens via `app.css`.
 */
function OperationDetail({
  op,
  benchmark,
  mark,
}: {
  op: LedgerOperation;
  benchmark?: Benchmark;
  mark?: Mark;
}) {
  return (
    <Tabs defaultValue="summary" className="gap-0">
      <TabsList variant="line" className="mb-2.5 gap-4 p-0">
        <TabsTrigger value="summary" className="px-0 text-[13.5px]">
          Summary
        </TabsTrigger>
        <TabsTrigger value="transactions" className="px-0 text-[13.5px]">
          Transactions
          <span className="text-muted-text tabular-nums">{op.transactions.length}</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="summary">
        <Summary op={op} benchmark={benchmark} mark={mark} />
      </TabsContent>
      <TabsContent value="transactions">
        <Journal transactions={op.transactions} />
      </TabsContent>
    </Tabs>
  );
}

/**
 * One operation, read top to bottom: what happened, why, then the facts.
 *
 * THE RESULT IS EXPLAINED BEFORE IT IS COMPARED. Three figures add up to the
 * headline exactly --
 *
 *     lpPnlUsd === hodlPnlUsd + impermanentLossUsd + feesAndCostsUsd
 *
 * -- and the panel leads with that sum. The version this replaced showed only
 * the last two, which make up `strategyUsd` and NOT the headline, so an
 * operator reading -$128.48 next to -$51.19 and +$11.04 could not see where
 * the rest of the loss came from. The missing piece is the market moving the
 * deposited basket, and naming it as a line removes the need for a separate
 * "If simply held" benchmark that nobody could parse.
 *
 * EVERY DRAWER ENDS IN A SUBTRACTION THE READER CAN DO. Both values being
 * differenced are on screen, so the bottom line is checkable rather than
 * asserted. Drawers hold numbers only: prose in a drawer and colour inside one
 * were both tried and both read as noise, since the colour is already on the
 * row that was clicked. The last line of a drawer repeats the ROW's label
 * rather than inventing a synonym.
 */
function Summary({
  op,
  benchmark,
  mark,
}: {
  op: LedgerOperation;
  benchmark?: Benchmark;
  mark?: Mark;
}) {
  const rentNet = op.rentLockedUsd + op.rentReturnedUsd;

  /*
   * Prices for display, derived from the SAME figures the arithmetic uses.
   *
   * NOT `op.prices`, which starts at the operation's FIRST transaction -- the
   * funding swap -- while `costBasisUsd` and `hodlValueUsd` use the
   * `create_lp` row. Measured gap on one cycle: $112.37 against $112.53, which
   * is enough that recomputing the market move from the displayed price lands
   * $2.50 away from the booked figure, in a panel whose whole job is to be
   * checkable. `deposited[].openPriceUsd` IS the create_lp price, and the
   * close price falls out of `hodlValueUsd` by construction.
   */
  const sol = benchmark?.deposited.find((t) => t.token === 'SOL');
  const otherUsd = benchmark
    ? benchmark.deposited.reduce((t, d) => (d.token === 'SOL' ? t : t + d.amount), 0)
    : 0;
  const openPrice = sol?.openPriceUsd ?? null;
  const closePrice =
    sol && sol.amount > 0 && benchmark?.hodlValueUsd != null
      ? (benchmark.hodlValueUsd - otherUsd) / sol.amount
      : null;

  return (
    <Surface>
      {benchmark && (
        <Band title="Net P&L">
          {/* One figure at a size nothing else competes with, because it is
              the only one that answers what happened to the money. The note
              under it carries the context that makes the figure legible:
              -$128 on $3,495 over 4.8h is a different story from the same
              -$128 on $994 over five days. */}
          <div className="flex flex-col gap-0.75 px-4 pt-0.75 pb-3.5">
            <span className="text-6xl font-figure">
              <Money value={benchmark.lpPnlUsd} tone="auto" />
            </span>
            <span className="text-base text-muted-text">
              {op.capitalInUsd !== null && (
                <>
                  on <Money value={op.capitalInUsd} sign="none" /> ·{' '}
                </>
              )}
              {op.durationHours !== null && <>{duration(op.durationHours)} · </>}
              {/* Was an inline template that rendered the EMPTY STRING when
                  capital-in was null or zero, silently dropping the clause --
                  the exact failure `format.ts` was written to prevent, in the
                  one place its helpers were not used. */}
              <Pct
                value={op.capitalInUsd ? (benchmark.lpPnlUsd / op.capitalInUsd) * 100 : null}
                unit="percent"
              />
            </span>
          </div>

          <Disclosure
            label="Market move"
            help="marketMove"
            value={
              benchmark.hodlPnlUsd === null ? null : (
                <Money value={benchmark.hodlPnlUsd} tone="auto" />
              )
            }
          >
            {benchmark.hodlPnlUsd === null ? (
              <Rows rows={[['Benchmark', benchmark.hodlUnknownReason ?? 'unknown']]} />
            ) : (
              <Rows
                rows={[
                  ['You deposited', depositLine(benchmark)],
                  [priceLine('Worth at open', openPrice), <Money value={benchmark.costBasisUsd} sign="none" />],
                  [priceLine('Worth at close', closePrice), <Money value={benchmark.hodlValueUsd} sign="none" />],
                  'rule',
                  ['Market move', <Money value={benchmark.hodlPnlUsd} />, true],
                ]}
              />
            )}
          </Disclosure>

          <Disclosure
            label="Impermanent loss"
            help="impermanentLoss"
            value={
              benchmark.impermanentLossUsd === null ? null : (
                <>
                  <Money value={benchmark.impermanentLossUsd} tone="bad" />
                  {/* The detector, said out loud. Holding is worth at least as
                      much as the pool's version of it at every price, so a plus
                      here means these rows do not describe one position -- and
                      then every figure above it is wrong too. Colour alone
                      cannot carry that. */}
                  {benchmark.impermanentLossUsd > 0 && (
                    <span className="text-muted-text"> · rows disagree</span>
                  )}
                </>
              )
            }
          >
            {benchmark.impermanentLossUsd === null || benchmark.hodlValueUsd === null ? (
              <Rows rows={[['Benchmark', benchmark.hodlUnknownReason ?? 'unknown']]} />
            ) : (
              <Rows
                rows={[
                  [
                    'Tokens that came back',
                    <Money value={benchmark.principalChangeUsd + benchmark.costBasisUsd} sign="none" />,
                  ],
                  ['Tokens you put in', <Money value={benchmark.hodlValueUsd} sign="none" />],
                  [priceLine('both priced at', closePrice), ''],
                  'rule',
                  ['Impermanent loss', <Money value={benchmark.impermanentLossUsd} />, true],
                ]}
              />
            )}
          </Disclosure>

          <Disclosure
            label="Fees, after costs"
            help="feesAndCosts"
            value={
              <Money value={benchmark.feesAndCostsUsd} tone="auto" />
            }
          >
            <Rows
              rows={[
                [
                  'Fees earned',
                  <Money value={op.feesEarnedUsd} unknown="not booked until the close" />,
                ],
                ['Network fees and slippage', <Money value={op.feesPaidUsd} />],
                [
                  `Rent — ${usd(Math.abs(op.rentLockedUsd))} locked, ${usd(op.rentReturnedUsd)} back`,
                  <Money value={rentNet} />,
                ],
                /* By SUBTRACTION, and it has to be shown or the column visibly
                   fails to add up. It is the funding swap's two `principal`
                   legs failing to cancel -- the gap between the price recorded
                   on the row and what the router actually filled at. Measured
                   +$2.09 on one cycle and +$0.01 on another, so it is neither
                   small nor reliably signed. */
                [
                  'Funding swap',
                  <Money
                    value={
                      benchmark.feesAndCostsUsd -
                      ((op.feesEarnedUsd ?? 0) + op.feesPaidUsd + rentNet)
                    }
                  />,
                ],
                'rule',
                ['Fees, after costs', <Money value={benchmark.feesAndCostsUsd} />, true],
              ]}
            />
          </Disclosure>

          {/* Not a button and no caret: it is the sum of the three above it,
              not a fourth thing to open. */}
          {/* STAYS A BORDER, not a `Separator`. The heaviness belongs to
              this row -- it marks the row as the sum of the three above it --
              and a separator is a sibling node with no relationship to the
              row it qualifies. It is also darker rather than thicker, which
              `Separator` could not express either way: it is `h-px`. */}
          <div className="flex items-baseline gap-3 border-t border-border-strong px-4 pt-2.25 pb-3.25 text-xl">
            <span className="flex-1 pl-5.25 font-semibold">Net P&amp;L</span>
            <span className="font-semibold tabular-nums">
              <Money value={benchmark.lpPnlUsd} tone="auto" />
            </span>
          </div>
        </Band>
      )}

      {benchmark && (
        <Band title="Compared with">
          <Disclosure
            label="Holding all SOL"
            help="vsAllSol"
            first
            value={
              benchmark.allSolPnlUsd == null ? null : (
                /* The sign is in the WORD, so the figure beside it is unsigned
                   -- `lost by -$3.34` would state the direction twice and the
                   two statements could disagree. The colour still derives from
                   the gap, which is why the tone sits on the whole clause. */
                <span className={benchmark.lpPnlUsd - benchmark.allSolPnlUsd >= 0 ? 'text-good' : 'text-bad'}>
                  LP strategy {benchmark.lpPnlUsd - benchmark.allSolPnlUsd >= 0 ? 'won' : 'lost'} by{' '}
                  <Money value={Math.abs(benchmark.lpPnlUsd - benchmark.allSolPnlUsd)} sign="none" />
                </span>
              )
            }
          >
            {benchmark.allSolPnlUsd == null ? (
              <Rows rows={[['Benchmark', benchmark.allSolUnknownReason ?? 'unknown']]} />
            ) : (
              <Rows
                rows={[
                  [
                    priceLine('All of it in SOL at', openPrice),
                    <Money value={benchmark.allSolPnlUsd} />,
                  ],
                  ['LP strategy', <Money value={benchmark.lpPnlUsd} />],
                  'rule',
                  [
                    `LP strategy ${benchmark.lpPnlUsd - benchmark.allSolPnlUsd >= 0 ? 'won' : 'lost'} by`,
                    <Money value={Math.abs(benchmark.lpPnlUsd - benchmark.allSolPnlUsd)} sign="none" />,
                    true,
                  ],
                ]}
              />
            )}
          </Disclosure>
        </Band>
      )}

      {/* A position that has not settled gets a MARK, not a verdict. No result
          and no comparison: those are what an operation RETURNED, and this one
          has returned nothing yet. What is here is MEASURED -- the amounts the
          chain reported at the time stamped on the row, never a composition
          inferred from the stored range, which is what the bot ASKED for and
          not what Raydium's tick snapping gave it. */}
      {!benchmark && mark && (
        <Band title="So far">
          <FactGrid>
            <Fact
              label="Impermanent loss, so far"
              help="impermanentLossOpen"
              value={
                <Money
                  value={mark.impermanentLossUsd}
                  tone="bad"
                  unknown={<Unknown>{mark.unknownReason ?? 'unknown'}</Unknown>}
                />
              }
            />
            <Fact
              label="Fees collected so far"
              help="feesSoFar"
              value={
                <Money
                  value={mark.feesSoFarUsd}
                  tone="good"
                  unknown={<Unknown>unreadable at the last check</Unknown>}
                />
              }
            />
            <Fact
              label="As of"
              help="markedAt"
              value={
                mark.markedAt === null ? (
                  <span className="text-muted-text">never read</span>
                ) : (
                  <span className="text-muted-text">
                    {new Date(mark.markedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC
                    {mark.priceUsd !== null && ` · SOL ${price(mark.priceUsd)}`}
                  </span>
                )
              }
            />
          </FactGrid>
        </Band>
      )}

      <Band title="Operation">
        <FactGrid>
          {/* The create_lp price, so this agrees with every figure above. */}
          {openPrice !== null ? (
            <Fact
              label="SOL price"
              help="solPrice"
              value={
                /*
                 * `unknown`, NOT "still open", and the branch below is where
                 * "still open" belongs. `openPrice` is non-null only when a
                 * BENCHMARK exists, and a benchmark exists only for a SETTLED
                 * operation -- so a null `closePrice` here cannot mean the
                 * position is running. It means `hodlValueUsd` was null, i.e.
                 * no close price could be found for the volatile leg. Saying
                 * "still open" about a closed operation is the same mistake as
                 * an unknown printed as a zero: a confident wrong answer where
                 * the honest one was available. `price(null)` is already the
                 * word, so the ternary this replaces was doing nothing else.
                 */
                `${price(openPrice)} → ${price(closePrice)}`
              }
            />
          ) : (
            op.prices.map((track) => (
              <Fact
                key={track.token}
                label={`${track.token} price`}
                help="solPrice"
                value={
                  track.closeUsd === null
                    ? `${price(track.openUsd)} → still open`
                    : `${price(track.openUsd)} → ${price(track.closeUsd)}`
                }
              />
            ))
          )}
          <Fact
            label="Capital in"
            help="capitalIn"
            value={<Money value={op.capitalInUsd} sign="none" unknown={<Unknown />} />}
          />
          <Fact
            label="Capital out"
            help="capitalOut"
            value={
              <Money
                value={op.capitalOutUsd}
                sign="none"
                unknown={<Unknown>{capitalOutMissing(op.status)}</Unknown>}
              />
            }
          />
          {op.durationHours !== null && (
            <Fact label="Held for" help="heldFor" value={duration(op.durationHours)} />
          )}
          <Fact
            label="Operation ID"
            help="operationId"
            value={<code className="font-mono text-base text-secondary-text">{op.operationId}</code>}
          />
        </FactGrid>
      </Band>
    </Surface>
  );
}

/** "15.3645 SOL + $1,766.19" — what actually went in, in tokens. */
function depositLine(benchmark: Benchmark): string {
  return benchmark.deposited
    .map((d) => (d.token === 'SOL' ? `${d.amount.toFixed(4)} SOL` : usd(d.amount)))
    .join(' + ');
}

/** A drawer label that carries the price the figure beside it was computed at. */
function priceLine(label: string, p: number | null): React.ReactNode {
  return p === null ? label : (
    <>
      {label} <span className="text-muted-text">SOL {price(p)}</span>
    </>
  );
}

/**
 * A row that opens in place.
 *
 * Collapsed, the label is at most three words and the value carries the whole
 * answer -- opening it should CONFIRM what the row already said, never be the
 * only way to learn it.
 */
function Disclosure({
  label,
  help,
  value,
  first,
  children,
}: {
  label: string;
  help: string;
  value: React.ReactNode;
  first?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/*
        `all: unset` is DELETED, not translated. Its comment said the right
        thing -- "this is a <button> for the keyboard and the screen reader,
        and none of the browser's button chrome belongs on a table row" --
        and that intent is exactly a ghost button with explicit layout. The
        declaration itself cannot come along: `all: unset` on a component
        whose styling is utility classes would wipe every one of them.

        The focus ring stays INSET. A row is flush with the panel's edge, so
        the default outward ring would be clipped by the card it sits in.
      */}
      <Button
        variant="ghost"
        /*
         * A NAMED group, and the name is load-bearing. The caret turns on the
         * button's own `aria-expanded` rather than on a second piece of state
         * that could disagree with it -- but `<Help>` is rendered INSIDE this
         * button and is itself a `group` with `group-aria-expanded:` rules for
         * its own popover. An unnamed group here is the nearest ancestor for
         * those too, so every help dot inside an OPEN drawer drew itself in
         * its pinned colours. Caught by the drawers capture, which is only a
         * real capture at all as of this unit.
         */
        className={`group/disclosure flex h-auto w-full items-baseline justify-start gap-3 rounded-none text-left border-t border-border px-4 py-2.25 text-xl font-normal hover:bg-surface-0 focus-visible:ring-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-series-lp ${first ? 'border-t-0' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span
          className="shrink-0 grow-0 basis-[9px] text-2xs leading-[1.7] text-muted-text transition-transform duration-[140ms] group-aria-expanded/disclosure:rotate-90"
          aria-hidden="true"
        >
          ▶
        </span>
        <span className="flex-1 text-secondary-text">
          {label}
          <Help id={help} />
        </span>
        <span className="font-semibold tabular-nums">{value ?? <Unknown />}</span>
      </Button>
      {/* Drawers are NUMBERS ONLY -- no prose, no colour. The colour is on the
          row that was clicked; repeating it inside makes a second thing to
          decode. Every drawer ends in a subtraction whose two operands are
          both on screen. */}
      {open && <div className="pt-px pr-4 pb-3.25 pl-9.25">{children}</div>}
    </>
  );
}

/** The total line at the foot of a drawer: the only row that carries weight. */
const STRONG = 'font-semibold text-primary-text';

/**
 * The inside of a drawer: numbers only, no colour.
 *
 * The colour is already on the row that was clicked, and repeating it here
 * just makes a second thing to decode. `'rule'` draws the line above a total.
 */
function Rows({ rows }: { rows: Array<'rule' | [React.ReactNode, React.ReactNode, boolean?]> }) {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-x-5 gap-y-1.5 text-md text-secondary-text">
      {rows.map((r, i) =>
        r === 'rule' ? (
          <Separator key={i} className="col-span-2 my-0.5" />
        ) : (
          <Fragment key={i}>
            <div className={r[2] ? STRONG : undefined}>{r[0]}</div>
            <div className={`text-right tabular-nums ${r[2] ? STRONG : ''}`}>{r[1]}</div>
          </Fragment>
        )
      )}
    </div>
  );
}

function Journal({ transactions }: { transactions: LedgerTransaction[] }) {
  return (
    <Surface>
      <Table level="nested" aria-label="Transactions in this operation">
        <TableHeader>
          <TableRow>
            <TableHead aria-label="expand" className="w-5.5" />
            <TableHead>Date</TableHead>
            <TableHead>Time (UTC)</TableHead>
            <TableHead>Transaction</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead className="text-right">
              Debit <span className="font-normal text-unit tracking-unit text-muted-text">USD</span> <Help id="debit" />
            </TableHead>
            <TableHead className="text-right">
              Credit <span className="font-normal text-unit tracking-unit text-muted-text">USD</span> <Help id="credit" />
            </TableHead>
            <TableHead className="text-right">
              Balance <span className="font-normal text-unit tracking-unit text-muted-text">USD</span> <Help id="balance" />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {transactions.map((tx) => (
            <JournalRow key={tx.txId} tx={tx} />
          ))}
        </TableBody>
      </Table>
    </Surface>
  );
}

function JournalRow({ tx }: { tx: LedgerTransaction }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <TableRowButton onClick={() => setOpen((wasOpen) => !wasOpen)}>
        <TableCell className="w-5.5 text-center">
          <RowToggle
            open={open}
            controls={`movements-${tx.txId}`}
            label={`${open ? 'Collapse' : 'Expand'} transaction ${shortTx(tx.txId)}`}
            onToggle={() => setOpen((wasOpen) => !wasOpen)}
          />
        </TableCell>
        <TableCell className="font-mono text-base text-secondary-text">{utcDate(tx.at)}</TableCell>
        <TableCell className="font-mono text-base text-secondary-text">{utcTime(tx.at)}</TableCell>
        {/* The raw action stays in the title so the page is still auditable
            against the ledger where a friendlier word is displayed. */}
        <TableCell className="font-semibold leading-stacked" title={tx.action}>
          {actionLabel(tx.action)}
          <span className="block text-xs font-normal text-muted-text">
            {tx.protocol} · {tx.movements.length} movements
          </span>
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
        <TableCell className="text-right">
          <Money value={tx.balanceUsd} unit="bare" tone="auto" />
        </TableCell>
      </TableRowButton>

      {open && (
        <TableRow id={`movements-${tx.txId}`} className="[&>td]:pt-3.5 [&>td]:pr-0 [&>td]:pb-4 [&>td]:pl-8.5">
          <TableCell colSpan={8}>
            <Movements tx={tx} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
