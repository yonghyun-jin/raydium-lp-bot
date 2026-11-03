/**
 * Reconcile recorded positions against the chain.
 *
 * The chain is the source of truth for EXISTENCE; every local record is a cache
 * of it. Three cases, of which the last had no handler anywhere:
 *
 *   chain o / record o   consistent, leave alone
 *   chain o / record x   present but unrecorded -- report, do not invent a record
 *   chain x / record o   recorded open, not on-chain  <- close the record
 *
 * Read-only by default. Pass --apply to write.
 *
 * This exists because `.orchestrator-state/positions.json` accumulated EIGHT
 * rows marked ACTIVE against ONE position on-chain -- and that one position was
 * not among them. Every DRY_RUN rehearsal wrote one. That store has since been
 * deleted along with the orchestrator CLI that was its only reader, so this now
 * reconciles Postgres alone -- but the branch it exists for, "recorded open and
 * absent on-chain", is not specific to any store and still has no other handler.
 */

import 'dotenv/config';
import { RaydiumClient } from '../src/raydium/client';
import { recordPositionClosed } from '../src/recording';

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(apply ? 'MODE: apply\n' : 'MODE: dry run (pass --apply to write)\n');

  const client = new RaydiumClient();
  await client.init();
  const onChain = new Set(
    (await client.getMyPositions()).map((p: any) => p.nftMint as string)
  );
  console.log(`on-chain positions: ${onChain.size}`);
  for (const m of onChain) console.log(`  ${m}`);

  // --- Postgres ---
  const { positionService } = await import('../src/db');
  const open = await positionService.getOpenPositions();
  console.log(`\npostgres rows marked open: ${open.length}`);

  let closed = 0;
  for (const row of open) {
    if (onChain.has(row.nftMint)) {
      console.log(`  KEEP  ${row.nftMint} (present on-chain)`);
      continue;
    }
    console.log(`  CLOSE ${row.nftMint} (recorded open, not on-chain)`);
    if (apply) {
      // No withdrawal figures: nothing was withdrawn, the position was never
      // there. Recording zeros would assert a settlement that did not happen.
      await recordPositionClosed(row.nftMint);
      closed++;
    }
  }

  // --- present on-chain but recorded nowhere ---
  const recorded = new Set(open.map((r) => r.nftMint));
  for (const m of onChain) {
    if (!recorded.has(m)) {
      console.log(
        `\nUNRECORDED on-chain position: ${m}\n` +
          '  Not adopted automatically: its open time is not recoverable from the\n' +
          '  chain, and inventing one would make a mature position look fresh.\n' +
          '  Adopt it from Telegram with /done, which records the adoption time.'
      );
    }
  }

  if (apply) console.log(`\ndone: ${closed} postgres row(s) closed`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('reconcile failed:', e?.message ?? e);
    process.exit(1);
  });
