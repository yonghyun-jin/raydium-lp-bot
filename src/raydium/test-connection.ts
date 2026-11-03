// Test Raydium Connection

import { RaydiumClient } from './client';
import { config } from './config';

async function main() {
  console.log('='.repeat(50));
  console.log('Raydium Connection Test');
  console.log('='.repeat(50));

  try {
    // 1. Create client
    const client = new RaydiumClient();

    // 2. Initialize SDK
    await client.init();

    // 3. Check balances
    console.log('\n--- Wallet Balances ---');
    const solBalance = await client.getSolBalance();
    console.log(`SOL: ${solBalance.toFixed(4)}`);

    const usdcBalance = await client.getUsdcBalance();
    console.log(`USDC: ${usdcBalance.toFixed(2)}`);

    // 4. Get configured pool info
    if (config.pool.ID) {
      console.log('\n--- Configured Pool Info ---');
      console.log(`Pool ID: ${config.pool.ID}`);

      const poolInfo = await client.fetchPoolInfo(config.pool.ID);
      if (poolInfo) {
        console.log(`Pair: ${poolInfo.mintA.symbol}/${poolInfo.mintB.symbol}`);
        console.log(`Price: $${poolInfo.price.toFixed(4)}`);
        console.log(`TVL: $${poolInfo.tvl.toLocaleString()}`);
        console.log(`Fee: ${(poolInfo.feeRate * 100).toFixed(2)}%`);
        console.log(`Tick Current: ${poolInfo.tickCurrent}`);
        console.log(`Tick Spacing: ${poolInfo.tickSpacing}`);
      }
    } else {
      console.log('\n--- Finding SOL-USDC CLMM Pools ---');
      const pools = await client.getSolUsdcPools();

      if (pools.length === 0) {
        console.log('No SOL-USDC CLMM pools found');
      } else {
        console.log(`Found ${pools.length} pool(s):`);
        pools.slice(0, 5).forEach((pool: any, i: number) => {
          console.log(`\nPool ${i + 1}:`);
          console.log(`  ID: ${pool.id}`);
          console.log(`  TVL: $${(pool.tvl || 0).toLocaleString()}`);
          console.log(`  Fee: ${((pool.feeRate || 0) * 100).toFixed(2)}%`);
        });
      }
    }

    console.log('\n✅ Connection successful!');

  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  }
}

main();
