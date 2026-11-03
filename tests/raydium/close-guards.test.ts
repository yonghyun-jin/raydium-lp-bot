/**
 * The close path must never burn a position NFT on an unconfirmed withdrawal.
 *
 * WHY: `closePosition` waited 45s for `decreaseLiquidity` to confirm and, on
 * timeout, did `decreaseResult = { txId: txIdArray[0] }` -- inventing a success
 * from a signature that had only been SUBMITTED. That satisfied the caller's
 * `if (!decreaseResult.txId) throw` and fell straight through to burning the
 * NFT, which destroys the position account.
 *
 * It is the same `txId != success` bug the create path was already fixed for,
 * and it survived on the close path where the consequence is worse: the create
 * path wastes a fee, this one destroys the account holding the money.
 *
 * The rule both guards encode: a signature proves SUBMISSION, and the absence
 * of a confirmation proves NOTHING -- a send that missed its window may still
 * land. Only the position account on chain settles it.
 */

import BN from 'bn.js';
import * as fs from 'fs';
import * as path from 'path';
import { withdrawalLanded, assertSafeToBurn } from '../../src/raydium/closeGuards';

const MINT = '9RXMvuKfSN7QfBk83SsAgyrjLiqoyh6ozkU51Vgy61ot';

describe('withdrawalLanded', () => {
  it('accepts a withdrawal whose transactions all confirmed', () => {
    expect(withdrawalLanded(true, new BN(0))).toBe(true);
    // Confirmed is confirmed; the chain read is not even consulted.
    expect(withdrawalLanded(true, null)).toBe(true);
  });

  it('accepts an UNCONFIRMED withdrawal only when the chain says the position is empty', () => {
    // Landed late -- the wait window expired but the transaction did land.
    expect(withdrawalLanded(false, new BN(0))).toBe(true);
  });

  it('refuses an unconfirmed withdrawal while liquidity is still on chain', () => {
    // THE BUG: this case used to return the first txId and be treated as done.
    expect(withdrawalLanded(false, new BN('526385595'))).toBe(false);
  });

  it('refuses when the position cannot be found and nothing was confirmed', () => {
    // Unreadable is not empty.
    expect(withdrawalLanded(false, null)).toBe(false);
  });
});

describe('assertSafeToBurn', () => {
  it('allows the burn when the position is verifiably empty', () => {
    expect(() => assertSafeToBurn(MINT, new BN(0))).not.toThrow();
  });

  it('refuses to burn a position that still holds liquidity', () => {
    expect(() => assertSafeToBurn(MINT, new BN('526385595'))).toThrow(
      /still holds liquidity 526385595/
    );
  });

  it('refuses to burn when the position state could not be read', () => {
    // "I could not check" must never read as "there is nothing left".
    expect(() => assertSafeToBurn(MINT, null)).toThrow(/cannot be verified/);
  });

  it('names the position in every refusal, so the operator can go look', () => {
    for (const liquidity of [null, new BN(1)]) {
      expect(() => assertSafeToBurn(MINT, liquidity)).toThrow(new RegExp(MINT));
    }
  });
});

