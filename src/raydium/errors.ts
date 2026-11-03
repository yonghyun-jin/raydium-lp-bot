/**
 * Raydium CLMM error decoding.
 *
 * Extracted from client.ts so it can be tested directly. The retry ladder in
 * createPosition branches entirely on what this returns, and the error-code
 * plumbing around it has been fixed twice (7f4bb9c, c2d3ac1) without ever
 * gaining a regression test.
 */

export interface ParsedTransactionError {
  errorCode: number | null;
  errorMessage: string;
  retryable: boolean;
  explanation: string;
}

/**
 * Raydium CLMM error codes and their meanings.
 * Also includes common Solana/Anchor errors (0-100).
 */
export const RAYDIUM_ERRORS: Record<number, { message: string; retryable: boolean }> = {
  // Common Solana/Anchor errors
  0: { message: 'Success', retryable: false },
  1: { message: 'Insufficient funds for rent or transaction fees', retryable: false },
  2: { message: 'Invalid account data', retryable: false },
  3: { message: 'Account not initialized', retryable: false },
  4: { message: 'Account already initialized', retryable: false },
  5: { message: 'Invalid program id', retryable: false },
  // Raydium CLMM errors
  6000: { message: 'LOK (Lock error)', retryable: false },
  6001: { message: 'NotApproved', retryable: false },
  6002: { message: 'InvalidUpdateConfigFlag', retryable: false },
  6003: { message: 'AccountLack', retryable: false },
  6004: { message: 'ClosePositionErr', retryable: false },
  6005: { message: 'ZeroMintAmount', retryable: false },
  6006: { message: 'InvaildTickIndex', retryable: false },
  6007: { message: 'TickInvaildOrder', retryable: false },
  6008: { message: 'TickLowerOverflow', retryable: false },
  6009: { message: 'TickUpperOverflow', retryable: false },
  6010: { message: 'TickAndSpacingNotMatch', retryable: false },
  6011: { message: 'InvalidTickArray', retryable: false },
  6012: { message: 'InvalidTickArrayBoundary', retryable: false },
  6013: { message: 'SqrtPriceLimitOverflow', retryable: false },
  6014: { message: 'SqrtPriceX64', retryable: false },
  6015: { message: 'LiquiditySubValueErr', retryable: false },
  6016: { message: 'LiquidityAddValueErr', retryable: false },
  6017: { message: 'Price slippage check failed - price moved during transaction', retryable: true },
  6018: { message: 'InvaildLiquidity', retryable: false },
  6019: { message: 'InvalidProtocolFeeRate', retryable: false },
  6020: { message: 'InvalidFundFeeRate', retryable: false },
  6021: { message: 'InvalidTradeDirection', retryable: false },
  6022: { message: 'ZeroTradeFee', retryable: false },
  6023: { message: 'LiquidityOverflow', retryable: false },
  6024: { message: 'TransactionTooOld', retryable: true },
  6025: { message: 'PriceSlippageCheck', retryable: true },
  // Surfaced by the first DRY_RUN rehearsal of closePosition against a live
  // position (2026-09-18). decrease_liquidity.rs:517 rejects the transaction
  // when the reward accounts passed do not match the pool's configured rewards.
  // Deterministic -- the same build fails identically every attempt -- so it is
  // NOT retryable; the transaction has to be rebuilt with the right accounts.
  6030: {
    message:
      'InvalidRewardInputAccountNumber - the pool has reward tokens and the ' +
      'instruction was built with the wrong number of reward accounts',
    retryable: false,
  },
};

/** Decode a transaction error string and decide whether retrying can help. */
export function parseTransactionError(error: string): ParsedTransactionError {
  // Anchor encodes program errors as {"Custom": 6017}. Everything upstream that
  // rethrows must preserve this shape, or the retry ladder goes blind.
  const customMatch = error.match(/"Custom":\s*(\d+)/);
  if (customMatch) {
    const code = parseInt(customMatch[1], 10);
    const knownError = RAYDIUM_ERRORS[code];

    if (knownError) {
      let explanation = knownError.message;

      if (code === 6017) {
        explanation =
          'Price moved during transaction, causing slippage to exceed tolerance. ' +
          'This can happen during high volatility. Will retry with fresh price data.';
      } else if (code === 6025) {
        explanation = 'Price moved too much during transaction. Will retry with fresh data.';
      }

      return {
        errorCode: code,
        errorMessage: knownError.message,
        retryable: knownError.retryable,
        explanation,
      };
    }

    return {
      errorCode: code,
      errorMessage: `Unknown Raydium error ${code}`,
      retryable: false,
      explanation: `Unknown CLMM error code ${code}. Check Raydium documentation.`,
    };
  }

  const lowerError = error.toLowerCase();

  if (lowerError.includes('blockhash') || lowerError.includes('expired')) {
    return {
      errorCode: null,
      errorMessage: 'Blockhash expired',
      retryable: true,
      explanation: 'Transaction took too long and blockhash expired. Will retry.',
    };
  }

  if (lowerError.includes('timeout')) {
    return {
      errorCode: null,
      errorMessage: 'Transaction timeout',
      retryable: true,
      explanation: 'Transaction confirmation timed out. Will retry.',
    };
  }

  if (lowerError.includes('insufficient') || lowerError.includes('balance')) {
    return {
      errorCode: null,
      errorMessage: 'Insufficient balance',
      retryable: false,
      explanation: 'Not enough tokens in wallet for this transaction.',
    };
  }

  return {
    errorCode: null,
    errorMessage: error,
    retryable: false,
    explanation: error,
  };
}
