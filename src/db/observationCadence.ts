// When to append a row to `position_observations`, and why that row exists.

/**
 * The cadence decision, kept pure and kept out of the Prisma layer.
 *
 * `position_observations` is the series that makes TIME IN RANGE measurable,
 * and until this existed it had no writer at all -- which blocked three
 * separate questions: how long a position actually earns, how often price
 * reverts into a range it left, and therefore how far a hold-instead-of-close
 * policy may let the price run before giving up.
 *
 * Two kinds of row, and the distinction is the whole design:
 *
 *   `transition`  the tick where the position crossed in or out of range. These
 *                 are what time-in-range is computed FROM, so they must never
 *                 be missed and must never be invented.
 *   `heartbeat`   a sample while nothing crossed. This is the fee curve, where
 *                 coarse resolution is fine.
 *
 * Writing every tick would be ~1M rows a year per position and would not answer
 * anything the transitions do not already answer.
 */
export type ObservationDecision =
  | { write: false; reason: 'no-change' | 'value-unknown' }
  | { write: true; reason: 'transition' | 'heartbeat' };

export function decideObservation(input: {
  /**
   * `positions.last_in_range` as stored BEFORE this reading.
   *
   * Null means nobody has looked at this position yet. That is a BASELINE, not
   * a crossing -- reporting it as a transition would put a range change in the
   * series that never happened.
   */
  storedInRange: boolean | null;
  inRange: boolean;
  /**
   * Null or undefined SKIPS the row. `value_usd` is NOT NULL in the schema and
   * a 0 would read as a worthless position in the one series a fee curve is
   * computed from -- the same lie as a zeroed fee figure.
   */
  valueUsd: number | null | undefined;
  /** Whether the caller's heartbeat interval has elapsed. */
  heartbeat: boolean | undefined;
}): ObservationDecision {
  const { storedInRange, inRange, valueUsd, heartbeat } = input;

  if (valueUsd === null || valueUsd === undefined || !Number.isFinite(valueUsd)) {
    return { write: false, reason: 'value-unknown' };
  }

  // A real crossing. Checked before the heartbeat so a transition that happens
  // to land on a heartbeat tick is still labelled a transition.
  if (storedInRange !== null && storedInRange !== inRange) {
    return { write: true, reason: 'transition' };
  }

  // First sight of this position: establish where the series starts.
  if (storedInRange === null) {
    return { write: true, reason: 'heartbeat' };
  }

  if (heartbeat === true) return { write: true, reason: 'heartbeat' };

  return { write: false, reason: 'no-change' };
}
