// Test Position Creation with 50/50 Balance

import { RaydiumClient } from './client';
import { config, STRATEGY } from './config';

interface BalanceCalculation {
  currentSol: number;
  currentUsdc: number;
  currentPrice: number;
  solValueUsd: number;
  totalValueUsd: number;
  currentSolRatio: number;
  targetSolValue: number;
  targetUsdcValue: number;
  action: 'buy_sol' | 'sell_sol' | 'balanced';
  swapAmount: number;
  afterSwapSol: number;
  afterSwapUsdc: number;
}

/**
 * Calculate how much to swap for 50/50 balance
 */
function calculate5050Balance(
  solBalance: number,
  usdcBalance: number,
  solPrice: number
): BalanceCalculation {
  const solValueUsd = solBalance * solPrice;
  const totalValueUsd = solValueUsd + usdcBalance;
  const currentSolRatio = solValueUsd / totalValueUsd;

  const targetValue = totalValueUsd / 2; // 50% each
  const solDiff = solValueUsd - targetValue;

  let action: 'buy_sol' | 'sell_sol' | 'balanced';
  let swapAmount: number;
  let afterSwapSol: number;
  let afterSwapUsdc: number;

  if (Math.abs(solDiff) < 1) {
    // Within $1, consider balanced
    action = 'balanced';
    swapAmount = 0;
    afterSwapSol = solBalance;
    afterSwapUsdc = usdcBalance;
  } else if (solDiff > 0) {
    // Too much SOL, sell some
    action = 'sell_sol';
    const solToSell = solDiff / solPrice;
    swapAmount = solToSell;
    afterSwapSol = solBalance - solToSell;
    afterSwapUsdc = usdcBalance + solDiff; // Approximate (ignoring slippage for calc)
  } else {
    // Too much USDC, buy SOL
    action = 'buy_sol';
    const usdcToSwap = Math.abs(solDiff);
    swapAmount = usdcToSwap;
    afterSwapSol = solBalance + (usdcToSwap / solPrice);
    afterSwapUsdc = usdcBalance - usdcToSwap;
  }

  return {
    currentSol: solBalance,
    currentUsdc: usdcBalance,
    currentPrice: solPrice,
    solValueUsd,
    totalValueUsd,
    currentSolRatio,
    targetSolValue: targetValue,
    targetUsdcValue: targetValue,
    action,
    swapAmount,
    afterSwapSol,
    afterSwapUsdc,
  };
}