describe('the close path wiring', () => {
  const raw = fs.readFileSync(
    path.join(__dirname, '../../src/raydium/client.ts'),
    'utf8'
  );

  /**
   * Comments stripped before matching.
   *
   * The first version of this test grepped the raw file and matched its OWN
   * explanatory comments -- the ones quoting the removed line to say it was
   * removed -- and reported the bug as still present. A guard that reads prose
   * is measuring the wrong thing.
   */
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');

  it('gates the NFT burn on a fresh chain read', () => {
    const guard = src.indexOf('assertSafeToBurn(nftMint');
    const burn = src.indexOf('this.raydium.clmm.closePosition({');
    expect(guard).toBeGreaterThan(-1);
    expect(burn).toBeGreaterThan(-1);
    // The guard must come BEFORE the burn, not merely exist somewhere.
    expect(guard).toBeLessThan(burn);
  });

  it('no longer invents a result from an unconfirmed signature', () => {
    // The old line, verbatim, with its telling comment.
    expect(src).not.toContain('// Try the first txId anyway');
    // Every assignment of the first txId must be inside a branch that
    // established the withdrawal actually landed.
    const fabrications = src.match(/decreaseResult = \{ txId: txIdArray\[0\] \}/g) ?? [];
    expect(fabrications.length).toBe(2); // allConfirmed, and withdrawalLanded
    expect(src).toContain('withdrawalLanded(false, liquidity)');
  });

  it('confirms EVERY transaction the SDK execute path returned', () => {
    // The SDK can split decreaseLiquidity across more than one transaction, and
    // the old loop stopped at the first confirmation -- calling a partial
    // withdrawal a complete one.
    expect(src).toContain('let allConfirmed = true;');
  });

  it('has no path that accepts an unconfirmed txId after the check rejects it', () => {
    // This one nearly shipped: `if (!decreaseResult && executeResult?.txId)`
    // ran two branches after the confirmation check deliberately withheld
    // decreaseResult, and put the invented success straight back for the
    // single-transaction case -- i.e. the normal one. The fix above was inert
    // until this was removed.
    expect(src).not.toMatch(/if \(!decreaseResult && executeResult\?\.txId\) \{/);
    const assignments = src.match(/decreaseResult = \{ txId: executeResult\.txId \}/g) ?? [];
    expect(assignments.length).toBe(0);
  });
});

/**
 * The NFT burn: confirmed over http, and idempotent across retries.
 *
 * Two defects found by auditing the close path, both verified against the
 * installed SDK rather than inferred:
 *
 * 1. The burn was the ONLY step confirmed with `sendAndConfirm: true`. The
 *    SDK's V0 helper is
 *      `async function tr(s,e){ s.getSignatureStatuses([e]),
 *         new Promise((ok,fail)=>{setTimeout(fail,6e4); s.onSignature(...)}) }`
 *    -- the getSignatureStatuses result is DISCARDED by the comma operator, so
 *    confirmation rides entirely on a websocket subscription and rejects with
 *    `undefined` after 60s. This project's Connection takes its wsEndpoint from
 *    a separate setting than its RPC url, and `.env` pairs a mainnet RPC with a
 *    devnet websocket -- so the notification can never arrive and every burn
 *    "fails" 60 seconds after it has already landed.
 *
 * 2. Which fed the second defect: the retry then re-reads the chain, cannot
 *    find the now-burned position, and throws "Position not found" -- so a
 *    close that fully succeeded was reported as a hard failure and the caller
 *    never recorded it.
 */
describe('the NFT burn', () => {
  const src = fs
    .readFileSync(path.join(__dirname, '../../src/raydium/client.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');

  /**
   * Positional assertions are scoped to closePosition's own body.
   *
   * The first version of this used `src.indexOf('for (let attempt = 1; ...')`
   * on the whole file and matched createPosition's identically-shaped retry
   * loop thousands of lines earlier, so an ordering check silently compared two
   * unrelated functions.
   */
  // Anchored on the NAME only: the signature became multi-line when it started
  // returning the decreaseLiquidity signature alongside the burn, and anchoring
  // on the parameter list silently sliced from -1 and passed nothing.
  const closeFn = src.slice(src.indexOf('async closePosition('));

  it('never delegates confirmation to the SDK websocket helper', () => {
    // Anywhere in the file: sendAndConfirm: true is the websocket-only path.
    expect(src).not.toMatch(/sendAndConfirm:\s*true/);
  });

  it('confirms the burn over http, with the same helper every other branch uses', () => {
    expect(src).toContain('closeResult.execute({ sendAndConfirm: false })');
    expect(src).toMatch(/verifyTransaction\(burnTxId/);
  });

  it('records the burn signature before confirming it, not after', () => {
    const assign = closeFn.indexOf('burnTxId = executeResult.txId');
    const confirm = closeFn.indexOf('verifyTransaction(burnTxId');
    expect(assign).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(assign);
  });

  it('keeps the burn signature across retry attempts', () => {
    // Declared OUTSIDE the retry loop, or each attempt forgets the burn it sent.
    const decl = closeFn.indexOf('let burnTxId: string | undefined;');
    const loop = closeFn.indexOf('for (let attempt = 1; attempt <= maxRetries; attempt++)');
    expect(decl).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(decl);
  });

  it('treats a vanished position as success once a burn was broadcast', () => {
    // "Position not found" after our own burn is evidence the close worked.
    // The field list grows (decreaseTxId, withdrewLiquidity); what this guards is
    // that the burn signature is what gets returned, not that it is returned alone.
    expect(src).toMatch(/if \(burnTxId\) \{[\s\S]{0,200}return \{ txId: burnTxId[^}]*\}/);
  });

  it('does not re-send a withdrawal whose signature was lost to the race timeout', () => {
    // execute()'s promise is the only record of a signature the SDK already
    // broadcast; the 15s Promise.race throws it away.
    expect(src).toMatch(/catch \(sdkError[\s\S]{0,600}withdrawalLanded\(false, liquidity\)/);
  });
});
