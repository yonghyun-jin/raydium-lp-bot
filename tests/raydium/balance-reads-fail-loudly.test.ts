/**
 * A balance that could not be read is NOT zero.
 *
 * `getTokenBalance` used to wrap its whole body in `catch (e) { return 0 }`,
 * which made `getUsdcBalance` incapable of throwing while `getSolBalance`
 * (no catch) could. That asymmetry is what turned an RPC hiccup into
 * fabricated money:
 *
 *   ClosePosition.readBalances returns null only when a read THROWS. A silent
 *   zero from the USDC leg gave `after.usdc = 0`, so
 *   `usdcWithdrawn = 0 - before.usdc` -- a large negative that ledgerRows
 *   books as a real close_lp/principal row, because it skips a leg only on
 *   `delta === null`. getOperationPnL sums every row, so the P&L carried a
 *   loss that never happened. Its size is the IDLE WALLET balance, not the
 *   position's: SwapToRatio deliberately funds a small position out of a large
 *   wallet, so a $10 position on a $500 wallet books -$500.
 *
 * The behavioural half of this guard lives in close-position.test.ts, which
 * drives a client whose USDC read throws. That test PASSED throughout the bug
 * -- it asserted a behaviour the real client could not exhibit. The source
 * assertions below are what tie it to production.
 */

import * as fs from 'fs';
import * as path from 'path';

function read(rel: string): string {
  return fs
    .readFileSync(path.join(__dirname, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** A method body, bounded at the next member so the slice cannot run away. */
function method(source: string, signature: RegExp): string {
  const start = source.search(signature);
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n {2}(?:private |public |async |static )?[a-zA-Z_]+[<(]/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

describe('an unreadable balance is unknown, never zero', () => {
  const client = read('../../src/raydium/client.ts');

  it('getTokenBalance does not swallow read failures', () => {
    const body = method(client, /async getTokenBalance\(/);

    // The bug verbatim. Any catch that returns a number is the same bug in
    // different clothes, so the second assertion is the load-bearing one.
    expect(body).not.toMatch(/catch[\s\S]*?return\s+0\s*;/);
    expect(body).not.toMatch(/catch\s*\([^)]*\)\s*\{[\s\S]*?return\s+[-\d]/);
  });

  it('getTokenBalance still reports a genuinely absent token account as 0', () => {
    const body = method(client, /async getTokenBalance\(/);

    // The legitimate zero must survive: a wallet that has never held the mint
    // has no token account, and that IS zero. Losing this would make the fix
    // refuse a first-ever deposit.
    expect(body).toMatch(/accounts\.value\.length === 0/);
    expect(body).toMatch(/return 0;/);
  });

  it('getUsdcBalance adds no catch of its own', () => {
    const body = method(client, /async getUsdcBalance\(/);
    expect(body).not.toMatch(/catch/);
  });

  it('getSolBalance still propagates, so both legs fail the same way', () => {
    const body = method(client, /async getSolBalance\(/);
    expect(body).not.toMatch(/catch/);
  });

  it('ClosePosition brackets BOTH balance reads in one try', () => {
    const close = read('../../src/orchestrator/components/ClosePosition.ts');
    const body = method(close, /private async readBalances\(/);

    // Both awaits must sit inside the same try. Splitting them so only the SOL
    // leg is guarded is how the original asymmetry reached the ledger.
    const tryStart = body.indexOf('try');
    const catchStart = body.indexOf('catch');
    expect(tryStart).toBeGreaterThan(-1);
    expect(catchStart).toBeGreaterThan(tryStart);

    const guarded = body.slice(tryStart, catchStart);
    expect(guarded).toMatch(/getSolBalance\(\)/);
    expect(guarded).toMatch(/getUsdcBalance\(\)/);
  });

  it('ledgerRows still skips a leg only when the delta is null', () => {
    const rows = read('../../src/orchestrator/ledgerRows.ts');

    // This is the line the fabricated number walked past. It is correct as
    // written -- null means unreadable -- and it only works if an unreadable
    // balance actually arrives as null.
    expect(rows).toMatch(/if \(delta === null\) return;/);
  });
});
