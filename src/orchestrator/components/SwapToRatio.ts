// SwapToRatio - Swap wallet balance to target ratio (not hardcoded 50/50)

import { LpClient, SwapPriceGuard, TransactionEffects } from '../../raydium/LpClient';
import { calculateDepositRatio } from '../../raydium/clmmMath';
import { SwapResult } from '../types';

export interface SwapDetails extends SwapResult {
  direction: 'SOL_TO_USDC' | 'USDC_TO_SOL';
  /**
   * The POOL-MID expectation, `amountIn x currentPrice`. Kept for the console
   * line it has always printed, but it is NOT the slippage baseline -- the
   * router's own promise is, and it lives in `quote.outAmount`. The two answer
   * different questions and conflating them was the original mistake.
   */
  expectedOut: number;
  actualOut?: number;
  slippageCost?: number;
  priceAtSwap: number;
  /** What the router promised, verbatim. Absent if it could not be preserved. */
  quote?: unknown;
  /** What the transaction actually did to the wallet, or null if unreadable. */
  effects?: TransactionEffects | null;
}

export class SwapToRatio {
  private client: LpClient;
  private minSolReserve: number;  // SOL reserve for gas
  /**
   * Allowance added when buying the missing leg, so the swap's own slippage
   * does not leave the position a fraction short. Matches the Jupiter
   * tolerance in src/raydium/config.ts (MAX_SLIPPAGE).
   */
  private swapSlippage: number;

  constructor(client: LpClient, minSolReserve: number = 0.05, swapSlippage: number = 0.003) {
    this.client = client;
    this.minSolReserve = minSolReserve;
    this.swapSlippage = swapSlippage;
  }

