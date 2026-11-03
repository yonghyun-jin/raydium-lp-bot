/**
 * Turning a money event into ledger rows.
 *
 * Kept apart from the Orchestrator because the arithmetic is the interesting
 * part and it is easier to be sure of on its own. One rule governs all of it:
 *
 *   THE ROWS MUST SUM TO WHAT ACTUALLY MOVED.
 *
 * That is what makes `SUM(value_usd)` a real P&L rather than a plausible one,
 * and it is why the close is not the obvious decomposition -- see below.
 *
 * There is NO catch-all category. A balance change the rows do not account for
 * is a missing instruction effect, and `verifyEffects` at the recording
 * boundary turns it into a failed check rather than a plausible expense. See
 * docs/v1/scopes/C3-execution-costs.md.
 *
 * Still not booked here: RENT. It is refundable, so it is two events
 * (rent_deposit / rent_reclaim) that need the account creations and closures
 * out of `innerInstructions` -- taking it as leftover SOL would be the
 * catch-all this design exists to avoid.
 */

import type { LedgerMovement } from '../recording';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** USDC is the unit of account here; one row's price is 1 by definition. */
const USDC_PRICE = 1;

/**
 * Opening a position: both legs leave the wallet.
 *
 * Negative amounts, because the ledger's sign convention is the WALLET's: money
 * going into a position is money leaving the wallet.
 */
export function openPositionRows(input: {
  solDeposited: number;
  usdcDeposited: number;
  solPriceUsd: number;
  priceSource: string;
  positionId: string;
  /**
   * What the transaction charged, from its own meta.
   *
   * WITHOUT THESE THE OPEN AND THE CLOSE ARE MEASURED DIFFERENTLY, and the
   * difference is not cosmetic: the open books the amounts the SDK says it
   * deposited while the close books an observed wallet delta, so the network
   * fee and the position account's rent leave the wallet on the open and are
   * booked nowhere, while the SAME rent comes back inside the close's delta
   * and reads as profit. A completed cycle then reports better than it was.
   */
  networkFeeSol?: number;
  rentDeposited?: number;
  rentReclaimed?: number;
}): LedgerMovement[] {
  const rows: LedgerMovement[] = [];

  if (input.solDeposited > 0) {
    rows.push({
      action: 'create_lp',
      category: 'principal',
      token: 'SOL',
      tokenAddress: SOL_MINT,
      amount: -input.solDeposited,
      priceUsd: input.solPriceUsd,
      priceSource: input.priceSource,
      positionId: input.positionId,
      description: 'deposited into the position',
    });
  }

  if (input.usdcDeposited > 0) {
    rows.push({
      action: 'create_lp',
      category: 'principal',
      token: 'USDC',
      tokenAddress: USDC_MINT,
      amount: -input.usdcDeposited,
      priceUsd: USDC_PRICE,
      priceSource: input.priceSource,
      positionId: input.positionId,
      description: 'deposited into the position',
    });
  }

  const sol = { token: 'SOL' as const, mint: SOL_MINT, price: input.solPriceUsd };
  const cost = (
    category: LedgerMovement['category'],
    amount: number,
    description: string
  ) => {
    if (!amount) return;
    rows.push({
      action: 'create_lp',
      category,
      token: sol.token,
      tokenAddress: sol.mint,
      amount,
      priceUsd: sol.price,
      priceSource: input.priceSource,
      positionId: input.positionId,
      description,
    });
  };

  cost('network_fee', -(input.networkFeeSol ?? 0), 'transaction fee, priority fee included');
  // Opening a CLMM position creates accounts -- the position NFT and its token
  // account at least -- and their rent leaves the wallet HERE. It comes back at
  // the close, which is why the pair exists rather than one cost.
  cost('rent_deposit', -(input.rentDeposited ?? 0), 'rent locked in accounts this transaction created');
  cost('rent_reclaim', input.rentReclaimed ?? 0, 'rent returned by accounts this transaction closed');

  return rows;
}

/**
 * Closing a position: principal and fees arrive TOGETHER, in one movement.
 *
 * This is the part that is easy to get wrong. `solWithdrawn` and `usdcWithdrawn`
 * are wallet deltas, and a close returns the principal AND the collected fees in
 * the same transfer -- so booking the full delta as `principal` and then the
 * fees as `reward` counts the fees twice, and the position reads as more
 * profitable than it was.
 *
 * The rows are therefore `delta - fee` as principal plus `fee` as reward, which
 * sums back to the delta: the total is what actually arrived, and the split says
 * how much of it was earned.
 *
 * When the fees could not be read, the whole delta is booked as principal and NO
 * reward row is written. That understates earnings rather than inventing them,
 * and it keeps the sum true either way -- the P&L total is right, only the
 * attribution is lost. A `reward` row of 0 would instead assert the position
 * earned nothing.
 */
