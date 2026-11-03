/**
 * Run Monitoring Loop
 *
 * This script starts the orchestrator monitoring loop to:
 * 1. Check existing LP positions
 * 2. Monitor for out-of-range conditions
 * 3. Auto-rebalance when needed
 *
 * Usage:
 *   npx ts-node scripts/run-monitor.ts
 *   npx ts-node scripts/run-monitor.ts --interval 60  (check every 60 seconds)
 */

import 'dotenv/config';
import { RaydiumClient } from '../src/raydium/client';

// Default check interval (30 seconds)
const DEFAULT_INTERVAL = 30000;

async function main() {
  console.log('='.repeat(60));
  console.log('LP Position Monitor');
  console.log('='.repeat(60));

  // Parse command line args
  const args = process.argv.slice(2);
  let checkInterval = DEFAULT_INTERVAL;

  const intervalIndex = args.indexOf('--interval');
  if (intervalIndex !== -1 && args[intervalIndex + 1]) {
    checkInterval = parseInt(args[intervalIndex + 1]) * 1000;
  }

  console.log(`Check interval: ${checkInterval / 1000} seconds`);

  // Initialize client to check positions
  console.log('\nInitializing Raydium client...');
  const client = new RaydiumClient(false);
  await client.init();

  const walletAddress = client.getWalletAddress();
  console.log(`Wallet: ${walletAddress}`);

  // Check balances
  console.log('\nBalances:');
  const solBalance = await client.getSolBalance();
  const usdcBalance = await client.getUsdcBalance();
  console.log(`  SOL:  ${solBalance.toFixed(4)}`);
  console.log(`  USDC: ${usdcBalance.toFixed(2)}`);

  // Check existing positions
  console.log('\nChecking positions...');
  const positions = await client.getMyPositions();
  console.log(`Found ${positions.length} position(s)`);

  if (positions.length === 0) {
    console.log('\nNo positions to monitor.');
    console.log('Create a position first:');
    console.log('  1. Via Raydium UI: https://raydium.io/clmm/pools/');
    console.log('  2. Via test script: npx ts-node scripts/test-lp-flow.ts --execute');
    console.log('\nOr run in demo mode to see how monitoring works:');
    console.log('  npx ts-node scripts/run-monitor.ts --demo');

    if (args.includes('--demo')) {
      console.log('\n--- DEMO MODE ---');
      await runDemoMonitor(client, checkInterval);
    }
    return;
  }

  // Display position details
  for (const pos of positions) {
    console.log(`\nPosition: ${pos.nftMint}`);
    console.log(`  Pool: ${pos.poolId}`);
    console.log(`  Range: $${pos.priceLower?.toFixed(2) || '?'} - $${pos.priceUpper?.toFixed(2) || '?'}`);

    const details = await client.getPositionDetails(pos.nftMint);
    if (details) {
      console.log(`  Status: ${details.inRange ? 'IN RANGE' : 'OUT OF RANGE'}`);
      console.log(`  Current Price: $${details.currentPrice.toFixed(4)}`);
      console.log(`  SOL: ${details.amountA.toFixed(4)}`);
      console.log(`  USDC: ${details.amountB.toFixed(2)}`);
      console.log(`  Value: $${details.totalValueUsd.toFixed(2)}`);
      console.log(
        details.feeA === null || details.feeB === null
          ? '  Pending Fees: unknown (could not read pool/tick accounts)'
          : `  Pending Fees: ${details.feeA.toFixed(6)} SOL, ${details.feeB.toFixed(4)} USDC`
      );
    }
  }

  // Start monitoring loop
  console.log('\n' + '='.repeat(60));
  console.log('Starting monitoring loop...');
  console.log('Press Ctrl+C to stop');
  console.log('='.repeat(60));

  await runMonitorLoop(client, positions, checkInterval);
}

async function runMonitorLoop(
  client: RaydiumClient,
  initialPositions: any[],
  interval: number
) {
  let iteration = 0;

  while (true) {
    iteration++;
    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] Check #${iteration}`);

    try {
      // Get fresh position data
      const positions = await client.getMyPositions();

      if (positions.length === 0) {
        console.log('  No positions found');
        await sleep(interval);
        continue;
      }

      for (const pos of positions) {
        const details = await client.getPositionDetails(pos.nftMint);
        if (!details) continue;

        const status = details.inRange ? 'IN_RANGE' : 'OUT_OF_RANGE';
        const statusEmoji = details.inRange ? '✓' : '⚠';

        console.log(`  ${statusEmoji} ${pos.nftMint.slice(0, 8)}... | ` +
          `$${details.priceLower.toFixed(2)}-$${details.priceUpper.toFixed(2)} | ` +
          `Current: $${details.currentPrice.toFixed(2)} | ` +
          `${status}`);

        if (!details.inRange) {
          console.log(`    ACTION NEEDED: Position out of range`);
          console.log(`    Price ${details.currentPrice < details.priceLower ? 'below' : 'above'} range`);
          // In auto mode, would trigger rebalance here
        }
      }
    } catch (error: any) {
      console.error(`  Error: ${error.message}`);
    }

    await sleep(interval);
  }
}

async function runDemoMonitor(client: RaydiumClient, interval: number) {
  console.log('\nSimulating position monitoring...');

  // Get current SOL price
  const poolId = '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv';
  let currentPrice = await client.getCurrentPrice(poolId);

  // Simulated position
  const simPosition = {
    nftMint: 'DEMO_' + Math.random().toString(36).slice(2, 10),
    priceLower: currentPrice * 0.98,
    priceUpper: currentPrice * 1.02,
  };

  console.log(`\nSimulated Position: ${simPosition.nftMint}`);
  console.log(`  Range: $${simPosition.priceLower.toFixed(2)} - $${simPosition.priceUpper.toFixed(2)}`);

  let iteration = 0;
  while (true) {
    iteration++;
    const timestamp = new Date().toISOString();

    try {
      currentPrice = await client.getCurrentPrice(poolId);
    } catch {
      // Use slightly random price if API fails
      currentPrice = currentPrice * (1 + (Math.random() - 0.5) * 0.002);
    }

    const inRange = currentPrice >= simPosition.priceLower && currentPrice <= simPosition.priceUpper;
    const status = inRange ? 'IN_RANGE' : 'OUT_OF_RANGE';
    const statusEmoji = inRange ? '✓' : '⚠';

    console.log(`[${timestamp}] #${iteration} | ` +
      `Price: $${currentPrice.toFixed(2)} | ` +
      `Range: $${simPosition.priceLower.toFixed(2)}-$${simPosition.priceUpper.toFixed(2)} | ` +
      `${statusEmoji} ${status}`);

    if (!inRange) {
      console.log(`  ⚡ Would trigger rebalance...`);
    }

    await sleep(interval);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nMonitoring stopped.');
  process.exit(0);
});

main().catch((error) => {
  console.error('\nError:', error.message);
  process.exit(1);
});
