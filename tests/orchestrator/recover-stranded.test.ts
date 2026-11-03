/**
 * Recovery must not depend on having anticipated the failure.
 *
 * On 2026-09-25 a rebalance closed a $1031.18 position, failed to reopen it, and
 * the money sat in the wallet while the monitoring loop returned early every 30s
 * for hours. Two causes were found and fixed. These tests are about the OTHER
 * half of that lesson: a 6017 revert, a Jupiter outage, the 120s Python predictor
 * timing out or a Prisma hiccup all strand the funds identically, and a recovery
 * path built from `instanceof` checks is a list that the next failure is not on.
 *
 * So what authorises a redeploy here is STATE -- no position on-chain means
 * nothing was deployed, whatever threw -- and the error class only decides how
 * long to wait first.
 */

import { Orchestrator } from '../../src/orchestrator/Orchestrator';
import { SETTLE_MS } from '../../src/raydium/recoverability';

jest.mock('../../src/recording', () => ({
  hasExceededRebalanceLimit: jest.fn(async () => false),
  recordRebalance: jest.fn(async () => undefined),
  getInvestmentAmount: jest.fn(async () => 10),
  getOpenPositionForPool: jest.fn(async () => null),
  recordPositionOpened: jest.fn(async () => undefined),
  recordPositionClosed: jest.fn(async () => undefined),
  recordLedgerRows: jest.fn(async () => undefined),
  getPositionContext: jest.fn(async () => null),
  getRebalanceCountToday: jest.fn(async () => 0),
  resetRebalanceCount: jest.fn(async () => undefined),
  recordStranded: jest.fn(async () => undefined),
  clearStranded: jest.fn(async () => undefined),
  recordDeployIntent: jest.fn(async () => undefined),
  recordRecoveryAttempt: jest.fn(async () => undefined),
  getRecoveryState: jest.fn(async () => null),
}));

const recording = require('../../src/recording');
const POOL = 'POOL_A';
const LONG_AGO = new Date(Date.now() - 10 * 60_000);

/** A strand that is past its settle window and outside any backoff. */
function strandedState(over: Record<string, unknown> = {}) {
  return {
    deployIntent: 'DEPLOYED' as const,
    strandedUsd: 1031.18,
    strandedSince: LONG_AGO,
    recoveryAttempts: 0,
    lastRecoveryAt: null,
    ...over,
  };
}

function makeOrchestrator(over: { onChain?: any[]; createThrows?: Error } = {}) {
  const calls: string[] = [];
  const client: any = { init: async () => undefined };

  const o = new Orchestrator({}, client);
  (o as any).init = async () => undefined;
  (o as any).openPositionsInPool = jest.fn(async () => {
    calls.push('readChain');
    return over.onChain ?? [];
  });
  (o as any).createNewPosition = jest.fn(async (p: any) => {
    calls.push(`create:${p.investmentUsd}`);
    if (over.createThrows) throw over.createThrows;
    return {
      operationId: 'op_1', nftMint: 'NEW_MINT', txId: 'TX_OPEN',
      priceLower: 100, priceUpper: 120, solAmount: 1, usdcAmount: 500,
      solRatio: 48, usdcRatio: 52, source: 'ml', valueUsd: 1031.18,
    };
  });
  return { o, calls };
}

beforeEach(() => jest.clearAllMocks());

describe('when there is nothing to do', () => {
  it('does nothing if the operator does not want a position', async () => {
    // /stop must actually stop it. An autonomous recovery loop with no off switch
    // would put the money back after being told not to.
    recording.getRecoveryState.mockResolvedValueOnce(
      strandedState({ deployIntent: 'IDLE' })
    );
    const { o, calls } = makeOrchestrator();
    expect(await o.recoverStranded({ poolId: POOL })).toEqual({ status: 'not-wanted' });
    expect(calls).toEqual([]);
  });

  it('does nothing when no funds are owed', async () => {
    recording.getRecoveryState.mockResolvedValueOnce(strandedState({ strandedUsd: null }));
    const { o } = makeOrchestrator();
    expect(await o.recoverStranded({ poolId: POOL })).toEqual({ status: 'nothing-stranded' });
  });

  it('REFUSES TO GUESS when the state cannot be read', async () => {
    // Null is "cannot establish", never "nothing is stranded". An unreachable
    // database must not look like healthy state and silence the alarm.
    recording.getRecoveryState.mockResolvedValueOnce(null);
    const { o, calls } = makeOrchestrator();
    expect(await o.recoverStranded({ poolId: POOL })).toEqual({ status: 'unknown' });
    expect(calls).toEqual([]);
  });
});