export function closePositionRows(input: {
  solWithdrawn: number | null;
  usdcWithdrawn: number | null;
  feeSol: number | undefined;
  feeUsdc: number | undefined;
  solPriceUsd: number;
  priceSource: string;
  positionId: string;
  /**
   * What the transaction charged and returned, from its own meta.
   *
   * These change what `principal` MEANS on the SOL leg. The withdrawal delta
   * already has the network fee subtracted and the reclaimed rent added, so
   * booking it whole as principal reports the rent as money the position
   * earned back. Pulling both out leaves principal as the actual principal.
   */
  networkFeeSol?: number;
  rentDeposited?: number;
  rentReclaimed?: number;
}): LedgerMovement[] {
  const rows: LedgerMovement[] = [];

  const networkFeeSol = input.networkFeeSol ?? 0;
  const rentReclaimed = input.rentReclaimed ?? 0;
  const rentDeposited = input.rentDeposited ?? 0;

  const leg = (
    delta: number | null,
    fee: number | undefined,
    token: 'SOL' | 'USDC',
    mint: string,
    priceUsd: number
  ) => {
    // A delta we could not read is not a movement of zero; it is a movement we
    // cannot describe. Booking it as 0 would assert nothing came back.
    if (delta === null) return;

    const earned = fee ?? 0;

    // The SOL delta is not just principal and fees. The network took its fee
    // out of it and the closed accounts put their rent back into it, so both
    // are removed here and booked as their own rows below. Leaving them in
    // would make "principal returned" include rent we never earned -- and the
    // principal/reward split is the only thing that could show impermanent
    // loss, so corrupting it costs more than the dollars involved.
    const chargesInThisLeg = token === 'SOL' ? rentReclaimed - networkFeeSol - rentDeposited : 0;
    const principal = delta - earned - chargesInThisLeg;

    if (principal !== 0) {
      rows.push({
        action: 'close_lp',
        category: 'principal',
        token,
        tokenAddress: mint,
        amount: principal,
        priceUsd,
        priceSource: input.priceSource,
        positionId: input.positionId,
        description: 'withdrawn from the position',
      });
    }

    if (earned > 0) {
      rows.push({
        action: 'close_lp',
        category: 'reward',
        token,
        tokenAddress: mint,
        amount: earned,
        priceUsd,
        priceSource: input.priceSource,
        positionId: input.positionId,
        description: 'fees accrued while in range',
      });
    }
  };

  leg(input.solWithdrawn, input.feeSol, 'SOL', SOL_MINT, input.solPriceUsd);
  leg(input.usdcWithdrawn, input.feeUsdc, 'USDC', USDC_MINT, USDC_PRICE);

  // Only written when the SOL leg was readable: these come out of the same
  // delta, and booking them against a delta we could not read would make the
  // rows claim a movement nobody measured.
  if (input.solWithdrawn !== null) {
    const sol = { token: 'SOL' as const, mint: SOL_MINT, price: input.solPriceUsd };
    const cost = (
      category: LedgerMovement['category'],
      amount: number,
      description: string
    ) => {
      if (!amount) return;
      rows.push({
        action: 'close_lp',
        category,
        token: sol.token,
        tokenAddress: sol.mint,
        amount,
        priceUsd: sol.price,
        priceSource: input.priceSource,
        positionId: input.positionId,
        description,
      });
    };

    cost('network_fee', -networkFeeSol, 'transaction fee, priority fee included');
    cost('rent_reclaim', rentReclaimed, 'rent returned by accounts this transaction closed');
    cost('rent_deposit', -rentDeposited, 'rent locked in accounts this transaction created');
  }

  return rows;
}

