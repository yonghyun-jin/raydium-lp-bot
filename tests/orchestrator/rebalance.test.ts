/**
 * The rebalance's ORDER is its safety property, and this asserts it by
 * observing calls rather than by slicing source.
 *
 * These invariants used to be checked against `bot.ts` with string indices,
 * because the logic lived in the UI and there was no seam. Now it is
 * `Orchestrator.rebalance()`, whose collaborators can be stubbed — so "the
 * budget is read before anything is destroyed" becomes a fact about call order
 * instead of a fact about character offsets. Each one encodes a real incident:
 *
 * - The cap is checked FIRST and fails closed. It once lived in a file that a
 *   redeploy erased, so a deploy-heavy day had no cap at all.
 * - More than one open position REFUSES. Acting on a guess eventually closes
 *   money that is not ours.
 * - The budget is what the closing position was worth, read before the send.
 *   The configured amount would top a shrunken position back up out of the
 *   wallet on every rebalance, without the operator deciding to.
 * - A close that cannot be sized reports `closed-only`, not `refused`. The
 *   position is GONE; rendering it as "nothing happened" leaves the bot
 *   watching something that does not exist.
 */

import { Orchestrator } from '../../src/orchestrator/Orchestrator';
import { BlockhashExpiredError } from '../../src/raydium/jito';

jest.mock('../../src/recording', () => ({
  hasExceededRebalanceLimit: jest.fn(async () => false),
  recordRebalance: jest.fn(async () => undefined),
  getInvestmentAmount: jest.fn(async () => 10),
  getOpenPositionForPool: jest.fn(async () => ({ nftMint: 'OLD_MINT', openedAt: new Date() })),
  recordPositionOpened: jest.fn(async () => undefined),
  recordPositionClosed: jest.fn(async () => undefined),
  recordLedgerRows: jest.fn(async () => undefined),
  getPositionContext: jest.fn(async () => null),
  getRebalanceCountToday: jest.fn(async () => 0),
  resetRebalanceCount: jest.fn(async () => undefined),
  // The recovery state writers. A jest.mock factory REPLACES the module, so an
  // export missing here is `undefined` at the call site and throws -- which the
  // rebalance's own catch then reports as `failed`, i.e. the omission shows up as
  // a wrong OUTCOME rather than as a missing-mock error. Keep this in step with
  // what Orchestrator imports.
  recordStranded: jest.fn(async () => undefined),
  clearStranded: jest.fn(async () => undefined),
  recordDeployIntent: jest.fn(async () => undefined),
  recordRecoveryAttempt: jest.fn(async () => undefined),
  getRecoveryState: jest.fn(async () => null),
}));

const recording = require('../../src/recording');

const POOL = 'POOL_A';

function makeOrchestrator(overrides: {
  closeValue?: number | null;
  onChain?: any[];
  createThrows?: Error;
  /** Thrown once per create attempt, in order; undefined entries succeed. */
  createThrowsPerAttempt?: (Error | undefined)[];
} = {}) {
  const calls: string[] = [];

  const client: any = {
    init: async () => undefined,
    getMyPositions: async () => {
      calls.push('getMyPositions');
      return overrides.onChain ?? [];
    },
  };

  const o = new Orchestrator({}, client);
  (o as any).init = async () => undefined;

  (o as any).closePosition = jest.fn(async (mint: string) => {
    calls.push(`close:${mint}`);
    return {
      txId: 'TX_CLOSE',
      solWithdrawn: 0.05,
      usdcWithdrawn: 5,
      feesEarnedUsd: 0.2,
      valueBeforeUsd: overrides.closeValue === undefined ? 9.73 : overrides.closeValue,
      feeSol: 0.002,
      feeUsdc: 0.03,
    };
  });

  let createAttempt = 0;
  (o as any).createNewPosition = jest.fn(async (p: any) => {
    calls.push(`create:${p.investmentUsd}:${p.prevPositionMint ?? 'none'}`);
    const perAttempt = overrides.createThrowsPerAttempt?.[createAttempt++];
    if (perAttempt) throw perAttempt;
    if (overrides.createThrows) throw overrides.createThrows;
    return {
      operationId: 'op_1', nftMint: 'NEW_MINT', txId: 'TX_OPEN',
      priceLower: 100, priceUpper: 120, solAmount: 0.05, usdcAmount: 5,
      solRatio: 48.8, usdcRatio: 51.2, source: 'ml', valueUsd: 9.73,
    };
  });

  (o as any).sleep = async () => undefined;

  return { o, calls };
}

