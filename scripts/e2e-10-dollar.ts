/**
 * $10 end-to-end test on Solana mainnet.
 *
 * Usage:
 *   npx ts-node scripts/e2e-10-dollar.ts                  # dry run (default, spends nothing)
 *   ALLOW_REAL_MONEY=true npx ts-node scripts/e2e-10-dollar.ts --execute
 *   ALLOW_REAL_MONEY=true npx ts-node scripts/e2e-10-dollar.ts --close <nftMint>
 *
 * The dry run builds the real transaction against live pool state and simulates
 * it. Nothing proceeds to --execute until a dry run comes back clean.
 */

import dotenv from 'dotenv';
import { Connection, PublicKey } from '@solana/web3.js';

import { RaydiumClient } from '../src/raydium/client';
import { Orchestrator } from '../src/orchestrator/Orchestrator';
import { getRangePrediction, validatePrediction } from '../src/orchestrator/prediction';
import config from '../src/raydium/config';

dotenv.config();

const INVESTMENT_USD = 10;
const CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const CLOSE_INDEX = args.indexOf('--close');
const CLOSE_MINT = CLOSE_INDEX >= 0 ? args[CLOSE_INDEX + 1] : null;

function heading(text: string): void {
  console.log(`\n${'='.repeat(64)}\n${text}\n${'='.repeat(64)}`);
}

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) {
    throw new Error(`Pre-flight failed: ${label}${detail ? ` (${detail})` : ''}`);
  }
}

/**
 * Pre-flight for the CLOSE path.
 *
 * The create path's preflight cannot be reused: it asserts that NO position is
 * open in the pool, which is the precondition a close inverts. Skipping preflight
 * altogether -- which is what this script used to do -- meant the one irreversible
 * command ran with none of the safety checks the create path gets, including the
 * devnet check.
 */
async function closePreflight(client: RaydiumClient, nftMint: string) {
  heading('PRE-FLIGHT (CLOSE)');

  check('Not pointed at devnet', !config.network.IS_DEVNET, config.network.RPC_URL.split('/')[2]);

  const positions = await client.getMyPositions();
  const target = positions.find((p: any) => p.nftMint?.toString?.() === nftMint);
  check('Position is owned by this wallet', target !== undefined, `${positions.length} position(s) in wallet`);

  const details = await client.getPositionDetails(nftMint);
  if (details) {
    console.log(
      `  Holding: ${details.amountA?.toFixed(6) ?? '?'} SOL + ${details.amountB?.toFixed(2) ?? '?'} USDC` +
        ` = $${details.totalValueUsd?.toFixed(2) ?? '?'}  (inRange: ${details.inRange})`
    );
  } else {
    // null here is ambiguous -- not-owned, pool info unavailable, or an RPC
    // error -- so report it rather than asserting the position is gone.
    console.log('  Could not read position details (RPC error, or position not readable). Proceeding.');
  }

  const sol = await client.getSolBalance();
  check('SOL covers the close transaction fees', sol >= 0.01, `${sol.toFixed(4)} SOL`);

  return details;
}

async function preflight(client: RaydiumClient, poolId: string) {
  heading('PRE-FLIGHT');

  check('Not pointed at devnet', !config.network.IS_DEVNET, config.network.RPC_URL.split('/')[2]);

  const connection = config.createConnection();
  const poolAccount = await connection.getAccountInfo(new PublicKey(poolId));
  check('Pool account exists', poolAccount !== null);
  check(
    'Pool is a CLMM pool',
    poolAccount!.owner.toBase58() === CLMM_PROGRAM,
    poolAccount!.owner.toBase58()
  );

  const sol = await client.getSolBalance();
  const usdc = await client.getUsdcBalance();
  const price = await client.getCurrentPrice(poolId);
  console.log(`  Wallet: ${sol.toFixed(4)} SOL + ${usdc.toFixed(2)} USDC  @ $${price.toFixed(2)}/SOL`);

  // Rent (~0.0035) + priority fees + Jito tip + the gas reserve, with margin.
  check('SOL covers rent, fees and reserve', sol >= 0.1, `${sol.toFixed(4)} SOL`);
  check('USDC covers the position', usdc >= INVESTMENT_USD + 2, `${usdc.toFixed(2)} USDC`);

  const existing = await client.getMyPositions();
  const inThisPool = existing.filter((p: any) => p.poolId?.toString?.() === poolId);
  check('No open position in this pool', inThisPool.length === 0, `${inThisPool.length} found`);

  heading('PREDICTION');
  const prediction = await getRangePrediction(price);
  const validation = validatePrediction(prediction);

  console.log(`  Source:  ${prediction.source}`);
  console.log(`  Range:   $${prediction.lower.toFixed(2)} - $${prediction.upper.toFixed(2)} (${prediction.width_pct.toFixed(2)}% wide)`);
  console.log(`  Ratio:   ${(prediction.sol_ratio * 100).toFixed(1)}% SOL / ${(prediction.usdc_ratio * 100).toFixed(1)}% USDC`);

  check('Range is the fixed v0 range', prediction.source === 'fixed');
  check('Prediction is valid', validation.valid, validation.errors.join(', '));

  const marginLow = (price - prediction.lower) / price;
  const marginHigh = (prediction.upper - price) / price;
  check('Range brackets spot by >=1% each side', marginLow >= 0.01 && marginHigh >= 0.01,
    `-${(marginLow * 100).toFixed(2)}% / +${(marginHigh * 100).toFixed(2)}%`);

  const solLeg = (INVESTMENT_USD * prediction.sol_ratio) / price;
  const usdcLeg = INVESTMENT_USD * prediction.usdc_ratio;
  console.log(`\n  Plan: deposit ~${solLeg.toFixed(6)} SOL + ~${usdcLeg.toFixed(2)} USDC  (~$${INVESTMENT_USD})`);

  return { price, prediction };
}

