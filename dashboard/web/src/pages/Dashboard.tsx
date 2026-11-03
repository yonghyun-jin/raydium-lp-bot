/**
 * What the bot has made, and what it cost to make it.
 *
 * MOVED OUT OF `App.tsx`, WHICH IS WHAT `10-page-dashboard` SAID IT HAD DONE
 * and had not: it was still 147 lines at the bottom of the shell, which is how
 * a shell ends up owning a page's arithmetic. `App.tsx` is now routing and
 * fetching only.
 *
 * It takes the whole `PnlResponse` rather than pre-computed totals, because
 * filtering here RECOMPUTES the totals and the line rather than slicing them
 * -- see the note on `completed`. That is the thing to be careful of when
 * touching this file: these figures are not the shell's and must not become
 * the shell's.
 */

import { DateFilter, inRange, isFiltered, type DateRange } from '@/components/Filters';
import { Dash, Money, Pct, Unknown } from '@/components/Money';
import { KpiTile } from '@/components/KpiTile';
import { NoData } from '@/components/Feedback';
import { Panel } from '@/components/Surface';
import { PageHead } from '@/components/PageHead';
import { PnlChart } from '@/components/PnlChart';
import { shortDate } from '@/lib/format';
import type { PnlResponse } from '@/lib/types';
import { buildSeries, buildTotals } from '../../../../src/pnl';

/**
 * Who won, in words.
 *
 * "percentage points" and not "%": the gap between two percentages is pp, and
 * writing % there invites the reader to divide by something.
 */
function verdict(against: string, lp?: number | null, other?: number | null): string {
  if (lp === null || lp === undefined || other === null || other === undefined) {
    return `vs. ${against}: unknown`;
  }
  const d = lp - other;
  return `vs. ${against}: LP strategy ${d >= 0 ? 'won' : 'lost'} by ${Math.abs(d).toFixed(2)} pp`;
}

export function Dashboard({
  data,
  range,
  onRangeChange,
}: {
  data: PnlResponse;
  range: DateRange;
  onRangeChange: (range: DateRange) => void;
}) {
  const { ledger } = data;

  /*
   * Filtering here RECOMPUTES the totals and the line; it does not slice them.
   *
   * The series is cumulative, so dropping its leading points would leave a line
   * that starts partway up the axis at a number nothing on screen explains.
   * `buildTotals` and `buildSeries` are the same functions the server used, so
   * a filtered figure cannot drift from the unfiltered one -- which is the
   * whole reason the completed operations are on the wire at all.
   */
  const completed = data.completed
    .filter((op) => inRange(op.closedAt, range))
    .map((op) => ({ ...op, openedAt: new Date(op.openedAt), closedAt: new Date(op.closedAt) }));

  const totals = buildTotals(completed);
  const series = buildSeries(completed);
  const lastPoint = series.length ? series[series.length - 1] : null;

  const operations = ledger.filter((op) =>
    op.transactions.some((tx) => inRange(tx.at, range))
  );

  const feesEarned = operations.reduce((total, op) => total + (op.feesEarnedUsd ?? 0), 0);
  const feesPaid = operations.reduce((total, op) => total + op.feesPaidUsd, 0);
  const rentNet = operations.reduce(
    (total, op) => total + op.rentLockedUsd + op.rentReturnedUsd,
    0
  );

  return (
    <>
      <PageHead
        title="Dashboard"
        note="What the bot has made, and what it cost to make it."
        meta={
          totals.firstOpenedAt
            ? `${shortDate(totals.firstOpenedAt)} – ${shortDate(totals.lastClosedAt!)}${
                isFiltered(range) ? ' · filtered' : ''
              }`
            : 'nothing settled yet'
        }
      />

      <DateFilter range={range} onChange={onRangeChange} />

      {/* Two scopes, stated rather than blended. P&L can only come from
          operations whose capital came back; fees and rent are money that has
          already left the wallet, including on the position still running. */}
      <div className="mb-7 grid grid-cols-[repeat(auto-fit,minmax(var(--tile-col-min),1fr))] gap-3">
        {/* A sum over no operations is arithmetically 0 and reads as "the bot
            broke even", which is a different and wrong statement. With nothing
            settled in scope the tile says so instead. */}
        <KpiTile
          label="Net P&L"
          value={
            totals.completedOperations === 0 ? (
              <Unknown>
                <Dash says="no settled operations" />
              </Unknown>
            ) : (
              <Money value={totals.lpPnlUsd} tone="auto" />
            )
          }
          note={
            totals.completedOperations === 0
              ? 'no settled operations in this range'
              : `settled operations only · ${totals.completedOperations}`
          }
        />
        <KpiTile
          label="Fees earned"
          value={<Money value={feesEarned} tone="good" />}
          note="booked so far, every operation"
        />
        <KpiTile
          label="Fees paid"
          value={<Money value={feesPaid} tone="bad" />}
          note="every operation"
        />
        <KpiTile
          label="Rent, net"
          value={<Money value={rentNet} tone="auto" />}
          note="every operation, incl. still locked"
        />
      </div>

      <section className="mb-8">
        {/* `font-bold` is the browser's 700, stated before preflight removes it.
            See the note on `PageHead`'s `<h1>`. */}
        <h2 className="m-0 mb-1 text-3xl font-bold tracking-display">Against simply holding</h2>
        <p className="m-0 mb-3.5 max-w-note text-lg text-secondary-text">
          Each strategy's cumulative return, compounded cycle by cycle. Only the hours a position
          was actually live count — the gaps between cycles move no line. Returns, not dollars, so
          a change in deposit size cannot move the chart on its own. The grey dotted
          line is the basket the bot itself deposited: beating <strong>all SOL</strong> while only
          matching that one means the gap came from holding half stablecoin, not from the pool.
          Settled operations only.
        </p>
        <Panel>
          <div className="flex flex-wrap gap-5 px-1 pb-3.5">
            <span className="flex items-center gap-2 text-lg text-secondary-text">
              <span className="size-2.5 shrink-0 rounded-xs bg-series-lp" /> My LP strategy{' '}
              <strong>
                <Pct value={lastPoint?.lpReturnPct} unit="percent" />
              </strong>
            </span>
            <span className="flex items-center gap-2 text-lg text-secondary-text">
              <span className="size-2.5 shrink-0 rounded-xs bg-series-hodl" /> Holding all SOL{' '}
              <strong>
                <Pct value={lastPoint?.allSolReturnPct} unit="percent" />
              </strong>
            </span>
            <span className="flex items-center gap-2 text-lg text-secondary-text">
              <span className="size-2.5 shrink-0 rounded-xs bg-series-mix" /> Holding what I
              deposited <strong>
                <Pct value={lastPoint?.mixReturnPct} unit="percent" />
              </strong>
            </span>
          </div>
          {/* The verdict in words. A reader should not have to subtract two
              index levels to learn who won, and "points" rather than "%"
              because these are levels off a $100 base, not a rate. */}
          <p className="mt-0.5 mr-0 mb-2.5 ml-0 max-w-note text-lg text-secondary-text">
            {verdict('Holding all SOL', lastPoint?.lpReturnPct, lastPoint?.allSolReturnPct)}
            {' · '}
            {verdict('Holding what I deposited', lastPoint?.lpReturnPct, lastPoint?.mixReturnPct)}
          </p>
          {series.length > 1 ? (
            <PnlChart series={series} />
          ) : (
            <NoData>Nothing to plot yet — a line needs at least one settled operation.</NoData>
          )}
        </Panel>
      </section>
    </>
  );
}
