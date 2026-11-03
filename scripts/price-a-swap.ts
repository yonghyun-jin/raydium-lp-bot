/**
 * What rate did a swap actually get, and how far was it from the market?
 *
 * READ ONLY. Sends nothing, spends nothing.
 *
 * This answers the question the bot could not answer about itself until
 * `checkQuotePrice` existed: not "did it slip" but "did it pay too much". The
 * implied rate comes from what the wallet really moved, and the reference
 * comes from a venue that had nothing to do with the trade.
 *
 * SIGNATURES MUST BE NAMED. There is no wallet scan — a transaction this bot
 * did not send is not a strategy event. See scripts/reconcile-costs.ts.
 *
 *   npx ts-node scripts/price-a-swap.ts <txId>...
 */

import { RaydiumClient } from '../src/raydium/client';
import { config } from '../src/raydium/config';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * SOL/USD around a moment, from a venue unrelated to the trade.
 *
 * Coinbase, because the boot probe measures it at 0.065% mean agreement with
 * the training series — well inside the project's 0.28% bar — and because
 * using Raydium here would compare the pool against itself.
 */
async function marketPriceAt(unixSeconds: number): Promise<number | null> {
  // One-minute granularity, a short window around the block.
  const start = new Date((unixSeconds - 120) * 1000).toISOString();
  const end = new Date((unixSeconds + 120) * 1000).toISOString();

  try {
    const res = await fetch(
      `https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=60&start=${start}&end=${end}`,
      { headers: { 'User-Agent': 'lp-auto-strategy' } }
    );
    const candles = (await res.json()) as number[][];
    if (!Array.isArray(candles) || candles.length === 0) return null;

    // [time, low, high, open, close, volume] -- take the candle closest to the
    // block and use its CLOSE. A mid of high/low would flatter a bad fill.
    const nearest = candles.reduce((best, c) =>
      Math.abs(c[0] - unixSeconds) < Math.abs(best[0] - unixSeconds) ? c : best
    );
    const close = nearest[4];
    return Number.isFinite(close) && close > 0 ? close : null;
  } catch {
    return null;
  }
}

async function main() {
  const signatures = process.argv.slice(2);
  if (signatures.length === 0) {
    console.error('Name the signatures to price. There is no wallet scan.');
    process.exit(1);
  }

  const client = new RaydiumClient();
  await client.init();
  const connection = (client as any).connection;

  for (const txId of signatures) {
    console.log('─'.repeat(74));
    console.log(txId);

    const effects = await client.getTransactionEffects(txId);
    if (!effects) {
      console.log('  UNREADABLE — nothing can be said about this one.\n');
      continue;
    }

    const usdc = effects.tokenDeltas[USDC_MINT] ?? 0;
    // The SOL side carries the network fee and any rent, so those come back
    // out — otherwise the fee is charged to the exchange rate.
    const sol = effects.solDelta + effects.networkFeeSol + effects.rentDeposited - effects.rentReclaimed;

    if (Math.abs(usdc) < 1e-6 || Math.abs(sol) < 1e-9 || Math.sign(usdc) === Math.sign(sol)) {
      console.log(
        `  Not a two-sided SOL/USDC swap (SOL ${sol.toFixed(9)}, USDC ${usdc.toFixed(6)}).\n`
      );
      continue;
    }

    const direction = sol > 0 ? 'USDC -> SOL' : 'SOL -> USDC';
    const impliedPrice = Math.abs(usdc) / Math.abs(sol);

    const parsed = await connection.getParsedTransaction(txId, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    const blockTime: number | undefined = parsed?.blockTime ?? undefined;
    const market = blockTime ? await marketPriceAt(blockTime) : null;

    console.log(`  ${direction}`);
    console.log(`  moved         ${sol.toFixed(9)} SOL  /  ${usdc.toFixed(6)} USDC`);
    console.log(`  implied rate  $${impliedPrice.toFixed(4)} per SOL`);

    if (market === null) {
      // Unknown is a real answer: a missing reference does not become "fine".
      console.log(`  market        UNKNOWN — cannot say whether this was expensive.\n`);
      continue;
    }

    console.log(`  market        $${market.toFixed(4)} per SOL  (Coinbase, at the block)`);

    // Signed so NEGATIVE always means worse for us, whichever way it ran.
    const raw = (impliedPrice - market) / market;
    const deviation = sol > 0 ? -raw : raw;

    const band =
      config.strategy.MAX_SLIPPAGE + config.strategy.MAX_PRICE_IMPACT;

    console.log(
      `  paid          ${deviation >= 0 ? 'BETTER by' : 'WORSE by'} ` +
        `${Math.abs(deviation * 100).toFixed(3)}%  ` +
        `(${(Math.abs(deviation) * Math.abs(usdc)).toFixed(2)} USDC)`
    );

    if (deviation < -band) {
      console.log(
        `  => the gate added today would REFUSE this quote ` +
          `(band ~${(band * 100).toFixed(2)}% before the pool fee).`
      );
    } else {
      console.log(`  => inside the band the gate now enforces.`);
    }
    console.log();
  }

  console.log('─'.repeat(74));
  console.log('Nothing was sent and nothing was spent.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
