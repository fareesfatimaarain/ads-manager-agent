import { describe, expect, it } from 'vitest';
import {
  MIN_EXPECTED_CELL_COUNT,
  poolArms,
  twoProportionZTest,
  type ProportionArm,
} from '../../src/stats/proportionTest.js';

const arm = (successes: number, trials: number): ProportionArm => ({ successes, trials });

describe('twoProportionZTest — validity gating', () => {
  it('refuses an empty variant arm', () => {
    const r = twoProportionZTest(arm(0, 0), arm(100, 1000), 'VARIANT_WORSE');
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toBe('EMPTY_VARIANT_ARM');
    expect(r.pValue).toBeNull();
  });

  it('refuses an empty baseline arm', () => {
    const r = twoProportionZTest(arm(10, 100), arm(0, 0), 'VARIANT_WORSE');
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toBe('EMPTY_BASELINE_ARM');
    expect(r.pValue).toBeNull();
  });

  it('refuses successes exceeding trials', () => {
    const r = twoProportionZTest(arm(200, 100), arm(100, 1000), 'VARIANT_WORSE');
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toBe('SUCCESSES_EXCEED_TRIALS');
  });

  it('refuses negative counts', () => {
    const r = twoProportionZTest(arm(-5, 100), arm(100, 1000), 'VARIANT_WORSE');
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toBe('NEGATIVE_COUNTS');
  });

  it('refuses non-integer counts', () => {
    const r = twoProportionZTest(arm(10.5, 100), arm(100, 1000), 'VARIANT_WORSE');
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toBe('NON_INTEGER_COUNTS');
  });

  it('refuses NaN counts rather than propagating them', () => {
    const r = twoProportionZTest(arm(NaN, 100), arm(100, 1000), 'VARIANT_WORSE');
    expect(r.valid).toBe(false);
    expect(r.pValue).toBeNull();
  });

  it('refuses an all-zero pooled rate (no discriminating information)', () => {
    // Nobody converted anywhere. There is no evidence that one arm is worse.
    const r = twoProportionZTest(arm(0, 5000), arm(0, 5000), 'VARIANT_WORSE');
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toBe('DEGENERATE_POOLED_RATE');
    expect(r.pValue).toBeNull();
  });

  it('refuses an all-success pooled rate', () => {
    const r = twoProportionZTest(arm(500, 500), arm(500, 500), 'VARIANT_BETTER');
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toBe('DEGENERATE_POOLED_RATE');
  });

  it('refuses samples too small for the normal approximation', () => {
    // Pooled rate 1/20 = 0.05; expected cell count 10*0.05 = 0.5, well under 5.
    const r = twoProportionZTest(arm(0, 10), arm(1, 10), 'VARIANT_WORSE');
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toBe('NORMAL_APPROXIMATION_INVALID');
    expect(r.pValue).toBeNull();
  });

  it('accepts a sample that just clears the approximation threshold', () => {
    // Pooled = 20/400 = 0.05; expected cell = 200*0.05 = 10 >= 5.
    const r = twoProportionZTest(arm(8, 200), arm(12, 200), 'VARIANT_WORSE');
    expect(r.valid).toBe(true);
    expect(r.minExpectedCellCount).toBeGreaterThanOrEqual(MIN_EXPECTED_CELL_COUNT);
  });
});

describe('twoProportionZTest — computed values', () => {
  it('matches a hand-computed z and p', () => {
    // baseline 100/1000 = 0.10, variant 150/1000 = 0.15
    // pooled = 0.125, SE = sqrt(0.125*0.875*0.002) = 0.0147902
    // z = 0.05 / 0.0147902 = 3.38062
    const r = twoProportionZTest(arm(150, 1000), arm(100, 1000), 'VARIANT_BETTER');
    expect(r.valid).toBe(true);
    expect(r.z!).toBeCloseTo(3.38062, 4);
    expect(r.pValue!).toBeCloseTo(0.000362, 5);
    expect(r.variantRate!).toBeCloseTo(0.15, 12);
    expect(r.baselineRate!).toBeCloseTo(0.1, 12);
    expect(r.pooledRate!).toBeCloseTo(0.125, 12);
    expect(r.relativeLiftPct!).toBeCloseTo(50, 9);
  });

  it('reports the opposite tail for the opposite direction', () => {
    const better = twoProportionZTest(arm(150, 1000), arm(100, 1000), 'VARIANT_BETTER');
    const worse = twoProportionZTest(arm(150, 1000), arm(100, 1000), 'VARIANT_WORSE');
    expect(better.pValue! + worse.pValue!).toBeCloseTo(1, 6);
    // A clearly better variant must not look significantly worse.
    expect(worse.pValue!).toBeGreaterThan(0.99);
  });

  it('finds no significance when the arms are identical', () => {
    const r = twoProportionZTest(arm(100, 1000), arm(100, 1000), 'VARIANT_WORSE');
    expect(r.valid).toBe(true);
    expect(r.z!).toBeCloseTo(0, 12);
    expect(r.pValue!).toBeCloseTo(0.5, 6);
  });

  it('does not reach significance on a large relative gap with a thin sample', () => {
    // Variant CTR is half the baseline, but on 300 impressions it is still noise.
    const r = twoProportionZTest(arm(3, 300), arm(12, 600), 'VARIANT_WORSE');
    if (r.valid) {
      expect(r.pValue!).toBeGreaterThan(0.1);
    } else {
      expect(r.invalidReason).toBe('NORMAL_APPROXIMATION_INVALID');
    }
  });

  it('reaches significance on the same gap with enough impressions', () => {
    // Same 50% CTR gap, now at the 3000-impression guardrail floor.
    const r = twoProportionZTest(arm(30, 3000), arm(120, 6000), 'VARIANT_WORSE');
    expect(r.valid).toBe(true);
    expect(r.pValue!).toBeLessThan(0.1);
  });

  it('never returns NaN for any valid result', () => {
    for (let s = 0; s <= 50; s += 5) {
      const r = twoProportionZTest(arm(s, 500), arm(25, 500), 'VARIANT_WORSE');
      if (r.valid) {
        expect(Number.isNaN(r.pValue!)).toBe(false);
        expect(Number.isNaN(r.z!)).toBe(false);
      } else {
        expect(r.pValue).toBeNull();
      }
    }
  });

  it('leaves relativeLiftPct null when the baseline rate is zero', () => {
    // Baseline had no successes but the variant did, so pooled is non-degenerate.
    const r = twoProportionZTest(arm(60, 1000), arm(0, 1000), 'VARIANT_BETTER');
    expect(r.valid).toBe(true);
    expect(r.relativeLiftPct).toBeNull();
  });

  it('clamps rather than reporting an implausibly exact tiny p-value', () => {
    const r = twoProportionZTest(arm(900, 1000), arm(10, 1000), 'VARIANT_BETTER');
    expect(r.valid).toBe(true);
    expect(r.pValue!).toBeGreaterThan(0);
  });
});

describe('poolArms', () => {
  it('sums successes and trials', () => {
    expect(poolArms([arm(1, 10), arm(2, 20), arm(3, 30)])).toEqual({ successes: 6, trials: 60 });
  });

  it('returns an empty arm for an empty list, which the test then rejects', () => {
    const pooled = poolArms([]);
    expect(pooled).toEqual({ successes: 0, trials: 0 });
    const r = twoProportionZTest(arm(10, 100), pooled, 'VARIANT_WORSE');
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toBe('EMPTY_BASELINE_ARM');
  });
});
