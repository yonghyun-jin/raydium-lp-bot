/**
 * Hourly SOL candles, from Binance.US.
 *
 * This is the ONE outbound call this service makes, and it is a deliberate
 * exception to "the dashboard only reads Postgres". The reason: what the price
 * actually did between a position's open and its close is not recorded
 * anywhere. `position_observations` exists in the schema and nothing writes to
 * it (scope C2), and the ledger holds two price points per closed position --
 * enough to draw a straight line that would LIE about the path.
 *
 * When C2 lands, observations become the source of truth for positions the bot
 * watched, and this stays as the only way to see a window the bot was not
 * running for.
 *
 * Binance.US rather than CoinGecko: no API key, and it returns high and low per
 * candle. A range model is judged on whether the price TOUCHED an edge, which a
 * series of closes cannot show.
 *
 * It fails loudly. A price path that cannot be fetched is reported as missing,
 * never silently replaced with the ledger's two points or with nothing --
 * either would read as "the price sat still".
 */

import type { Candle } from '../../src/predictions';

const ENDPOINT = 'https://api.binance.us/api/v3/klines';
/** USDT, not USDC: it is the deeper book, and the two differ by basis points. */
const SYMBOL = 'SOLUSDT';
const INTERVAL = '1h';
const HOUR = 3_600_000;
/** Binance's own cap per call. */
const MAX_CANDLES = 1000;
/** A runaway window must not turn into an unbounded number of calls. */
const MAX_PAGES = 6;

/*
 * Caching, and why it is shaped this way.
 *
 * It is NOT about cost. This endpoint needs no key and no account, a klines
 * call weighs 2 against a 6000-per-minute IP budget, and the page makes one
 * call however many episodes it draws -- measured, not assumed. You would need
 * roughly 3,000 page loads a minute to be rate limited, and there is no bill at
 * any volume.
 *
 * It is about two other things:
 *
 *  - An hour that has CLOSED can never change. Re-deriving it on every render
 *    is pure waste, so a window that has already ended is cached with no expiry
 *    at all -- the snapshot is the answer, permanently.
 *  - Only the window that is still running needs refreshing, because its last
 *    candle is still forming. That one, and only that one, carries a TTL.
 *
 * What this does NOT survive is a process restart, and that is a deliberate
 * stopping point: making it survive means writing to Postgres, and this service
 * has no write path of any kind by decision. A restart costs one request of
 * weight 2. Revisit only if the page needs to keep working while Binance is
 * down, which is a different requirement from this one.
 */

/** Closed hours, by their open time. Immutable, so never evicted by age. */
const settled = new Map<number, Candle>();

/**
 * The still-forming tail: the current hour and the one before it.
 *
 * Held separately from `settled` because it is the only part that can change,
 * and it must still be CACHED -- treating unsettled hours as permanently
 * missing made every call refetch, which is the bug a request count caught and
 * a correctness test never would.
 */
const LIVE_TTL_MS = 5 * 60_000;
let liveTail: Candle[] = [];
let liveFetchedAt = 0;

function parse(raw: unknown[]): Candle {
  return {
    t: Number(raw[0]),
    open: Number(raw[1]),
    high: Number(raw[2]),
    low: Number(raw[3]),
    close: Number(raw[4]),
  };
}

function sorted(from: number, to: number): Candle[] {
  return [...settled.values()]
    .filter((c) => c.t >= from && c.t <= to)
    .sort((a, b) => a.t - b.t);
}

async function fetchRange(from: number, to: number): Promise<Candle[]> {
  const fetched: Candle[] = [];
  let cursor = from;

  for (let page = 0; page < MAX_PAGES && cursor <= to; page++) {
    const url =
      `${ENDPOINT}?symbol=${SYMBOL}&interval=${INTERVAL}` +
      `&startTime=${cursor}&endTime=${to}&limit=${MAX_CANDLES}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Binance.US returned ${response.status} for ${SYMBOL} ${INTERVAL} candles.`
      );
    }

    const body = (await response.json()) as unknown[][];
    if (!Array.isArray(body)) throw new Error('Binance.US returned a body that is not a list.');
    if (body.length === 0) break;

    const page_ = body.map(parse);
    fetched.push(...page_);

    const last = page_[page_.length - 1].t;
    // No forward progress means another page would repeat this one forever.
    if (last < cursor) break;
    cursor = last + HOUR;
  }

  return fetched;
}

/**
 * Every hourly candle in [from, to].
 *
 * Fetches only the hours it does not already hold, so a page that has drawn
 * once costs nothing to draw again, and a new position adds only its own hours.
 */
export async function loadCandles(from: number, to: number, now = Date.now()): Promise<Candle[]> {
  const start = Math.floor(from / HOUR) * HOUR;
  const end = Math.min(Math.floor(to / HOUR) * HOUR, Math.floor(now / HOUR) * HOUR);
  if (end < start) return [];

  // The hour in progress, and the one before it, are not settled yet.
  const settledBefore = Math.floor(now / HOUR) * HOUR - HOUR;

  // Only SETTLED hours can be missing. An unsettled hour is never stored, so
  // counting it here would make every call a cache miss forever.
  let missingFrom = Number.POSITIVE_INFINITY;
  for (let t = start; t <= Math.min(end, settledBefore); t += HOUR) {
    if (!settled.has(t)) {
      missingFrom = t;
      break;
    }
  }

  const wantsLive = end > settledBefore;
  const liveStale = now - liveFetchedAt > LIVE_TTL_MS;
  const needsFetch = missingFrom !== Number.POSITIVE_INFINITY || (wantsLive && liveStale);

  if (needsFetch) {
    const fetchFrom = Math.min(missingFrom, wantsLive ? Math.max(start, settledBefore) : Infinity);
    const fresh = await fetchRange(fetchFrom, end);

    const tail: Candle[] = [];
    for (const candle of fresh) {
      if (candle.t <= settledBefore) settled.set(candle.t, candle);
      else tail.push(candle);
    }

    if (wantsLive) {
      liveTail = tail;
      liveFetchedAt = now;
    }
  }

  const live = liveTail.filter((c) => c.t >= start && c.t <= end);
  return [...sorted(start, Math.min(end, settledBefore)), ...live].sort((a, b) => a.t - b.t);
}
