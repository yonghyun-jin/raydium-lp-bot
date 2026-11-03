/**
 * The dashboard says WHICH failure it was, not one sentence for all of them.
 *
 * The page printed "Could not read the ledger." for every way `/api/pnl` can
 * fail -- a database that refused, a dev proxy with nothing behind it, an
 * expired password, a request that never completed -- and the cause was left to
 * a detail line built from `r.statusText`, which is the empty string over
 * HTTP/2. In production, the one transport where it matters, the operator got a
 * heading blaming the database and a blank line under it.
 *
 * The honest discriminator is not the cause: a browser is deliberately not told
 * whether a request failed to DNS, a refused connection, CORS or being offline.
 * It is whether a response arrived and what status it carried. These assertions
 * pin that, and nothing finer.
 *
 * Mutation-verified three ways, each reintroducing one half of the original
 * bug -- a constant heading, `statusText` in place of `status`, and dropping
 * the detail-present test on a gateway status. Each turns this suite red.
 */

import { httpFailure, transportFailure } from '../../dashboard/web/src/lib/failure';

const PRISMA =
  "Invalid `prisma.position.findMany()` invocation: Can't reach database server at " +
  '`altaria.proxy.rlwy.net:40644`';

describe('a response that arrived', () => {
  it('blames the ledger only when the API itself explained the failure', () => {
    const failure = httpFailure('the ledger', 503, { error: 'x', detail: PRISMA });

    expect(failure.heading).toBe('Could not read the ledger.');
    expect(failure.detail).toContain(PRISMA);
  });

  it('blames the API, not the ledger, when a gateway answered with nothing', () => {
    // Vite's proxy with no server behind it, and Railway's edge with the
    // service down, both answer this way: a gateway status, empty body. The
    // database was never asked, so a ledger heading here is a false statement.
    expect(httpFailure('the ledger', 502, null).heading).toBe('Could not reach the dashboard API.');
    expect(httpFailure('the ledger', 504, null).heading).toBe('Could not reach the dashboard API.');
  });

  it('separates those two by the detail, not by the status', () => {
    // 503 is BOTH the API's own refusal and an edge's "service is down", so
    // reading the status alone cannot tell them apart.
    expect(httpFailure('the ledger', 503, { detail: PRISMA }).heading).toBe(
      'Could not read the ledger.'
    );
    expect(httpFailure('the ledger', 503, null).heading).toBe('Could not reach the dashboard API.');
  });

  it('names authorisation when that is what was refused', () => {
    // auth.ts replies in plain text, so the body does not parse and arrives
    // here as null -- the status is the only thing that says what happened.
    expect(httpFailure('the ledger', 401, null).heading).toBe(
      'Not authorised to read the ledger.'
    );
    expect(httpFailure('the ledger', 403, null).heading).toBe(
      'Not authorised to read the ledger.'
    );
  });

  it('always carries the status, because statusText is empty over HTTP/2', () => {
    for (const status of [401, 500, 502, 503]) {
      expect(httpFailure('the ledger', status, null).detail).toContain(String(status));
    }
  });

  it('says a detail was missing rather than printing a blank line', () => {
    for (const body of [null, {}, { detail: '' }, { detail: '   ' }, 'not an object']) {
      expect(httpFailure('the ledger', 500, body).detail).toBe('500 · the response carried no detail');
    }
  });

  it('keeps the status on the same line as the detail it belongs to', () => {
    // Prisma's message opens with a newline and the panel renders the detail
    // `pre-wrap`, so an untrimmed value strands "503 ·" on a line of its own.
    expect(httpFailure('the ledger', 503, { detail: `\n${PRISMA}\n` }).detail).toBe(
      `503 · ${PRISMA}`
    );
  });

  it("falls back to the server's own heading field before giving up on a detail", () => {
    expect(httpFailure('the ledger', 503, { error: 'Could not read the ledger.' }).detail).toBe(
      '503 · Could not read the ledger.'
    );
  });

  it('names what was being read, so the two endpoints cannot share a heading', () => {
    expect(httpFailure('the predictions', 503, { detail: PRISMA }).heading).toBe(
      'Could not read the predictions.'
    );
  });
});

describe('no response that could be used', () => {
  it('claims only that nothing answered', () => {
    const failure = transportFailure('/api/pnl', new TypeError('Failed to fetch'));

    expect(failure.heading).toBe('Could not reach the dashboard API.');
    expect(failure.detail).toContain('no HTTP response from /api/pnl');
    // The browser's own words are the evidence and are kept verbatim.
    expect(failure.detail).toContain('Failed to fetch');
  });

  it('distinguishes something answering with the wrong thing entirely', () => {
    // A 200 holding index.html: the request reached the SPA catch-all, not the
    // API. Reported as unreachable, because the API is what was not reached.
    const failure = transportFailure(
      '/api/pnl',
      new SyntaxError("Unexpected token '<', \"<!doctype \"... is not valid JSON")
    );

    expect(failure.heading).toBe('Could not reach the dashboard API.');
    expect(failure.detail).toContain('is not JSON');
    expect(failure.detail).not.toContain('no HTTP response');
  });

  it('survives something that is not an Error at all', () => {
    expect(transportFailure('/api/pnl', 'dropped').detail).toContain('dropped');
  });
});
