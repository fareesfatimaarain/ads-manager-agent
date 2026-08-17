import { describe, expect, it } from 'vitest';
import {
  bootstrapRatioLowerBound,
  seedFromString,
  type DailyRatioObservation,
} from '../../src/stats/bootstrap.js';

const OPTS = { confidence: 0.95, minDays: 5, iterations: 2000, seed: 12345 };

/** `days` days of steady spend with the given ROAS. */
const steady = (days: number, roas: number, spend = 10_000): DailyRatioObservation[] =>
  Array.from({ length: days }, () => ({
    denominatorCents: spend,
    numeratorCents: Math.round(spend * roas),
  }));

describe('bootstrapRatioLowerBound', () => {
  it('recovers the point estimate exactly', () => {
    const r = bootstrapRatioLowerBound(steady(10, 3), OPTS);
    expect(r.valid).toBe(true);
    expect(r.pointEstimate).toBeCloseTo(3, 9);
  });

  it('produces a lower bound at or below the point estimate', () => {
    const r = bootstrapRatioLowerBound(steady(10, 3), OPTS);
    expect(r.lowerBound!).toBeLessThanOrEqual(r.pointEstimate!);
  });

  it('gives a tight bound when every day is identical', () => {
    // No day-to-day variation means no uncertainty to express.
    const r = bootstrapRatioLowerBound(steady(10, 3), OPTS);
    expect(r.lowerBound!).toBeCloseTo(3, 6);
  });

  it('gives a much looser bound when days vary wildly', () => {
    // Same average ROAS of 3, but produced by a couple of enormous days. This is exactly the
    // case the bound exists to catch: a flattering average built from a few lucky orders.
    const spiky: DailyRatioObservation[] = [
      { denominatorCents: 10_000, numeratorCents: 0 },
      { denominatorCents: 10_000, numeratorCents: 0 },
      { denominatorCents: 10_000, numeratorCents: 0 },
      { denominatorCents: 10_000, numeratorCents: 0 },
      { denominatorCents: 10_000, numeratorCents: 150_000 },
    ];
    const r = bootstrapRatioLowerBound(spiky, OPTS);
    expect(r.pointEstimate).toBeCloseTo(3, 6);
    expect(r.lowerBound!).toBeLessThan(1);
  });

  it('refuses a spiky series that a naive average would have scaled', () => {
    const spiky: DailyRatioObservation[] = [
      ...Array.from({ length: 6 }, () => ({ denominatorCents: 10_000, numeratorCents: 5_000 })),
      { denominatorCents: 10_000, numeratorCents: 300_000 },
    ];
    const r = bootstrapRatioLowerBound(spiky, OPTS);
    const target = 3;
    expect(r.pointEstimate!).toBeGreaterThan(target); // average says scale
    expect(r.lowerBound!).toBeLessThan(target); // bound says wait
  });

  it('tightens as more consistent days accumulate', () => {
    const noise = (days: number, seed: number): DailyRatioObservation[] => {
      let s = seed;
      const rand = () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
      return Array.from({ length: days }, () => ({
        denominatorCents: 10_000,
        numeratorCents: Math.round(10_000 * (3 + (rand() - 0.5))),
      }));
    };
    const few = bootstrapRatioLowerBound(noise(5, 1), OPTS);
    const many = bootstrapRatioLowerBound(noise(60, 1), OPTS);
    expect(many.lowerBound!).toBeGreaterThan(few.lowerBound!);
  });

  it('is deterministic for a given seed', () => {
    const a = bootstrapRatioLowerBound(steady(8, 2.5), OPTS);
    const b = bootstrapRatioLowerBound(steady(8, 2.5), OPTS);
    expect(a.lowerBound).toBe(b.lowerBound);
  });

  it('gives a different bound for a different seed but stays close', () => {
    const a = bootstrapRatioLowerBound(steady(8, 2.5), { ...OPTS, seed: 1 });
    const b = bootstrapRatioLowerBound(steady(8, 2.5), { ...OPTS, seed: 999 });
    expect(Math.abs(a.lowerBound! - b.lowerBound!)).toBeLessThan(0.2);
  });

  it('refuses too few days rather than guessing', () => {
    const r = bootstrapRatioLowerBound(steady(3, 3), OPTS);
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toBe('TOO_FEW_DAYS');
    expect(r.lowerBound).toBeNull();
  });

  it('refuses a zero denominator', () => {
    const r = bootstrapRatioLowerBound(
      Array.from({ length: 6 }, () => ({ denominatorCents: 0, numeratorCents: 0 })),
      OPTS,
    );
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toBe('ZERO_DENOMINATOR');
  });

  it('refuses malformed observations', () => {
    const r = bootstrapRatioLowerBound(
      [...steady(5, 3), { denominatorCents: -100, numeratorCents: 10 }],
      OPTS,
    );
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toBe('MALFORMED_OBSERVATION');
  });

  it('validates its own options', () => {
    expect(() => bootstrapRatioLowerBound(steady(6, 3), { ...OPTS, confidence: 0 })).toThrow(RangeError);
    expect(() => bootstrapRatioLowerBound(steady(6, 3), { ...OPTS, confidence: 1 })).toThrow(RangeError);
    expect(() => bootstrapRatioLowerBound(steady(6, 3), { ...OPTS, iterations: 10 })).toThrow(RangeError);
  });

  it('produces a lower bound that falls as confidence rises', () => {
    const noisy = [
      { denominatorCents: 10_000, numeratorCents: 20_000 },
      { denominatorCents: 10_000, numeratorCents: 40_000 },
      { denominatorCents: 10_000, numeratorCents: 25_000 },
      { denominatorCents: 10_000, numeratorCents: 35_000 },
      { denominatorCents: 10_000, numeratorCents: 30_000 },
      { denominatorCents: 10_000, numeratorCents: 15_000 },
    ];
    const at80 = bootstrapRatioLowerBound(noisy, { ...OPTS, confidence: 0.8 });
    const at99 = bootstrapRatioLowerBound(noisy, { ...OPTS, confidence: 0.99 });
    expect(at99.lowerBound!).toBeLessThanOrEqual(at80.lowerBound!);
  });
});

describe('seedFromString', () => {
  it('is stable and distinct', () => {
    expect(seedFromString('variant-a')).toBe(seedFromString('variant-a'));
    expect(seedFromString('variant-a')).not.toBe(seedFromString('variant-b'));
  });
});
