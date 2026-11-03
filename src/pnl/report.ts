/**
 * Completed operations -> the two cumulative lines, the totals and the costs.
 *
 * The chart answers one question and it is the question this project was
 * rebuilt to answer: am I better off than if I had done nothing? Two series,
 * both cumulative USD against their own per-operation cost bases, so a change
 * in how much capital is deployed steps BOTH lines together and the gap between
 * them stays honest.
 */

import { buildLedger } from './ledger';
import { decomposeOperations } from './operations';
import { buildUnrealised } from './unrealised';
import type {
  OperationPnL,
  PnlReport,
  PnlRow,
  PnlTotals,
  ReportOptions,
  SeriesPoint,
} from './types';

export function buildReport(rows: PnlRow[], options: ReportOptions = {}): PnlReport {
  const { completed } = decomposeOperations(rows, options);

  return {
    // The chart and the benchmark read completed cycles only -- a cumulative
    // line cannot include an operation whose capital has not come back yet.
    series: buildSeries(completed),
    totals: buildTotals(completed),
    // The inputs to the two above, so a reader can recompute them for a subset
    // instead of slicing a cumulative line.
    completed,
    // The ledger reads EVERYTHING. Status is a column there, not a filter,
    // which is why there is no separate list of what was left out.
    ledger: buildLedger(rows, options),
    // A MARK on what is still running, from the monitor's last reading.
    // Deliberately computed after and read by none of the above.
    unrealised: buildUnrealised(rows, options.positions),
  };
}

/**
 * Cumulative USD, one point per completed cycle plus an origin at zero.
 *
 * Once any operation's HODL value is unknown the cumulative HODL goes null and
 * STAYS null. A total with a hole in it is not a smaller number, it is an
 * unknown one, and carrying on from the last known value would draw a line that
 * silently understates the benchmark.
 */
export function buildSeries(completed: OperationPnL[]): SeriesPoint[] {
  if (completed.length === 0) return [];

  const origin = completed.reduce(
    (earliest, op) => (op.openedAt < earliest ? op.openedAt : earliest),
    completed[0].openedAt
  );

  const points: SeriesPoint[] = [
    {
      t: origin.toISOString(),
      operationId: null,
      lpCumUsd: 0,
      hodlCumUsd: 0,
      lpReturnPct: 0,
      allSolReturnPct: 0,
      mixReturnPct: 0,
    },
  ];

  let lpCum = 0;
  let hodlCum: number | null = 0;
  // Carried as a GROWTH FACTOR (1.0 = break-even) because that is what
  // compounds; published as percent because that is what reads.
  let lp = 1;
  let allSol: number | null = 1;
  let mix: number | null = 1;

  for (const op of completed) {
    lpCum += op.lpPnlUsd;
    hodlCum = hodlCum === null || op.hodlPnlUsd === null ? null : hodlCum + op.hodlPnlUsd;

    lp = compound(lp, op.lpPnlUsd, op.costBasisUsd) ?? lp;
    allSol = compound(allSol, op.allSolPnlUsd, op.costBasisUsd);
    mix = compound(mix, op.hodlPnlUsd, op.costBasisUsd);

    points.push({
      t: op.closedAt.toISOString(),
      operationId: op.operationId,
      lpCumUsd: lpCum,
      hodlCumUsd: hodlCum,
      lpReturnPct: pct(lp)!,
      allSolReturnPct: pct(allSol),
      mixReturnPct: pct(mix),
    });
  }

  return points;
}

/** A growth factor as a percentage return. 1.04 -> +4. */
function pct(factor: number | null): number | null {
  return factor === null ? null : (factor - 1) * 100;
}

/**
 * One cycle's return, compounded onto a running growth factor.
 *
 * Returns null -- and null then propagates forever, because `factor` is already
 * null on the next call -- when the cycle's P&L is unknown, or when the cost
 * basis is not a positive number to divide by. A zero basis is not "no return",
 * it is an operation whose size nobody can establish, and dividing by it would
 * put Infinity or NaN on a chart axis.
 */
function compound(factor: number | null, pnlUsd: number | null, costBasisUsd: number): number | null {
  if (factor === null || pnlUsd === null) return null;
  if (!(costBasisUsd > 0)) return null;
  return factor * (1 + pnlUsd / costBasisUsd);
}

export function buildTotals(completed: OperationPnL[]): PnlTotals {
  const lpPnlUsd = completed.reduce((total, op) => total + op.lpPnlUsd, 0);
  const costBasisUsd = completed.reduce((total, op) => total + op.costBasisUsd, 0);

  // One unknown makes the total unknown. Treating it as zero would report a
  // benchmark the data does not support, and the gap to it is the headline.
  const anyHodlUnknown = completed.some((op) => op.hodlPnlUsd === null);
  const hodlPnlUsd = anyHodlUnknown
    ? null
    : completed.reduce((total, op) => total + (op.hodlPnlUsd ?? 0), 0);

  // Same fail-closed rule, separately: the all-SOL benchmark can be unknown
  // for an operation whose basket benchmark is fine (a cycle with no SOL leg),
  // so one null must not take the other down with it.
  const anyAllSolUnknown = completed.some((op) => op.allSolPnlUsd === null);
  const allSolPnlUsd = anyAllSolUnknown
    ? null
    : completed.reduce((total, op) => total + (op.allSolPnlUsd ?? 0), 0);

  return {
    completedOperations: completed.length,
    lpPnlUsd,
    hodlPnlUsd,
    strategyUsd: hodlPnlUsd === null ? null : lpPnlUsd - hodlPnlUsd,
    allSolPnlUsd,
    vsAllSolUsd: allSolPnlUsd === null ? null : lpPnlUsd - allSolPnlUsd,
    costBasisUsd,
    firstOpenedAt: completed.length ? completed[0].openedAt : null,
    lastClosedAt: completed.length ? completed[completed.length - 1].closedAt : null,
  };
}

