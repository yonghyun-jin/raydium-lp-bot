// The ladder's learned starting tip, persisted.
//
// A SEPARATE FILE so jito.ts stays free of the recording layer: the send path
// should not know whether the number it was handed came from Postgres, and the
// in-memory default there must remain usable on its own. Writes go through
// src/recording (never src/db directly) -- that facade loads Prisma lazily, is a
// no-op without DATABASE_URL or inside a test process, and never throws.

import { TipMemory } from './jito';
import { nextStart } from './tipLadder';
import { JITO } from './config';
import { getLearnedTipLamports, recordLearnedTipLamports } from '../recording';

const toLamports = (sol: number) => Math.max(1, Math.floor(sol * 1e9));

/**
 * Tip memory backed by bot_states.last_tip_lamports.
 *
 * Read once and cached: the ladder asks on every send, and a database round trip
 * in front of a money operation buys nothing here -- this process is the only
 * writer, so the cache cannot go stale behind us.
 *
 * A failed read is a COLD START, not an error. That falls back to the configured
 * floor, which already bids an order of magnitude above the median tip, so the
 * degradation is "not yet cheap" rather than "cannot land".
 */
export class DurableTipMemory implements TipMemory {
  private cached: number | null = null;
  private loaded = false;

  async startLamports(): Promise<number | null> {
    if (!this.loaded) {
      this.cached = await getLearnedTipLamports();
      this.loaded = true;
      if (this.cached !== null) {
        console.log(`[Jito] Resuming tip ladder from a learned ${this.cached} lamports`);
      }
    }
    return this.cached;
  }

  async record(outcome: {
    winningLamports?: number;
    highestTriedLamports?: number;
  }): Promise<void> {
    const next = nextStart({
      floorLamports: toLamports(JITO.TIP_SOL_FLOOR),
      ceilingLamports: toLamports(JITO.TIP_SOL_MAX),
      winningLamports: outcome.winningLamports,
      // Reported for the record, not to raise the estimate: `nextStart` resets a
      // failed climb to the floor on purpose. The cached fallback used to make a
      // failure CARRY FORWARD, which is how `last_tip_lamports` reached the
      // ceiling and stayed there -- see the note in ./tipLadder.
      highestTriedLamports: outcome.highestTriedLamports ?? this.cached ?? undefined,
    });

    this.cached = next;
    this.loaded = true;
    await recordLearnedTipLamports(next);
  }
}
