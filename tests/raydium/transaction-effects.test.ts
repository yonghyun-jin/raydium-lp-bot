/**
 * What a transaction cost has to come from the transaction.
 *
 * Every figure this project has about a swap came from one of two places, and
 * both were wrong in a way that is invisible:
 *
 *   - The wallet balance BEFORE and AFTER. That attributes everything that
 *     happened in between to this transaction, and it is what the silent-zero
 *     bug rode in on.
 *   - The Jupiter quote, which was fetched, console.logged, and dropped.
 *
 * So the ledger could say what the wallet ended up holding and never what it
 * was charged: the per-hop DEX fees, Jupiter's platform fee, the network fee
 * and the quoted output all existed and none of them were kept.
 *
 * This slice is plumbing only -- it adds no rows. The guards here are the ones
 * that would otherwise be discovered later, from a cost figure that looked
 * plausible.
 */

import * as fs from 'fs';
import * as path from 'path';
import { FakeLpClient } from '../fakes/FakeLpClient';
import { swapRows } from '../../src/orchestrator/ledgerRows';

function read(rel: string): string {
  return fs
    .readFileSync(path.join(__dirname, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the quote survives the swap', () => {
  it('a swap returns what the router promised, not just a signature', async () => {
    const fake = new FakeLpClient({ sol: 10, usdc: 0, price: 100 });
    const result = await fake.swapSolToUsdc(1, 100);

    expect(result.txId).toBeTruthy();
    // outAmount is the ONLY baseline for execution slippage. The pool mid
    // price is a different comparison and answers a different question.
    expect(result.quote?.outAmount).toBeTruthy();
  });

  it('the real client hands the quote back rather than logging it away', () => {
    const client = read('../../src/raydium/client.ts');
    const start = client.search(/private async jupiterSwap\(/);
    expect(start).toBeGreaterThan(-1);
    const rest = client.slice(start);
    const end = rest.slice(1).search(/\n {2}(?:private |public |async |static )?[a-zA-Z_]+[<(]/);
    const body = end === -1 ? rest : rest.slice(0, end + 1);

    expect(body).toMatch(/return \{ txId, quote/);
    expect(body).not.toMatch(/return \{ txId \};/);
  });
});

describe('transaction effects are read from the transaction', () => {
  it('getTransaction is asked for versioned transactions', () => {
    const client = read('../../src/raydium/client.ts');

    // Jupiter builds versioned transactions, so this option is required or the
    // call cannot read the very swaps the method exists for.
    //
    // getParsedTransaction, not getTransaction: the same meta plus decoded
    // instructions, which is what lets rent be ATTRIBUTED rather than guessed.
    //
    // NOT A REGRESSION GUARD -- the COMPILER already enforces it, and finding
    // that out is the useful part: dropping the option selects the legacy
    // `getTransaction` overload, whose `Message.getAccountKeys()` takes no
    // arguments, so the address-lookup-table call below stops compiling. Both
    // ways of removing it were tried and neither builds.
    //
    // This assertion is therefore documentation with a tripwire on it: if the
    // surrounding code is ever rewritten so the compiler no longer objects,
    // this line still says the option is load-bearing and why.
    expect(client).toMatch(/getParsedTransaction\([\s\S]{0,200}maxSupportedTransactionVersion/);
  });

  it('an unreadable transaction is null, never a zero fee', async () => {
    const fake = new FakeLpClient();
    expect(await fake.getTransactionEffects('NEVER_HAPPENED')).toBeNull();
  });

  it('a swap reports its network fee and both sides of the movement', async () => {
    const fake = new FakeLpClient({
      sol: 10,
      usdc: 0,
      price: 100,
      networkFeeSol: 0.000005,
      swapFrictionBps: 30,
    });

    const { txId } = await fake.swapSolToUsdc(1, 100);
    const effects = await fake.getTransactionEffects(txId);

    expect(effects).not.toBeNull();
    expect(effects!.networkFeeSol).toBeCloseTo(0.000005, 9);

    // The SOL side carries the fee inside it, which is why a later row builder
    // must subtract the fee rather than book the delta as principal outright.
    expect(effects!.solDelta).toBeCloseTo(-1.000005, 9);

    // 30bps of a $100 swap is $0.30 kept back by the route.
    expect(effects!.tokenDeltas[FakeLpClient.USDC_MINT]).toBeCloseTo(99.7, 6);
  });

  it('the fake is frictionless by default, so older tests keep their numbers', async () => {
    const fake = new FakeLpClient({ sol: 10, usdc: 0, price: 100 });
    const { txId, quote } = await fake.swapSolToUsdc(1, 100);
    const effects = await fake.getTransactionEffects(txId);

    expect(effects!.networkFeeSol).toBe(0);
    expect(effects!.tokenDeltas[FakeLpClient.USDC_MINT]).toBeCloseTo(100, 6);
    // Quoted and received agree, so execution slippage is zero rather than absent.
    expect(Number(quote!.outAmount) / 1e6).toBeCloseTo(100, 6);
  });
});

describe('rent is attributed, not left over', () => {
  it('rent is attributed from instructions, not from leftover SOL', () => {
    // The rule moved to rentAttribution.ts so it could be tested without a
    // wallet or an RPC -- which is how the two bugs in it were finally pinned
    // down. The guard follows it.
    const rent = read('../../src/raydium/rentAttribution.ts');

    expect(rent).toMatch(/createAccount/);
    expect(rent).toMatch(/closeAccount/);

    // And NOT from subtracting what we know from the wallet's SOL change.
    // That would make rent a residual, silently absorbing any cost nobody has
    // modelled -- the failure this whole scope exists to prevent.
    expect(rent).not.toMatch(/solDelta/);
  });

  it('inner instructions are walked, or an ATA creation is invisible', () => {
    const client = read('../../src/raydium/client.ts');
    const start = client.search(/private readRent\(/);
    const body = client.slice(start, start + 2500);

    // An ATA is created by a CPI from the associated-token program, so the
    // createAccount that actually moves the rent appears only in
    // innerInstructions. Top-level instructions alone report zero rent on
    // every swap that opens one.
    expect(body).toMatch(/innerInstructions/);
  });

  it('rent is two numbers, so a lifecycle can net to zero', async () => {
    const fake = new FakeLpClient({
      sol: 10, usdc: 0, price: 100, swapRentSol: 0.00203928,
    });
    const { txId } = await fake.swapSolToUsdc(1, 100);
    const effects = await fake.getTransactionEffects(txId);

    // wrapAndUnwrapSol opens a wSOL account and closes it in the same
    // transaction. Netting the two into one number first would hide that the
    // wallet ever locked anything up.
    expect(effects!.rentDeposited).toBeCloseTo(0.00203928, 9);
    expect(effects!.rentReclaimed).toBeCloseTo(0.00203928, 9);
  });

  it('a swap that locks rent and gives it back still balances', () => {
    const rows = swapRows({
      direction: 'SOL_TO_USDC',
      amountIn: 1,
      amountOut: 149.95,
      quotedOut: 150,
      networkFeeSol: 0.000005,
      rentDeposited: 0.00203928,
      rentReclaimed: 0.00203928,
      solPriceUsd: 150,
      priceSource: 'p',
    });

    const sol = rows.filter((r) => r.token === 'SOL').reduce((a, r) => a + r.amount, 0);
    expect(sol).toBeCloseTo(-1.000005, 9);

    // Both rows are present even though they cancel -- the pair is the record
    // that rent was locked, which a single netted row would not be.
    expect(rows.some((r) => r.category === 'rent_deposit')).toBe(true);
    expect(rows.some((r) => r.category === 'rent_reclaim')).toBe(true);
  });
});