async function main() {
  console.log('='.repeat(60));
  console.log('Position Creation Test');
  console.log('='.repeat(60));

  const client = new RaydiumClient();
  await client.init();

  // 1. Get current state
  console.log('\n--- Step 1: Current State ---');
  const solBalance = await client.getSolBalance();
  const usdcBalance = await client.getUsdcBalance();
  const price = await client.getCurrentPrice(config.pool.ID);

  console.log(`SOL Balance:  ${solBalance.toFixed(4)} SOL`);
  console.log(`USDC Balance: ${usdcBalance.toFixed(2)} USDC`);
  console.log(`SOL Price:    $${price.toFixed(4)}`);

  // 2. Calculate 50/50 balance
  console.log('\n--- Step 2: 50/50 Calculation ---');

  // Reserve SOL for gas
  const availableSol = Math.max(0, solBalance - STRATEGY.MIN_SOL_RESERVE);
  console.log(`Reserved for gas: ${STRATEGY.MIN_SOL_RESERVE} SOL`);
  console.log(`Available SOL:    ${availableSol.toFixed(4)} SOL`);

  const calc = calculate5050Balance(availableSol, usdcBalance, price);

  console.log(`\nCurrent portfolio:`);
  console.log(`  SOL value:  $${calc.solValueUsd.toFixed(2)} (${(calc.currentSolRatio * 100).toFixed(1)}%)`);
  console.log(`  USDC value: $${calc.currentUsdc.toFixed(2)} (${((1 - calc.currentSolRatio) * 100).toFixed(1)}%)`);
  console.log(`  Total:      $${calc.totalValueUsd.toFixed(2)}`);

  console.log(`\nTarget (50/50):`);
  console.log(`  SOL value:  $${calc.targetSolValue.toFixed(2)} (50%)`);
  console.log(`  USDC value: $${calc.targetUsdcValue.toFixed(2)} (50%)`);

  console.log(`\nAction needed:`);
  if (calc.action === 'balanced') {
    console.log(`  ✅ Already balanced!`);
  } else if (calc.action === 'buy_sol') {
    console.log(`  📈 BUY SOL with $${calc.swapAmount.toFixed(2)} USDC`);
    console.log(`  Will get ~${(calc.swapAmount / price).toFixed(4)} SOL`);
  } else {
    console.log(`  📉 SELL ${calc.swapAmount.toFixed(4)} SOL for USDC`);
    console.log(`  Will get ~$${(calc.swapAmount * price).toFixed(2)} USDC`);
  }

  console.log(`\nAfter swap (estimated):`);
  console.log(`  SOL:  ${calc.afterSwapSol.toFixed(4)} SOL ($${(calc.afterSwapSol * price).toFixed(2)})`);
  console.log(`  USDC: ${calc.afterSwapUsdc.toFixed(2)} USDC`);

  // 3. Calculate position range
  console.log('\n--- Step 3: Position Range ---');
  const rangePercent = STRATEGY.RANGE_PERCENT;
  const priceLower = price * (1 - rangePercent);
  const priceUpper = price * (1 + rangePercent);

  console.log(`Range: ±${(rangePercent * 100).toFixed(1)}%`);
  console.log(`Lower: $${priceLower.toFixed(4)}`);
  console.log(`Upper: $${priceUpper.toFixed(4)}`);
  console.log(`Slippage: ${(STRATEGY.MAX_SLIPPAGE * 100).toFixed(1)}%`);

  // 4. Check if user wants to execute
  console.log('\n--- Step 4: Execute ---');

  if (!process.argv.includes('--execute')) {
    console.log('This is a DRY RUN. To execute:');
    console.log('  npm run test:create-position -- --execute');
    console.log('\n⚠️  This will:');
    console.log(`  1. Swap to 50/50 balance (if needed)`);
    console.log(`  2. Create LP position with ±${(rangePercent * 100).toFixed(1)}% range`);
    console.log(`  3. Lock your funds in the position`);
    return;
  }

  // Execute!
  console.log('\n⚠️  EXECUTING REAL TRANSACTION!');

  // Step 4a: Swap to 50/50 if needed
  if (calc.action !== 'balanced') {
    console.log('\n[Swap] Balancing to 50/50...');

    if (calc.action === 'buy_sol') {
      console.log(`[Swap] Buying SOL with $${calc.swapAmount.toFixed(2)} USDC...`);
      const result = await client.swapUsdcToSol(calc.swapAmount);
      console.log(`[Swap] Done! TX: ${result.txId}`);
    } else {
      console.log(`[Swap] Selling ${calc.swapAmount.toFixed(4)} SOL...`);
      const result = await client.swapSolToUsdc(calc.swapAmount);
      console.log(`[Swap] Done! TX: ${result.txId}`);
    }

    // Wait a moment for balance to update
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Get updated balances
  const newSolBalance = await client.getSolBalance();
  const newUsdcBalance = await client.getUsdcBalance();
  const availableForPosition = newSolBalance - STRATEGY.MIN_SOL_RESERVE;

  console.log('\n[Position] Updated balances:');
  console.log(`  SOL:  ${availableForPosition.toFixed(4)} (keeping ${STRATEGY.MIN_SOL_RESERVE} for gas)`);
  console.log(`  USDC: ${newUsdcBalance.toFixed(2)}`);

  // Step 4b: Create position
  console.log('\n[Position] Creating LP position...');
  console.log(`  Pool: ${config.pool.ID}`);
  console.log(`  Range: $${priceLower.toFixed(2)} - $${priceUpper.toFixed(2)}`);
  console.log(`  SOL: ${availableForPosition.toFixed(4)}`);
  console.log(`  USDC: ${newUsdcBalance.toFixed(2)}`);

  try {
    const result = await client.createPosition(
      config.pool.ID,
      availableForPosition,
      newUsdcBalance,
      priceLower,
      priceUpper
    );

    console.log('\n✅ Position created!');
    console.log(`  NFT Mint: ${result.nftMint}`);
    console.log(`  TX: ${result.txId}`);
  } catch (error: any) {
    console.error('\n❌ Position creation failed:', error.message);
    console.log('\nThis might be due to:');
    console.log('  - Insufficient balance');
    console.log('  - RPC rate limiting');
    console.log('  - SDK compatibility issue');
  }

  // Final balance check
  console.log('\n--- Final Balances ---');
  const finalSol = await client.getSolBalance();
  const finalUsdc = await client.getUsdcBalance();
  console.log(`SOL:  ${finalSol.toFixed(4)} (was ${solBalance.toFixed(4)})`);
  console.log(`USDC: ${finalUsdc.toFixed(2)} (was ${usdcBalance.toFixed(2)})`);

  console.log('\n✅ Test complete!');
}

main().catch(console.error);
