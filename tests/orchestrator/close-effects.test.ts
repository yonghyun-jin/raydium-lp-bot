/**
 * A close is TWO transactions, and the ledger must measure both.
 *
 * Raydium sends `decreaseLiquidity`+`collect` -- the transaction that actually
 * returns the principal and the fees -- and then `closePosition`, which burns
 * the NFT and reclaims rent, a few seconds later. `bookLedgerRows` reconciled
 * the WHOLE close against the burn alone, so a verified real close reported:
 *
 *   [Ledger] 4sgYko2R... does not reconcile:
 *     SOL:  rows say 0.099532532, chain says 0.003441160  (off by -0.096091372)
 *     USDC: rows say 1019.349254,  chain says 0.000000000  (off by -1019.349254)
 *
 * Both lines were true OF THE BURN -- 0.003441160 SOL is reclaimed rent and no
 * USDC moves in a burn at all -- and worthless as a check. `USDC: chain says
 * 0.000000000` for a withdrawal that had plainly arrived is the tell.
 */

import { Orchestrator } from '../../src/orchestrator/Orchestrator';

const DECREASE = 'sSn76fdyxNRrkpyh4tdacyDwA2quaPiGGqXbCxDMFNsei6hoFpy7vMBXbtMtGgFSgTUQTAk4Vpkam2X8KpEY5uE';
const BURN = '56osw8Wh3EGgi1v7ppyzWA4Gy8EyFy1ahyBsRu6uAuDsP8BvNpMazz2KfkaZHpKDmN2D76jMyChfWV8SS7c98k9D';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** The two halves of the real 2026-09-25 close. */
const EFFECTS: Record<string, any> = {
  [DECREASE]: {
    networkFeeSol: 0.000105,
    solDelta: 0.096091372,
    tokenDeltas: { [USDC]: 1019.349254 },
    rentDeposited: 0,
    rentReclaimed: 0,
  },
  [BURN]: {
    networkFeeSol: 0.000005,
    solDelta: 0.00344116,
    tokenDeltas: {},
    rentDeposited: 0,
    rentReclaimed: 0.00148844,
  },
};

function makeOrchestrator(effects: Record<string, any | null>) {
  const asked: string[] = [];
  const client: any = {
    init: async () => undefined,
    getTransactionEffects: async (txId: string) => {
      asked.push(txId);
      return effects[txId] ?? null;
    },
  };
  const o = new Orchestrator({}, client);
  (o as any).init = async () => undefined;
  return { o, asked };
}

const closeEffects = (o: Orchestrator, result: any) =>
  (o as any).closeEffects('MINT_A', result);

const fullClose = {
  txId: BURN,
  decreaseTxId: DECREASE,
  withdrewLiquidity: true,
};

describe('closeEffects', () => {
  it('reads BOTH signatures, not just the burn', async () => {
    const { o, asked } = makeOrchestrator(EFFECTS);
    await closeEffects(o, fullClose);

    expect(asked).toContain(DECREASE);
    expect(asked).toContain(BURN);
  });

  it('REGRESSION: the USDC total is the withdrawal, not the burn’s zero', async () => {
    const { o } = makeOrchestrator(EFFECTS);
    const combined = await closeEffects(o, fullClose);

    // The number the old code compared against was 0.000000000.
    expect(combined!.tokenDeltas[USDC]).toBeCloseTo(1019.349254, 9);
  });

  it('REGRESSION: the SOL total covers the withdrawal and the rent refund', async () => {
    const { o } = makeOrchestrator(EFFECTS);
    const combined = await closeEffects(o, fullClose);

    // 0.096091372 withdrawn + 0.003441160 reclaimed rent. The old check saw only
    // the second term and reported the first as a missing instruction effect.
    expect(combined!.solDelta).toBeCloseTo(0.099532532, 9);
  });

  it('sums the network fee, which the burn-only reading lost entirely', async () => {
    const { o } = makeOrchestrator(EFFECTS);
    const combined = await closeEffects(o, fullClose);

    expect(combined!.networkFeeSol).toBeCloseTo(0.00011, 9);
  });

  it('carries the rent through so it is not double-counted or dropped', async () => {
    const { o } = makeOrchestrator(EFFECTS);
    const combined = await closeEffects(o, fullClose);

    expect(combined!.rentReclaimed).toBeCloseTo(0.00148844, 9);
    expect(combined!.rentDeposited).toBe(0);
  });

  it('does not double-count when both signatures are the same', async () => {
    // Defensive: a path that reported one signature twice would otherwise
    // silently double every figure.
    const { o, asked } = makeOrchestrator(EFFECTS);
    const combined = await closeEffects(o, {
      txId: BURN,
      decreaseTxId: BURN,
      withdrewLiquidity: true,
    });

    expect(asked).toEqual([BURN]);
    expect(combined!.solDelta).toBeCloseTo(0.00344116, 9);
  });
});

describe('closeEffects when the total cannot be known', () => {
  it('skips rather than checks against a partial total', async () => {
    // An absent actualByToken SKIPS verification; a partial one FAILS it, and
    // fails it by blaming a missing instruction effect -- pointing the reader at
    // ATAs and transfer fees when the real answer is that nobody read the other
    // signature.
    const { o } = makeOrchestrator({ [BURN]: EFFECTS[BURN], [DECREASE]: null });
    expect(await closeEffects(o, fullClose)).toBeNull();
  });

  it('skips when the decrease signature was never captured', async () => {
    const { o } = makeOrchestrator(EFFECTS);
    const combined = await closeEffects(o, {
      txId: BURN,
      decreaseTxId: undefined,
      withdrewLiquidity: true,
    });

    expect(combined).toBeNull();
  });
});

describe('closeEffects on an already-empty position', () => {
  it('measures the burn ALONE, because that is the whole close', async () => {
    // Not the same absence: there is no decrease to reconcile, rather than no
    // decrease to reconcile AGAINST. Skipping here would warn about a signature
    // for a withdrawal that never happened.
    const { o, asked } = makeOrchestrator(EFFECTS);
    const combined = await closeEffects(o, {
      txId: BURN,
      decreaseTxId: undefined,
      withdrewLiquidity: false,
    });

    expect(asked).toEqual([BURN]);
    expect(combined!.solDelta).toBeCloseTo(0.00344116, 9);
  });
});
