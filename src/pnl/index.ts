/**
 * P&L reporting.
 *
 * Pure arithmetic over ledger rows: no database client, no HTTP, no
 * dependencies at all. `dashboard/` supplies the rows and renders the result;
 * a Telegram command could do the same without touching this file.
 */

export { buildReport, buildSeries, buildTotals } from './report';
export { buildLedger, kindOf } from './ledger';
export { decomposeOperations, sumOperation } from './operations';
export { buildUnrealised } from './unrealised';
export type {
  DepositedToken,
  ExcludedOperation,
  ExclusionReason,
  OperationPnL,
  PnlReport,
  PnlRow,
  PnlTotals,
  SeriesPoint,
  UnrealisedPnL,
  LedgerOperation,
  LedgerTransaction,
  Movement,
  MovementKind,
  OperationStatus,
  PositionContext,
  PriceTrack,
  QuoteSummary,
  ReportOptions,
} from './types';