/**
 * A swap, decomposed into who charged what.
 *
 * THE SHAPE, and why it is not the obvious one:
 *
 *   principal  SOL    -1.000000      sent
 *   principal  USDC +150.000000      the QUOTED output -- gross, not what arrived
 *   dex_fee    USDC   -0.030000      the pools' cut
 *   platform   USDC   -0.010000      Jupiter's own
 *   slippage   USDC   -0.010000      quote vs fill, net of the stated fees
 *   network    SOL    -0.000005      meta.fee
 *
 * The principal row carries the GROSS amount and the costs are their own rows,
 * so the per-token sum still equals what the wallet really moved (+149.95
 * USDC) while every charge is visible and queryable. Booking the NET amount
 * and then also booking a cost row would double-count -- that is the mistake
 * C1 removed, and it was right THEN because there was no quote to decompose
 * against. Decomposition is only correct when the parts sum to the whole, which
 * is why `verifyEffects` runs at the recording boundary in the same change.
 *
 * FEES ARE ONLY BOOKED IN A TOKEN THE WALLET ACTUALLY MOVED. `routePlan[]` is
 * per hop and each hop names its own `feeMint`; on a multi-hop route that can
 * be an intermediate token which never touched this wallet. A row denominated
 * in such a token would make that token's rows sum to something non-zero while
 * its real delta is zero -- breaking the very invariant this decomposition
 * exists to satisfy. Fees in unmoved tokens are therefore left inside the
 * quote-vs-fill gap, where they are still counted, just not separately named.
 *
 * `execution_slippage` is DEFINED as quoted-out minus actual-out minus the fees
 * booked above. It is NOT a catch-all: it is bounded to the output token, and
 * anything that moved which we did not model at all is caught by
 * `verifyEffects` against the chain's own deltas, not swept in here. The two
 * catch different failures and only the second is allowed to be silent.
 *
 * `priceImpactPct` is not here at all. It is a quote-time estimate, not a
 * measurement, and it lives in the preserved quote.
 */
export function swapRows(input: {
  direction: 'SOL_TO_USDC' | 'USDC_TO_SOL';
  /** What the wallet actually sent. */
  amountIn: number;
  /** What the wallet actually received. */
  amountOut: number;
  /** The router's promised output, in UI units. Absent means no decomposition. */
  quotedOut?: number;
  /** Stated fees, in the OUTPUT token's UI units. Anything charged in another token is not here. */
  dexFee?: number;
  platformFee?: number;
  /** meta.fee, in SOL. Charged in SOL whichever way the swap ran. */
  networkFeeSol?: number;
  /**
   * Rent locked up and released by this transaction, in SOL.
   *
   * TWO numbers, never a net one. They usually cancel -- Jupiter's
   * wrapAndUnwrapSol opens a wSOL account and closes it in the same
   * transaction -- and netting them first would hide that the wallet ever
   * locked anything up. When they do NOT cancel, an account is still open and
   * holding our lamports, which is a fact worth being able to query.
   */
  rentDeposited?: number;
  rentReclaimed?: number;
  /**
   * Whether the route stated any fee at all. False means the pool's cut is
   * inside `quotedOut` with nothing naming it, so the slippage row below is
   * carrying it -- which the row says, rather than implying the swap was free.
   */
  feesReported?: boolean;
  solPriceUsd: number;
  priceSource: string;
}): LedgerMovement[] {
  const solToUsdc = input.direction === 'SOL_TO_USDC';

  const spent = solToUsdc
    ? { token: 'SOL' as const, mint: SOL_MINT, price: input.solPriceUsd }
    : { token: 'USDC' as const, mint: USDC_MINT, price: USDC_PRICE };
  const received = solToUsdc
    ? { token: 'USDC' as const, mint: USDC_MINT, price: USDC_PRICE }
    : { token: 'SOL' as const, mint: SOL_MINT, price: input.solPriceUsd };

  const rows: LedgerMovement[] = [];

  const row = (
    category: LedgerMovement['category'],
    leg: { token: 'SOL' | 'USDC'; mint: string; price: number },
    amount: number,
    description: string
  ) => {
    if (amount === 0) return;
    rows.push({
      action: 'swap',
      category,
      token: leg.token,
      tokenAddress: leg.mint,
      amount,
      priceUsd: leg.price,
      priceSource: input.priceSource,
      description,
    });
  };

  if (input.amountIn > 0) {
    row('principal', spent, -input.amountIn, 'sent');
  }

  const dexFee = input.dexFee ?? 0;
  const platformFee = input.platformFee ?? 0;

  if (input.quotedOut === undefined) {
    // No quote to decompose against. Book what arrived and nothing else --
    // inventing a zero fee would assert the route charged nothing.
    if (input.amountOut > 0) {
      row('principal', received, input.amountOut, 'received; no quote preserved');
    }
  } else if (input.amountOut > 0) {
    // Gross first, then each charge, so the rows still sum to what arrived.
    row(
      'principal',
      received,
      input.quotedOut,
      `quoted ${input.quotedOut.toFixed(6)}, received ${input.amountOut.toFixed(6)}`
    );
    row('dex_fee', received, -dexFee, 'pool fees on the route');
    row('platform_fee', received, -platformFee, 'router fee');

    // Whatever the fill missed the quote by, beyond the charges that were
    // actually stated. Bounded to this token by construction.
    const slippage = input.quotedOut - input.amountOut - dexFee - platformFee;
    row(
      'execution_slippage',
      received,
      -slippage,
      input.feesReported === false
        ? 'quote vs fill; the route stated no fees, so any pool cut is inside this figure'
        : 'quote vs fill, net of stated fees'
    );
  }

  const sol = { token: 'SOL' as const, mint: SOL_MINT, price: input.solPriceUsd };

  if (input.networkFeeSol) {
    row('network_fee', sol, -input.networkFeeSol, 'transaction fee, priority fee included');
  }

  if (input.rentDeposited) {
    row('rent_deposit', sol, -input.rentDeposited, 'rent locked in accounts this transaction created');
  }
  if (input.rentReclaimed) {
    row('rent_reclaim', sol, input.rentReclaimed, 'rent returned by accounts this transaction closed');
  }

  return rows;
}

