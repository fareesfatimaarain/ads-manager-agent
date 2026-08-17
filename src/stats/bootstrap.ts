/**
 * Seeded bootstrap for ratio estimators — used to put a genuine confidence bound on ROAS.
 *
 * WHY A BOOTSTRAP
 * ---------------
 * Cost per acquisition has a clean parametric treatment: conversions are Poisson, so the true
 * CPA has a Gamma posterior (see gamma.ts). Revenue does not. It is compound Poisson — a
 * random number of purchases, each of a random value — and the variance of that depends on
 * the spread of individual order values, which daily aggregates do not expose.
 *
 * Rather than assert a confidence figure the data cannot support, this resamples whole days.
 * Day-to-day variation in observed ROAS already embodies both sources of noise (how many
 * people bought, and how much they spent), so resampling days gives an honest picture of how
 * much the ratio could plausibly move. It needs no assumption about the shape of the order
 * value distribution.
 *
 * WHAT IT COSTS
 * -------------
 * Resolution is limited by the number of days observed. With five days there are only five
 * distinct values to resample, so the bound is coarse and conservative. That is the correct
 * failure mode: a coarse bound refuses to scale, it does not authorise it.
 *
 * DETERMINISM
 * -----------
 * The generator is seeded from a caller-supplied value (in practice, derived from the variant
 * id). Identical inputs therefore produce an identical bound on every run and every machine.
 * A money decision must never depend on unseeded randomness.
 */

export interface DailyRatioObservation {
  /** Denominator contribution for the day, in integer minor units. */
  readonly denominatorCents: number;
  /** Numerator contribution for the day, in integer minor units. */
  readonly numeratorCents: number;
}

export type BootstrapInvalidReason =
  | 'TOO_FEW_DAYS'
  | 'ZERO_DENOMINATOR'
  | 'MALFORMED_OBSERVATION';

export interface RatioBoundResult {
  readonly valid: boolean;
  readonly invalidReason: BootstrapInvalidReason | null;
  /** Ratio computed on the observed data: sum(numerator) / sum(denominator). */
  readonly pointEstimate: number | null;
  /** One-sided lower confidence bound at the requested level. Null when invalid. */
  readonly lowerBound: number | null;
  readonly confidence: number;
  readonly days: number;
  readonly iterations: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash, so a variant id can seed the generator reproducibly. */
export function seedFromString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function invalid(reason: BootstrapInvalidReason, confidence: number, days: number): RatioBoundResult {
  return {
    valid: false,
    invalidReason: reason,
    pointEstimate: null,
    lowerBound: null,
    confidence,
    days,
    iterations: 0,
  };
}

/**
 * One-sided lower confidence bound on sum(numerator)/sum(denominator), by resampling days
 * with replacement.
 *
 * @param confidence e.g. 0.95 for a 95% lower bound
 */
export function bootstrapRatioLowerBound(
  observations: readonly DailyRatioObservation[],
  options: {
    readonly confidence: number;
    readonly minDays: number;
    readonly iterations: number;
    readonly seed: number;
  },
): RatioBoundResult {
  const { confidence, minDays, iterations, seed } = options;
  const days = observations.length;

  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new RangeError(`confidence must be in (0,1), received ${confidence}`);
  }
  if (!Number.isInteger(iterations) || iterations < 100) {
    throw new RangeError(`iterations must be an integer >= 100, received ${iterations}`);
  }

  for (const o of observations) {
    if (
      !Number.isFinite(o.denominatorCents) ||
      !Number.isFinite(o.numeratorCents) ||
      o.denominatorCents < 0 ||
      o.numeratorCents < 0
    ) {
      return invalid('MALFORMED_OBSERVATION', confidence, days);
    }
  }

  if (days < minDays) return invalid('TOO_FEW_DAYS', confidence, days);

  const totalDenominator = observations.reduce((s, o) => s + o.denominatorCents, 0);
  if (totalDenominator <= 0) return invalid('ZERO_DENOMINATOR', confidence, days);

  const totalNumerator = observations.reduce((s, o) => s + o.numeratorCents, 0);
  const pointEstimate = totalNumerator / totalDenominator;

  const rand = mulberry32(seed);
  const samples = new Float64Array(iterations);
  let produced = 0;

  for (let i = 0; i < iterations; i++) {
    let num = 0;
    let den = 0;
    for (let d = 0; d < days; d++) {
      const pick = observations[Math.floor(rand() * days)]!;
      num += pick.numeratorCents;
      den += pick.denominatorCents;
    }
    // A resample can in principle draw only zero-spend days. Skip rather than divide by zero.
    if (den > 0) {
      samples[produced++] = num / den;
    }
  }

  if (produced === 0) return invalid('ZERO_DENOMINATOR', confidence, days);

  const used = samples.subarray(0, produced);
  used.sort();

  // One-sided lower bound: the (1 - confidence) quantile of the resampled ratios.
  const index = Math.max(0, Math.min(produced - 1, Math.floor((1 - confidence) * produced)));
  const lowerBound = used[index]!;

  return {
    valid: true,
    invalidReason: null,
    pointEstimate,
    lowerBound,
    confidence,
    days,
    iterations: produced,
  };
}
