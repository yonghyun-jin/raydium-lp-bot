// Jito tip ladder: find the SMALLEST tip that lands, not a tip that always wins.
//
// WHY A LADDER AND NOT A PERCENTILE. Paying the 95th percentile every time lands
// reliably and overpays permanently. The tip that matters is the smallest one
// that clears the auction in the slots we happen to hit, and that number moves:
// measured minutes apart on the same day, the 95th percentile of landed tips ran
// 0.00039 SOL and then 0.0000349 SOL, a 10x swing. Any fixed choice is wrong
// most of the time.
//
// WHY THE RUNGS ARE CHEAP. A Jito bundle that is not selected costs NOTHING --
// no tip, no network fee, because none of its transactions execute. So climbing
// costs no money. What it costs is TIME, and time is what the caller is really
// budgeting: a stale quote eventually trips Jupiter's on-chain minimum-out check
// (6017), and an LP range keeps drifting while we bid.
//
// WHY FAILURE IS NOT EVIDENCE. Jito is a sealed-bid auction per slot. A rung can
// lose to the wrong leader, a leader not running Jito at all, or a burst of
// competition -- none of which mean the tip was too low. So a naive
// "increase until it works" ratchets upward forever: it only ever observes
// failures below wherever it stopped. The downward probe in nextStart is the
// counter-pressure that keeps the estimate honest.

export interface TipLadderConfig {
  /** First rung, in lamports. Learned from the last success where possible. */
  startLamports: number;
  /** Hard ceiling. No rung may exceed it. */
  ceilingLamports: number;
  /**
   * Multiplier between rungs. SMALL on purpose -- the point is to discover the
   * cheapest tip that clears, not to win at any price. 1.35 reaches ~4.5x over
   * five rungs, which spans the 50th-to-95th percentile gap without jumping it.
   */
  stepFactor: number;
  /** Rungs per blockhash window. */
  maxRungs: number;
}

export const DEFAULT_LADDER: Omit<TipLadderConfig, 'startLamports' | 'ceilingLamports'> = {
  stepFactor: 1.35,
  maxRungs: 5,
};

/**
 * The tip for one rung, in lamports. Monotonic, clamped, always >= 1.
 *
 * Clamped rather than terminated so a ladder whose ceiling is close to its start
 * still runs its rungs -- repeating the ceiling is a legitimate retry, since a
 * lost auction is not proof the bid was too small.
 */
export function tipForRung(config: TipLadderConfig, rung: number): number {
  const start = Math.max(1, Math.floor(config.startLamports));
  const ceiling = Math.max(start, Math.floor(config.ceilingLamports));
  const raw = start * Math.pow(config.stepFactor, Math.max(0, rung));
  return Math.max(1, Math.min(Math.floor(raw), ceiling));
}

/** The whole planned ladder, for logging and for tests. */
export function ladderTips(config: TipLadderConfig): number[] {
  return Array.from({ length: Math.max(1, config.maxRungs) }, (_, i) =>
    tipForRung(config, i)
  );
}

/**
 * Where the NEXT ladder should start, given what this one did.
 *
 * On a win, probe BELOW the winning tip. That is the whole mechanism for
 * converging on the smallest viable tip: without it, every success cements the
 * price paid and the estimate can only go up. `probeFactor` below 1 means a calm
 * market walks the tip down one rebalance at a time, and a tightening market
 * simply costs one extra rung to climb back.
 *
 * On an EXHAUSTED ladder, reset to the floor. This used to keep the highest rung
 * actually tried, so that the next send would not re-walk the same climb -- and
 * that is what pinned this bot's ladder shut on 2026-10-13. The climb ran out of
 * ROOM rather than losing on price, remembered the ceiling, and from then on
 * every rung of every send was clamped to the same number:
 *
 *   [Jito] Window 1/3: climbing from 6000000 lamports, ceiling 6000000
 *   [Jito] Rung 1: 6000000 ... Rung 5: 6000000
 *
 * Thirty bundles went out over two attempts at 25-87x the 99th percentile of
 * landed tips, all at one price, and none was included -- while the one mechanism
 * that could have shown the tip was never the constraint had been disabled by its
 * own optimisation. An exhausted climb is evidence about ROOM, not about PRICE,
 * so it must not cement the top rung.
 *
 * What the reset costs is re-walking the rungs, which costs TIME and not money:
 * an unselected bundle pays neither tip nor network fee. The floor
 * (`JITO_TIP_SOL`, 0.0001 SOL) already bids above the 99th percentile, so the
 * climb restarts above the market rather than blind from zero.
 */
export function nextStart(params: {
  floorLamports: number;
  ceilingLamports: number;
  /** The tip that landed, if one did. */
  winningLamports?: number;
  /**
   * The highest rung tried when nothing landed.
   *
   * Accepted but no longer RAISES the estimate -- see the note above. It stays in
   * the signature because the caller has it and a future policy may want it; the
   * one thing it must never do again is become the next start.
   */
  highestTriedLamports?: number;
  /** How far below a win to probe next time. */
  probeFactor?: number;
}): number {
  const floor = Math.max(1, Math.floor(params.floorLamports));
  const ceiling = Math.max(floor, Math.floor(params.ceilingLamports));
  const clamp = (n: number) => Math.max(floor, Math.min(Math.floor(n), ceiling));

  if (params.winningLamports !== undefined && params.winningLamports > 0) {
    const probe = params.probeFactor ?? 0.85;
    return clamp(params.winningLamports * probe);
  }

  return floor;
}
