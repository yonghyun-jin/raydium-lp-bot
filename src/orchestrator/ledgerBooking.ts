// Ledger booking: writes the ledger rows for each money event (swap, open,
// close). The row arithmetic lives in ledgerRows.ts; this module gathers the
// price and the chain's effects and hands them to recordLedgerRows.

import type { LpClient, TransactionEffects } from '../raydium/LpClient';
import type { PriceMonitor } from './components';
import type { SwapDetails } from './components/SwapToRatio';
import type { Config, ClosePositionResult, CreatePositionResult } from './types';
import { recordLedgerRows, getPositionContext } from '../recording';
import { openPositionRows, closePositionRows, swapRows, readQuote, MINTS } from './ledgerRows';

/** Book the rows for a ratio swap under the operation it funds. */
export async function bookSwap(swap: SwapDetails, operationId: string): Promise<void> {
  const solToUsdc = swap.direction === 'SOL_TO_USDC';
  const outputMint = solToUsdc ? MINTS.USDC : MINTS.SOL;
  const { quotedOut, dexFee, platformFee, feesReported } = readQuote(
    swap.quote,
    outputMint,
    solToUsdc ? 6 : 9
  );

  // The chain's own account of the transaction, so rows are checked against
  // what really moved rather than a balance bracket.
  const actualByToken = swap.effects
    ? {
        SOL: swap.effects.solDelta,
        USDC: swap.effects.tokenDeltas[MINTS.USDC] ?? 0,
      }
    : undefined;

  await recordLedgerRows({
    txId: swap.txId,
    operationId,
    protocol: 'jupiter',
    quote: swap.quote,
    actualByToken,
    movements: swapRows({
      direction: swap.direction,
      amountIn: swap.amountIn,
      amountOut: swap.amountOut,
      quotedOut,
      dexFee,
      platformFee,
      feesReported,
      networkFeeSol: swap.effects?.networkFeeSol,
      rentDeposited: swap.effects?.rentDeposited,
      rentReclaimed: swap.effects?.rentReclaimed,
      solPriceUsd: swap.priceAtSwap,
      priceSource: 'raydium-pool',
    }),
  });
}

/**
 * Book the rows for a landed open. Never throws: without a price the rows are
 * skipped and said so, because the position row is already recorded.
 *
 * Priced at the pool, not at the prediction's anchor -- this must be what the
 * deposit was actually worth.
 */
export async function bookOpen(
  client: LpClient,
  priceMonitor: PriceMonitor,
  config: Config,
  result: CreatePositionResult
): Promise<void> {
  try {
    const price = await priceMonitor.getCurrentPrice(config.poolId);

    // The open creates accounts; their rent and the network fee leave the
    // wallet here and must be booked, or the open and close measure on
    // different bases.
    const effects = await client.getTransactionEffects(result.txId);

    await recordLedgerRows({
      txId: result.txId,
      operationId: config.operationId,
      protocol: 'raydium',
      actualByToken: effects
        ? {
            SOL: effects.solDelta,
            USDC: effects.tokenDeltas[MINTS.USDC] ?? 0,
          }
        : undefined,
      movements: openPositionRows({
        solDeposited: result.solDeposited ?? config.coin1Amount,
        usdcDeposited: result.usdcDeposited ?? config.coin2Amount,
        solPriceUsd: price,
        priceSource: 'raydium-pool',
        positionId: result.nftMint,
        networkFeeSol: effects?.networkFeeSol,
        rentDeposited: effects?.rentDeposited,
        rentReclaimed: effects?.rentReclaimed,
      }),
    });
  } catch (error: any) {
    console.warn(
      `[Ledger] Open of ${result.nftMint} not booked: no price ` +
        `(${error?.message ?? error}). The position row is recorded; the P&L rows are not.`
    );
  }
}

/**
 * What a close did to the wallet, summed over its transactions.
 *
 * Null when the total cannot be known. Null SKIPS the reconciliation check,
 * whereas a partial total would fail it and blame the wrong cause (a "missing
 * instruction effect" instead of an unread signature). Do not return partials.
 */
