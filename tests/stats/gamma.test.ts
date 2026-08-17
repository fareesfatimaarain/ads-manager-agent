import { describe, expect, it } from 'vitest';
import {
  gammaCdf,
  gammaP,
  lnGamma,
  probabilityCpaAboveTarget,
  probabilityCpaBelowTarget,
} from '../../src/stats/gamma.js';
import { erf } from '../../src/stats/normal.js';

describe('lnGamma', () => {
  it('matches factorial identities', () => {
    expect(lnGamma(1)).toBeCloseTo(0, 10);
    expect(lnGamma(2)).toBeCloseTo(0, 10);
    expect(lnGamma(3)).toBeCloseTo(Math.log(2), 10);
    expect(lnGamma(4)).toBeCloseTo(Math.log(6), 10);
    expect(lnGamma(5)).toBeCloseTo(Math.log(24), 10);
    expect(lnGamma(10)).toBeCloseTo(Math.log(362880), 9);
  });

  it('matches the half-integer value', () => {
    // Gamma(1/2) = sqrt(pi)
    expect(lnGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 9);
  });

  it('rejects non-positive input', () => {
    expect(() => lnGamma(0)).toThrow(RangeError);
    expect(() => lnGamma(-1)).toThrow(RangeError);
  });
});

describe('gammaP', () => {
  it('matches the closed form for shape=1 (exponential)', () => {
    // P(1, x) = 1 - e^-x
    for (const x of [0.5, 1, 2, 5]) {
      expect(gammaP(1, x)).toBeCloseTo(1 - Math.exp(-x), 10);
    }
  });

  it('matches the closed form for shape=2', () => {
    // P(2, x) = 1 - e^-x (1 + x)
    for (const x of [0.5, 2, 6]) {
      expect(gammaP(2, x)).toBeCloseTo(1 - Math.exp(-x) * (1 + x), 10);
    }
  });

  it('matches the closed form for shape=1/2 (error function)', () => {
    // P(1/2, x) = erf(sqrt(x))
    for (const x of [0.25, 1, 4]) {
      expect(gammaP(0.5, x)).toBeCloseTo(erf(Math.sqrt(x)), 6);
    }
  });

  it('crosses the series/continued-fraction boundary smoothly', () => {
    // Boundary is at x = a + 1; sample either side of it for a = 10.
    const a = 10;
    const left = gammaP(a, 10.999);
    const right = gammaP(a, 11.001);
    expect(right - left).toBeGreaterThan(0);
    expect(right - left).toBeLessThan(1e-3);
  });

  it('is monotone increasing in x', () => {
    let prev = -1;
    for (let x = 0; x <= 40; x += 0.25) {
      const v = gammaP(5, x);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('stays within [0,1]', () => {
    for (const [a, x] of [
      [0.5, 0],
      [0.5, 500],
      [100, 1],
      [100, 1000],
    ] as const) {
      const v = gammaP(a, x);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('rejects invalid parameters', () => {
    expect(() => gammaP(0, 1)).toThrow(RangeError);
    expect(() => gammaP(-1, 1)).toThrow(RangeError);
    expect(() => gammaP(1, -1)).toThrow(RangeError);
  });

  it('gammaCdf scales by rate', () => {
    // Gamma(shape, rate) CDF at x equals P(shape, rate*x)
    expect(gammaCdf(2, 3, 0.5)).toBeCloseTo(gammaP(3, 1), 12);
    expect(() => gammaCdf(1, 1, 0)).toThrow(RangeError);
  });
});

describe('probabilityCpaBelowTarget', () => {
  const TARGET = 5000; // $50.00 in cents

  it('returns zero confidence when nothing has been spent', () => {
    expect(probabilityCpaBelowTarget(0, 0, TARGET)).toBe(0);
  });

  it('gives ~50% when observed CPA sits exactly on target', () => {
    // 25 conversions from 25 * $50 = $1250 of spend => observed CPA is exactly target.
    // With no strong evidence either way, confidence should sit near a coin flip.
    const p = probabilityCpaBelowTarget(25, 25 * TARGET, TARGET);
    expect(p).toBeGreaterThan(0.4);
    expect(p).toBeLessThan(0.6);
  });

  it('quantifies the zero-conversion kill rule', () => {
    // Spending 2x target CPA with zero conversions. The guardrail default treats this as
    // sufficient evidence to kill; this asserts the underlying probability supports that.
    // Closed form: 1 - erf(sqrt(2)) ~= 0.0455
    const p = probabilityCpaBelowTarget(0, 2 * TARGET, TARGET);
    expect(p).toBeCloseTo(1 - erf(Math.sqrt(2)), 5);
    expect(p).toBeLessThan(0.05);
  });

  it('is far less certain after only 1x target spend with no conversions', () => {
    // This is why the multiple matters: at 1x spend, ~16% is not enough to kill on.
    const p = probabilityCpaBelowTarget(0, TARGET, TARGET);
    expect(p).toBeGreaterThan(0.1);
    expect(p).toBeLessThan(0.2);
  });

  it('increases with more conversions at fixed spend', () => {
    const spend = 25 * TARGET;
    let prev = -1;
    for (const k of [5, 10, 20, 25, 30, 40, 60]) {
      const p = probabilityCpaBelowTarget(k, spend, TARGET);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it('decreases with more spend at fixed conversions', () => {
    let prev = 2;
    for (const mult of [10, 20, 25, 30, 50]) {
      const p = probabilityCpaBelowTarget(25, mult * TARGET, TARGET);
      expect(p).toBeLessThan(prev);
      prev = p;
    }
  });

  it('demands a genuinely better observed CPA to clear 95% confidence', () => {
    const spend = 25 * TARGET; // $1250
    // Observed CPA exactly on target -> nowhere near 95%.
    expect(probabilityCpaBelowTarget(25, spend, TARGET)).toBeLessThan(0.95);
    // ~35 conversions on the same spend (observed CPA ~$35.7) clears it.
    expect(probabilityCpaBelowTarget(35, spend, TARGET)).toBeGreaterThan(0.95);
  });

  it('is not fooled by a tiny sample with a flattering ratio', () => {
    // 1 conversion at $10 spend implies an observed CPA of $10 vs a $50 target: a 5x beat.
    // The posterior must NOT report high confidence from a single event.
    const p = probabilityCpaBelowTarget(1, 1000, TARGET);
    expect(p).toBeLessThan(0.95);
  });

  it('complements probabilityCpaAboveTarget', () => {
    for (const k of [0, 3, 25]) {
      const below = probabilityCpaBelowTarget(k, 25 * TARGET, TARGET);
      const above = probabilityCpaAboveTarget(k, 25 * TARGET, TARGET);
      expect(below + above).toBeCloseTo(1, 12);
    }
  });

  it('rejects malformed inputs loudly', () => {
    expect(() => probabilityCpaBelowTarget(-1, 100, TARGET)).toThrow(RangeError);
    expect(() => probabilityCpaBelowTarget(1.5, 100, TARGET)).toThrow(RangeError);
    expect(() => probabilityCpaBelowTarget(1, -100, TARGET)).toThrow(RangeError);
    expect(() => probabilityCpaBelowTarget(1, 100, 0)).toThrow(RangeError);
    expect(() => probabilityCpaBelowTarget(1, 100, -5)).toThrow(RangeError);
  });
});
