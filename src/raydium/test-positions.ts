// Test getting positions

import { RaydiumClient } from './client';
import { config } from './config';

async function main() {
  console.log('='.repeat(50));
  console.log('Testing Position Management');
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
  console.log('\n--- Current Price ---');
  const price = await client.getCurrentPrice(config.pool.ID);
  console.log(`SOL/USDC: $${price.toFixed(4)}`);

  // Calculate value
  const solValue = solBalance * price;
  const totalValue = solValue + usdcBalance;
  const solRatio = (solValue / totalValue) * 100;

  console.log('\n--- Portfolio Value ---');
  console.log(`SOL value: $${solValue.toFixed(2)}`);
  console.log(`USDC value: $${usdcBalance.toFixed(2)}`);
  console.log(`Total: $${totalValue.toFixed(2)}`);
  console.log(`SOL ratio: ${solRatio.toFixed(1)}%`);

  // Calculate ideal range
  const rangePercent = config.strategy.RANGE_PERCENT;
  const priceLower = price * (1 - rangePercent);
  const priceUpper = price * (1 + rangePercent);

  console.log('\n--- Ideal Position Range (±1%) ---');
  console.log(`Lower: $${priceLower.toFixed(4)}`);
  console.log(`Upper: $${priceUpper.toFixed(4)}`);

  // Try to get positions
  console.log('\n--- Checking Positions ---');
  try {
    const positions = await client.getMyPositions();
    if (positions.length === 0) {
      console.log('No existing CLMM positions found');
    } else {
      console.log(`Found ${positions.length} position(s):`);
      positions.forEach((pos: any, i: number) => {
        console.log(`\nPosition ${i + 1}:`);
        console.log(`  NFT: ${pos.nftMint}`);
        console.log(`  Pool: ${pos.poolId}`);
        console.log(`  Liquidity: ${pos.liquidity}`);
      });
    }
  } catch (e) {
    console.log('Error getting positions:', e);
  }

  console.log('\n✅ Test complete!');
}

main().catch(console.error);
