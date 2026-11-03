// Benchmark timing and costs for each operation

import { RaydiumClient } from './client';
import { config } from './config';

interface BenchmarkResult {
  operation: string;
  timeMs: number;
  estimatedGasSol: number;
  estimatedGasUsd: number;
  notes: string;
}

async function benchmark() {
  console.log('='.repeat(60));
  console.log('LP Bot Operations Benchmark');
  console.log('='.repeat(60));

  const client = new RaydiumClient();
  const results: BenchmarkResult[] = [];
  let solPrice = 0;

  // 1. Initialize SDK
  console.log('\n[1] Initializing SDK...');
  let start = Date.now();
  await client.init();
  let elapsed = Date.now() - start;
  results.push({
    operation: 'SDK Initialize',
    timeMs: elapsed,
    estimatedGasSol: 0,
    estimatedGasUsd: 0,
    notes: 'One-time startup cost',
  });
  console.log(`    Time: ${elapsed}ms`);

  // 2. Get SOL Balance
  console.log('\n[2] Get SOL Balance...');
  start = Date.now();
  const solBalance = await client.getSolBalance();
  elapsed = Date.now() - start;
  results.push({
    operation: 'Get SOL Balance',
    timeMs: elapsed,
    estimatedGasSol: 0,
    estimatedGasUsd: 0,
    notes: 'RPC call, no gas',
  });
  console.log(`    Time: ${elapsed}ms, Balance: ${solBalance.toFixed(4)} SOL`);

  // 3. Get USDC Balance
  console.log('\n[3] Get USDC Balance...');
  start = Date.now();
  const usdcBalance = await client.getUsdcBalance();
  elapsed = Date.now() - start;
  results.push({
    operation: 'Get USDC Balance',
    timeMs: elapsed,
    estimatedGasSol: 0,
    estimatedGasUsd: 0,
    notes: 'RPC call, no gas',
  });
  console.log(`    Time: ${elapsed}ms, Balance: ${usdcBalance.toFixed(2)} USDC`);

  // 4. Get Price from API
  console.log('\n[4] Get Price (API)...');
  start = Date.now();
  solPrice = await client.getCurrentPrice(config.pool.ID);
  elapsed = Date.now() - start;
  results.push({
    operation: 'Get Price (API)',
    timeMs: elapsed,
    estimatedGasSol: 0,
    estimatedGasUsd: 0,
    notes: 'Raydium API call, no gas',
  });
  console.log(`    Time: ${elapsed}ms, Price: $${solPrice.toFixed(4)}`);

  // 5. Get Pool Info from API
  console.log('\n[5] Get Pool Info (API)...');
  start = Date.now();
  await client.fetchPoolInfo(config.pool.ID);
  elapsed = Date.now() - start;
  results.push({
    operation: 'Get Pool Info (API)',
    timeMs: elapsed,
    estimatedGasSol: 0,
    estimatedGasUsd: 0,
    notes: 'Raydium API call, no gas',
  });
  console.log(`    Time: ${elapsed}ms`);

  // 6. Get Pool Info from Chain (RPC)
  console.log('\n[6] Get Pool Info (Chain/RPC)...');
  start = Date.now();
  try {
    await client.getPoolInfoFromChain(config.pool.ID);
    elapsed = Date.now() - start;
    results.push({
      operation: 'Get Pool Info (RPC)',
      timeMs: elapsed,
      estimatedGasSol: 0,
      estimatedGasUsd: 0,
      notes: 'On-chain read, no gas',
    });
    console.log(`    Time: ${elapsed}ms`);
  } catch (e) {
    elapsed = Date.now() - start;
    results.push({
      operation: 'Get Pool Info (RPC)',
      timeMs: elapsed,
      estimatedGasSol: 0,
      estimatedGasUsd: 0,
      notes: 'Failed - rate limited',
    });
    console.log(`    Time: ${elapsed}ms (failed - rate limited)`);
  }

  // Estimated costs (from Solana docs and typical transactions)
  const estimatedCosts: BenchmarkResult[] = [
    {
      operation: 'Swap (Jupiter)',
      timeMs: 3000, // typical
      estimatedGasSol: 0.0001,
      estimatedGasUsd: 0.0001 * solPrice,
      notes: 'Includes priority fee',
    },
    {
      operation: 'Create Position',
      timeMs: 5000, // typical
      estimatedGasSol: 0.003,
      estimatedGasUsd: 0.003 * solPrice,
      notes: 'Creates NFT + position accounts',
    },
    {
      operation: 'Close Position',
      timeMs: 4000, // typical
      estimatedGasSol: 0.002,
      estimatedGasUsd: 0.002 * solPrice,
      notes: 'Decrease liquidity + close',
    },
    {
      operation: 'Full Rebalance',
      timeMs: 12000, // close + swap + create
      estimatedGasSol: 0.006,
      estimatedGasUsd: 0.006 * solPrice,
      notes: 'Close + Swap + Create new',
    },
  ];

  // Print results table
  console.log('\n' + '='.repeat(60));
  console.log('BENCHMARK RESULTS');
  console.log('='.repeat(60));

  console.log('\n--- Measured Operations (Read-only) ---');
  console.log('| Operation | Time (ms) | Gas (SOL) | Gas ($) | Notes |');
  console.log('|-----------|-----------|-----------|---------|-------|');
  for (const r of results) {
    console.log(
      `| ${r.operation.padEnd(20)} | ${r.timeMs.toString().padStart(6)} | ${r.estimatedGasSol.toFixed(6)} | $${r.estimatedGasUsd.toFixed(4)} | ${r.notes} |`
    );
  }

  console.log('\n--- Estimated Transaction Costs ---');
  console.log('| Operation | Time (ms) | Gas (SOL) | Gas ($) | Notes |');
  console.log('|-----------|-----------|-----------|---------|-------|');
  for (const r of estimatedCosts) {
    console.log(
      `| ${r.operation.padEnd(20)} | ${r.timeMs.toString().padStart(6)} | ${r.estimatedGasSol.toFixed(6)} | $${r.estimatedGasUsd.toFixed(4)} | ${r.notes} |`
    );
  }

  // Calculate monitoring interval analysis
  console.log('\n--- Monitoring Interval Analysis ---');
  const totalReadTime = results.filter(r => r.operation.includes('Get')).reduce((sum, r) => sum + r.timeMs, 0);
  console.log(`Total read operations time: ~${totalReadTime}ms`);
  console.log(`\nInterval comparison:`);
  console.log(`  60s interval: ${60000 / totalReadTime} checks possible, safe for RPC limits`);
  console.log(`  15s interval: ${15000 / totalReadTime} checks possible, may hit rate limits`);
  console.log(`  30s interval: ${30000 / totalReadTime} checks possible, good balance`);

  // Return data for MD generation
  return { results, estimatedCosts, solPrice, totalReadTime };
}

benchmark().catch(console.error);