  /**
   * Balance current holdings to target SOL ratio
   * @param poolId - Pool ID for price lookup
   * @param targetSolRatio - Target SOL ratio (0.0 to 1.0), e.g., 0.45 for 45% SOL
   * @param threshold - What % difference triggers swap (default 2%)
   */
  async execute(
    poolId: string,
    targetSolRatio: number = 0.5,
    threshold: number = 0.005,
    opts: { budgetUsd?: number } = {}
  ): Promise<SwapDetails | null> {
    // Validate target ratio
    if (targetSolRatio < 0 || targetSolRatio > 1) {
      throw new Error(`Invalid targetSolRatio: ${targetSolRatio}. Must be between 0 and 1.`);
    }

    // 1. Get current balances
    const solBalance = await this.client.getSolBalance();
    const usdcBalance = await this.client.getUsdcBalance();
    const currentPrice = await this.client.getCurrentPrice(poolId);

    // The price that SIZED the trade also becomes the reference the quote is
    // checked against. That is deliberate: a router disagreeing with the pool
    // we are about to deposit into is the disagreement that matters, whatever
    // either of them thinks the "real" price is.
    //
    // Built here rather than at each call site because BOTH branches swap --
    // the budgeted one that covers a missing leg, and the ratio one below --
    // and a guard attached to only one of them is the half-protection that
    // reads as protection.
    const priceGuard: SwapPriceGuard = {
      referencePrice: currentPrice,
      poolFeeRate: (await this.client.getPoolFeeRate(poolId)) ?? 0,
    };

    // Exclude SOL for gas
    const availableSol = Math.max(0, solBalance - this.minSolReserve);

    if (availableSol <= 0 && usdcBalance <= 0) {
      console.log('[SwapToRatio] No funds available');
      return null;
    }

    const solValue = availableSol * currentPrice;
    const walletValue = solValue + usdcBalance;
    const currentSolRatio = walletValue > 0 ? solValue / walletValue : 0;

    console.log(`[SwapToRatio] Current balance:`);
    console.log(`  - SOL: ${availableSol.toFixed(4)} ($${solValue.toFixed(2)})`);
    console.log(`  - USDC: ${usdcBalance.toFixed(2)}`);
    console.log(`  - Current SOL ratio: ${(currentSolRatio * 100).toFixed(1)}%`);
    console.log(`  - Target SOL ratio:  ${(targetSolRatio * 100).toFixed(1)}%`);

    // 2. A budget changes the question entirely.
    //
    //    Without one, we are rebalancing the whole wallet to a ratio. With one,
    //    we only need the wallet to HOLD the two legs of a position of that
    //    size -- and a large wallet usually already does, so no swap is needed.
    //    Rebalancing the whole wallet for a $10 position would have sold ~$196
    //    of SOL out of a $1,000 wallet to hit a ratio only $10 of it would use.
    if (opts.budgetUsd !== undefined) {
      const budget = Math.min(opts.budgetUsd, walletValue);
      const neededSol = (budget * targetSolRatio) / currentPrice;
      const neededUsdc = budget * (1 - targetSolRatio);

      const solShortfall = Math.max(0, neededSol - availableSol);
      const usdcShortfall = Math.max(0, neededUsdc - usdcBalance);

      console.log(
        `[SwapToRatio] Budget $${budget.toFixed(2)} needs ` +
          `${neededSol.toFixed(6)} SOL + ${neededUsdc.toFixed(2)} USDC`
      );

      if (solShortfall === 0 && usdcShortfall === 0) {
        console.log('[SwapToRatio] Wallet already holds both legs, no swap needed');
        return null;
      }
      if (solShortfall > 0 && usdcShortfall > 0) {
        throw new Error(
          `Cannot fund a $${budget.toFixed(2)} position: short ` +
            `${solShortfall.toFixed(6)} SOL and ${usdcShortfall.toFixed(2)} USDC`
        );
      }

      // Cover exactly the missing leg, plus the swap's own slippage allowance.
      if (solShortfall > 0) {
        const usdcToSpend = Math.min(solShortfall * currentPrice * (1 + this.swapSlippage), usdcBalance);
        return this.buySol(usdcToSpend, currentPrice, solBalance, priceGuard);
      }
      const solToSell = Math.min(
        (usdcShortfall * (1 + this.swapSlippage)) / currentPrice,
        availableSol
      );
      return this.sellSol(solToSell, currentPrice, usdcBalance, priceGuard);
    }

    // 3. No swap needed if within threshold
    if (Math.abs(currentSolRatio - targetSolRatio) <= threshold) {
      console.log(`[SwapToRatio] Already balanced (within ${threshold * 100}% threshold)`);
      return null;
    }

    const totalValue = walletValue;

    // 4. Calculate target values
    const targetSolValue = totalValue * targetSolRatio;
    const targetUsdcValue = totalValue * (1 - targetSolRatio);

    // 5. Execute swap
    if (solValue > targetSolValue) {
      return this.sellSol((solValue - targetSolValue) / currentPrice, currentPrice, usdcBalance, priceGuard);
    }
    return this.buySol(usdcBalance - targetUsdcValue, currentPrice, solBalance, priceGuard);
  }

  /** Sell SOL for USDC and report what actually came back. */
  private async sellSol(
    solToSell: number,
    currentPrice: number,
    usdcBefore: number,
    priceGuard: SwapPriceGuard
  ): Promise<SwapDetails> {
    const expectedUsdc = solToSell * currentPrice;
    console.log(`[SwapToRatio] Selling ${solToSell.toFixed(6)} SOL for ~$${expectedUsdc.toFixed(2)} USDC`);

    // expectedUsdc is what this swap is worth; passing it caps the swap by
    // MAX_POSITION_USD instead of leaving it unbounded.
    const result = await this.client.swapSolToUsdc(solToSell, expectedUsdc, priceGuard);
    const effects = await this.client.getTransactionEffects(result.txId);

    const actualOut = (await this.client.getUsdcBalance()) - usdcBefore;
    const slippageCost = expectedUsdc - actualOut;
    console.log(
      `[SwapToRatio] Expected: $${expectedUsdc.toFixed(2)}, ` +
        `Actual: $${actualOut.toFixed(2)}, Slippage: $${slippageCost.toFixed(2)}`
    );

    return {
      txId: result.txId,
      amountIn: solToSell,
      amountOut: actualOut,
      direction: 'SOL_TO_USDC',
      expectedOut: expectedUsdc,
      actualOut,
      slippageCost,
      priceAtSwap: currentPrice,
      quote: result.quote,
      effects,
    };
  }

