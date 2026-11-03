import 'dotenv/config';
import { Connection } from '@solana/web3.js';
import { RaydiumClient } from '../src/raydium/client';

async function check() {
  const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

  const txId = process.argv[2];
  if (!txId) {
    console.error('Usage: npx ts-node scripts/check-position.ts <transaction signature>');
    process.exit(1);
  }

  console.log('Checking transaction:', txId);

  const status = await connection.getSignatureStatus(txId);
  console.log('Status:', status.value?.confirmationStatus);
  console.log('Error:', status.value?.err);

  const client = new RaydiumClient(false);
  await client.init();

  console.log('\nBalances:');
  console.log('  SOL:', (await client.getSolBalance()).toFixed(4));
  console.log('  USDC:', (await client.getUsdcBalance()).toFixed(2));

  console.log('\nChecking positions...');
  const positions = await client.getMyPositions();
  console.log('Found positions:', positions.length);

  for (const pos of positions) {
    console.log('\nPosition:');
    console.log('  NFT:', pos.nftMint);
    console.log('  Pool:', pos.poolId);
    console.log('  Range: $' + (pos.priceLower?.toFixed(2) || '?') + ' - $' + (pos.priceUpper?.toFixed(2) || '?'));
    console.log('  Liquidity:', pos.liquidity);

    const details = await client.getPositionDetails(pos.nftMint);
    if (details) {
      console.log('  In Range:', details.inRange);
      console.log('  SOL:', details.amountA?.toFixed(4));
      console.log('  USDC:', details.amountB?.toFixed(2));
      console.log('  Value: $' + details.totalValueUsd?.toFixed(2));
    }
  }
}

check().catch(console.error);
