/**
 * What moves this wallet's money that the ledger has no name for.
 *
 * READ ONLY. Sends nothing, signs nothing, spends nothing.
 *
 * THIS EXISTS TO MAKE C3 FINITE. Costs were being found one at a time by
 * reading transactions, which is accurate and has no visible end. This buckets
 * every instruction that moves our money by (program, type) and marks each
 * bucket modelled or not; whatever comes back unmodelled IS the remaining work
 * -- a list, not a stream.
 *
 * IT READS ONLY TRANSACTIONS THIS BOT SENT -- the signatures in our own
 * ledger. It does NOT scan the wallet.
 *
 * That is the same rule the ledger itself follows and it is not a detail:
 * THIS LEDGER RECORDS THE LP STRATEGY. The operator moving their own money
 * between wallets is not a strategy event, and a sweep that went looking
 * through wallet history would surface those transfers as though they were
 * costs to explain. An earlier version did exactly that, and three of the four
 * destinations it flagged turned out to be the operator's own wallets.
 *
 *   npx ts-node scripts/reconcile-costs.ts [delayMs]
 *
 * SOLANA_RPC_URL points at the public mainnet endpoint, which rate-limits
 * getParsedTransaction hard. Hence the throttle, and hence a transaction that
 * fails is COUNTED rather than fatal -- a partial sweep that says how partial
 * it is beats a complete one that never finishes.
 */

import { RaydiumClient } from '../src/raydium/client';
import { PublicKey } from '@solana/web3.js';
import { prisma } from '../src/db';

/**
 * Instruction kinds C3 already turns into rows.
 *
 * `system/transfer` is deliberately NOT here. This project's transactions
 * carry one of ~0.0137 SOL to a third party that looks like the Jito tip --
 * three times the rent -- and it has no category yet. Listing it as modelled
 * would hide exactly what this script is for.
 */
const MODELLED = new Set([
  'system/createAccount',
  'system/createAccountWithSeed',
  'spl-token/closeAccount',
  'spl-token/transfer',
  'spl-token/transferChecked',
  'spl-associated-token-account/create',
  'spl-associated-token-account/createIdempotent',
  'system/allocate',
  'system/assign',
]);

interface Bucket {
  count: number;
  /** Lamports leaving this wallet. A cost only ever lives here. */
  solOut: number;
  /** Lamports arriving. Funding and refunds, not costs. */
  solIn: number;
  examples: string[];
  /** Where outgoing lamports went, biggest first. Names the Jito tip accounts. */
  destinations: Map<string, number>;
}

async function main() {
  const delayMs = Number(process.argv[2] ?? 400);
  const pause = () => new Promise((r) => setTimeout(r, delayMs));

  const client = new RaydiumClient();
  await client.init();

  const wallet = (client as any).wallet.publicKey as PublicKey;
  const connection = (client as any).connection;
  const me = wallet.toString();

  // Our own records, not the wallet's history. A transaction we never sent is
  // not ours to explain.
  const recorded = await prisma.ledgerEntry.findMany({
    distinct: ['txId'],
    select: { txId: true },
    orderBy: { timestamp: 'desc' },
  });
  const landed = recorded
    .map((r) => ({ signature: r.txId }))
    .filter((r) => r.signature && r.signature !== 'DRY_RUN');

  console.log(`Wallet ${me}`);
  console.log(`${landed.length} transaction(s) this bot recorded\n`);

  if (landed.length === 0) {
    console.log(
      'Nothing to reconcile: the ledger has no transactions yet. That is an\n' +
        'honest answer, not an error -- there is no wallet scan to fall back on,\n' +
        'because a transaction this bot did not send is not a strategy event.'
    );
    return;
  }

  const buckets = new Map<string, Bucket>();
  let unreadable = 0;
  let read = 0;
  let totalFeeSol = 0;

  for (const { signature } of landed) {
    await pause();

    let tx: any;
    try {
      tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
    } catch (error: any) {
      // Rate limits are not findings. Counting them keeps the sweep honest
      // about its own coverage instead of silently reporting a short list.
      unreadable++;
      continue;
    }

    if (!tx?.meta) {
      unreadable++;
      continue;
    }

    read++;

    totalFeeSol += tx.meta.fee / 1e9;

    const instructions: any[] = [
      ...(tx.transaction.message.instructions ?? []),
      ...((tx.meta.innerInstructions ?? []).flatMap((i: any) => i.instructions ?? [])),
    ];

    for (const ix of instructions) {
      const parsed = ix?.parsed;
      if (!parsed?.info) continue;

      const info = parsed.info;
      // Only instructions where OUR money moves. A transaction touches many
      // accounts; the ones that matter are the ones we pay from or receive to.
      const ours =
        info.source === me ||
        info.destination === me ||
        info.authority === me ||
        info.payer === me ||
        info.owner === me;
      if (!ours) continue;

      const key = `${ix.program}/${parsed.type}`;
      const bucket =
        buckets.get(key) ??
        { count: 0, solOut: 0, solIn: 0, examples: [], destinations: new Map<string, number>() };
      bucket.count++;

      // DIRECTION IS THE WHOLE POINT for a cost sweep. A bucket summing both
      // ways looks alarming when it is mostly the wallet being funded.
      if (typeof info.lamports === 'number') {
        const sol = info.lamports / 1e9;
        if (info.source === me) {
          bucket.solOut += sol;
          const to = String(info.destination ?? info.newAccount ?? 'unknown');
          bucket.destinations.set(to, (bucket.destinations.get(to) ?? 0) + sol);
        } else if (info.destination === me) {
          bucket.solIn += sol;
        }
      }

      if (bucket.examples.length < 2) bucket.examples.push(signature.slice(0, 16));
      buckets.set(key, bucket);
    }
  }

  const rows = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count);

  const show = (title: string, keep: (k: string) => boolean) => {
    const subset = rows.filter(([k]) => keep(k));
    console.log(`${title} (${subset.length})`);
    if (subset.length === 0) console.log('  none');
    for (const [key, b] of subset) {
      const flow =
        b.solOut || b.solIn
          ? `  out ${b.solOut.toFixed(6)}  in ${b.solIn.toFixed(6)} SOL`
          : '  moves no lamports';
      console.log(`  ${String(b.count).padStart(4)}x  ${key.padEnd(34)}${flow}`);
      if (MODELLED.has(key)) continue;

      console.log(`        e.g. ${b.examples.join(', ')}`);
      const top = [...b.destinations.entries()].sort((a, c) => c[1] - a[1]).slice(0, 4);
      for (const [to, sol] of top) {
        console.log(`        -> ${to}  ${sol.toFixed(6)} SOL`);
      }
    }
    console.log();
  };

  show('MODELLED -- already becomes rows', (k) => MODELLED.has(k));
  show('NOT MODELLED -- this is the remaining C3 work', (k) => !MODELLED.has(k));

  console.log(`${read} transaction(s) inspected; network fees ${totalFeeSol.toFixed(6)} SOL`);
  if (unreadable) {
    console.log(
      `${unreadable} could NOT be read (rate limit or missing meta). The list ` +
        `above covers ${read}/${read + unreadable} -- re-run with a larger delay to close the gap.`
    );
  }
  console.log('\nNothing was sent and nothing was spent.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
