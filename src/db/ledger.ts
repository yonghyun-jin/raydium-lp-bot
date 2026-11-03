/**
 * Ledger Service (Prisma)
 *
 * Record and query all DeFi token movements.
 * 1 row = 1 token movement
 */

import { prisma } from './index';

/**
 * What kind of movement this row is.
 *
 * `reward` and `fee` are opposites and must not be merged: fees EARNED on a
 * position and fees PAID to a protocol move P&L in opposite directions. The
 * original five-value set had only `reward`, so a paid fee had to be squeezed
 * into `cost` alongside rent.
 *
 * `debt` is the one that changes P&L CORRECTNESS. A borrow is recorded as a
 * `principal` row AND an opposing `debt` row so the pair nets to zero; profit
 * queries must exclude it, or borrowed money reads as income. See
 * docs/v1-confidential/ledger-schema.md.
 */
export type Category =
  | 'principal'  // your own capital moving. On a swap this is the asset FLOW, not "capital"; the sign carries direction
  | 'reward'     // yield EARNED -- LP fees, staking rewards, interest received
  | 'interest'   // interest PAID on debt
  | 'debt'       // a liability created or settled -- SUMMED, it cancels its pair

  // Execution costs, separated by WHO charged them. Merging them loses the
  // ability to ask "would a different route have been cheaper?"
  | 'dex_fee'            // the pools' own fees, summed across routePlan[] hops
  | 'platform_fee'       // Jupiter's own charge, separate from any pool's
  | 'network_fee'        // meta.fee, priority fee included. Not "gas" -- that is EVM vocabulary
  | 'execution_slippage' // QUOTED output vs ACTUAL output. Not priceImpactPct, which is a pre-trade estimate

  // Rent is refundable, so it is two events and nets to zero over a lifecycle.
  // A single `rent` cost would overstate every completed cycle.
  | 'rent_deposit'
  | 'rent_reclaim'

  /*
   * THERE IS NO `unexplained` CATEGORY, and that is deliberate.
   *
   * An earlier draft of this made the residual a bookable cost. That is the
   * wrong shape: it hands our own incomplete model to the data and calls it an
   * expense. A transaction's balance changes all have causes, and the goal is
   * to name every one of them -- not to have somewhere to put the ones we have
   * not explained yet.
   *
   * So the residual is a VERIFICATION RESULT, not a row. See
   * `verifyEffects()` in src/orchestrator/verifyEffects.ts: rows that do not
   * sum to the transaction's real delta are a BUG to investigate, and a
   * newly-introduced cost (a Token-2022 transfer fee, an ATA creation, wSOL
   * wrapping) then shows up as a failing check rather than as a plausible line
   * item nobody questions.
   */

  // Superseded, still accepted so rows written before C3 keep their meaning.
  | 'fee'        // -> dex_fee | platform_fee
  | 'slippage'   // -> execution_slippage
  | 'gas'        // -> network_fee
  | 'cost';      // -> rent_deposit | rent_reclaim

/**
 * What caused the movement.
 *
 * Deliberately an open string. `chain` and `protocol` were always open and
 * `action` was the only closed one, which is exactly what blocked lending -- no
 * enum anticipates every DeFi verb. Conventions:
 *
 *   swap     swap
 *   LP       create_lp | close_lp | harvest
 *   lending  supply | withdraw | borrow | repay
 *   staking  stake | unstake | claim
 */
export type Action = string;

/**
 * NOTE -- there is deliberately no "exclude from P&L" list.
 *
 * The first version of this excluded `debt`, which is backwards and was caught
 * by an integration run: a borrow writes `principal +1000` AND `debt -1000`, so
 * excluding the debt row leaves the +1000 standing alone and reports $988 of
 * profit on a loan. The debt row exists precisely BECAUSE it cancels. Sum
 * everything; the pair nets to zero on its own.
 *
 * `debt` is still a distinct category so outstanding liability can be QUERIED
 * (see getOutstandingDebt), not so it can be filtered out of income.
 */

export interface LedgerRowInput {
  txId: string;
  operationId: string;
  timestamp?: Date;
  chain?: string;
  protocol: string;
  action: Action;
  category: Category;
  /** Display label, e.g. 'USDC'. NOT an identity -- see tokenAddress. */
  token: string;
  /**
   * Mint / contract address. The real identity: Solana USDC, Ethereum USDC and
   * Arbitrum USDC share a symbol and are different assets. Null only for native
   * assets that have no address.
   */
  tokenAddress?: string;
  amount: number;
  priceUsd: number;
  valueUsd: number;
  /** Where priceUsd came from, e.g. 'raydium-pool' | 'coingecko'. */
  priceSource?: string;
  positionId?: string;
  description?: string;
  /**
   * What the router said it would do, on a swap's first row.
   *
   * MUST be carried all the way to the `data:` literal below. This project has
   * twice declared a field on this type, had the compiler accept it, and had
   * it silently dropped because the Prisma mapping was not updated -- a field
   * that looks stored and is not.
   */
  quote?: unknown;
}

/**
 * Insert multiple ledger entries in a transaction
 */
export async function insertLedgerEntries(inputs: LedgerRowInput[]): Promise<number> {
  const result = await prisma.ledgerEntry.createMany({
    data: inputs.map((input) => ({
      txId: input.txId,
      operationId: input.operationId,
      timestamp: input.timestamp ?? new Date(),
      chain: input.chain ?? 'solana',
      protocol: input.protocol,
      action: input.action,
      category: input.category,
      token: input.token,
      tokenAddress: input.tokenAddress,
      amount: input.amount,
      priceUsd: input.priceUsd,
      valueUsd: input.valueUsd,
      priceSource: input.priceSource,
      positionId: input.positionId,
      description: input.description,
      quote: (input.quote ?? undefined) as never,
    })),
  });
  return result.count;
}

/**
 * P&L for an operation. Sums EVERY row, including `debt`.
 *
 * A borrow writes two rows -- `principal +1000` and `debt -1000` -- which cancel,
 * so borrowing contributes nothing and only the real costs remain. Filtering
 * `debt` out would leave the +1000 unopposed and report a loan as income; that
 * was the first version of this function and an integration run caught it
 * returning $988 where the answer was -$12.
 */
export async function getOperationPnL(operationId: string): Promise<number> {
  const result = await prisma.ledgerEntry.aggregate({
    where: { operationId },
    _sum: { valueUsd: true },
  });
  return result._sum.valueUsd ?? 0;
}

/**
 * Get P&L breakdown by category for an operation
 */
export async function getOperationBreakdown(operationId: string): Promise<Record<Category, number>> {
  const entries = await prisma.ledgerEntry.groupBy({
    by: ['category'],
    where: { operationId },
    _sum: { valueUsd: true },
  });

  const breakdown: Record<Category, number> = {
    principal: 0,
    reward: 0,
    interest: 0,
    debt: 0,
    dex_fee: 0,
    platform_fee: 0,
    network_fee: 0,
    execution_slippage: 0,
    rent_deposit: 0,
    rent_reclaim: 0,
    // Superseded; still initialised so historical rows report rather than
    // arrive as undefined in a breakdown a caller is summing.
    fee: 0,
    slippage: 0,
    gas: 0,
    cost: 0,
  };

  for (const entry of entries) {
    breakdown[entry.category as Category] = entry._sum.valueUsd ?? 0;
  }

  return breakdown;
}
