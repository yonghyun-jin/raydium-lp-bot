// Orchestrator tunables and their defaults.

export interface OrchestratorConfig {
  checkInterval: number;     // ms (default 30 seconds)
  minSolReserve: number;     // SOL reserve for gas
  usePrediction: boolean;    // Use the fixed v0 range (default true)
  defaultWidthPct: number;   // Fallback width if prediction fails
  failureLimitPerDay: number; // Max rebalances per day before asking user (default 3)
  /**
   * How many times to try getting stranded funds back into a position.
   *
   * Deliberately SEPARATE from failureLimitPerDay: that cap fails closed after
   * three failed rebalances, and sharing it would make the churn guard block
   * recovering the money too.
   */
  recoveryAttemptLimit: number;
  /**
   * Allow a position to be created from the symmetric fallback range when the
   * model is unavailable. Off by default: a silent fallback once hid a broken
   * predictor for five days and 19 failed transactions.
   */
  allowFallback: boolean;
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  checkInterval: 30000,
  minSolReserve: 0.05,
  usePrediction: true,
  defaultWidthPct: 10,
  failureLimitPerDay: 3,
  recoveryAttemptLimit: 6,
  allowFallback: false,
};
