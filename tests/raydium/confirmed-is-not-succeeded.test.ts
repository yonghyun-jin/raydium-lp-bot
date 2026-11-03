/**
 * A transaction that LANDS AND REVERTS is not a successful swap.
 *
 * `connection.confirmTransaction` resolves for a reverted transaction — the
 * failure arrives as `value.err`, not as a throw. The happy path returned the
 * signature without reading it, so a revert was reported as a completed swap.
 *
 * The case that matters most is the one this path exists to protect: Jupiter's
 * on-chain minimum-out check firing because the price moved. That is the
 * SLIPPAGE GUARD WORKING, and it was being reported as success. The wallet is
 * unchanged, so SwapToRatio then computes `actualOut` from balance deltas and
 * gets ~0 — and the position is created against balances that never changed.
 *
 * The timeout branch already read `value.err`, and `verifyTransaction` does
 * the same for creates. Only the happy path was missing it.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  assertConfirmationSucceeded,
  TransactionRevertedError,
  BlockhashExpiredError,
} from '../../src/raydium/jito';

const jito = fs
  .readFileSync(path.join(__dirname, '../../src/raydium/jito.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

function body(signature: RegExp): string {
  const start = jito.search(signature);
  expect(start).toBeGreaterThan(-1);
  const rest = jito.slice(start);
  const end = rest.slice(1).search(/\n {2}(?:private |public |async |static )?[a-zA-Z_]+[<(]/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

/**
 * BEHAVIOURAL, not source-matching.
 *
 * A first version asserted the TEXT `confirmation.value?.err` was present.
 * Reintroducing the bug as `if (false && confirmation.value?.err)` left that
 * text in place and the suite stayed green -- a guard that could not fail.
 *
 * `sendNormalTransaction` cannot be driven directly: `assertSendAllowed`
 * refuses any send from a test process, which is correct and must not be
 * mocked away. So the decision itself is a free function, and this drives it.
 */
describe('confirmed is not succeeded', () => {
  it('a reverted transaction throws', () => {
    // confirmTransaction RESOLVES for a transaction that landed and failed --
    // the error arrives as value.err, not as a throw.
    expect(() =>
      assertConfirmationSucceeded('SIG', { value: { err: { InstructionError: [2, { Custom: 6001 }] } } })
    ).toThrow(TransactionRevertedError);
  });

  it('the error carries the signature and says nothing moved', () => {
    try {
      assertConfirmationSucceeded('SIGNATURE_1111', { value: { err: 'AccountNotFound' } });
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(TransactionRevertedError);
      expect(e.txId).toBe('SIGNATURE_1111');
      expect(e.message).toMatch(/Nothing moved/);
      // The chain's own words, so a 6001 can be looked up rather than guessed.
      expect(e.message).toMatch(/AccountNotFound/);
    }
  });

  it('a clean confirmation passes', () => {
    expect(() => assertConfirmationSucceeded('SIG', { value: { err: null } })).not.toThrow();
  });

  it('an absent result is not treated as a failure', () => {
    // Only a PRESENT err means the chain rejected it. Missing structure is a
    // shape we do not understand, and the caller's other paths handle that --
    // inventing a revert here would turn an unknown into a false certainty.
    expect(() => assertConfirmationSucceeded('SIG', undefined)).not.toThrow();
    expect(() => assertConfirmationSucceeded('SIG', { value: null })).not.toThrow();
    expect(() => assertConfirmationSucceeded('SIG', {} as any)).not.toThrow();
  });

  it('it is wired into the send path before the success log', () => {
    const send = body(/private async sendNormalTransaction\(/);
    const check = send.indexOf('assertConfirmationSucceeded(txId, confirmation)');
    const ok = send.indexOf('[Tx] Confirmed');

    expect(check).toBeGreaterThan(-1);
    expect(ok).toBeGreaterThan(check);
  });

  it('a revert is not re-handled as a timeout', () => {
    // The timeout branch re-fetches a status we already have and would rethrow
    // the same thing, so the revert must pass straight through.
    const send = body(/private async sendNormalTransaction\(/);
    expect(send).toMatch(/e instanceof TransactionRevertedError\) throw e;/);
  });
});

describe('the size ceiling applies on the Jito path too', () => {
  it('sendTransaction takes valueUsd and passes it to the guard', () => {
    const send = body(/async sendTransaction\(/);
    expect(send).toMatch(/valueUsd\?: number/);
    expect(send).toMatch(/assertSendAllowed\('Jito bundle send', valueUsd\)/);
  });

  it('the fallback receives it as well', () => {
    expect(jito).toMatch(/this\.sendNormalTransaction\(transaction, valueUsd\)/);
    const fallback = body(/private async sendNormalTransaction\(/);
    expect(fallback).toMatch(/assertSendAllowed\('Jito fallback: plain RPC send', valueUsd\)/);
  });

  it('the client supplies it', () => {
    const client = fs
      .readFileSync(path.join(__dirname, '../../src/raydium/client.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // USE_JITO defaults true, so this is the DEFAULT send path. It was
    // bypassing MAX_POSITION_USD entirely while plain RPC honoured it.
    // The third argument is the rebuild closure that gives each retry a fresh
    // blockhash; valueUsd staying SECOND is what this guards.
    expect(client).toMatch(
      /this\.jito\.sendTransaction\(transaction, valueUsd(,\s*buildSwapTx)?\)/
    );
  });
});

describe('the two known-harmless failures are distinguishable', () => {
  it('a revert carries its signature and says nothing moved', () => {
    const error = new TransactionRevertedError('x', 'SIG');
    expect(error.name).toBe('TransactionRevertedError');
    expect(error.txId).toBe('SIG');

    // A FIXED WINDOW, not a lazy regex: `[\s\S]{0,300}?\)` stops at the first
    // `)`, which here is inside JSON.stringify(...), so it matched a truncated
    // string and the assertion checked prose that was never in it.
    const sites = [...jito.matchAll(/new TransactionRevertedError\(/g)];
    expect(sites.length).toBeGreaterThanOrEqual(1);
    for (const site of sites) {
      expect(jito.slice(site.index!, site.index! + 400)).toMatch(/Nothing moved/);
    }
  });

  it('it is a different type from an expired blockhash', () => {
    // Both are known not to have spent, but for different reasons and with
    // different remedies: a revert means the program said no; an expiry means
    // nothing ever ran. Collapsing them loses which one to retry.
    expect(new TransactionRevertedError('x', 'S')).not.toBeInstanceOf(BlockhashExpiredError);
  });
});
