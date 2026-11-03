import {
  getRangePrediction,
  validatePrediction,
  V0_HALF_WIDTH_PCT,
  PredictionError,
} from '../../src/orchestrator/prediction';

describe('v0 fixed range', () => {
  it('is the live price plus or minus 4%', async () => {
    const p = await getRangePrediction(150);
    expect(V0_HALF_WIDTH_PCT).toBe(4);
    expect(p.lower).toBeCloseTo(144, 10);
    expect(p.upper).toBeCloseTo(156, 10);
    expect(p.width_pct).toBe(8);
    expect(p.source).toBe('fixed');
  });

  it('passes validation, with ratios from CLMM maths summing to 1', async () => {
    const p = await getRangePrediction(150);
    expect(validatePrediction(p)).toEqual({ valid: true, errors: [] });
    expect(p.sol_ratio + p.usdc_ratio).toBeCloseTo(1, 9);
  });

  it('refuses to set a range without a live price', async () => {
    await expect(getRangePrediction()).rejects.toThrow(PredictionError);
  });
});