describe('what authorises the redeploy is state, not the error', () => {
  it('redeploys the PERSISTED budget, not the configured amount', async () => {
    // The whole reason strandedUsd is written down. By now the position it came
    // from is burned, so resolveOpenPosition finds nothing and the budget would
    // fall back to INVESTMENT_AMOUNT -- which really happened: the 2026-09-25
    // retry read `Budget $1000.00` against $1031.18 actually withdrawn.
    recording.getRecoveryState.mockResolvedValueOnce(strandedState());
    const { o, calls } = makeOrchestrator();

    const out = await o.recoverStranded({ poolId: POOL });

    expect(out).toMatchObject({ status: 'recovered', redeployedUsd: 1031.18 });
    expect(calls).toContain('create:1031.18');
    expect(calls).not.toContain('create:10');
  });

  it('reads the chain BEFORE deploying', async () => {
    recording.getRecoveryState.mockResolvedValueOnce(strandedState());
    const { o, calls } = makeOrchestrator();
    await o.recoverStranded({ poolId: POOL });
    expect(calls.indexOf('readChain')).toBeLessThan(calls.indexOf('create:1031.18'));
  });

  it('RECOVERS FROM A FAILURE NOBODY CLASSIFIED, once the settle window passed', async () => {
    // The answer to "what about the exception we have not seen yet". The strand
    // carries no error class at all -- recoverStranded assumes UNKNOWN -- and it
    // still recovers, because an empty chain after the settle window is final.
    recording.getRecoveryState.mockResolvedValueOnce(strandedState());
    const { o } = makeOrchestrator();
    expect(await o.recoverStranded({ poolId: POOL })).toMatchObject({ status: 'recovered' });
  });

  it('will not deploy while a send could still be in flight', async () => {
    // Freshly stranded: a transaction submitted moments ago may yet land, and
    // deploying alongside it is the double-deploy this gate exists to prevent.
    recording.getRecoveryState.mockResolvedValueOnce(
      strandedState({ strandedSince: new Date(Date.now() - 5_000) })
    );
    const { o, calls } = makeOrchestrator();

    const out = await o.recoverStranded({ poolId: POOL });

    expect(out).toMatchObject({ status: 'waiting' });
    expect(calls).not.toContain('create:1031.18');
    expect(SETTLE_MS).toBeGreaterThan(60_000);
  });

  it('clears a stale strand when a position turns up', async () => {
    // An earlier attempt landed after we stopped watching. Retrying against that
    // forever would be the double-deploy; clearing resolves the episode.
    recording.getRecoveryState.mockResolvedValueOnce(strandedState());
    const { o, calls } = makeOrchestrator({ onChain: [{ nftMint: 'SURPRISE' }] });

    const out = await o.recoverStranded({ poolId: POOL });

    expect(out).toEqual({ status: 'already-deployed' });
    expect(recording.clearStranded).toHaveBeenCalled();
    expect(calls).not.toContain('create:1031.18');
  });
});

describe('bounds', () => {
  it('gives up at the ceiling instead of retrying forever', async () => {
    recording.getRecoveryState.mockResolvedValueOnce(strandedState({ recoveryAttempts: 6 }));
    const { o, calls } = makeOrchestrator();

    const out = await o.recoverStranded({ poolId: POOL });

    expect(out).toMatchObject({ status: 'exhausted', idleUsd: 1031.18, attempts: 6 });
    expect(calls).not.toContain('create:1031.18');
  });

  it('backs off between attempts', async () => {
    recording.getRecoveryState.mockResolvedValueOnce(
      strandedState({ recoveryAttempts: 2, lastRecoveryAt: new Date(Date.now() - 1_000) })
    );
    const { o, calls } = makeOrchestrator();

    const out = await o.recoverStranded({ poolId: POOL });

    expect(out).toMatchObject({ status: 'waiting' });
    expect(calls).not.toContain('create:1031.18');
  });

  it('counts the attempt BEFORE trying, so a hard crash still burns one', async () => {
    // Otherwise the ceiling never bites and a crashing failure retries forever.
    recording.getRecoveryState.mockResolvedValueOnce(strandedState());
    const { o } = makeOrchestrator({ createThrows: new Error('boom') });

    await o.recoverStranded({ poolId: POOL });

    expect(recording.recordRecoveryAttempt).toHaveBeenCalled();
  });

  it('keeps the strand when an attempt fails, so the next tick retries', async () => {
    recording.getRecoveryState.mockResolvedValueOnce(strandedState());
    const { o } = makeOrchestrator({ createThrows: new Error('Jupiter 503') });

    const out = await o.recoverStranded({ poolId: POOL });

    expect(out).toMatchObject({ status: 'failed', idleUsd: 1031.18, attempts: 1 });
    expect(recording.clearStranded).not.toHaveBeenCalled();
  });

  it('clears the strand only once the funds are actually deployed', async () => {
    recording.getRecoveryState.mockResolvedValueOnce(strandedState());
    const { o } = makeOrchestrator();

    await o.recoverStranded({ poolId: POOL });

    expect(recording.clearStranded).toHaveBeenCalled();
  });
});
