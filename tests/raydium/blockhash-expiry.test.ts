/**
 * A doomed send must not become a signature.
 *
 * A real $1000 open died here. The Jito ladder waited its full 60s timeout on
 * the first attempt, which is the whole lifetime of a blockhash; retries 2 and
 * 3 re-sent the SAME signed bytes and both came back `bundle contains an
 * expired blockhash`; and the RPC fallback then sent that same dead
 * transaction anyway. It produced signature 56izVxXz…, which never landed and
 * never could have — `getSignatureStatuses` with searchTransactionHistory
 * returns null for it.
 *
 * The operator was told "It is unknown if it succeeded or failed", went
 * looking for money that had never moved, and the bot restarted on a 90s
 * Telegram polling timeout on the way out.
 *
 * Nothing here can be exercised against a real validator in a unit test, so
 * these guard the STRUCTURE that made every path unlandable.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BlockhashExpiredError } from '../../src/raydium/jito';

const jito = fs
  .readFileSync(path.join(__dirname, '../../src/raydium/jito.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the ladder cannot double-spend', () => {
  // THE central safety property, and the reason the code is shaped this way.
  //
  // Within one blockhash window the MAIN transaction is byte-identical on every
  // rung -- only the tip transaction changes -- so Solana's duplicate-signature
  // rejection means at most one rung can ever execute, however many are in
  // flight. Across windows the transaction is REBUILT, which gives it a new
  // signature, and two different signatures doing the same swap CAN both land.
  //
  // An earlier version of this file guarded "rebuilds between attempts", which
  // was exactly the unsafe thing: it escaped the blockhash deadline by trading
  // "cannot land" for "might land twice".
  const windowLoop = () => {
    const from = jito.indexOf('for (let window = 0');
    const to = jito.indexOf('private async attemptRung');
    return jito.slice(from, to);
  };

  it('falls back to plain RPC while the transaction is still ALIVE', () => {
    // THE STRANDING BUG. `guardedRpcFallback` was reachable only after the whole
    // budget was spent, and it refuses a dead transaction -- correctly, since a
    // dead one can only produce a signature nobody can confirm. So the one send
    // path that does not have to win an auction was never taken, and
    // $3,636.90 sat in the wallet through two full attempts on 2026-10-13.
    // Measured the same day: a Jupiter-minted blockhash lives ~28s, which is
    // 4-5 rungs, so "spend the budget first" means "always too late".
    const loop = windowLoop();

    const fallback = loop.indexOf('RPC_FALLBACK_AFTER_WINDOWS');
    const rungLoop = loop.indexOf('for (let rung = 0');
    expect(fallback).toBeGreaterThan(-1);
    // BEFORE the rungs: a fallback window must not bid first, because bidding
    // is what spends the blockhash it needs.
    expect(rungLoop).toBeGreaterThan(fallback);
    // Through the gate, so the blockhash is CHECKED rather than assumed alive
    // and valueUsd still reaches MAX_POSITION_USD.
    expect(loop).toMatch(/return await this\.guardedRpcFallback\(/);

    // And it must sit after the rebuild, i.e. be reached on a LATER window --
    // window 0's transaction is the one that has already been bid with.
    expect(loop).toMatch(/if \(window >= JITO\.RPC_FALLBACK_AFTER_WINDOWS\)/);
  });

  it('encodes the main transaction ONCE per window, outside the rung loop', () => {
    const loop = windowLoop();
    const encode = loop.indexOf('bs58.encode(transaction.serialize())');
    const rungLoop = loop.indexOf('for (let rung = 0');

    expect(encode).toBeGreaterThan(-1);
    expect(rungLoop).toBeGreaterThan(-1);
    // Encoding inside the rung loop would let the bytes drift between rungs.
    expect(encode).toBeLessThan(rungLoop);
  });

  it('passes those frozen bytes to every rung', () => {
    expect(windowLoop()).toMatch(/this\.attemptRung\(mainB58,/);
  });

  it('only the TIP varies per rung', () => {
    const rung = jito.slice(
      jito.indexOf('private async attemptRung'),
      jito.indexOf('private async submitBundle')
    );
    expect(rung).toMatch(/createTipTransaction\(tipLamports\)/);
    // The main bundle member is the caller's frozen string, never re-serialized.
    expect(rung).not.toMatch(/transaction\.serialize\(\)/);
  });

  it('gates every rebuild on PROVEN death', () => {
    const loop = windowLoop();
    const gate = loop.indexOf('provablyDead');
    const rebuildCall = loop.indexOf('await rebuild()');

    expect(gate).toBeGreaterThan(-1);
    expect(rebuildCall).toBeGreaterThan(gate);
    // Either the chain says dead, or Jito already said `expired blockhash`.
    expect(loop).toMatch(/expiredDuringWindow \|\| \(await this\.provablyDead\(/);
  });

  it('refuses to rebuild when death cannot be proven', () => {
    const loop = windowLoop();
    const gate = loop.indexOf('const dead =');
    expect(loop.slice(gate)).toMatch(/if \(!dead\)[\s\S]{0,400}break;/);
  });

  it('proves death ONLY on an explicit false, never on an unreadable answer', () => {
    // The RPC really does return 429 in bursts on this project's plan. Answering
    // "dead" on a throttle would let a rebuild mint a second live signature, so
    // an unknown answer must count as STILL ALIVE.
    const fn = jito.slice(jito.indexOf('private async provablyDead'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    expect(body).toMatch(/valid === false/);
    expect(body).toMatch(/catch\s*\{\s*return false;/);
  });

  it('provablyDead is NOT the negation of blockhashStillValid', () => {
    // Both fail in the SAME direction -- "unknown means still alive" -- because
    // both wrong answers are the dangerous one. blockhashStillValid returns true
    // when unreadable (allow the send); provablyDead returns false when
    // unreadable (refuse the rebuild). Collapsing them into one helper would
    // force one of the two to fail the wrong way.
    const stillValid = jito.slice(jito.indexOf('private async blockhashStillValid'));
    expect(stillValid.slice(0, 600)).toMatch(/catch\s*\{\s*return true;/);
  });

  it('stops instead of climbing forever when nothing can change the bytes', () => {
    expect(windowLoop()).toMatch(/if \(!rebuild\)[\s\S]{0,300}break;/);
  });

  it('is bounded by wall-clock as well as by rungs and windows', () => {
    // The binding constraint is no longer the blockhash -- it is the quote, which
    // carries a slippage bound and eventually trips 6017.
    const loop = windowLoop();
    expect(loop).toMatch(/Date\.now\(\) >= deadline/);
    // The two bounds moved from source literals into config (default 240s / 8
    // windows) once every window re-quoted: a hard 90s was the right ceiling
    // while a rebuild reused the FIRST quote -- spending longer then only bid
    // with a deader minimum-out -- and the wrong one once the time buys fresh
    // quotes. An incident needs to be able to move them without a deploy.
    expect(jito).toMatch(/get totalBudgetMs\(\)/);
    expect(jito).toMatch(/JITO\.TOTAL_BUDGET_MS/);
    expect(jito).toMatch(/get maxWindows\(\)/);
    expect(jito).toMatch(/JITO\.MAX_WINDOWS/);
  });
});

describe('rungs are cheap, so they are ordinary control flow', () => {
  it('a bundle that does not land returns null rather than throwing', () => {
    // An unselected bundle executes nothing and costs neither tip nor network
    // fee, so "did not land" is the expected outcome of most rungs. The old code
    // threw `Bundle confirmation timeout`, which logged every one as a failure.
    const poll = jito.slice(jito.indexOf('private async pollBundle'));
    const body = poll.slice(0, poll.indexOf('\n  }'));
    expect(body).toMatch(/return null;/);
    expect(body).not.toMatch(/throw new Error\('Bundle confirmation timeout'\)/);
  });

  it('submits each rung to every region at once', () => {
    // Free coverage: more regions per tip means a lower winning tip, and the
    // bundle id is a content hash so one status poll covers them all.
    const rung = jito.slice(
      jito.indexOf('private async attemptRung'),
      jito.indexOf('private async submitBundle')
    );
    expect(rung).toMatch(/Promise\.allSettled\(/);
    expect(rung).toMatch(/JITO_ENDPOINTS\.mainnet\.map\(/);
  });

  it('records what the ladder learned, win or lose', () => {
    const send = jito.slice(
      jito.indexOf('async sendTransaction('),
      jito.indexOf('private async attemptRung')
    );
    expect(send).toMatch(/this\.tips\.record\(\{ winningLamports: tipLamports \}\)/);
    expect(send).toMatch(/this\.tips\.record\(\{ highestTriedLamports: highestTried \}\)/);
  });
});

describe('the tip is not a source literal at the median', () => {
  it('DEFAULT_CONFIG no longer carries one', () => {
    // `tipLamports: 10000` shipped as the default and was EXACTLY the 50th
    // percentile of Jito's landed tips, so roughly half the market outbid every
    // bundle this bot sent.
    expect(jito).not.toMatch(/tipLamports:\s*\d+/);
  });

  it('is priced off the market between configured bounds', () => {
    expect(jito).toMatch(/clampTipSol\(marketSol, JITO\.TIP_SOL_FLOOR, JITO\.TIP_SOL_MAX\)/);
  });
});

describe('an expired blockhash is recognised, whoever words it', () => {
  it('is detected rather than retried', () => {
    expect(jito).toMatch(/isExpiredBlockhash/);
    expect(jito).toMatch(/expired blockhash/);
    expect(jito).toMatch(/blockhash not found/);
  });

  it('ends the window rather than throwing, now that a rebuild is gated', () => {
    // SUPERSEDES "throws instead of continuing to the next endpoint". Throwing
    // was right while the bytes were frozen for the whole send: no later attempt
    // could land, so stopping was all that was left. Now an expiry is Jito's own
    // PROOF that the bytes are dead, which is exactly the permission a rebuild
    // needs -- so it ends the window and the climb continues on fresh bytes.
    const loop = jito.slice(
      jito.indexOf('for (let window = 0'),
      jito.indexOf('private async attemptRung')
    );
    const detect = loop.indexOf('outcome.expired');
    expect(detect).toBeGreaterThan(-1);
    expect(loop.slice(detect)).toMatch(/expiredDuringWindow = true;[\s\S]{0,200}break;/);
  });

  it('an expiry reported by the block engines is treated as proof of death', () => {
    const rung = jito.slice(
      jito.indexOf('private async attemptRung'),
      jito.indexOf('private async submitBundle')
    );
    expect(rung).toMatch(/errors\.some\(e => isExpiredBlockhash\(e\)\)/);
  });
});

describe('the RPC fallback refuses a transaction that cannot land', () => {
  it('checks validity before sending', () => {
    const fn = jito.slice(jito.indexOf('private async guardedRpcFallback'));
    const check = fn.indexOf('await this.blockhashStillValid(');
    const send = fn.indexOf('return this.sendNormalTransaction(');

    expect(check).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(check);
  });

  it('is the ONLY route from the bundle path to a plain send', () => {
    // The tip-creation failure branch inside the loop used to call
    // sendNormalTransaction directly: no validity check, and valueUsd dropped,
    // so it also skipped MAX_POSITION_USD. Funnelling both fallbacks through one
    // gate is what stops the next branch from skipping it too.
    const send = jito.slice(
      jito.indexOf('async sendTransaction('),
      jito.indexOf('private async guardedRpcFallback')
    );
    expect(send).not.toMatch(/this\.sendNormalTransaction\(/);
    expect(send).toMatch(/this\.guardedRpcFallback\(/);
  });

  it('an unreadable validity answer allows the send', () => {
    // Refusing a send that might have worked is the worse error, and the
    // caller's own confirmation still gates success either way.
    const fn = jito.slice(jito.indexOf('private async blockhashStillValid'));
    expect(fn.slice(0, 600)).toMatch(/catch\s*\{\s*return true;/);
  });
});

describe('the error says what it knows', () => {
  it('BlockhashExpiredError exists and is distinct', () => {
    const error = new BlockhashExpiredError('x');
    expect(error.name).toBe('BlockhashExpiredError');
    expect(error).toBeInstanceOf(Error);
  });

  it('its messages state that no money moved', () => {
    // The whole point of a distinct type: an expired transaction is the one
    // send failure KNOWN not to have spent anything, so it must not be
    // reported with the "unknown if it succeeded" wording a timeout deserves.
    const throws = jito.match(/new BlockhashExpiredError\([\s\S]{0,400}?\)/g) ?? [];
    // One site now, not two: the in-loop throw became a gated rebuild, and the
    // surviving one is the fallback refusing to turn dead bytes into a signature.
    expect(throws.length).toBeGreaterThanOrEqual(1);
    for (const t of throws) {
      expect(t).toMatch(/no money moved/);
    }
  });
});