async function main(): Promise<void> {
  const poolId = process.env.POOL_ID;
  if (!poolId) throw new Error('POOL_ID is not set');

  const dryRun = !EXECUTE;
  if (dryRun) {
    process.env.DRY_RUN = 'true';
  }

  heading(`$${INVESTMENT_USD} END-TO-END  [${dryRun ? 'DRY RUN — nothing will be sent' : 'LIVE — REAL MONEY'}]`);

  const client = new RaydiumClient();
  await client.init();

  if (CLOSE_MINT) {
    await closePreflight(client, CLOSE_MINT);

    heading(`CLOSING ${CLOSE_MINT}`);
    const before = { sol: await client.getSolBalance(), usdc: await client.getUsdcBalance() };
    const result = await client.closePosition(CLOSE_MINT);
    console.log(`  tx: ${result.txId}`);
    const after = { sol: await client.getSolBalance(), usdc: await client.getUsdcBalance() };
    console.log(`  Recovered: ${(after.sol - before.sol).toFixed(6)} SOL, ${(after.usdc - before.usdc).toFixed(6)} USDC`);
    return;
  }

  await preflight(client, poolId);

  heading(dryRun ? 'SIMULATING' : 'EXECUTING');
  const orchestrator = new Orchestrator({ minSolReserve: 0.05, allowFallback: false }, client);
  const result = await orchestrator.createNewPosition({
    poolId,
    investmentUsd: INVESTMENT_USD,
    duration: 0,
  });

  heading('RESULT');
  console.log(`  Job code:  ${result.operationId}`);
  console.log(`  NFT mint:  ${result.nftMint}`);
  console.log(`  Tx:        ${result.txId}`);
  console.log(`  Range:     $${result.priceLower.toFixed(2)} - $${result.priceUpper.toFixed(2)}`);
  console.log(`  Ratio:     ${result.solRatio.toFixed(1)}% SOL / ${result.usdcRatio.toFixed(1)}% USDC`);
  console.log(`  Deposited: $${result.valueUsd.toFixed(2)}`);
  console.log(`  Source:    ${result.source}`);

  if (dryRun) {
    console.log('\n  Dry run clean. Re-run with ALLOW_REAL_MONEY=true --execute to spend.');
    return;
  }

  heading('ON-CHAIN VERIFICATION (independent of the code under test)');
  const connection = new Connection(config.network.RPC_URL, 'confirmed');
  const tx = await connection.getTransaction(result.txId, { maxSupportedTransactionVersion: 0 });
  check('Transaction found on-chain', tx !== null);
  check('Transaction has no error', tx!.meta?.err === null, JSON.stringify(tx!.meta?.err));
  const nftHeld = (tx!.meta?.postTokenBalances || []).some(
    (b) => b.mint === result.nftMint && b.uiTokenAmount.uiAmount === 1
  );
  check('Position NFT minted to the wallet', nftHeld);

  const details = await client.getPositionDetails(result.nftMint);
  check('Position readable on-chain', details !== null);
  check('Position is in range', details!.inRange === true);
  check(
    'Deposited value is ~$10',
    Math.abs(details!.totalValueUsd - INVESTMENT_USD) / INVESTMENT_USD < 0.05,
    `$${details!.totalValueUsd.toFixed(2)}`
  );

  // --execute matters: without it DRY_RUN is set, and the close now simulates
  // and refuses rather than sending. The old form of this line omitted it.
  console.log(`\n  To rehearse the close: npx ts-node scripts/e2e-10-dollar.ts --close ${result.nftMint}`);
  console.log(`  To close for real:     ALLOW_REAL_MONEY=true npx ts-node scripts/e2e-10-dollar.ts --execute --close ${result.nftMint}`);
}

main().catch((error) => {
  console.error(`\nFAILED: ${error?.message ?? error}`);
  process.exit(1);
});