beforeEach(() => {
  jest.clearAllMocks();
  recording.hasExceededRebalanceLimit.mockResolvedValue(false);
  recording.getInvestmentAmount.mockResolvedValue(10);
  recording.getOpenPositionForPool.mockResolvedValue({ nftMint: 'OLD_MINT', openedAt: new Date() });
});

describe('the daily cap comes first', () => {
  it('refuses before recording anything when the cap is reached', async () => {
    recording.hasExceededRebalanceLimit.mockResolvedValue(true);
    const { o, calls } = makeOrchestrator();

    const out = await o.rebalance({ poolId: POOL });

    expect(out).toEqual({ status: 'capped', limit: expect.any(Number) });
    expect(recording.recordRebalance).not.toHaveBeenCalled();
    expect(calls).toEqual([]); // nothing closed, nothing created
  });

  it('records the rebalance once the cap passes', async () => {
    const { o } = makeOrchestrator();
    await o.rebalance({ poolId: POOL });
    expect(recording.recordRebalance).toHaveBeenCalledTimes(1);
  });
});

describe('what to close', () => {
  it('uses the recorded position when there is one', async () => {
    const { o, calls } = makeOrchestrator();
    await o.rebalance({ poolId: POOL });
    expect(calls).toContain('close:OLD_MINT');
  });

  it('recovers it from the chain when the record has lost it', async () => {
    recording.getOpenPositionForPool.mockResolvedValue(null);
    const { o, calls } = makeOrchestrator({ onChain: [{ nftMint: 'CHAIN_MINT', poolId: POOL }] });
    await o.rebalance({ poolId: POOL });
    expect(calls).toContain('close:CHAIN_MINT');
  });

  it('REFUSES when more than one is open and closes nothing', async () => {
    recording.getOpenPositionForPool.mockResolvedValue(null);
    const { o, calls } = makeOrchestrator({
      onChain: [{ nftMint: 'A', poolId: POOL }, { nftMint: 'B', poolId: POOL }],
    });

    const out = await o.rebalance({ poolId: POOL });

    expect(out).toEqual({ status: 'refused', reason: 'ambiguous-position', openCount: 2 });
    expect(calls.some((c) => c.startsWith('close:'))).toBe(false);
    expect(calls.some((c) => c.startsWith('create:'))).toBe(false);
  });

  it('creates without closing when nothing is open', async () => {
    recording.getOpenPositionForPool.mockResolvedValue(null);
    const { o, calls } = makeOrchestrator({ onChain: [] });

    const out = await o.rebalance({ poolId: POOL });

    expect(calls.some((c) => c.startsWith('close:'))).toBe(false);
    expect(calls).toContain('create:10:none'); // the configured amount, no predecessor
    expect(out.status).toBe('rebalanced');
  });
});

describe('the budget is what the closing position was worth', () => {
  it('redeploys the closed value, not the configured amount', async () => {
    const { o, calls } = makeOrchestrator({ closeValue: 9.73 });
    await o.rebalance({ poolId: POOL });
    // 9.73 came from the close; 10 is the configured amount and must not win.
    expect(calls).toContain('create:9.73:OLD_MINT');
  });

  it('closes BEFORE it creates, and links the replacement to what it replaced', async () => {
    const { o, calls } = makeOrchestrator();
    await o.rebalance({ poolId: POOL });
    expect(calls.indexOf('close:OLD_MINT')).toBeLessThan(
      calls.findIndex((c) => c.startsWith('create:'))
    );
    expect(calls.find((c) => c.startsWith('create:'))).toContain(':OLD_MINT');
  });

  it('reports closed-only when the value cannot be read, and creates nothing', async () => {
    const { o, calls } = makeOrchestrator({ closeValue: null });

    const out = await o.rebalance({ poolId: POOL });

    expect(out).toEqual({ status: 'closed-only', closedMint: 'OLD_MINT' });
    expect(calls.some((c) => c.startsWith('create:'))).toBe(false);
    // And it must NOT quietly substitute the configured amount.
    expect(calls.some((c) => c === 'create:10:OLD_MINT')).toBe(false);
  });

  it('refuses a first open with no configured amount rather than deploying everything', async () => {
    recording.getOpenPositionForPool.mockResolvedValue(null);
    recording.getInvestmentAmount.mockResolvedValue(null);
    const { o, calls } = makeOrchestrator({ onChain: [] });

    const out = await o.rebalance({ poolId: POOL });

    expect(out).toEqual({ status: 'refused', reason: 'no-budget' });
    expect(calls.some((c) => c.startsWith('create:'))).toBe(false);
  });
});

