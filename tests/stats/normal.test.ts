import { describe, expect, it } from 'vitest';
import { erf, erfc, normalCdf, normalQuantile, normalSf } from '../../src/stats/normal.js';

// A&S 7.1.26 carries max abs error ~1.5e-7; assert to 1e-6.
const TOL = 1e-6;

describe('erf', () => {
  it('matches known values', () => {
    expect(erf(0)).toBeCloseTo(0, 12);
    expect(erf(0.5)).toBeCloseTo(0.5204998778, 6);
    expect(erf(1)).toBeCloseTo(0.8427007929, 6);
    expect(erf(2)).toBeCloseTo(0.995322265, 6);
  });

  it('is odd', () => {
    for (const x of [0.1, 0.7, 1.3, 2.5, 4]) {
      expect(erf(-x)).toBeCloseTo(-erf(x), 12);
    }
  });

  it('erfc complements erf', () => {
    for (const x of [-2, -0.5, 0, 0.5, 2]) {
      expect(erfc(x) + erf(x)).toBeCloseTo(1, 12);
    }
  });

  it('rejects non-finite input rather than returning NaN', () => {
    expect(() => erf(NaN)).toThrow(TypeError);
    expect(() => erf(Infinity)).toThrow(TypeError);
  });
});

describe('normalCdf', () => {
  it('matches published critical values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 9);
    expect(normalCdf(1)).toBeCloseTo(0.8413447461, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.1586552539, 6);
    expect(normalCdf(1.6448536269)).toBeCloseTo(0.95, 6);
    expect(normalCdf(1.9599639845)).toBeCloseTo(0.975, 6);
    expect(normalCdf(2.5758293035)).toBeCloseTo(0.995, 6);
    expect(normalCdf(3)).toBeCloseTo(0.9986501, 6);
  });

  it('is symmetric about zero', () => {
    for (const z of [0.3, 1.1, 2.2, 3.5]) {
      expect(normalCdf(z) + normalCdf(-z)).toBeCloseTo(1, TOL);
    }
  });

  it('is monotone non-decreasing', () => {
    let prev = -Infinity;
    for (let z = -5; z <= 5; z += 0.05) {
      const v = normalCdf(z);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('never escapes [0,1] even far into the tails', () => {
    for (const z of [-40, -10, 10, 40]) {
      const v = normalCdf(z);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(Number.isNaN(v)).toBe(false);
    }
  });

  it('normalSf complements normalCdf', () => {
    for (const z of [-2, 0, 1.5, 3]) {
      expect(normalCdf(z) + normalSf(z)).toBeCloseTo(1, 9);
    }
  });

  it('throws on non-finite input', () => {
    expect(() => normalCdf(NaN)).toThrow(TypeError);
  });
});

describe('normalQuantile', () => {
  it('inverts normalCdf', () => {
    for (const p of [0.001, 0.01, 0.025, 0.05, 0.1, 0.5, 0.9, 0.95, 0.975, 0.99, 0.999]) {
      expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 6);
    }
  });

  it('matches standard critical values', () => {
    expect(normalQuantile(0.95)).toBeCloseTo(1.6448536269, 5);
    expect(normalQuantile(0.975)).toBeCloseTo(1.9599639845, 5);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
  });

  it('rejects out-of-range probabilities', () => {
    expect(() => normalQuantile(0)).toThrow(RangeError);
    expect(() => normalQuantile(1)).toThrow(RangeError);
    expect(() => normalQuantile(-0.1)).toThrow(RangeError);
  });
});
