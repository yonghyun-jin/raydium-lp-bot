// Deposit sizing against the SDK's integer maths.

import { PoolUtils } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';

/**
 * Refine a deposit against the SDK's own integer maths.
 *
 * sizeDeposit() works in float64, and `sqrtPb - sqrtP` is a difference of two
 * nearly-equal numbers, so it UNDERSTATES the USDC a position needs -- by
 * ~0.07% on a +/-10% range and ~0.69% on +/-1% (measured against this pool).
 * At 0.1% slippage that is enough to fail with 6017 on the first attempt and
 * burn a transaction discovering it.
 *
 * PoolUtils.getLiquidityAmountOutFromAmountIn runs the same integer maths as
 * the on-chain program, so its `amountB` is the real requirement. We quote,
 * and if the answer does not fit the USDC budget we scale the SOL leg and
 * re-quote. Amounts are linear in liquidity, so this converges immediately.
 */
export async function refineDepositWithSdk(params: {
  poolInfo: any;
  epochInfo: any;
  tickLower: number;
  tickUpper: number;
  solAmount: number;
  usdcAvailable: number;
  slippage: number;
  decimalsA: number;
  decimalsB: number;
}): Promise<{ baseAmount: BN; otherAmountMax: BN; liquidity: BN; solAmount: number; requiredUsdc: number }> {
  const { poolInfo, epochInfo, tickLower, tickUpper, usdcAvailable, slippage, decimalsA, decimalsB } = params;

  const usdcBudget = usdcAvailable / (1 + slippage);
  let solAmount = params.solAmount;

  for (let attempt = 0; attempt < 3; attempt++) {
    const baseAmount = new BN(Math.floor(solAmount * Math.pow(10, decimalsA)));
    if (baseAmount.lten(0)) {
      throw new Error('Deposit scaled to zero while fitting the USDC budget');
    }

    const quote: any = await PoolUtils.getLiquidityAmountOutFromAmountIn({
      poolInfo,
      slippage: 0,
      inputA: true,
      tickUpper,
      tickLower,
      amount: baseAmount,
      add: true,
      amountHasFee: false,
      epochInfo,
    } as any);

    const requiredUsdc = Number(quote.amountB.amount.toString()) / Math.pow(10, decimalsB);

    if (requiredUsdc <= usdcBudget) {
      return {
        baseAmount,
        otherAmountMax: new BN(Math.ceil(requiredUsdc * (1 + slippage) * Math.pow(10, decimalsB))),
        liquidity: quote.liquidity,
        solAmount,
        requiredUsdc,
      };
    }

    // Scale the SOL leg to fit, with a hair of headroom for the re-quote.
    solAmount *= (usdcBudget / requiredUsdc) * 0.999;
  }

  throw new Error('Could not fit the deposit to the available USDC after 3 quotes');
}