export async function closeEffects(
  client: LpClient,
  nftMint: string,
  result: ClosePositionResult
): Promise<TransactionEffects | null> {
  // An already-empty position is closed by the burn alone, so the burn IS the
  // whole close.
  if (result.withdrewLiquidity === false) {
    return client.getTransactionEffects(result.txId);
  }

  if (!result.decreaseTxId) {
    console.warn(
      `[Ledger] Close of ${nftMint}: the decreaseLiquidity signature was not ` +
        `captured, so the withdrawal cannot be reconciled against the chain. ` +
        `Rows are still booked; the check is skipped.`
    );
    return null;
  }

  const signatures = [...new Set([result.decreaseTxId, result.txId])];
  const readings = await Promise.all(
    signatures.map(id => client.getTransactionEffects(id))
  );

  const unreadable = signatures.filter((_, i) => readings[i] === null);
  if (unreadable.length > 0) {
    console.warn(
      `[Ledger] Close of ${nftMint}: effects unreadable for ${unreadable.join(', ')}. ` +
        `Checking the rows against a partial total would blame the wrong cause, ` +
        `so the check is skipped.`
    );
    return null;
  }

  const present = readings as TransactionEffects[];
  const tokenDeltas: Record<string, number> = {};
  for (const effect of present) {
    for (const [mint, delta] of Object.entries(effect.tokenDeltas)) {
      tokenDeltas[mint] = (tokenDeltas[mint] ?? 0) + delta;
    }
  }

  const sum = (pick: (e: TransactionEffects) => number): number =>
    present.reduce((total, e) => total + pick(e), 0);

  return {
    networkFeeSol: sum(e => e.networkFeeSol),
    solDelta: sum(e => e.solDelta),
    tokenDeltas,
    rentDeposited: sum(e => e.rentDeposited),
    rentReclaimed: sum(e => e.rentReclaimed),
  };
}

/**
 * Book the ledger rows for a close.
 *
 * The operation id comes from the position row so the close groups with its
 * open. Without that id or a price the rows are skipped and SAID so -- a
 * visible gap beats a half-recorded cycle.
 */
export async function bookClose(
  priceMonitor: PriceMonitor,
  nftMint: string,
  result: ClosePositionResult,
  readEffects: (nftMint: string, result: ClosePositionResult) => Promise<TransactionEffects | null>
): Promise<void> {
  const context = await getPositionContext(nftMint);
  if (!context?.operationId) {
    console.warn(
      `[Ledger] Close of ${nftMint} not booked: no operation id on its position row. ` +
        `The position row is recorded; the P&L rows are not.`
    );
    return;
  }

  let price: number;
  try {
    price = await priceMonitor.getCurrentPrice(context.poolId);
  } catch (error: any) {
    console.warn(
      `[Ledger] Close of ${nftMint} not booked: no price (${error?.message ?? error}). ` +
        `Rows valued at a guessed price would be worse than none.`
    );
    return;
  }

  // The withdrawal figures are wallet deltas, so they already net out the
  // network fee and add back reclaimed rent; closePositionRows pulls both back
  // out as their own rows. A close is TWO transactions (decrease + burn), so
  // actuals must come from both -- checking against the burn alone reports the
  // withdrawal as missing. Rows stay keyed to the burn.
  const effects = await readEffects(nftMint, result);

  await recordLedgerRows({
    txId: result.txId,
    operationId: context.operationId,
    protocol: 'raydium',
    actualByToken: effects
      ? {
          SOL: effects.solDelta,
          USDC: effects.tokenDeltas[MINTS.USDC] ?? 0,
        }
      : undefined,
    movements: closePositionRows({
      solWithdrawn: result.solWithdrawn,
      usdcWithdrawn: result.usdcWithdrawn,
      feeSol: result.feeSol,
      feeUsdc: result.feeUsdc,
      solPriceUsd: price,
      priceSource: 'raydium-pool',
      positionId: nftMint,
      networkFeeSol: effects?.networkFeeSol,
      rentDeposited: effects?.rentDeposited,
      rentReclaimed: effects?.rentReclaimed,
    }),
  });
}
