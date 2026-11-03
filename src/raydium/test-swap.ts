// Test Swap Functions

import { RaydiumClient } from './client';
import { config } from './config';

async function main() {
  console.log('='.repeat(50));
  console.log('Swap Test (DRY RUN)');
  console.log('='.repeat(50));

  const client = new RaydiumClient();
  await client.init();

  // Check balances
  console.log('\n--- Current Balances ---');
  const solBalance = await client.getSolBalance();
  const usdcBalance = await client.getUsdcBalance();
  console.log(`SOL: ${solBalance.toFixed(4)}`);
  console.log(`USDC: ${usdcBalance.toFixed(2)}`);

  // Get current price
  const price = await client.getCurrentPrice(config.pool.ID);
  console.log(`\nSOL Price: $${price.toFixed(4)}`);

  // Calculate portfolio
  const solValue = solBalance * price;
  const totalValue = solValue + usdcBalance;
  const solRatio = (solValue / totalValue) * 100;

  console.log('\n--- Portfolio Analysis ---');
  console.log(`SOL value: $${solValue.toFixed(2)} (${solRatio.toFixed(1)}%)`);
  console.log(`USDC value: $${usdcBalance.toFixed(2)} (${(100 - solRatio).toFixed(1)}%)`);
  console.log(`Total: $${totalValue.toFixed(2)}`);

  // Calculate what's needed for 50/50
  const targetValue = totalValue / 2;
  const solDiff = solValue - targetValue;

  console.log('\n--- 50/50 Balance Calculation ---');
  if (Math.abs(solDiff) < 1) {
    console.log('Already balanced within $1!');
  } else if (solDiff > 0) {
    const solToSell = solDiff / price;
    console.log(`Need to SELL ${solToSell.toFixed(4)} SOL for USDC`);
    console.log(`This would give ~$${(solToSell * price).toFixed(2)} USDC`);
  } else {
    const usdcToSwap = Math.abs(solDiff);
    console.log(`Need to BUY SOL with $${usdcToSwap.toFixed(2)} USDC`);
    console.log(`This would give ~${(usdcToSwap / price).toFixed(4)} SOL`);
  }

  // Ask user if they want to execute
  console.log('\n--- Swap Test ---');
  console.log('To test a REAL swap, run with --execute flag');
  console.log('Example: npx ts-node src/raydium/test-swap.ts --execute');

  if (process.argv.includes('--execute')) {
    console.log('\n⚠️  EXECUTING REAL SWAP!');

    // Calculate small test amount (5% of imbalance or $5 max)
    const testAmount = Math.min(Math.abs(solDiff) * 0.05, 5);

    if (solDiff > 0) {
      const solToSell = testAmount / price;
      console.log(`Selling ${solToSell.toFixed(4)} SOL...`);

      try {
        const result = await client.swapSolToUsdc(solToSell);
        console.log(`✅ Swap complete! TX: ${result.txId}`);
      } catch (e) {
        console.error('❌ Swap failed:', e);
      }
    } else {
      console.log(`Buying SOL with $${testAmount.toFixed(2)} USDC...`);

      try {
        const result = await client.swapUsdcToSol(testAmount);
        console.log(`✅ Swap complete! TX: ${result.txId}`);
      } catch (e) {
        console.error('❌ Swap failed:', e);
      }
    }

    // Check new balances
    console.log('\n--- New Balances ---');
    const newSol = await client.getSolBalance();
    const newUsdc = await client.getUsdcBalance();
    console.log(`SOL: ${newSol.toFixed(4)} (was ${solBalance.toFixed(4)})`);
    console.log(`USDC: ${newUsdc.toFixed(2)} (was ${usdcBalance.toFixed(2)})`);
  }

  console.log('\n✅ Test complete!');
}

main().catch(console.error);
