import { describe, expect, it } from 'vitest';
import { adjustFamily, benjaminiHochberg } from '../../src/stats/multipleComparisons.js';

describe('benjaminiHochberg', () => {
  it('matches a hand-computed example', () => {
    // p = [0.01..0.05], m=5. Every rank gives (m/i)*p_(i) = 0.05.
    expect(benjaminiHochberg([0.01, 0.02, 0.03, 0.04, 0.05])).toEqual([0.05, 0.05, 0.05, 0.05, 0.05]);
  });

  it('adjusts a clear winner among noise', () => {
    expect(benjaminiHochberg([0.001, 0.5])).toEqual([0.002, 0.5]);
  });

  it('enforces monotonicity regardless of input order', () => {
    const out = benjaminiHochberg([0.04, 0.01]);
    expect(out[0]).toBeCloseTo(0.04, 12);
    expect(out[1]).toBeCloseTo(0.02, 12);
  });

  it('never reports an adjusted value below its raw value', () => {
    const raws = [0.001, 0.008, 0.02, 0.04, 0.2, 0.6];
    const adj = benjaminiHochberg(raws);
    raws.forEach((raw, i) => {
      expect(adj[i]!).toBeGreaterThanOrEqual(raw - 1e-12);
    });
  });

  it('caps adjusted values at 1', () => {
    benjaminiHochberg([0.9, 0.95, 0.99]).forEach((a) => expect(a!).toBeLessThanOrEqual(1));
  });

  it('excludes nulls from the family size', () => {
    const withNulls = benjaminiHochberg([0.001, null, 0.5, null]);
    expect(withNulls[0]).toBeCloseTo(0.002, 12);
    expect(withNulls[1]).toBeNull();
    expect(withNulls[3]).toBeNull();
    expect(withNulls[0]).toBeCloseTo(benjaminiHochberg([0.001, 0.5])[0]!, 12);
  });

  it('handles empty and all-null families', () => {
    expect(benjaminiHochberg([])).toEqual([]);
    expect(benjaminiHochberg([null, null])).toEqual([null, null]);
  });

  it('leaves a single test unchanged', () => {
    expect(benjaminiHochberg([0.03])).toEqual([0.03]);
  });

  it('materially raises the bar for a large family — the whole point', () => {
    const family = [0.03, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const adj = benjaminiHochberg(family);
    expect(family[0]!).toBeLessThan(0.05); // would have passed a naive gate
    expect(adj[0]!).toBeGreaterThan(0.05); // does not pass after correction
  });

  it('rejects malformed p-values loudly', () => {
    expect(() => benjaminiHochberg([1.5])).toThrow(RangeError);
    expect(() => benjaminiHochberg([-0.1])).toThrow(RangeError);
    expect(() => benjaminiHochberg([NaN])).toThrow(RangeError);
  });

  it('adjustFamily preserves input indices', () => {
    const out = adjustFamily([0.001, null, 0.5]);
    expect(out).toHaveLength(2);
    expect(out[0]!.index).toBe(0);
    expect(out[1]!.index).toBe(2);
  });
});
