/**
 * One-sided two-proportion z-test with explicit validity gating.
 *
 * The single most dangerous failure mode in this file is returning a number that *looks*
 * like a p-value but isn't — from a zero denominator, a degenerate pooled rate, or a sample
 * too small for the normal approximation to hold. A NaN compared against a threshold
 * evaluates false in JS, which happens to be safe, but a *wrong finite number* is not safe
 * at all. So this module never returns a bare number: it returns a result object whose
 * `pValue` is null unless every precondition was met.
 */
import { normalCdf, normalSf, MIN_REPORTABLE_P } from './normal.js';

export interface ProportionArm {
  /** e.g. clicks (for CTR) or conversions (for CVR). */
  readonly successes: number;
  /** e.g. impressions (for CTR) or clicks (for CVR). */
  readonly trials: number;
}

/** Direction of the alternative hypothesis, from the variant's point of view. */
export type TestDirection = 'VARIANT_WORSE' | 'VARIANT_BETTER';

export type ProportionTestInvalidReason =
  | 'EMPTY_VARIANT_ARM'
  | 'EMPTY_BASELINE_ARM'
  | 'NON_INTEGER_COUNTS'
  | 'SUCCESSES_EXCEED_TRIALS'
  | 'NEGATIVE_COUNTS'
  | 'DEGENERATE_POOLED_RATE'
  | 'NORMAL_APPROXIMATION_INVALID';

export interface ProportionTestResult {
  readonly valid: boolean;
  readonly invalidReason: ProportionTestInvalidReason | null;
  /** Null whenever `valid` is false. Never NaN. */
  readonly pValue: number | null;
  readonly z: number | null;
  readonly variantRate: number | null;
  readonly baselineRate: number | null;
  readonly pooledRate: number | null;
  /** (variantRate - baselineRate) / baselineRate * 100. Null if baseline rate is 0. */
  readonly relativeLiftPct: number | null;
  /** Smallest expected cell count; the normal approximation needs this >= 5. */
  readonly minExpectedCellCount: number | null;
  readonly direction: TestDirection;
  /** variantRate - baselineRate. Feeds the always-valid sequential test. */
  readonly effectSize: number | null;
  /** Pooled standard error of the effect at the current sample size. Always > 0 when valid. */
  readonly standardError: number | null;
}

/** Standard rule of thumb for the normal approximation to the binomial. */
export const MIN_EXPECTED_CELL_COUNT = 5;

function invalid(
  reason: ProportionTestInvalidReason,
  direction: TestDirection,
): ProportionTestResult {
  return {
    valid: false,
    invalidReason: reason,
    pValue: null,
    z: null,
    variantRate: null,
    baselineRate: null,
    pooledRate: null,
    relativeLiftPct: null,
    minExpectedCellCount: null,
    direction,
    effectSize: null,
    standardError: null,
  };
}

/**
 * Tests the variant arm against a baseline arm.
 *
 * The baseline is expected to be the POOLED performance of the other variants in the same
 * test cohort — see PLAN.md assumption 3. A cohort of one has no baseline and must not
 * reach this function; callers check that first.
 */
export function twoProportionZTest(
  variant: ProportionArm,
  baseline: ProportionArm,
  direction: TestDirection,
): ProportionTestResult {
  const counts = [variant.successes, variant.trials, baseline.successes, baseline.trials];

  if (counts.some((n) => !Number.isFinite(n))) {
    return invalid('NON_INTEGER_COUNTS', direction);
  }
  if (counts.some((n) => !Number.isInteger(n))) {
    return invalid('NON_INTEGER_COUNTS', direction);
  }
  if (counts.some((n) => n < 0)) {
    return invalid('NEGATIVE_COUNTS', direction);
  }
  if (variant.trials === 0) {
    return invalid('EMPTY_VARIANT_ARM', direction);
  }
  if (baseline.trials === 0) {
    return invalid('EMPTY_BASELINE_ARM', direction);
  }
  if (variant.successes > variant.trials || baseline.successes > baseline.trials) {
    return invalid('SUCCESSES_EXCEED_TRIALS', direction);
  }

  const n1 = baseline.trials;
  const n2 = variant.trials;
  const p1 = baseline.successes / n1;
  const p2 = variant.successes / n2;
  const pooled = (baseline.successes + variant.successes) / (n1 + n2);

  // All-zero or all-success across both arms carries no discriminating information.
  // The standard error would be 0 and z would be +/-Infinity or NaN.
  if (pooled <= 0 || pooled >= 1) {
    return invalid('DEGENERATE_POOLED_RATE', direction);
  }

  const minExpectedCellCount = Math.min(
    n1 * pooled,
    n1 * (1 - pooled),
    n2 * pooled,
    n2 * (1 - pooled),
  );
  if (minExpectedCellCount < MIN_EXPECTED_CELL_COUNT) {
    return invalid('NORMAL_APPROXIMATION_INVALID', direction);
  }

  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  // Cannot be 0 here: pooled is strictly inside (0,1) and both n are positive.
  const z = (p2 - p1) / standardError;

  const rawP = direction === 'VARIANT_WORSE' ? normalCdf(z) : normalSf(z);
  const pValue = Math.max(rawP, MIN_REPORTABLE_P);

  const relativeLiftPct = p1 > 0 ? ((p2 - p1) / p1) * 100 : null;

  return {
    valid: true,
    invalidReason: null,
    pValue,
    z,
    variantRate: p2,
    baselineRate: p1,
    pooledRate: pooled,
    relativeLiftPct,
    minExpectedCellCount,
    direction,
    effectSize: p2 - p1,
    standardError,
  };
}

/** Sums arms into a single pooled arm. Used to build the "everyone else" baseline. */
export function poolArms(arms: readonly ProportionArm[]): ProportionArm {
  let successes = 0;
  let trials = 0;
  for (const arm of arms) {
    successes += arm.successes;
    trials += arm.trials;
  }
  return { successes, trials };
}
