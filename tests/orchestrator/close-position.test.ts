/**
 * A close must report what it produced — and read it before it sends.
 *
 * WHY THIS IS A BEHAVIOURAL TEST: the invariants below used to be asserted by
 * slicing `bot.ts` as text and comparing string indices, because the logic
 * lived in the UI layer and there was no seam to test through. Now there is
 * one: `ClosePosition` takes an `LpClient`, so call ORDER can be asserted on a
 * fake. That is a strictly better guard than an index comparison, and it
 * survives the code moving again.
 *
 * Each invariant encodes a real incident:
 *
 * - Fees read BEFORE the send. A successful close burns the position account,
 *   so afterwards there is nothing to read. Every fee figure the bot ever
 *   computed was displayed and discarded for exactly this reason.
 * - Value read BEFORE the send. It is the budget for a rebalance's replacement,
 *   and reading it after would fold the close's own gas into the number.
 * - Unreadable fees are `undefined`, never 0 — 0 means "earned nothing" in the
 *   column a P&L report sums.
 * - A failed READ must not prevent the close. The caller asked to exit a
 *   position; refusing because a balance query timed out would strand it.
 * - A failed SEND must still throw.
 */

import { ClosePosition } from '../../src/orchestrator/components/ClosePosition';

const MINT = '9RXMvuKfSN7QfBk83SsAgyrjLiqoyh6ozkU51Vgy61ot';

type Overrides = Partial<{
  details: any;
  detailsThrows: boolean;
  balancesThrow: boolean;
  closeThrows: Error;
}>;

function fakeClient(o: Overrides = {}) {
  const calls: string[] = [];
  let sol = 1.0;
  let usdc = 100;

  const client: any = {
    async getPositionDetails() {
      calls.push('getPositionDetails');
      if (o.detailsThrows) throw new Error('rpc down');
      return o.details === undefined
        ? { feeA: 0.0002, feeB: 0.03, currentPrice: 100, totalValueUsd: 9.73 }
        : o.details;
    },
    async getSolBalance() {
      calls.push('getSolBalance');
      if (o.balancesThrow) throw new Error('rpc down');
      return sol;
    },
    async getUsdcBalance() {
      calls.push('getUsdcBalance');
      if (o.balancesThrow) throw new Error('rpc down');
      return usdc;
    },
    async closePosition() {
      calls.push('closePosition');
      if (o.closeThrows) throw o.closeThrows;
      // The withdrawal lands in the wallet.
      sol += 0.05;
      usdc += 4.5;
      return { txId: 'TX_ABC' };
    },
  };

  return { client, calls };
}

describe('ClosePosition reads before it sends', () => {
  it('reads the position BEFORE closing it', async () => {
    const { client, calls } = fakeClient();
    await new ClosePosition(client).execute(MINT);
    expect(calls.indexOf('getPositionDetails')).toBeLessThan(calls.indexOf('closePosition'));
  });

  it('reads balances on both sides of the send', async () => {
    const { client, calls } = fakeClient();
    await new ClosePosition(client).execute(MINT);
    const close = calls.indexOf('closePosition');
    const reads = calls.reduce<number[]>((acc, c, i) => (c === 'getSolBalance' ? [...acc, i] : acc), []);
    expect(reads.length).toBe(2);
    expect(reads[0]).toBeLessThan(close);
    expect(reads[1]).toBeGreaterThan(close);
  });

  it('reports the withdrawal as the wallet delta', async () => {
    const { client } = fakeClient();
    const r = await new ClosePosition(client).execute(MINT);
    expect(r.txId).toBe('TX_ABC');
    expect(r.solWithdrawn).toBeCloseTo(0.05, 8);
    expect(r.usdcWithdrawn).toBeCloseTo(4.5, 8);
  });

  it('reports fees and the pre-close value', async () => {
    const { client } = fakeClient();
    const r = await new ClosePosition(client).execute(MINT);
    expect(r.feesEarnedUsd).toBeCloseTo(0.0002 * 100 + 0.03, 8);
    expect(r.valueBeforeUsd).toBe(9.73);
  });
});

describe('what an unreadable figure means', () => {
  it('unreadable fees are undefined, never 0', async () => {
    const { client } = fakeClient({
      details: { feeA: null, feeB: null, currentPrice: 100, totalValueUsd: 9.73 },
    });
    const r = await new ClosePosition(client).execute(MINT);
    expect(r.feesEarnedUsd).toBeUndefined();
    expect(r.feesEarnedUsd).not.toBe(0);
    // ...and the value is still reported, because they are separate questions.
    expect(r.valueBeforeUsd).toBe(9.73);
  });

  it('an unreadable position yields null value and undefined fees', async () => {
    const { client } = fakeClient({ details: null });
    const r = await new ClosePosition(client).execute(MINT);
    expect(r.valueBeforeUsd).toBeNull();
    expect(r.feesEarnedUsd).toBeUndefined();
  });

  it('unreadable balances yield null withdrawals', async () => {
    const { client } = fakeClient({ balancesThrow: true });
    const r = await new ClosePosition(client).execute(MINT);
    expect(r.solWithdrawn).toBeNull();
    expect(r.usdcWithdrawn).toBeNull();
  });
});

describe('a failed read must not strand the position', () => {
  it('still closes when the pre-close read throws', async () => {
    const { client, calls } = fakeClient({ detailsThrows: true });
    const r = await new ClosePosition(client).execute(MINT);
    expect(calls).toContain('closePosition');
    expect(r.txId).toBe('TX_ABC');
    expect(r.valueBeforeUsd).toBeNull();
  });

  it('still closes when the balance reads throw', async () => {
    const { client, calls } = fakeClient({ balancesThrow: true });
    await new ClosePosition(client).execute(MINT);
    expect(calls).toContain('closePosition');
  });
});

describe('a failed send must still throw', () => {
  it('propagates a close failure', async () => {
    const { client } = fakeClient({ closeThrows: new Error('on-chain failure 6030') });
    await expect(new ClosePosition(client).execute(MINT)).rejects.toThrow(/6030/);
  });

  it('propagates a guard refusal, so DRY_RUN cannot report success', async () => {
    // A close that reports success while money is still on-chain is the mirror
    // of the phantom-position bug.
    class SendBlockedError extends Error {}
    const { client } = fakeClient({ closeThrows: new SendBlockedError('[GUARD] DRY_RUN') });
    await expect(new ClosePosition(client).execute(MINT)).rejects.toThrow(/DRY_RUN/);
  });
});
