/**
 * Error decoding tests.
 *
 * The retry ladder in createPosition branches entirely on `retryable`, and this
 * plumbing was fixed twice (7f4bb9c "Fix error code propagation for retry
 * logic", c2d3ac1) with no test either time.
 */

import { parseTransactionError, RAYDIUM_ERRORS } from '../../src/raydium/errors';

describe('parseTransactionError', () => {
  it('decodes every code in the table consistently', () => {
    for (const [codeStr, entry] of Object.entries(RAYDIUM_ERRORS)) {
      const code = Number(codeStr);
      const parsed = parseTransactionError(`{"InstructionError":[4,{"Custom":${code}}]}`);

      expect(parsed.errorCode).toBe(code);
      expect(parsed.retryable).toBe(entry.retryable);
      expect(parsed.explanation.length).toBeGreaterThan(0);
    }
  });

  it('marks the slippage codes retryable and the structural ones not', () => {
    expect(parseTransactionError('{"Custom":6017}').retryable).toBe(true); // PriceSlippageCheck
    expect(parseTransactionError('{"Custom":6025}').retryable).toBe(true);
    expect(parseTransactionError('{"Custom":6024}').retryable).toBe(true); // TransactionTooOld
    expect(parseTransactionError('{"Custom":6011}').retryable).toBe(false); // InvalidTickArray
    expect(parseTransactionError('{"Custom":6006}').retryable).toBe(false); // InvaildTickIndex
    expect(parseTransactionError('{"Custom":1}').retryable).toBe(false); // Insufficient funds
  });

  it('REGRESSION: finds the code through the wrapper createPositionAttempt adds', () => {
    // client.ts wraps failures as `Position creation failed: ${message}`. When a
    // rethrow dropped the {"Custom":NNNN} fragment, parsed.errorCode came back
    // undefined, retryable defaulted to false, and the ladder never escalated.
    const wrapped =
      'Position creation failed: {"Custom":6017} Price moved during transaction';
    const parsed = parseTransactionError(wrapped);

    expect(parsed.errorCode).toBe(6017);
    expect(parsed.retryable).toBe(true);
  });

  it('finds the code in the raw on-chain error shape', () => {
    // Verbatim from tx 5DbF4pRHRW... on 2026-09-17.
    const parsed = parseTransactionError('{"InstructionError":[4,{"Custom":6017}]}');
    expect(parsed.errorCode).toBe(6017);
    expect(parsed.retryable).toBe(true);
  });

  it('tolerates whitespace after the key', () => {
    expect(parseTransactionError('{"Custom": 6017}').errorCode).toBe(6017);
  });

  it('treats an unknown code as fatal rather than retrying blindly', () => {
    const parsed = parseTransactionError('{"Custom":9999}');
    expect(parsed.errorCode).toBe(9999);
    expect(parsed.retryable).toBe(false);
    expect(parsed.explanation).toMatch(/Unknown CLMM error/);
  });

  it('classifies blockhash and timeout failures as retryable', () => {
    expect(parseTransactionError('Blockhash not found').retryable).toBe(true);
    expect(parseTransactionError('block height exceeded, blockhash expired').retryable).toBe(true);
    expect(parseTransactionError('Transaction confirmation timeout').retryable).toBe(true);
  });

  it('classifies insufficient funds as fatal', () => {
    expect(parseTransactionError('Attempt to debit an account: insufficient funds').retryable).toBe(false);
  });

  it('defaults to fatal for anything it does not recognise', () => {
    const parsed = parseTransactionError('something nobody has seen before');
    expect(parsed.errorCode).toBeNull();
    expect(parsed.retryable).toBe(false);
  });

  it('a code wins over a keyword that happens to appear alongside it', () => {
    // "expired" would otherwise mark this retryable and mask a fatal error.
    const parsed = parseTransactionError('{"Custom":6011} tick array expired');
    expect(parsed.errorCode).toBe(6011);
    expect(parsed.retryable).toBe(false);
  });
});

describe('the retry ladder, given these verdicts', () => {
  // client.ts:829 -- slippage escalates only on 6017.
  const SLIPPAGE_STEPS = [0.001, 0.003, 0.005, 0.01, 0.02];

  function ladder(errors: string[]): number[] {
    let index = 0;
    const used: number[] = [];
    for (const error of errors) {
      used.push(SLIPPAGE_STEPS[Math.min(index, SLIPPAGE_STEPS.length - 1)]);
      const parsed = parseTransactionError(error);
      if (parsed.errorCode === 6017) index++;
      if (!parsed.retryable) break;
    }
    return used;
  }

  it('walks the full ladder on repeated 6017', () => {
    expect(ladder(Array(5).fill('{"Custom":6017}'))).toEqual(SLIPPAGE_STEPS);
  });

  it('REGRESSION: a non-6017 retryable error burns an attempt without escalating', () => {
    // Documents a real gap: a mixed error sequence never reaches the 2% rung.
    expect(ladder(Array(5).fill('blockhash expired'))).toEqual([0.001, 0.001, 0.001, 0.001, 0.001]);
  });

  it('stops immediately on a fatal error instead of burning retries', () => {
    expect(ladder(['{"Custom":6011}', '{"Custom":6017}'])).toEqual([0.001]);
  });

  it('REGRESSION: the ladder could never have rescued the real failure', () => {
    // The shortfall on 2026-09-17 was 535074377 / 499163590 = 7.2%.
    // The widest rung is 2%. No number of retries closes that gap, which is why
    // the fix had to be in the sizing, not the slippage.
    const shortfall = 535074377 / 499163590 - 1;
    expect(SLIPPAGE_STEPS.every((step) => step < shortfall)).toBe(true);
  });
});
