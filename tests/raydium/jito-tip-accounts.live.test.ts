/**
 * The tip accounts, checked against Jito itself.
 *
 * The unit test pins the list so an edit is deliberate. This one is the only
 * thing that catches Jito ROTATING its accounts, which would silently take the
 * send path back to the intermittent "Bundles must write lock at least one tip
 * account" rejection that cost roughly one rung in eight.
 *
 * Live, because the authoritative answer is a network call. Never swallow a
 * failure here to keep it green -- a rate limit and a changed list must not
 * look the same.
 */

import { JITO_TIP_ACCOUNTS } from '../../src/raydium/jito';

const ENDPOINT = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';

describe('the tip accounts match the block engine', () => {
  it('equals getTipAccounts exactly', async () => {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }),
    });

    expect(res.ok).toBe(true);
    const body = (await res.json()) as { result?: string[] };
    const official = body.result;

    // A missing result is a broken probe, not a passing check.
    expect(Array.isArray(official)).toBe(true);
    expect(official!.length).toBeGreaterThan(0);

    expect([...JITO_TIP_ACCOUNTS].sort()).toEqual([...official!].sort());
  }, 30_000);
});
