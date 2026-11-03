/**
 * A ledger. What moved, when, what it cost, and what came back.
 *
 * Everything here is derived from rows written when money actually moved.
 * Anything that is not a row is either absent or labelled unknown — never
 * inferred, never defaulted to zero.
 *
 * Three pages behind a sidebar: the Dashboard is the verdict, Operations is
 * that verdict grouped by position, Transactions is the same money flat and in
 * time order.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { ALL_TIME, inRange, isFiltered, type DateRange } from '@/components/Filters';
import { Nav, ROUTES, type Route } from '@/components/Nav';
import { Footnote } from '@/components/Footnote';
import { Panel } from '@/components/Surface';
import { PageHead } from '@/components/PageHead';
import { Failed, Spinner, Waiting } from '@/components/Feedback';
import { Dashboard } from '@/pages/Dashboard';
import { Operations } from '@/pages/Operations';
import { Predictions } from '@/pages/Predictions';
import { Transactions } from '@/pages/Transactions';
import { useTheme, type Preference } from '@/lib/theme';
import { type Failure } from '@/lib/failure';
import { read } from '@/lib/read';
import type { PnlResponse, PredictionsResponse } from '@/lib/types';
import { wireList } from '@/lib/wire';
import { shortDate } from '@/lib/format';



/**
 * `#/operations/op_123` — the tab, and optionally the row it should open.
 *
 * The hash rather than a router: one dependency less, and the page it leaves in
 * the address bar is a real link an operator can paste into a message.
 */
