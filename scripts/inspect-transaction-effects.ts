/**
 * Read what real, already-landed transactions actually cost.
 *
 * READ ONLY. It sends nothing, signs nothing and spends nothing -- it reads
 * signatures this wallet has already produced and runs the C3 machinery over
 * them.
 *
 * WHY NOT DRY_RUN: a rehearsal never sends, so there is no signature, and
 * everything C3 added reads a LANDED transaction. DRY_RUN cannot reach this
 * code at all. Past transactions can, and they are free.
 *
 * SIGNATURES MUST BE NAMED, or come from our own ledger. There is no
 * wallet-history default: THIS LEDGER RECORDS THE LP STRATEGY, and a
 * transaction this bot did not send is not a strategy event. An earlier
 * version scanned the wallet and surfaced the operator's own transfers
 * between their wallets as though they were costs to explain.
 *
 *   npx ts-node scripts/inspect-transaction-effects.ts            # our recorded ones
 *   npx ts-node scripts/inspect-transaction-effects.ts <txId>...  # named ones
 */

import { RaydiumClient } from '../src/raydium/client';
import { PublicKey } from '@solana/web3.js';
import { prisma } from '../src/db';

function sol(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(9)}`;
}

async function main() {
  const client = new RaydiumClient();
  await client.init();

  const wallet = (client as any).wallet.publicKey as PublicKey;

  console.log(`Wallet: ${wallet.toString()}\n`);

  let signatures = process.argv.slice(2);

  if (signatures.length === 0) {
    const recorded = await prisma.ledgerEntry.findMany({
      distinct: ['txId'],
      select: { txId: true },
      orderBy: { timestamp: 'desc' },
      take: 10,
    });
    signatures = recorded.map((r) => r.txId).filter((t) => t && t !== 'DRY_RUN');

    if (signatures.length === 0) {
      console.log(
        'The ledger has no transactions yet, and there is no wallet scan to\n' +
          'fall back on. Name the signatures to inspect, or open a position first.'
      );
      return;
    }
    console.log(`Inspecting ${signatures.length} transaction(s) this bot recorded.\n`);
  }

  let unreadable = 0;

  for (const txId of signatures) {
    console.log('─'.repeat(72));
    console.log(txId);

    const effects = await client.getTransactionEffects(txId);

    if (!effects) {
      // Null is a real answer here: it means no cost rows may be written for
      // this transaction, not that it cost nothing.
      console.log('  UNREADABLE -- no rows could be booked for this one.\n');
      unreadable++;
      continue;
    }

    console.log(`  network_fee   SOL  ${sol(-effects.networkFeeSol)}`);
    console.log(`  rent_deposit  SOL  ${sol(-effects.rentDeposited)}`);
    console.log(`  rent_reclaim  SOL  ${sol(effects.rentReclaimed)}`);
    console.log(`  wallet SOL delta   ${sol(effects.solDelta)}`);

    const rentNet = effects.rentReclaimed - effects.rentDeposited;
    if (rentNet !== 0) {
      console.log(
        `  ^ rent did NOT net to zero (${sol(rentNet)}): an account this ` +
          `transaction touched is still holding, or gave back, lamports.`
      );
    }

    const tokens = Object.entries(effects.tokenDeltas);
    if (tokens.length === 0) {
      console.log('  no token movements for this wallet');
    }
    for (const [mint, delta] of tokens) {
      console.log(`  token ${mint.slice(0, 8)}…  ${delta >= 0 ? '+' : ''}${delta}`);
    }

    // What the SOL delta does NOT explain once the charges are removed. This is
    // the number the ledger has to account for with principal and reward rows.
    const unaccounted = effects.solDelta + effects.networkFeeSol + effects.rentDeposited - effects.rentReclaimed;
    console.log(`  => principal/reward must explain SOL ${sol(unaccounted)}`);
    console.log();
  }

  console.log('─'.repeat(72));
  console.log(
    `${signatures.length - unreadable}/${signatures.length} readable. ` +
      `Nothing was sent and nothing was spent.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
