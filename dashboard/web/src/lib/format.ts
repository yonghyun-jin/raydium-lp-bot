/**
 * Rendering numbers that might not exist.
 *
 * Null is a real answer everywhere in this project and it has to survive all
 * the way to the screen. `usd(null)` is "unknown", never "$0.00" -- a zero
 * would claim the bot broke even when what actually happened is that nobody
 * knows.
 */

export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Same, but always carries an explicit + so a gain reads as one. */
export function signedUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  return `${value > 0 ? '+' : ''}${usd(value)}`;
}

/*
 * Percentages, and the two units that are not the same unit.
 *
 * These replace four hand-rolled implementations that no two of which agreed:
 * one rendered zero as `0.00%` and the others as `+0.00%`, two skipped the
 * finite check, and the fourth -- inline in a template literal -- rendered the
 * EMPTY STRING when it had nothing, which is the one outcome this whole file
 * exists to prevent. The surviving convention is the one the live code paths
 * already shared: an explicit sign at zero, and `unknown` for an absence.
 */

/** A return. `+2.91%`, `-0.00%`, and zero is a gain like everywhere else. */
export function percent(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  return `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(decimals)}%`;
}

/**
 * A gap BETWEEN two percentages, which is percentage points and never `%`.
 * Writing `%` there invites the reader to divide it by something.
 */
export function points(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  return `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(decimals)} pp`;
}

export function shortDate(iso: string | Date): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function dateTime(iso: string | Date): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function duration(hours: number): string {
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours - days * 24);
  return rest ? `${days}d ${rest}h` : `${days}d`;
}

/** A token amount, at the precision the chain actually moved. */
export function tokenAmount(value: number): string {
  const sign = value < 0 ? '-' : '+';
  const abs = Math.abs(value);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return `${sign}${abs.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/**
 * A price, which never needs a sign.
 *
 * `unknown`, not an em dash. This figure stands ALONE -- in a sentence, a fact
 * grid or a range -- where there is no column to lend the dash its meaning,
 * and "nothing" and "nobody knows" are different answers about money. The
 * column form is `priceEntry` below and it keeps the dash.
 */
export function price(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function range(lower: number, upper: number): string {
  return `${price(lower)}–${price(upper)}`;
}

/** `op_1700000011000_94d730b0` -> `…0000abcd`, the part that distinguishes it. */
export function shortOperation(operationId: string): string {
  const tail = operationId.split('_').pop() ?? operationId;
  return tail === operationId ? operationId : `…${tail}`;
}

export function shortTx(txId: string): string {
  return txId.length > 16 ? `${txId.slice(0, 8)}…${txId.slice(-6)}` : txId;
}

/**
 * Why an operation has no capital-out figure.
 *
 * Two different facts, and printing one where the other is true is a lie about
 * money: an OPEN position's capital is sitting in the pool and has not come
 * back yet, while an adopted one's return has no cost basis to be measured
 * against and genuinely cannot be computed. Never an em dash -- in a money
 * column that reads as "nothing came back", which is a settled figure.
 */
export function capitalOutMissing(status: string): string {
  return status === 'open' ? 'still deployed' : 'unknown';
}

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  closed: 'Closed',
  /* "No OPENING record", not "No open record". In a Status column whose
     first value is literally `Open`, the word reads as the state rather than
     as the missing event, and one letter removes the collision. */
  incomplete: 'No opening record',
  'set-aside': 'Test run',
};

/**
 * A status, in words.
 *
 * A LOOKUP WITH A FALLBACK, the way `movementLabel()` and `actionLabel()`
 * already work -- and here it is load-bearing rather than tidy. The map is
 * `Record<string, string>` and this tsconfig does not set
 * `noUncheckedIndexedAccess`, so an unmapped status typechecked as a `string`
 * while being `undefined` at runtime: an outlined pill with NOTHING IN IT.
 * `styles.css` stated the rule the whole time -- "Status carries a word,
 * never colour alone" -- and an empty pill is colour alone.
 */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/*
 * Timestamps are rendered in UTC, from the ISO string's own parts.
 *
 * NOT `toLocaleString` with a timeZone option: the whole point is that a row
 * here can be matched against Solscan character for character, and a locale
 * formatter silently applies the viewer's calendar as well as their clock. The
 * $1,000 position opened at 06:35:38 UTC on 09/22 and reads 23:35 on 09/21 in
 * this operator's timezone -- a different DAY, which is exactly the confusion
 * this avoids.
 */

/** "09/22/2026" */
export function utcDate(iso: string | Date): string {
  const [y, m, d] = new Date(iso).toISOString().slice(0, 10).split('-');
  return `${m}/${d}/${y}`;
}

/** "06:35:38" */
export function utcTime(iso: string | Date): string {
  return new Date(iso).toISOString().slice(11, 19);
}

/*
 * Money inside a COLUMN is bare; money standing alone carries its symbol.
 *
 * A `$` repeated down forty rows is forty copies of one fact, and it pushes the
 * digits out of alignment the moment one figure is four characters longer than
 * its neighbour. The unit belongs in the header -- `Debit (USD)` -- said once,
 * for every row beneath it. `usd()` and `price()` above are for figures that
 * appear OUTSIDE a money column (tiles, summary facts, the range), where there
 * is no header to carry the unit and the symbol has to travel with the number.
 *
 * Every formatter here is fixed at two decimals so the decimal points line up
 * and a column can be read as a column rather than as a list.
 */

/**
 * A debit or credit figure: bare, positive, two decimals, em dash for nothing.
 *
 * No sign. The COLUMN says which way the money went, so a sign here would state
 * the same fact twice — and two statements of one fact can disagree, which is
 * worse than one.
 */
export function entry(value: number): string {
  if (!value) return '—';
  return Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * A running balance: bare, but signed, because its direction is the answer and
 * no column heading can carry it.
 */
export function balance(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** A price inside a money column: bare, two decimals, em dash for unknown. */
export function priceEntry(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
