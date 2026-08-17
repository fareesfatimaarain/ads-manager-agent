import { describe, expect, it } from 'vitest';
import {
  alwaysValidPValue,
  tauForProportion,
  MIN_ALWAYS_VALID_P,
} from '../../src/stats/alwaysValid.js';
import { twoProportionZTest } from '../../src/stats/proportionTest.js';

const call = (effect: number, se: number, tau = 0.01, direction: 'VARIANT_WORSE' | 'VARIANT_BETTER' = 'VARIANT_BETTER') =>
  alwaysValidPValue({ effect, standardError: se, tau, direction });

describe('alwaysValidPValue — basic behaviour', () => {
  it('returns p = 1 for no observed effect', () => {
    expect(call(0, 0.01).pValue).toBe(1);
  });

  it('returns p = 1 when the effect points the wrong way', () => {
    // A variant doing BETTER is not evidence that it is worse.
    const worse = call(0.05, 0.01, 0.01, 'VARIANT_WORSE');
    expect(worse.pValue).toBe(1);
    expect(worse.wrongDirection).toBe(true);

    const better = call(-0.05, 0.01, 0.01, 'VARIANT_BETTER');
    expect(better.pValue).toBe(1);
    expect(better.wrongDirection).toBe(true);
  });

  it('shrinks the p-value as evidence strengthens', () => {
    let previous = 1;
    for (const effect of [0.005, 0.01, 0.02, 0.03, 0.05]) {
      const p = call(effect, 0.01).pValue!;
      expect(p).toBeLessThanOrEqual(previous);
      previous = p;
    }
    expect(previous).toBeLessThan(0.01);
  });

  it('shrinks the p-value as the standard error falls at fixed effect', () => {
    // Same observed difference, more data => more convincing.
    const loose = call(0.02, 0.02).pValue!;
    const tight = call(0.02, 0.005).pValue!;
    expect(tight).toBeLessThan(loose);
  });

  it('never returns a p-value above 1 or at/below 0', () => {
    for (const effect of [0, 1e-9, 0.001, 0.5, 1]) {
      for (const se of [1e-4, 0.001, 0.05, 1]) {
        const p = call(effect, se).pValue!;
        expect(p).toBeGreaterThan(0);
        expect(p).toBeLessThanOrEqual(1);
        expect(Number.isNaN(p)).toBe(false);
      }
    }
  });

  it('clamps rather than overflowing on overwhelming evidence', () => {
    const r = call(0.9, 1e-4);
    expect(r.valid).toBe(true);
    expect(r.pValue).toBe(MIN_ALWAYS_VALID_P);
    expect(Number.isFinite(r.likelihoodRatio!)).toBe(true);
  });

  it('rejects unusable inputs instead of returning a number', () => {
    expect(call(0.01, 0).valid).toBe(false);
    expect(call(0.01, -1).valid).toBe(false);
    expect(call(0.01, 0.01, 0).valid).toBe(false);
    expect(call(NaN, 0.01).valid).toBe(false);
    expect(call(0.01, 0.01).valid).toBe(true);
    expect(call(0.01, 0).pValue).toBeNull();
  });
});

describe('alwaysValidPValue — the property that motivated it', () => {
  it('is strictly more conservative than the fixed-sample p-value', () => {
    // This is the whole point: a fixed-sample p is only correct for one pre-planned look.
    // The always-valid p pays for the right to look whenever we like, so it is always larger.
    const cases = [
      { variant: { successes: 150, trials: 1000 }, baseline: { successes: 100, trials: 1000 } },
      { variant: { successes: 40, trials: 1000 }, baseline: { successes: 60, trials: 3000 } },
      { variant: { successes: 300, trials: 5000 }, baseline: { successes: 250, trials: 5000 } },
    ];
    for (const c of cases) {
      const z = twoProportionZTest(c.variant, c.baseline, 'VARIANT_BETTER');
      expect(z.valid).toBe(true);
      const av = alwaysValidPValue({
        effect: z.effectSize!,
        standardError: z.standardError!,
        tau: tauForProportion(z.pooledRate!, 0.5),
        direction: 'VARIANT_BETTER',
      });
      expect(av.pValue!).toBeGreaterThan(z.pValue!);
    }
  });

  it('does not depend on how many times it has been evaluated', () => {
    // The look count is not an input at all — that is what makes daily evaluation safe.
    const a = call(0.02, 0.01);
    const b = call(0.02, 0.01);
    expect(a.pValue).toBe(b.pValue);
  });

  it('holds its error guarantee across a long simulated peeking run', () => {
    // Two identical arms, evaluated after every additional 200 impressions for 60 looks,
    // repeated across many seeded trials. A fixed 0.05 gate would fire far too often; the
    // always-valid gate must fire on at most ~5% of runs.
    let falsePositives = 0;
    const runs = 300;
    const trueRate = 0.05;

    for (let run = 0; run < runs; run++) {
      let seed = run * 7919 + 13;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      let aSucc = 0;
      let aTrials = 0;
      let bSucc = 0;
      let bTrials = 0;
      let crossed = false;

      for (let look = 0; look < 60; look++) {
        for (let i = 0; i < 200; i++) {
          if (rand() < trueRate) aSucc++;
          aTrials++;
          if (rand() < trueRate) bSucc++;
          bTrials++;
        }
        const z = twoProportionZTest(
          { successes: aSucc, trials: aTrials },
          { successes: bSucc, trials: bTrials },
          'VARIANT_BETTER',
        );
        if (!z.valid) continue;
        const av = alwaysValidPValue({
          effect: z.effectSize!,
          standardError: z.standardError!,
          tau: tauForProportion(z.pooledRate!, 0.5),
          direction: 'VARIANT_BETTER',
        });
        if (av.valid && av.pValue! < 0.05) {
          crossed = true;
          break;
        }
      }
      if (crossed) falsePositives++;
    }

    const rate = falsePositives / runs;
    // Ville's inequality bounds this at 0.05; allow simulation slack but it must not be
    // anywhere near the ~25-40% an uncorrected daily gate would produce.
    expect(rate).toBeLessThan(0.12);
  });
});

describe('tauForProportion', () => {
  it('scales with the base rate', () => {
    expect(tauForProportion(0.02, 0.5)).toBeCloseTo(0.01, 12);
    expect(tauForProportion(0.2, 0.5)).toBeCloseTo(0.1, 12);
  });

  it('never returns zero, even for a degenerate base rate', () => {
    expect(tauForProportion(0, 0.5)).toBeGreaterThan(0);
    expect(tauForProportion(NaN, 0.5)).toBeGreaterThan(0);
  });
});