/** Base units -> UI units. SOL is 9 decimals, USDC 6. */
function ui(base: string | number | undefined, decimals: number): number | undefined {
  if (base === undefined || base === null) return undefined;
  const n = typeof base === 'string' ? Number(base) : base;
  return Number.isFinite(n) ? n / Math.pow(10, decimals) : undefined;
}

/**
 * Pull the decomposable numbers out of a Jupiter quote.
 *
 * Everything returned is in the OUTPUT token's UI units, because that is the
 * only denomination the resulting rows may use -- see the note on swapRows.
 *
 * `routePlan[]` is per hop and each hop names its own `feeMint`. A fee charged
 * in an intermediate token never touched this wallet, so booking a row in it
 * would make that token's rows sum to something while its real delta is zero.
 * Such hops are SKIPPED here rather than converted at a guessed rate: their
 * cost is still inside the quote-vs-fill gap, just not separately named, and a
 * fabricated conversion would be a worse answer than an unnamed one.
 */
export function readQuote(
  quote: unknown,
  outputMint: string,
  outputDecimals: number
): { quotedOut?: number; dexFee?: number; platformFee?: number; feesReported?: boolean } {
  if (!quote || typeof quote !== 'object') return {};
  const q = quote as Record<string, any>;

  const quotedOut = ui(q.outAmount, outputDecimals);

  let dexFee: number | undefined;
  /*
   * Did the route state its fees AT ALL?
   *
   * Three different situations used to collapse into `dexFee === undefined`,
   * and therefore into "no fee row": a route that charged nothing, a route
   * whose fee was charged in some other token, and a route that simply did not
   * SAY. The last one is the common case -- a single-hop Jupiter quote came
   * back with `feeAmount: undefined, feeMint: undefined`, so the ledger
   * recorded that nobody charged anything for a swap the pool had certainly
   * taken its cut on, inside `outAmount`.
   *
   * Reporting zero where the answer is unknown is the one thing this project
   * does not do. The number cannot be recovered -- the router never sent it --
   * so what is recorded instead is that it is missing.
   */
  let feesReported = false;
  if (Array.isArray(q.routePlan)) {
    for (const hop of q.routePlan) {
      const info = hop?.swapInfo ?? hop;
      if (!info) continue;
      const amount = ui(info.feeAmount, outputDecimals);
      if (amount === undefined || info.feeMint === undefined || info.feeMint === null) continue;
      // The hop stated a fee. Whether it lands in a row depends on the token.
      feesReported = true;
      // Only hops whose fee is charged in the output token can become a row.
      if (info.feeMint !== outputMint) continue;
      dexFee = (dexFee ?? 0) + amount;
    }
  }

  // Jupiter's platform fee is denominated in the output mint.
  const platformFee = ui(q.platformFee?.amount, outputDecimals);
  if (platformFee !== undefined) feesReported = true;

  return { quotedOut, dexFee, platformFee, feesReported };
}

export const MINTS = { SOL: SOL_MINT, USDC: USDC_MINT } as const;
