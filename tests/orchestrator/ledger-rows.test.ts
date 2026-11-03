/**
 * Ledger rows must sum to what actually moved.
 *
 * That is the whole invariant: it is what makes `SUM(value_usd)` a real P&L
 * rather than a plausible one. The close is where it is easy to break, because
 * a close returns principal and collected fees in ONE transfer — so booking the
 * full wallet delta as `principal` and then the fees as `reward` counts the fees
 * twice and the position reads as more profitable than it was.
 */

import { openPositionRows, closePositionRows, swapRows, readQuote } from '../../src/orchestrator/ledgerRows';
import { verifyEffects } from '../../src/orchestrator/verifyEffects';

const PRICE = 108.5;
const base = { solPriceUsd: PRICE, priceSource: 'raydium-pool', positionId: 'MINT_A' };

const sumUsd = (rows: { amount: number; priceUsd: number }[]) =>
  rows.reduce((t, r) => t + r.amount * r.priceUsd, 0);

describe('opening a position', () => {
  it('books both legs as leaving the wallet', () => {
    const rows = openPositionRows({ ...base, solDeposited: 0.046, usdcDeposited: 5 });
    expect(rows).toHaveLength(2);
    // The sign convention is the WALLET's: money into a position leaves it.
    expect(rows.every((r) => r.amount < 0)).toBe(true);
    expect(rows.every((r) => r.category === 'principal')).toBe(true);
  });

  it('values the deposit at what actually went in', () => {
    const rows = openPositionRows({ ...base, solDeposited: 0.046, usdcDeposited: 5 });
    expect(sumUsd(rows)).toBeCloseTo(-(0.046 * PRICE + 5), 8);
  });

  it('omits a leg that was not deposited rather than booking a zero', () => {
    const rows = openPositionRows({ ...base, solDeposited: 0, usdcDeposited: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0].token).toBe('USDC');
  });

  it('carries the mint, not just the symbol', () => {
    // Solana USDC, Ethereum USDC and Arbitrum USDC share a label. Grouping by
    // symbol merges three different assets into one wrong number.
    const rows = openPositionRows({ ...base, solDeposited: 1, usdcDeposited: 1 });
    expect(rows.every((r) => typeof r.tokenAddress === 'string')).toBe(true);
  });
});

