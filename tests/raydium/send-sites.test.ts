/**
 * Structural test: every transaction send site must be guarded.
 *
 * WHY A SOURCE-LEVEL TEST: `closePosition` "had guards" by grep -- three
 * assertSendAllowed calls sit inside it -- while its two real send sites were
 * completely unguarded, because those three were in a manual-fallback branch the
 * SDK path never reaches. Auditing per FUNCTION hid that for the whole life of
 * the close path. The only audit that works is per SEND SITE.
 *
 * `src/raydium/client.ts` cannot be imported here: it pulls @solana/web3.js, and
 * the no-money harness would (correctly) refuse to let it initialise. So this
 * reads the source as text. That is a real limitation -- it proves a guard call
 * is lexically present, not that it executes -- but it catches the regression
 * that actually happened: someone adds a new `.execute()` and forgets the guard.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Anything that can put a transaction on the wire. */
const SEND_PATTERNS = [
  /\.execute\(/,
  /\bawait execute\(/,
  /\bsendRawTransaction\(/,
  /\.sendTransaction\(/,
];

/**
 * How far back a guard may sit from the send it protects.
 *
 * Generous on purpose: the close path interleaves logging and result-shape
 * checks between its guard and its send. Too tight and this test fails on
 * harmless reformatting; too loose and it stops proving anything.
 */
const GUARD_WINDOW_LINES = 45;

/**
 * Only a real `assertSendAllowed` counts.
 *
 * A nearby `throw new SendBlockedError(...)` must NOT satisfy this: the DRY_RUN
 * refusals sit directly above two of these sends, and accepting them would let a
 * site pass while still ignoring ALLOW_REAL_MONEY, MAX_POSITION_USD and the
 * test-process backstop. (Verified: with this loosened, deleting the NFT-burn
 * guard still passed the scan.)
 */
const GUARD_PATTERN = /assertSendAllowed\(/;

function sendSitesIn(file: string): Array<{ line: number; text: string }> {
  const source = fs.readFileSync(file, 'utf8').split('\n');
  const sites: Array<{ line: number; text: string }> = [];

  source.forEach((text, index) => {
    const trimmed = text.trim();
    // Skip comments and the guard/definition lines themselves.
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
    if (/^async sendTransaction\(/.test(trimmed)) return; // a declaration, not a call
    if (SEND_PATTERNS.some((p) => p.test(text))) {
      sites.push({ line: index + 1, text: trimmed.slice(0, 90) });
    }
  });

  return sites;
}

function isGuarded(file: string, line: number): boolean {
  const source = fs.readFileSync(file, 'utf8').split('\n');
  const from = Math.max(0, line - 1 - GUARD_WINDOW_LINES);
  return source.slice(from, line - 1).some((l) => GUARD_PATTERN.test(l));
}

describe('every send site is guarded', () => {
  const files = [
    path.join(__dirname, '../../src/raydium/client.ts'),
    path.join(__dirname, '../../src/raydium/jito.ts'),
  ];

  for (const file of files) {
    const name = path.basename(file);

    it(`${name} has at least one send site (the scanner still matches)`, () => {
      // Guards against the test silently passing because the patterns rotted.
      expect(sendSitesIn(file).length).toBeGreaterThan(0);
    });

    it(`${name}: no send site is missing a guard`, () => {
      const unguarded = sendSitesIn(file).filter((site) => !isGuarded(file, site.line));
      const report = unguarded.map((s) => `  ${name}:${s.line}  ${s.text}`).join('\n');
      expect(report).toBe('');
    });
  }
});

/** Strip comments, so an assertion never matches prose describing the code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('closePosition specifically', () => {
  const client = path.join(__dirname, '../../src/raydium/client.ts');
  const source = fs.readFileSync(client, 'utf8');
  /** closePosition's body only -- the create path has its own DRY_RUN return. */
  const closeCode = (() => {
    const code = stripComments(source);
    const start = code.indexOf('async closePosition(');
    const next = code.indexOf('\n  private async jupiterSwap(', start);
    return code.slice(start, next > start ? next : undefined);
  })();

  it('guards the decreaseLiquidity send', () => {
    // The first of the two broadcasts, and the one that moves the money.
    expect(source).toMatch(/assertSendAllowed\('closePosition: decreaseLiquidity'\)/);
  });

  it('guards the NFT burn send', () => {
    // The second broadcast: destroys the position account and reclaims rent.
    expect(source).toMatch(/assertSendAllowed\('closePosition: NFT burn'\)/);
  });

  it('does not cap a close by MAX_POSITION_USD', () => {
    // Closing RECOVERS funds. Passing valueUsd here would refuse to close
    // exactly the oversized position you most need to exit.
    expect(source).not.toMatch(/assertSendAllowed\('closePosition:[^']*',\s*\w/);
  });

  it('refuses under DRY_RUN instead of returning a synthetic success', () => {
    // A dry run must never produce a result a real run would produce -- the
    // create path's DRY_RUN return is what filled .orchestrator-state with
    // phantom ACTIVE positions. The close mirror would be marking a position
    // CLOSED while it is still on-chain holding real money.
    expect(closeCode).toMatch(/DRY_RUN[\s\S]{0,400}?throw new SendBlockedError/);
    expect(closeCode).not.toMatch(/txId:\s*'DRY_RUN'/);
  });

  it('reconciles reward accounts before decreasing liquidity', () => {
    // getPoolInfoFromRpc hardcodes `rewardDefaultInfos: []`, so passing its
    // poolInfo straight through attaches ZERO reward accounts and the program
    // rejects the transaction with 6030 InvalidRewardInputAccountNumber.
    expect(closeCode).toMatch(/buildRewardAccounts\(poolData\)/);
    expect(closeCode).toMatch(/poolInfo:\s*rewardAwarePoolInfo/);
    expect(closeCode).toMatch(/rewardAccounts,/);
    // The raw API poolInfo must NOT be what decreaseLiquidity receives.
    expect(closeCode).not.toMatch(/decreaseLiquidity\(\{\s*\n\s*poolInfo:\s*poolData\.poolInfo/);
  });

  it('sources reward mints from poolKeys, not from the API poolInfo', () => {
    const helper = stripComments(source).slice(
      stripComments(source).indexOf('private buildRewardAccounts(')
    );
    expect(helper).toMatch(/poolData\?\.poolKeys\?\.rewardInfos/);
    expect(helper).toMatch(/getAssociatedTokenAddressSync/);
  });

  it('does not retry a policy refusal', () => {
    // Retrying a guard refusal burns attempts and, worse, the old code wrapped
    // it in a generic Error, destroying the type callers branch on.
    expect(closeCode).toMatch(/if \(error instanceof SendBlockedError\) \{\s*\n\s*throw error;/);
  });
});
