/**
 * Which failure it was, in the only terms the browser can stand behind.
 *
 * The page used to print one heading -- "Could not read the ledger." -- for
 * every way `/api/pnl` can fail, with the cause left to a detail line that
 * degrades to nothing. So an unreachable API, an expired password and a
 * database that genuinely refused all read as the same sentence, and they have
 * three different fixes. A heading that names a cause the page has not
 * established is the same mistake as a figure defaulted to zero.
 *
 * What the browser actually knows is narrow, and it is enough: whether an HTTP
 * response arrived, and what status it carried. It is NOT told why a request
 * failed to complete -- DNS, a refused connection, being offline and CORS are
 * one indistinguishable `TypeError` by design -- so nothing here guesses
 * between them. "Nothing answered" is the whole claim, and it is true.
 *
 * Deliberately NOT in `App.tsx`: the root Jest suite has no JSX in its
 * tsconfig, so a decision worth guarding has to live in a plain `.ts` module.
 */

export interface Failure {
  /** What the operator is told failed. */
  heading: string;
  /** The evidence, verbatim where the wire carried any. */
  detail: string;
}

/** Said when the wire carried no explanation of its own. */
const NO_DETAIL = 'the response carried no detail';

/**
 * A response arrived and it was not ok.
 *
 * `status` is used rather than `statusText`, which is the empty string over
 * HTTP/2 -- the transport Railway serves to browsers -- and would have left
 * the detail line blank in production, the one place it matters most.
 *
 * The API's own failures always carry a `detail` (`server/index.ts`), so a
 * gateway status WITHOUT one is something in front of the API answering: a dev
 * proxy with nothing behind it, or an edge whose service is down. Saying "could
 * not read the ledger" there blames a database that was never asked.
 */
export function httpFailure(subject: string, status: number, body: unknown): Failure {
  const detail = readDetail(body);
  const gateway = status === 502 || status === 503 || status === 504;

  const heading =
    status === 401 || status === 403
      ? `Not authorised to read ${subject}.`
      : gateway && detail === null
        ? 'Could not reach the dashboard API.'
        : `Could not read ${subject}.`;

  return { heading, detail: `${status} · ${detail ?? NO_DETAIL}` };
}

/**
 * No usable response arrived.
 *
 * Two shapes, and the distinction is worth keeping. A `SyntaxError` means
 * something DID answer and it was not JSON -- which is what a request landing
 * on the SPA catch-all rather than the API looks like, i.e. a frontend talking
 * to the wrong port or an older server. Anything else means nothing answered at
 * all. Either way the API was not reached, so they share a heading and differ
 * in the evidence.
 */
export function transportFailure(endpoint: string, error: unknown): Failure {
  const because = error instanceof Error && error.message ? error.message : String(error);

  return {
    heading: 'Could not reach the dashboard API.',
    detail:
      error instanceof SyntaxError
        ? `${endpoint} answered with something that is not JSON — ${because}`
        : `no HTTP response from ${endpoint} — ${because}`,
  };
}

/**
 * `detail` is what the API sends; `error` is its heading field, which the page
 * supplies itself and so only reads as a fallback. Null means the wire said
 * nothing -- never an empty string, which would print as a blank line and look
 * like the detail had been dropped.
 */
function readDetail(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;

  const fields = body as { detail?: unknown; error?: unknown };
  for (const value of [fields.detail, fields.error]) {
    // Trimmed because Prisma's message opens with a newline, which would push
    // the status onto a line of its own above the sentence it belongs to.
    if (typeof value === 'string' && value.trim()) return value.trim();
  }

  return null;
}