function useHashRoute(): { route: Route; param: string | null; go: (to: string) => void } {
  /* Not `read`: the shell imports a `read` that fetches, and two functions of
     that name one scope apart is a trap waiting for whoever moves a line. */
  const fromHash = () => {
    const [tab, ...rest] = window.location.hash.replace(/^#\/?/, '').split('/');
    return {
      route: (ROUTES as readonly string[]).includes(tab) ? (tab as Route) : 'dashboard',
      param: rest.length ? decodeURIComponent(rest.join('/')) : null,
    };
  };

  const [at, setAt] = useState(fromHash);

  useEffect(() => {
    const onHash = () => setAt(fromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return { ...at, go: (to: string) => void (window.location.hash = `#/${to}`) };
}

export function App() {
  const { preference, cycle } = useTheme();
  const { route, param, go } = useHashRoute();
  // One range, shared by both tables: switching tabs with a range set and
  // finding it silently dropped is worse than either behaviour on its own.
  const [range, setRange] = useState<DateRange>(ALL_TIME);
  const [data, setData] = useState<PnlResponse | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [predictions, setPredictions] = useState<PredictionsResponse | null>(null);
  const [predictionError, setPredictionError] = useState<Failure | null>(null);

  useEffect(() => {
    void read<PnlResponse>('/api/pnl', 'the ledger').then((outcome) =>
      'data' in outcome ? setData(outcome.data) : setError(outcome.failure)
    );
  }, []);

  /* Loaded only when the page is asked for: it is the one endpoint that calls
     out of this service, and opening the ledger should not pay for it. */
  useEffect(() => {
    if (route !== 'predictions' || predictions || predictionError) return;

    void read<PredictionsResponse>('/api/predictions', 'the predictions').then((outcome) =>
      'data' in outcome ? setPredictions(outcome.data) : setPredictionError(outcome.failure)
    );
  }, [route, predictions, predictionError]);

  /*
   * COMPUTED BEFORE THE FETCH GATES, because the rail is now rendered on all
   * four screens rather than only the loaded one. Null is the honest count
   * while the ledger is unread -- and `Nav` renders no number for a null, so
   * an unknown count cannot print as a zero.
   */
  const counts: Record<Route, number | null> = {
    dashboard: null,
    operations: data ? data.ledger.length : null,
    transactions: data ? data.ledger.reduce((n, op) => n + op.transactions.length, 0) : null,
    predictions: predictions ? predictions.episodes.length : null,
  };

  const shell = { route, counts, preference, onCycleTheme: cycle };


  /*
   * BOTH FAILURE SCREENS KEEP THE RAIL, which they did not before: an operator
   * who hit a 502 lost navigation entirely and could not reach any other page,
   * including the one that still works.
   */
  if (error) {
    return (
      <Shell {...shell}>
        <Failed failure={error}>
          A status code means the API, or something in front of it, answered. “No HTTP response”
          means nothing answered — the browser is not told why, so nothing here guesses.
        </Failed>
      </Shell>
    );
  }

  if (!data) {
    return (
      <Shell {...shell}>
        <Waiting>Reading the ledger…</Waiting>
      </Shell>
    );
  }

  const { ledger } = data;
  const transactions = ledger.flatMap((op) => op.transactions);

  /*
   * Counted here as well as inside each table, so the line under the title and
   * the line under the rows cannot disagree. "4 transactions" over a pager
   * reading "1-2 of 2" is the sort of small contradiction that makes an
   * operator distrust every other number on the page.
   */
  const shownTransactions = transactions.filter((tx) => inRange(tx.at, range)).length;
  const shownOperations = ledger.filter((op) =>
    op.transactions.some((tx) => inRange(tx.at, range))
  ).length;
  const filtered = isFiltered(range);

  /*
   * The benchmark, per operation, keyed for the Summary card.
   *
   * It lives on `completed` rather than on the ledger operation because only a
   * settled cycle has one. Without it the only figure the table shows is Net,
   * and Net is dominated by the market: a cycle that returned +$37.30 while
   * simply holding would have returned +$67.53 reads as a win until the
   * strategy line is next to it.
   */
  const benchmarks = new Map(data.completed.map((op) => [op.operationId, op]));
  // Marks are kept in their OWN map and never merged with benchmarks: a
  // settled result and a moving quote must not become interchangeable by
  // sharing a lookup.
  //
  // `wireList` because the server may be older than this bundle -- see
  // wire.ts. Reading `.map()` straight off the response threw and took the
  // whole page down to white, which is worse than any missing figure.
  const marks = new Map(wireList(data.unrealised).map((m) => [m.operationId, m]));
  const filterNote = filtered ? ` · filtered ${range.from || '…'} – ${range.to || '…'}` : '';
  // The Transactions page spans every transaction, which is a WIDER window than
  // `totals.firstOpenedAt`/`lastClosedAt` -- those cover settled operations
  // only, and printing them here would date the page to before its own newest
  // row.
  const times = transactions.map((tx) => new Date(tx.at).getTime());

  return (
    <Shell {...shell}>
      {route === 'dashboard' && (
        <Dashboard data={data} range={range} onRangeChange={setRange} />
      )}

      {route === 'operations' && (
        <>
          <PageHead
            title="Operations"
            note="One row per operation. Expand it for the LP range, the SOL price at each end, the fee split, and every transaction that made it up. A date range keeps any operation that was active in it, whole — its balance only walks to its Net if none of its transactions are missing."
            meta={`${
              filtered ? `${shownOperations} of ${ledger.length}` : ledger.length
            } operations · ${
              ledger.filter((op) => op.status === 'open').length
            } open${filterNote}`}
          />
          <Operations
            operations={ledger}
            focusId={param}
            range={range}
            onRangeChange={setRange}
            benchmarks={benchmarks}
            marks={marks}
          />
        </>
      )}

      {route === 'predictions' && (
        <>
          <PageHead
            title="Predictions"
            note="One card per position: the range it was opened at, against what the price actually did. The shaded band is the range; the line is the hourly price, with its high and low behind it, because a range is broken by a touch and not by a close. Predictions the bot made and discarded are counted above, not drawn."
            meta={
              predictions ? (
                `${predictions.episodes.length} positions · ${predictions.unusedPredictions} predictions the bot made and did not use · price from ${predictions.priceSource}${filterNote}`
              ) : (
                /* The ring alone, where the counts will be. A word here
                   would be the second loading label on a screen whose
                   panel already says what is being waited for. */
                <Spinner small />
              )
            }
          />
          {predictionError ? (
            <Panel>
              <Failed failure={predictionError}>
                Nothing is drawn rather than a chart with no line in it, which would read as
                the price sitting still.
              </Failed>
            </Panel>
          ) : predictions ? (
            <Predictions
              data={predictions}
              range={range}
              onRangeChange={setRange}
              onOpenOperation={(operationId) => go(`operations/${operationId}`)}
            />
          ) : (
            <Panel>
              <Waiting>Fetching the price history…</Waiting>
            </Panel>
          )}
        </>
      )}

      {route === 'transactions' && (
        <>
          <PageHead
            title="Transactions"
            note="Every transaction across every operation, newest first. Expand one for the movements inside it; the operation column goes back to the position it belongs to."
            meta={`${
              filtered ? `${shownTransactions} of ${transactions.length}` : transactions.length
            } transactions${
              !filtered && times.length
                ? ` · ${shortDate(new Date(Math.min(...times)))} – ${shortDate(
                    new Date(Math.max(...times))
                  )}`
                : ''
            }${filterNote}`}
          />
          <Transactions
            operations={ledger}
            onOpenOperation={(operationId) => go(`operations/${operationId}`)}
            range={range}
            onRangeChange={setRange}
          />
        </>
      )}

      <Footnote />
    </Shell>
  );
}

/**
 * The rail, the main column and the page's measure -- once, for all four
 * screens that render them.
 *
 * It was inlined in the loaded branch only, which is why the error and loading
 * screens had no navigation at all. `children` rather than a `route` switch,
 * so the route table lives in one place.
 *
 * `<Footnote />` is deliberately NOT here. It says "Fees are booked once, at
 * the close" -- which is true of every ledger route, and was being rendered on screens with no fees on them at all.
 */
function Shell({
  route,
  counts,
  preference,
  onCycleTheme,
  children,
}: {
  route: Route;
  counts: Record<Route, number | null>;
  preference: Preference;
  onCycleTheme: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-start max-rail:block">
      <Nav
        route={route}
        counts={counts}
        preference={preference}
        onCycleTheme={onCycleTheme}
      />

      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-page px-6 pt-7.5 pb-24 max-rail:px-4 max-rail:pt-5.5 max-rail:pb-20">
          {children}
        </div>
      </main>
    </div>
  );
}

