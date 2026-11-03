/**
 * Take one reading of every open position and store it.
 *
 * READ-ONLY against the chain and additive against Postgres: it calls
 * `getPositionDetails`, which this bot already runs every 30 seconds, and
 * writes the result to the position's `last_*` columns. No transaction is
 * built and no `assertSendAllowed` is reachable from here -- nothing it does
 * can spend.
 *
 * Why it exists: the monitor fills those columns on its own, but only once the
 * bot has been redeployed with the write. Until then an open position has
 * never been read into Postgres and the dashboard can only say "unknown",
 * which is true and useless. One run of this makes the panel honest
 * immediately, and the monitor keeps it fresh afterwards.
 */

import 'dotenv/config';
import { RaydiumClient } from '../src/raydium/client';
import { recordPositionReading } from '../src/recording';
import { prisma } from '../src/db';

async function main(): Promise<void> {
  const open = await prisma.position.findMany({
    where: { isOpen: true },
    select: { nftMint: true, operationId: true },
  });

  if (open.length === 0) {
    console.log('No open positions.');
    return;
  }

  const client = new RaydiumClient();
  await client.init();

  for (const { nftMint, operationId } of open) {
    const details = await client.getPositionDetails(nftMint);

    if (!details) {
      console.log(`${nftMint}  NOT FOUND on-chain -- left unread`);
      continue;
    }

    // Both legs or nothing. Half a fee figure is not a fee figure, and a null
    // here must reach the operator as "unreadable", never as zero.
    const feesUsd =
      details.feeA === null || details.feeB === null
        ? null
        : details.feeA * details.currentPrice + details.feeB;

    const stored = await recordPositionReading(nftMint, {
      price: details.currentPrice,
      solAmount: details.amountA,
      usdcAmount: details.amountB,
      feesUsd,
      inRange: details.inRange,
      at: new Date(),
    });

    console.log(
      `${nftMint}  ${operationId ?? '(no operation)'}\n` +
        `  price $${details.currentPrice.toFixed(2)}  ` +
        `holds ${details.amountA.toFixed(6)} SOL + ${details.amountB.toFixed(2)} USDC  ` +
        `fees ${feesUsd === null ? 'unreadable' : '$' + feesUsd.toFixed(2)}  ` +
        `${details.inRange ? 'in range' : 'OUT OF RANGE'}\n` +
        `  stored: ${stored ? 'yes' : 'NO -- the dashboard will still say unknown'}`
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