describe('failures are reported, not thrown at the UI', () => {
  it('returns failed when the create throws', async () => {
    const { o } = makeOrchestrator({ createThrows: new Error('6017 slippage') });
    const out = await o.rebalance({ poolId: POOL });

    // NOT 'failed'. The close already succeeded, so the money is in the wallet
    // and out of the market -- the state the UI has to act on, and the one it
    // reported as a generic failure while it kept watching the burned mint.
    expect(out).toMatchObject({
      status: 'closed-open-failed',
      closedMint: 'OLD_MINT',
      error: '6017 slippage',
      // A slippage revert is NOT known to have sent nothing; only an expiry is.
      nothingSent: false,
    });
  });
});

describe('progress is narration, not a question', () => {
  it('works with no listener at all', async () => {
    const { o } = makeOrchestrator();
    await expect(o.rebalance({ poolId: POOL })).resolves.toMatchObject({ status: 'rebalanced' });
  });

  it('narrates the close and what is being redeployed', async () => {
    const said: string[] = [];
    const { o } = makeOrchestrator();
    await o.rebalance({ poolId: POOL, onProgress: async (t) => said.push(t) });
    expect(said.join('\n')).toMatch(/Closing old position/);
    expect(said.join('\n')).toMatch(/9\.73/);
  });
});

/**
 * A close that succeeds and an open that does not.
 *
 * On 2026-09-25 this shape arrived as a plain `failed`. The bot went on watching
 * a mint it had just burned, logged `not found on-chain` as an error every 30s
 * for 3.4 hours, told the operator to check /status -- the one command that
 * resolves the stale mint and so cannot see this state -- and never mentioned
 * that $1031.18 was sitting in the wallet, out of the market.
 */
describe('a close that cannot be followed by an open', () => {
  it('reports the idle budget, not a generic failure', async () => {
    const { o } = makeOrchestrator({ createThrows: new Error('6017 slippage') });
    const out = await o.rebalance({ poolId: POOL });

    expect(out).toEqual({
      status: 'closed-open-failed',
      closedMint: 'OLD_MINT',
      idleUsd: 9.73,
      error: '6017 slippage',
      nothingSent: false,
    });
  });

  it('marks an expiry as having sent nothing', async () => {
    // The one failure KNOWN to have moved no money: an expired transaction
    // cannot be included by anyone. Worth saying plainly rather than leaving the
    // operator to wonder.
    const { o } = makeOrchestrator({
      createThrowsPerAttempt: [
        new BlockhashExpiredError('expired'),
        new BlockhashExpiredError('expired again'),
      ],
    });
    const out = await o.rebalance({ poolId: POOL });

    expect(out).toMatchObject({ status: 'closed-open-failed', nothingSent: true });
  });

  it('retries the open ONCE when the first attempt expired without sending', async () => {
    // BlockhashExpiredError has carried "Rebuild it against a fresh blockhash
    // and retry" since it was introduced, and nothing acted on it -- the
    // rebalance gave up with the position already closed.
    const { o, calls } = makeOrchestrator({
      createThrowsPerAttempt: [new BlockhashExpiredError('expired')],
    });
    const out = await o.rebalance({ poolId: POOL });

    expect(out).toMatchObject({ status: 'rebalanced' });
    expect(calls.filter(c => c.startsWith('create:'))).toHaveLength(2);
  });

  it('does not retry a failure that may have moved money', async () => {
    // A revert is a decision by the chain, not a transient failure, and a
    // second attempt on an unknown outcome is how you double-deploy.
    const { o, calls } = makeOrchestrator({ createThrows: new Error('6017 slippage') });
    await o.rebalance({ poolId: POOL });

    expect(calls.filter(c => c.startsWith('create:'))).toHaveLength(1);
  });

  it('still reports `failed` when there was nothing to close', async () => {
    // A first open that throws has stranded nothing: no position existed and no
    // withdrawal is sitting in the wallet.
    recording.getOpenPositionForPool.mockResolvedValueOnce(null);
    const { o } = makeOrchestrator({
      onChain: [],
      createThrows: new Error('6017 slippage'),
    });
    const out = await o.rebalance({ poolId: POOL });

    expect(out).toEqual({ status: 'failed', error: '6017 slippage' });
  });
});
