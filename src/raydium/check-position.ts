import { PublicKey } from '@solana/web3.js';
import { Raydium } from '@raydium-io/raydium-sdk-v2';
import { config } from './config';

const POOL_ID = '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv';

async function main() {
  const connection = config.createConnection();
  const wallet = config.loadWallet();

  console.log('Initializing Raydium...');
  const raydium = await Raydium.load({
    connection,
    owner: wallet,
    cluster: 'mainnet',
    disableFeatureCheck: true,
  });

  // Get pool info
  console.log('\nFetching pool info...');
  const poolData = await raydium.clmm.getPoolInfoFromRpc(POOL_ID);
  const rpcPoolInfo = poolData.rpcPoolInfo as any;
  console.log('Pool sqrtPriceX64:', rpcPoolInfo.sqrtPriceX64?.toString());

  // Fetch from API for current price
  const apiRes = await fetch(`https://api-v3.raydium.io/pools/info/ids?ids=${POOL_ID}`);
  const apiData = await apiRes.json() as any;
  const pool = apiData.data[0];
  console.log('Current price from API:', pool.price);
  console.log('Current tick from API:', pool.tickCurrent);

  console.log('\nFetching positions...');
  const positions = await raydium.clmm.getOwnerPositionInfo({
    programId: new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'),
  });

  for (const pos of positions) {
    console.log('\n=== Position ===');
    console.log('NFT Mint:', pos.nftMint?.toString());
    console.log('Liquidity:', pos.liquidity?.toString());
    console.log('Tick Lower:', pos.tickLower, '| Tick Upper:', pos.tickUpper);
    console.log('Pool Current Tick:', pool.tickCurrent);

    const liquidity = parseFloat(pos.liquidity?.toString() || '0');
    const tickLower = pos.tickLower;
    const tickUpper = pos.tickUpper;
    const tickCurrent = pool.tickCurrent;

    // CLMM math for token amounts
    // sqrtPrice = 1.0001^(tick/2)
    const sqrtPriceLower = Math.pow(1.0001, tickLower / 2);
    const sqrtPriceUpper = Math.pow(1.0001, tickUpper / 2);
    const sqrtPriceCurrent = Math.pow(1.0001, tickCurrent / 2);

    console.log('\nSqrt prices:');
    console.log('  Lower:', sqrtPriceLower);
    console.log('  Upper:', sqrtPriceUpper);
    console.log('  Current:', sqrtPriceCurrent);

    // Calculate amounts (in "units" - need to apply decimals later)
    let amountA: number, amountB: number;

    if (tickCurrent < tickLower) {
      // All in token A
      amountA = liquidity * (1/sqrtPriceLower - 1/sqrtPriceUpper);
      amountB = 0;
      console.log('\nPosition below range - all token A');
    } else if (tickCurrent >= tickUpper) {
      // All in token B
      amountA = 0;
      amountB = liquidity * (sqrtPriceUpper - sqrtPriceLower);
      console.log('\nPosition above range - all token B');
    } else {
      // In range - mix
      amountA = liquidity * (1/sqrtPriceCurrent - 1/sqrtPriceUpper);
      amountB = liquidity * (sqrtPriceCurrent - sqrtPriceLower);
      console.log('\nPosition in range - mixed');
    }

    console.log('\nRaw amounts (before decimal adjustment):');
    console.log('  Amount A (SOL raw):', amountA);
    console.log('  Amount B (USDC raw):', amountB);

    // Token decimals: SOL = 9, USDC = 6
    // The "price" in ticks uses decimal-adjusted prices
    // We need to account for the decimal difference
    const decimalsA = 9;  // SOL
    const decimalsB = 6;  // USDC

    // The sqrtPrice in CLMM is actually sqrt(price * 10^(decimalsB - decimalsA))
    // So we need to adjust back
    const decimalDiff = decimalsB - decimalsA;  // 6 - 9 = -3

    // Amount A in actual SOL = raw / 10^decimalsA
    // Amount B in actual USDC = raw / 10^decimalsB
    // But the liquidity is scaled, so we need to find the right factor

    // Try different scaling approaches
    console.log('\nTrying decimal adjustments:');

    // Approach 1: Simple division
    const solSimple = amountA / Math.pow(10, decimalsA);
    const usdcSimple = amountB / Math.pow(10, decimalsB);
    console.log('  Simple: SOL =', solSimple, ', USDC =', usdcSimple);

    // Approach 2: Account for decimal diff in sqrt
    const sqrtDecimalFactor = Math.pow(10, decimalDiff / 2);  // 10^(-1.5)
    const solAdj = amountA / sqrtDecimalFactor / Math.pow(10, decimalsA);
    const usdcAdj = amountB * sqrtDecimalFactor / Math.pow(10, decimalsB);
    console.log('  Adjusted: SOL =', solAdj, ', USDC =', usdcAdj);

    // Approach 3: Use Q64 format factor
    // Raydium stores sqrtPrice in Q64.64 format, so there's a 2^64 factor
    const Q64 = Math.pow(2, 64);
    const sqrtPriceX64 = BigInt(rpcPoolInfo.sqrtPriceX64?.toString() || '0');
    const sqrtPriceFromX64 = Number(sqrtPriceX64) / Q64;
    console.log('  sqrtPriceX64 converted:', sqrtPriceFromX64);

    // Recalculate with proper sqrtPrice
    const sqrtLowerX64 = Math.pow(1.0001, tickLower / 2);
    const sqrtUpperX64 = Math.pow(1.0001, tickUpper / 2);
    const sqrtCurrentX64 = sqrtPriceFromX64;

    let amtA3: number, amtB3: number;
    if (tickCurrent < tickLower) {
      amtA3 = liquidity * (1/sqrtLowerX64 - 1/sqrtUpperX64);
      amtB3 = 0;
    } else if (tickCurrent >= tickUpper) {
      amtA3 = 0;
      amtB3 = liquidity * (sqrtUpperX64 - sqrtLowerX64);
    } else {
      amtA3 = liquidity * (1/sqrtCurrentX64 - 1/sqrtUpperX64);
      amtB3 = liquidity * (sqrtCurrentX64 - sqrtLowerX64);
    }

    console.log('  X64 approach: SOL raw =', amtA3, ', USDC raw =', amtB3);
    console.log('  X64 approach: SOL =', amtA3 / Math.pow(10, decimalsA), ', USDC =', amtB3 / Math.pow(10, decimalsB));

    // Expected values from Raydium UI
    console.log('\n📊 Expected from Raydium UI:');
    console.log('  SOL: ~7.96');
    console.log('  USDC: ~1392.46');
    console.log('  Total: ~$2043');
  }
}

main().catch(console.error);