describe('closing a position', () => {
  it('does NOT count the fees twice', () => {
    // 0.05 SOL came back, of which 0.002 was fees. The rows must sum to 0.05,
    // not 0.052.
    const rows = closePositionRows({
      ...base,
      solWithdrawn: 0.05,
      usdcWithdrawn: 4.5,
      feeSol: 0.002,
      feeUsdc: 0.03,
    });
    const sol = rows.filter((r) => r.token === 'SOL');
    expect(sol.reduce((t, r) => t + r.amount, 0)).toBeCloseTo(0.05, 10);
    const usdc = rows.filter((r) => r.token === 'USDC');
    expect(usdc.reduce((t, r) => t + r.amount, 0)).toBeCloseTo(4.5, 10);
  });

  it('splits each leg into principal and reward', () => {
    const rows = closePositionRows({
      ...base,
      solWithdrawn: 0.05,
      usdcWithdrawn: 4.5,
      feeSol: 0.002,
      feeUsdc: 0.03,
    });
    const principal = rows.filter((r) => r.category === 'principal');
    const reward = rows.filter((r) => r.category === 'reward');
    expect(principal).toHaveLength(2);
    expect(reward).toHaveLength(2);
    expect(principal.find((r) => r.token === 'SOL')!.amount).toBeCloseTo(0.048, 10);
    expect(reward.find((r) => r.token === 'SOL')!.amount).toBeCloseTo(0.002, 10);
  });

  it('books the whole delta as principal when the fees could not be read', () => {
    // Understates earnings rather than inventing them, and the SUM stays true
    // either way — only the attribution is lost. A `reward` row of 0 would
    // instead assert the position earned nothing, which is a different claim.
    const rows = closePositionRows({
      ...base,
      solWithdrawn: 0.05,
      usdcWithdrawn: 4.5,
      feeSol: undefined,
      feeUsdc: undefined,
    });
    expect(rows.filter((r) => r.category === 'reward')).toHaveLength(0);
    expect(rows.reduce((t, r) => t + (r.token === 'SOL' ? r.amount : 0), 0)).toBeCloseTo(0.05, 10);
  });

  it('writes nothing for a leg whose delta could not be read', () => {
    // Unreadable is not zero. Booking 0 would assert nothing came back.
    const rows = closePositionRows({
      ...base,
      solWithdrawn: null,
      usdcWithdrawn: 4.5,
      feeSol: undefined,
      feeUsdc: 0.03,
    });
    expect(rows.some((r) => r.token === 'SOL')).toBe(false);
    expect(rows.some((r) => r.token === 'USDC')).toBe(true);
  });

  it('omits a zero principal rather than booking it', () => {
    // A position that returned exactly its fees and nothing else.
    const rows = closePositionRows({
      ...base,
      solWithdrawn: 0.002,
      usdcWithdrawn: 0,
      feeSol: 0.002,
      feeUsdc: 0,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('reward');
  });
});

describe('a full cycle balances', () => {
  it('a position that earned fees reads as profit, and by how much', () => {
    // Deposit 0.046 SOL + 5 USDC. Withdraw 0.046 SOL + 5 USDC plus fees.
    const open = openPositionRows({ ...base, solDeposited: 0.046, usdcDeposited: 5 });
    const close = closePositionRows({
      ...base,
      solWithdrawn: 0.048,
      usdcWithdrawn: 5.03,
      feeSol: 0.002,
      feeUsdc: 0.03,
    });
    const pnl = sumUsd(open) + sumUsd(close);
    // Exactly the fees: 0.002 SOL at 108.5 plus 0.03 USDC.
    expect(pnl).toBeCloseTo(0.002 * PRICE + 0.03, 8);
  });

  it('a position that lost value reads as a loss', () => {
    const open = openPositionRows({ ...base, solDeposited: 0.046, usdcDeposited: 5 });
    const close = closePositionRows({
      ...base,
      solWithdrawn: 0.04,
      usdcWithdrawn: 4.5,
      feeSol: 0,
      feeUsdc: 0,
    });
    expect(sumUsd(open) + sumUsd(close)).toBeLessThan(0);
  });
});

describe('the open and the close are measured the same way', () => {
  it('a full cycle does NOT report the rent as profit', () => {
    // THE BUG THIS EXISTS FOR. The open used to book only the deposited
    // amounts, so the position account's rent and the network fee left the
    // wallet unrecorded -- while the SAME rent came back inside the close's
    // wallet delta and was booked as principal returned. Every completed cycle
    // reported better than it was, by roughly rent + the open's fee.
    const RENT = 0.00203928;
    const FEE = 0.000005;

    const open = openPositionRows({
      solDeposited: 0.05,
      usdcDeposited: 5,
      solPriceUsd: 100,
      priceSource: 'p',
      positionId: 'MINT',
      networkFeeSol: FEE,
      rentDeposited: RENT,
    });

    // The position earned nothing and the price did not move, so the wallet
    // gets back exactly what it put in, plus the rent, minus the close's fee.
    const close = closePositionRows({
      solWithdrawn: 0.05 + RENT - FEE,
      usdcWithdrawn: 5,
      feeSol: 0,
      feeUsdc: 0,
      solPriceUsd: 100,
      priceSource: 'p',
      positionId: 'MINT',
      networkFeeSol: FEE,
      rentReclaimed: RENT,
    });

    // Rent nets to zero across the pair -- that is the point of two categories.
    const rent = [...open, ...close]
      .filter((r) => r.category === 'rent_deposit' || r.category === 'rent_reclaim')
      .reduce((a, r) => a + r.amount, 0);
    expect(rent).toBeCloseTo(0, 12);

    // And the cycle costs exactly the two network fees. Before this change it
    // came out POSITIVE by the rent.
    expect(sumUsd([...open, ...close])).toBeCloseTo(-2 * FEE * 100, 8);
  });

  it('principal on the close is the principal, not the principal plus rent', () => {
    const RENT = 0.002;
    const rows = closePositionRows({
      solWithdrawn: 0.05 + RENT,
      usdcWithdrawn: 0,
      feeSol: 0,
      feeUsdc: 0,
      solPriceUsd: 100,
      priceSource: 'p',
      positionId: 'MINT',
      rentReclaimed: RENT,
    });

    const principal = rows
      .filter((r) => r.category === 'principal' && r.token === 'SOL')
      .reduce((a, r) => a + r.amount, 0);

    // The principal/reward split is the only thing that could ever show
    // impermanent loss, so letting rent inflate it costs more than the dollars.
    expect(principal).toBeCloseTo(0.05, 9);
  });

  it('the close still sums to the wallet delta it was given', () => {
    const rows = closePositionRows({
      solWithdrawn: 0.0519,
      usdcWithdrawn: 10.32,
      feeSol: 0.001,
      feeUsdc: 0.03,
      solPriceUsd: 100,
      priceSource: 'p',
      positionId: 'MINT',
      networkFeeSol: 0.000005,
      rentReclaimed: 0.002,
    });

    const perToken = (t: string) =>
      rows.filter((r) => r.token === t).reduce((a, r) => a + r.amount, 0);

    // Decomposing is only legal while the parts still add back up.
    expect(perToken('SOL')).toBeCloseTo(0.0519, 9);
    expect(perToken('USDC')).toBeCloseTo(10.32, 9);
  });

  it('an unreadable SOL leg books no charges against it', () => {
    // The fee and rent come out of the same delta. Booking them against a
    // delta we could not read would claim a movement nobody measured.
    const rows = closePositionRows({
      solWithdrawn: null,
      usdcWithdrawn: 10,
      feeSol: undefined,
      feeUsdc: 0,
      solPriceUsd: 100,
      priceSource: 'p',
      positionId: 'MINT',
      networkFeeSol: 0.000005,
      rentReclaimed: 0.002,
    });

    expect(rows.some((r) => r.token === 'SOL')).toBe(false);
  });

  it('the open books its own fee and rent, which it never used to', () => {
    const rows = openPositionRows({
      solDeposited: 0.05,
      usdcDeposited: 5,
      solPriceUsd: 100,
      priceSource: 'p',
      positionId: 'MINT',
      networkFeeSol: 0.000005,
      rentDeposited: 0.002,
    });

    expect(rows.some((r) => r.category === 'network_fee')).toBe(true);
    expect(rows.some((r) => r.category === 'rent_deposit')).toBe(true);
  });
});

describe('swapping', () => {
  it('books only what arrived when there is no quote to decompose against', () => {
    // Without a quote there is no way to separate the charges, and inventing a
    // zero fee would assert the route charged nothing.
    const rows = swapRows({
      direction: 'USDC_TO_SOL',
      amountIn: 5,
      amountOut: 0.046,
      solPriceUsd: PRICE,
      priceSource: 'raydium-pool',
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.category === 'principal')).toBe(true);
  });

  it('decomposes into who charged what, and the rows still sum to what moved', () => {
    // 1 SOL at $100 out; the router quoted 150 USDC and 149.95 arrived, of
    // which 0.03 was pool fees and 0.01 the router's own.
    const rows = swapRows({
      direction: 'SOL_TO_USDC',
      amountIn: 1,
      amountOut: 149.95,
      quotedOut: 150,
      dexFee: 0.03,
      platformFee: 0.01,
      networkFeeSol: 0.000005,
      solPriceUsd: 150,
      priceSource: 'raydium-pool',
    });

    const by = (c: string) =>
      rows.filter((r) => r.category === c).reduce((a, r) => a + r.amount, 0);

    expect(by('dex_fee')).toBeCloseTo(-0.03, 9);
    expect(by('platform_fee')).toBeCloseTo(-0.01, 9);
    // 150 quoted - 149.95 filled = 0.05, of which 0.04 was stated fees.
    expect(by('execution_slippage')).toBeCloseTo(-0.01, 9);
    expect(by('network_fee')).toBeCloseTo(-0.000005, 9);

    // THE INVARIANT, per token. This is what makes the decomposition legal:
    // booking a gross principal AND cost rows is only correct when the parts
    // sum to the whole. Book the NET amount as principal and add cost rows on
    // top and the swap is double-counted -- the mistake C1 removed.
    const perToken = (t: string) =>
      rows.filter((r) => r.token === t).reduce((a, r) => a + r.amount, 0);

    expect(perToken('USDC')).toBeCloseTo(149.95, 9);
    expect(perToken('SOL')).toBeCloseTo(-1.000005, 9);

    // And in dollars the swap reads as what it cost -- about five cents --
    // rather than as a gain, which is what an inconsistent price would produce.
    expect(sumUsd(rows)).toBeCloseTo(-0.0507, 3);
  });

  it('verifyEffects accepts the decomposition against the real deltas', () => {
    const rows = swapRows({
      direction: 'SOL_TO_USDC',
      amountIn: 1,
      amountOut: 149.95,
      quotedOut: 150,
      dexFee: 0.03,
      platformFee: 0.01,
      networkFeeSol: 0.000005,
      solPriceUsd: 150,
      priceSource: 'raydium-pool',
    });

    const v = verifyEffects(rows, { SOL: -1.000005, USDC: 149.95 });
    expect(v.verified).toBe(true);
  });

  it('a poor fill still costs exactly what it cost, once', () => {
    // Spend 2.7 SOL worth $270, receive $269.20. The ledger must say $0.80 --
    // not $1.60, which is what booking the net principal plus a cost row gives.
    const rows = swapRows({
      direction: 'SOL_TO_USDC',
      amountIn: 2.7,
      amountOut: 269.2,
      quotedOut: 270,
      solPriceUsd: 100,
      priceSource: 'raydium-pool',
    });
    expect(sumUsd(rows)).toBeCloseTo(-0.8, 8);
  });

  it('never books a cost in a token the wallet did not move', () => {
    // routePlan hops can charge in an intermediate mint. A row denominated in
    // one would make that token's rows sum to something while its real delta
    // is zero -- breaking the invariant the decomposition exists to satisfy.
    const rows = swapRows({
      direction: 'SOL_TO_USDC',
      amountIn: 1,
      amountOut: 149.95,
      quotedOut: 150,
      dexFee: 0.05,
      solPriceUsd: 100,
      priceSource: 'raydium-pool',
    });
    expect(new Set(rows.map((r) => r.token))).toEqual(new Set(['SOL', 'USDC']));
  });

  it('keeps the quote in the description, so the fill is still auditable', () => {
    const rows = swapRows({
      direction: 'USDC_TO_SOL',
      amountIn: 5,
      amountOut: 0.046,
      quotedOut: 0.0461,
      solPriceUsd: PRICE,
      priceSource: 'raydium-pool',
    });
    expect(rows.find((r) => r.amount > 0)!.description).toMatch(
      /quoted 0\.046100, received 0\.046000/
    );
  });

  it('spends the token it says it spends, in each direction', () => {
    const sell = swapRows({
      direction: 'SOL_TO_USDC', amountIn: 1, amountOut: 100,
      solPriceUsd: 100, priceSource: 'p',
    });
    expect(sell.find((r) => r.amount < 0)!.token).toBe('SOL');
    expect(sell.find((r) => r.amount > 0)!.token).toBe('USDC');

    const buy = swapRows({
      direction: 'USDC_TO_SOL', amountIn: 100, amountOut: 1,
      solPriceUsd: 100, priceSource: 'p',
    });
    expect(buy.find((r) => r.amount < 0)!.token).toBe('USDC');
    expect(buy.find((r) => r.amount > 0)!.token).toBe('SOL');
  });
});

describe('reading a Jupiter quote', () => {
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const SOL = 'So11111111111111111111111111111111111111112';

  it('converts base units to UI units', () => {
    expect(readQuote({ outAmount: '150000000' }, USDC, 6).quotedOut).toBeCloseTo(150, 9);
  });

  it('sums only the hops whose fee is charged in the output token', () => {
    const q = {
      outAmount: '150000000',
      routePlan: [
        { swapInfo: { feeMint: USDC, feeAmount: '20000' } },
        { swapInfo: { feeMint: SOL, feeAmount: '900000' } }, // intermediate leg
        { swapInfo: { feeMint: USDC, feeAmount: '10000' } },
      ],
    };
    // 0.02 + 0.01 USDC. The SOL-denominated hop is skipped rather than
    // converted at a guessed rate -- a fabricated conversion is a worse answer
    // than an unnamed cost, and the gap still shows up in execution_slippage.
    expect(readQuote(q, USDC, 6).dexFee).toBeCloseTo(0.03, 9);
  });

  it('reads the platform fee', () => {
    const q = { outAmount: '150000000', platformFee: { amount: '10000', feeBps: 5 } };
    expect(readQuote(q, USDC, 6).platformFee).toBeCloseTo(0.01, 9);
  });

  it('a missing or malformed quote yields nothing rather than zeros', () => {
    // undefined means "unknown"; 0 would mean "charged nothing".
    expect(readQuote(undefined, USDC, 6)).toEqual({});
    expect(readQuote({ outAmount: 'not-a-number' }, USDC, 6).quotedOut).toBeUndefined();
    expect(readQuote({ outAmount: '1' }, USDC, 6).dexFee).toBeUndefined();
  });
});

describe('the swap and the open share one operation', () => {
  const fs = require('fs');
  const path = require('path');
  const orch = fs
    .readFileSync(path.join(__dirname, '../../src/orchestrator/Orchestrator.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  it('the operation id is minted before the swap, not by the config', () => {
    // The swap funds the position, so it happens before the config exists.
    // Booking it afterwards would lose it whenever the create throws — money
    // moved with nothing recording it.
    const mint = orch.indexOf('const operationId = newOperationId()');
    const swap = orch.indexOf('await this.swapAndBook(');
    expect(mint).toBeGreaterThan(-1);
    expect(swap).toBeGreaterThan(mint);
  });

  it('and the config is given that same id', () => {
    // Anchored to `operationId` as a bare PROPERTY on its own line. A looser
    // pattern matched `config.operationId,` in the process() call a few lines
    // below, so removing the property entirely still passed.
    expect(orch).toMatch(/duration: params\.duration \?\? 0,[\s\S]{0,200}\n\s+operationId,\n/);
  });
});

describe('the operation id cannot collide', () => {
  const { newOperationId } = require('../../src/orchestrator/types/Config');

  it('is unique even when minted in the same millisecond', () => {
    // It used to be `job_${Date.now()}`. Two cycles sharing an id merge
    // silently into one wrong number — nothing errors, the ledger simply
    // reports one operation where there were two.
    const ids = new Set(Array.from({ length: 2000 }, () => newOperationId()));
    expect(ids.size).toBe(2000);
  });

  it('still sorts chronologically, which is why the timestamp stays', () => {
    const a = newOperationId();
    const b = newOperationId();
    expect(Number(a.split('_')[1])).toBeLessThanOrEqual(Number(b.split('_')[1]));
  });
});

/**
 * A router that does not state its fees is not a router that charged none.
 *
 * The real quote that prompted this: a single-hop Jupiter route labelled
 * `Kipseli` came back with `feeAmount: undefined` and `feeMint: undefined`, so
 * no `dex_fee` row was written and the swap read as having cost nothing. The
 * pool had of course taken its cut -- inside `outAmount`, which the ledger
 * books as principal.
 *
 * The number cannot be recovered; the router never sent it. What can be fixed
 * is the claim, so the three cases below stay distinguishable.
 */
describe('readQuote tells a missing fee from a zero one', () => {
  const SOL = 'So11111111111111111111111111111111111111112';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  it('a route that states nothing reports feesReported false', () => {
    const quote = {
      outAmount: '8258119511',
      outputMint: SOL,
      routePlan: [{ swapInfo: { label: 'Kipseli', feeAmount: undefined, feeMint: undefined } }],
      platformFee: null,
    };

    const read = readQuote(quote, SOL, 9);

    expect(read.feesReported).toBe(false);
    expect(read.dexFee).toBeUndefined();
    expect(read.quotedOut).toBeCloseTo(8.258119511, 9);
  });

  it('a route that states a fee in the output token reports it and books it', () => {
    const quote = {
      outAmount: '8258119511',
      outputMint: SOL,
      routePlan: [{ swapInfo: { label: 'Orca', feeAmount: '2000000', feeMint: SOL } }],
    };

    const read = readQuote(quote, SOL, 9);

    expect(read.feesReported).toBe(true);
    expect(read.dexFee).toBeCloseTo(0.002, 9);
  });

  it('a fee stated in ANOTHER token still counts as stated, even with no row to show', () => {
    // It was charged and we know it; it just cannot be denominated in the
    // output token's rows. That is a different fact from never being told.
    const quote = {
      outAmount: '8258119511',
      outputMint: SOL,
      routePlan: [{ swapInfo: { label: 'Meteora', feeAmount: '900000', feeMint: USDC } }],
    };

    const read = readQuote(quote, SOL, 9);

    expect(read.feesReported).toBe(true);
    expect(read.dexFee).toBeUndefined();
  });

  it('the slippage row says the pool cut is inside it when nothing was stated', () => {
    const rows = swapRows({
      direction: 'USDC_TO_SOL',
      amountIn: 973.181488,
      amountOut: 8.26091,
      quotedOut: 8.258119511,
      feesReported: false,
      solPriceUsd: 117.91,
      priceSource: 'raydium-pool',
    });

    const slippage = rows.find((r) => r.category === 'execution_slippage');
    expect(slippage?.description).toMatch(/stated no fees/);

    // And the rows still add up to what actually arrived.
    const received = rows
      .filter((r) => r.token === 'SOL' && r.amount > 0)
      .reduce((total, r) => total + r.amount, 0);
    expect(received).toBeCloseTo(8.26091, 9);
  });

  it('says nothing of the sort when the route did state its fees', () => {
    const rows = swapRows({
      direction: 'USDC_TO_SOL',
      amountIn: 973.181488,
      amountOut: 8.25,
      quotedOut: 8.258119511,
      dexFee: 0.002,
      feesReported: true,
      solPriceUsd: 117.91,
      priceSource: 'raydium-pool',
    });

    expect(rows.find((r) => r.category === 'execution_slippage')?.description).not.toMatch(
      /stated no fees/
    );
    expect(rows.find((r) => r.category === 'dex_fee')?.amount).toBeCloseTo(-0.002, 9);
  });
});
