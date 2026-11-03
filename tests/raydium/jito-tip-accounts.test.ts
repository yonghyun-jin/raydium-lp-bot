/**
 * The tip accounts must be the REAL ones, and a typo here is invisible.
 *
 * A bundle must write-lock one of Jito's tip accounts to enter the auction, and
 * `pickTipAccount` draws at RANDOM. One corrupted entry therefore fails roughly
 * one rung in eight -- intermittently, independently of the tip SIZE, and with
 * siblings succeeding in the same window. It reads as losing the auction.
 *
 * That is exactly what happened: `HFqU5x63VTqvQss8hp11i4bVpkNgmnfxWYYMHpMYEJdV`
 * instead of `HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe`. The first 22
 * characters match, both are valid base58 so `new PublicKey` never threw, and
 * the address does not exist on chain. Code review cannot catch this class of
 * error, so it is pinned here instead.
 *
 * The network check against `getTipAccounts` lives in the live suite; this one
 * runs everywhere and makes any edit to the list deliberate.
 */

import { PublicKey } from '@solana/web3.js';

import { JITO_TIP_ACCOUNTS } from '../../src/raydium/jito';

/** Verified against the block engine's own getTipAccounts on 2026-10-12. */
const AUTHORITATIVE = [
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
];

describe('the Jito tip accounts', () => {
  it('matches the authoritative set exactly', () => {
    expect([...JITO_TIP_ACCOUNTS].sort()).toEqual([...AUTHORITATIVE].sort());
  });

  it('does not contain the corrupted address that cost one rung in eight', () => {
    expect(JITO_TIP_ACCOUNTS).not.toContain(
      'HFqU5x63VTqvQss8hp11i4bVpkNgmnfxWYYMHpMYEJdV'
    );
  });

  it('is all distinct -- a duplicate silently biases the random draw', () => {
    expect(new Set(JITO_TIP_ACCOUNTS).size).toBe(JITO_TIP_ACCOUNTS.length);
  });

  it('every entry parses as a PublicKey, which is NOT sufficient', () => {
    // Stated as a test so nobody adds this check and believes it is a guard:
    // the corrupted address passed it. Only the exact-set assertion above
    // catches a typo.
    for (const a of JITO_TIP_ACCOUNTS) {
      expect(() => new PublicKey(a)).not.toThrow();
    }
  });
});