  /** Buy SOL with USDC and report what actually came back. */
  private async buySol(
    usdcToSpend: number,
    currentPrice: number,
    solBefore: number,
    priceGuard: SwapPriceGuard
  ): Promise<SwapDetails> {
    const expectedSol = usdcToSpend / currentPrice;
    console.log(`[SwapToRatio] Buying ~${expectedSol.toFixed(6)} SOL with ${usdcToSpend.toFixed(2)} USDC`);

    const result = await this.client.swapUsdcToSol(usdcToSpend, usdcToSpend, priceGuard);
    const effects = await this.client.getTransactionEffects(result.txId);

    const actualOut = (await this.client.getSolBalance()) - solBefore;
    const slippageCost = (expectedSol - actualOut) * currentPrice;
    console.log(
      `[SwapToRatio] Expected: ${expectedSol.toFixed(6)} SOL, ` +
        `Actual: ${actualOut.toFixed(6)} SOL, Slippage: $${slippageCost.toFixed(2)}`
    );

    return {
      txId: result.txId,
      amountIn: usdcToSpend,
      amountOut: actualOut,
      direction: 'USDC_TO_SOL',
      expectedOut: expectedSol,
      actualOut,
      slippageCost,
      priceAtSwap: currentPrice,
      quote: result.quote,
      effects,
    };
  }

  /**
   * Get balances after swap
   */
  async getBalances(poolId: string): Promise<{
    sol: number;
    usdc: number;
    solValue: number;
    ratio: number;
  }> {
    const sol = await this.client.getSolBalance();
    const usdc = await this.client.getUsdcBalance();
    const price = await this.client.getCurrentPrice(poolId);

    const availableSol = Math.max(0, sol - this.minSolReserve);
    const solValue = availableSol * price;
    const totalValue = solValue + usdc;

    return {
      sol: availableSol,
      usdc,
      solValue,
      ratio: totalValue > 0 ? solValue / totalValue : 0,
    };
  }

  /**
   * Calculate required deposit ratio for an asymmetric price range
   * Uses correct CLMM/Uniswap V3 math
   *
   * @param currentPrice - Current price
   * @param priceLower - Lower bound price
   * @param priceUpper - Upper bound price
   * @returns { solRatio, usdcRatio } - Target ratios (0 to 1)
   */
  static calculateDepositRatio(
    currentPrice: number,
    priceLower: number,
    priceUpper: number
  ): { solRatio: number; usdcRatio: number } {
    return calculateDepositRatio(currentPrice, priceLower, priceUpper);
  }

  /**
   * How much of each asset to actually deploy.
   *
   * Without `budgetUsd` this returns the whole wallet (minus the gas reserve),
   * which is the historical behaviour. With it, the position is capped at that
   * USD value and split by `targetSolRatio`, so asking for $10 deploys $10
   * rather than everything the wallet happens to hold.
   */
  async getDeployable(
    poolId: string,
    targetSolRatio: number,
    budgetUsd?: number
  ): Promise<{ sol: number; usdc: number; price: number; valueUsd: number }> {
    const { sol, usdc, solValue } = await this.getBalances(poolId);
    const price = await this.client.getCurrentPrice(poolId);

    if (budgetUsd === undefined) {
      return { sol, usdc, price, valueUsd: solValue + usdc };
    }
    if (!(budgetUsd > 0)) {
      throw new Error(`Invalid budgetUsd: ${budgetUsd}. Must be positive.`);
    }

    const wantedSol = (budgetUsd * targetSolRatio) / price;
    const wantedUsdc = budgetUsd * (1 - targetSolRatio);

    // Never promise more than the wallet holds; the sizing solver downstream
    // will scale the position to whatever is actually fundable.
    const deployableSol = Math.min(sol, wantedSol);
    const deployableUsdc = Math.min(usdc, wantedUsdc);

    return {
      sol: deployableSol,
      usdc: deployableUsdc,
      price,
      valueUsd: deployableSol * price + deployableUsdc,
    };
  }
}
