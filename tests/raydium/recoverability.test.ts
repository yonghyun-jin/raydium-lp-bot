/**
 * Recovery must survive an exception nobody has seen yet.
 *
 * The 2026-09-25 incident was fixed at its two causes -- a median tip and a
 * frozen retry ladder. That does not stop the NEXT one: a 6017 revert, a Jupiter
 * outage, the 120s Python predictor timing out, a Prisma hiccup, all strand the
 * funds identically. A recovery path made of `instanceof` checks against known
 * errors is a list, and the next failure is not on it.
 *
 * So these assert the inversion: the error class does not authorise a retry,
 * STATE does. The classification only decides how long to wait before asking.
 */

import {
  classifyFailure,
  mayRedeploy,
  recoveryBackoffMs,
  SETTLE_MS,
} from '../../src/raydium/recoverability';
import { BlockhashExpiredError } from '../../src/raydium/jito';
import { SendBlockedError } from '../../src/raydium/guard';

describe('classifyFailure', () => {
  it('knows an expiry sent nothing', () => {
    expect(classifyFailure(new BlockhashExpiredError('expired'))).toBe('NOTHING_SENT');
  });

  it('knows a policy refusal sent nothing', () => {
    expect(classifyFailure(new SendBlockedError('DRY_RUN'))).toBe('NOTHING_SENT');
  });

  it('recognises web3.js’s own expiry error by name', () => {
    const e = new Error('Signature 5x has expired: block height exceeded.');
    e.name = 'TransactionExpiredBlockheightExceededError';
    expect(classifyFailure(e)).toBe('NOTHING_SENT');
  });

  it('recognises that expiry wording even without the class', () => {
    expect(classifyFailure(new Error('block height exceeded'))).toBe('NOTHING_SENT');
  });

  it('knows a revert executed and changed nothing but the fee', () => {
    const e = new Error('Transaction abc landed and FAILED on-chain: {"Custom":6017}');
    e.name = 'TransactionRevertedError';
    expect(classifyFailure(e)).toBe('LANDED_REVERTED');
  });

  it('FAILS CLOSED: an unrecognised error is UNKNOWN, never assumed safe', () => {
    // This is the property that makes a brand-new failure mode safe. Anything
    // that guessed "probably nothing sent" here would eventually double-deploy.
    for (const e of [
      new Error('ECONNRESET'),
      new Error('Prisma connection pool timeout'),
      new Error('something nobody has seen before'),
      new Error(''),
      undefined,
      null,
      'a bare string',
      { weird: true },
    ]) {
      expect(classifyFailure(e)).toBe('UNKNOWN');
    }
  });

  it('a bare timeout is UNKNOWN, because the signature may still confirm', () => {
    expect(classifyFailure(new Error('Transaction confirmation timeout'))).toBe('UNKNOWN');
  });
});

describe('mayRedeploy: state decides, not the error', () => {
  const settled = SETTLE_MS + 1;

  it('refuses when a position already exists, whatever the error said', () => {
    for (const classification of ['NOTHING_SENT', 'LANDED_REVERTED', 'UNKNOWN'] as const) {
      const verdict = mayRedeploy({
        classification,
        positionsOnChain: 1,
        msSinceLastAttempt: settled,
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toMatch(/already open/);
    }
  });

  it('allows immediately when nothing could have been sent', () => {
    const verdict = mayRedeploy({
      classification: 'NOTHING_SENT',
      positionsOnChain: 0,
      msSinceLastAttempt: 0,
    });
    expect(verdict.allowed).toBe(true);
  });

  it('allows immediately after a revert, which deployed nothing', () => {
    const verdict = mayRedeploy({
      classification: 'LANDED_REVERTED',
      positionsOnChain: 0,
      msSinceLastAttempt: 0,
    });
    expect(verdict.allowed).toBe(true);
  });

  it('MAKES AN UNKNOWN FAILURE RECOVERABLE once nothing can be in flight', () => {
    // The whole answer to "what about the exception we have not seen": it is not
    // a dead end, it is a wait. After the settle window a blockhash from the
    // failed attempt cannot be included by anyone, so an empty chain is final.
    const verdict = mayRedeploy({
      classification: 'UNKNOWN',
      positionsOnChain: 0,
      msSinceLastAttempt: settled,
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toMatch(/settle window has passed/);
  });

  it('holds an unknown failure until the window passes', () => {
    const verdict = mayRedeploy({
      classification: 'UNKNOWN',
      positionsOnChain: 0,
      msSinceLastAttempt: 5_000,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/in-flight/);
  });

  it('the settle window outlasts a blockhash', () => {
    // ~150 slots is ~60s at 400ms. If this were shorter than a blockhash life, a
    // still-includable transaction could be retried alongside its replacement.
    expect(SETTLE_MS).toBeGreaterThan(60_000);
  });
});

describe('recoveryBackoffMs', () => {
  it('grows exponentially so an outage is not hammered', () => {
    expect(recoveryBackoffMs(0)).toBe(30_000);
    expect(recoveryBackoffMs(1)).toBe(60_000);
    expect(recoveryBackoffMs(2)).toBe(120_000);
  });

  it('is capped so recovery never effectively stops', () => {
    expect(recoveryBackoffMs(99)).toBe(600_000);
  });

  it('treats a negative attempt count as the first', () => {
    expect(recoveryBackoffMs(-3)).toBe(30_000);
  });
});
