/**
 * The wire shape.
 *
 * Derived from the server's real types rather than hand-copied, so a field
 * added to the report cannot silently fail to arrive here. JSON has no Date,
 * so every Date becomes a string on the way across -- which is exactly what
 * `Serialized` encodes.
 */

import type { PnlReport } from '../../../../src/pnl';
import type { Episode as ServerEpisode, PredictionsResponse as ServerPredictions } from '../../../server/predictions';

export type Serialized<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Serialized<U>[]
    : T extends object
      ? { [K in keyof T]: Serialized<T[K]> }
      : T;

export type PnlResponse = Serialized<PnlReport>;

export type LedgerOperation = PnlResponse['ledger'][number];
export type LedgerTransaction = LedgerOperation['transactions'][number];
export type Movement = LedgerTransaction['movements'][number];
export type WirePoint = PnlResponse['series'][number];

export type PredictionsResponse = Serialized<ServerPredictions>;
export type Episode = Serialized<ServerEpisode>;

/** One settled operation's result against holding the same basket. */
export type Benchmark = PnlResponse['completed'][number];

/** Where one STILL-OPEN operation stood at the monitor's last reading. */
export type Mark = PnlResponse['unrealised'][number];
