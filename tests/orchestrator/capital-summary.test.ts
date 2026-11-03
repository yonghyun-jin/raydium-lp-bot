import {
  summariseCapital,
  isDriftWorthReporting,
  capitalLogLine,
  DRIFT_THRESHOLDS,
} from '../../src/orchestrator/capital';

/**
 * The capital summary exists because a $1,000 drift was invisible for weeks.
 * Every test here is about the gap being REPORTABLE -- either as a number, or
 * as "unknown". The one outcome this file forbids is a reassuring zero.
 */
describe('the capital summary', () => {
  it('measures the gap against what is DEPLOYED, not against the wallet', () => {
    const summary = summariseCapital({
      allocatedUsd: 4000,
      positionValueUsd: 3000,
      idleWalletUsd: 1000,
    });

    // $1,000 of the allocation is not in the position. That the wallet happens
    // to hold $1,000 does not close the gap -- it explains it.
    expect(summary.gapUsd).toBe(1000);
    expect(summary.coveredByIdle).toBe(true);
  });

  /**
   * THE FALSE-ALARM GUARD. The first version of this file summed the wallet
   * into "working", which asserts every dollar in it is the strategy's. This
   * wallet is known to hold the operator's own money -- $3,003.00 of unrelated
   * USDC turned up on the token account once -- so that version reported a
   * permanent phantom surplus and would have fired on every position.
   */
  it('does not read unrelated money in the wallet as a surplus', () => {
    const summary = summariseCapital({
      allocatedUsd: 10,
      positionValueUsd: 10,
      idleWalletUsd: 3003,
    });

    expect(summary.gapUsd).toBe(0);
    expect(isDriftWorthReporting(summary, DRIFT_THRESHOLDS)).toBe(false);
  });

  it('tells idle money apart from lost money', () => {
    const idle = summariseCapital({
      allocatedUsd: 4000,
      positionValueUsd: 3000,
      idleWalletUsd: 1000,
    });
    const gone = summariseCapital({
      allocatedUsd: 4000,
      positionValueUsd: 3000,
      idleWalletUsd: 2,
    });

    // Opposite responses from the operator, so they cannot render the same.
    expect(idle.coveredByIdle).toBe(true);
    expect(gone.coveredByIdle).toBe(false);
  });

  it('has nothing to cover when the gap is not positive', () => {
    const summary = summariseCapital({
      allocatedUsd: 4000,
      positionValueUsd: 4000,
      idleWalletUsd: 500,
    });

    // Null, not false: "no gap to cover" is not "the gap is uncovered".
    expect(summary.coveredByIdle).toBeNull();
  });

  it('reports the gap the operator never saw: $4,000 allocated, $3,000 deployed', () => {
    const summary = summariseCapital({
      allocatedUsd: 4000,
      positionValueUsd: 3000,
      idleWalletUsd: 0,
    });

    expect(summary.gapUsd).toBe(1000);
    expect(isDriftWorthReporting(summary, DRIFT_THRESHOLDS)).toBe(true);
  });

  it('reports a NEGATIVE gap only when the POSITION outgrew the allocation', () => {
    const summary = summariseCapital({
      allocatedUsd: 4000,
      positionValueUsd: 4300,
      idleWalletUsd: 100,
    });

    // Profit waiting for a decision, not an error. It still has to be said out
    // loud, because capping the budget at the allocation is what leaves it idle.
    // -300, from the POSITION alone: the $100 in the wallet is not counted,
    // because the bot cannot tell its own profit from an operator deposit.
    expect(summary.gapUsd).toBe(-300);
    expect(isDriftWorthReporting(summary, DRIFT_THRESHOLDS)).toBe(true);
  });

  /**
   * THE GUARD THAT MATTERS. Coercing any of these to 0 produces "gap $0.00",
   * which reads as "all of your capital is working" -- the exact sentence the
   * operator would have been shown while $1,000 sat idle.
   */
  describe('an unreadable input propagates as null, never as zero', () => {
    it('an unknown position value leaves working and gap unknown', () => {
      const summary = summariseCapital({
        allocatedUsd: 4000,
        positionValueUsd: null,
        idleWalletUsd: 1000,
      });

      expect(summary.gapUsd).toBeNull();
      expect(summary.coveredByIdle).toBeNull();
    });

    it('an unknown wallet still gives the gap, but cannot say if it is covered', () => {
      const summary = summariseCapital({
        allocatedUsd: 4000,
        positionValueUsd: 3000,
        idleWalletUsd: null,
      });

      // The gap does not depend on the wallet, so losing the wallet must not
      // lose the headline figure too.
      expect(summary.gapUsd).toBe(1000);
      expect(summary.coveredByIdle).toBeNull();
    });

    it('an unknown allocation leaves the gap unknown', () => {
      const summary = summariseCapital({
        allocatedUsd: null,
        positionValueUsd: 3000,
        idleWalletUsd: 1000,
      });

      expect(summary.gapUsd).toBeNull();
    });

    it('never calls an unknown gap a drift', () => {
      const summary = summariseCapital({
        allocatedUsd: 4000,
        positionValueUsd: null,
        idleWalletUsd: null,
      });

      expect(isDriftWorthReporting(summary, DRIFT_THRESHOLDS)).toBe(false);
    });

    it('renders every unknown as the word, not as a dollar figure', () => {
      const line = capitalLogLine(
        summariseCapital({ allocatedUsd: null, positionValueUsd: null, idleWalletUsd: null })
      );

      expect(line).toContain('allocated=unknown');
      expect(line).toContain('position=unknown');
      expect(line).toContain('idle=unknown');
      expect(line).toContain('gap=unknown');
      expect(line).not.toContain('$0.00');
    });
  });

  describe('the reporting threshold needs both a dollar figure and a share', () => {
    it('stays quiet about rounding on a large allocation', () => {
      const summary = summariseCapital({
        allocatedUsd: 4000,
        positionValueUsd: 3996,
        idleWalletUsd: 2,
      });

      // $4 is over nothing worth saying and is 0.1% of the allocation.
      expect(summary.gapUsd).toBe(4);
      expect(isDriftWorthReporting(summary, DRIFT_THRESHOLDS)).toBe(false);
    });

    it('stays quiet when the share is large but the money is trivial', () => {
      const summary = summariseCapital({
        allocatedUsd: 20,
        positionValueUsd: 17,
        idleWalletUsd: 0,
      });

      // 15% -- but $3, and interrupting over $3 trains the operator to ignore it.
      expect(isDriftWorthReporting(summary, DRIFT_THRESHOLDS)).toBe(false);
    });

    it('speaks up when both thresholds are cleared', () => {
      const summary = summariseCapital({
        allocatedUsd: 500,
        positionValueUsd: 480,
        idleWalletUsd: 0,
      });

      // $20 and 4%.
      expect(isDriftWorthReporting(summary, DRIFT_THRESHOLDS)).toBe(true);
    });

    it('cannot divide by a non-positive allocation', () => {
      const summary = summariseCapital({
        allocatedUsd: 0,
        positionValueUsd: 0,
        idleWalletUsd: 0,
      });

      expect(isDriftWorthReporting(summary, DRIFT_THRESHOLDS)).toBe(false);
    });
  });
});
