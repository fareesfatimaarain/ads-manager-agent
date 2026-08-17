/**
 * Benjamini-Hochberg false discovery rate control.
 *
 * Why this exists: evaluating 8 variants against the field, each at alpha = 0.05, gives a
 * family-wise false positive rate of roughly 1 - 0.95^8 = 34%. Without correction, about a
 * third of test cohorts would surface a "winner" that is pure noise, and the scale path
 * would then put real budget behind it. BH is preferred over Bonferroni here because
 * Bonferroni's power loss would push an already slow system into near-permanent inaction.
 *
 * The family is one decision cycle's tests within one test cohort. Getting the family
 * boundary wrong invalidates the correction, so the caller passes it explicitly.
 */

export interface AdjustedPValue {
  /** Index into the input array, so callers can map results back to variants. */
  readonly index: number;
  readonly raw: number;
  /** BH-adjusted (q-value). Monotone non-decreasing in raw. Capped at 1. */
  readonly adjusted: number;
}

/**
 * Returns BH-adjusted p-values aligned to the input array.
 *
 * Nulls represent tests that could not be computed (insufficient data, invalid
 * approximation). They are excluded from the family size `m` — counting them would inflate
 * m and make the correction spuriously conservative — and come back as null.
 */
export function benjaminiHochberg(pValues: readonly (number | null)[]): (number | null)[] {
  const present: { index: number; p: number }[] = [];

  for (let i = 0; i < pValues.length; i++) {
    const p = pValues[i];
    if (p === null || p === undefined) continue;
    if (!Number.isFinite(p) || p < 0 || p > 1) {
      throw new RangeError(`benjaminiHochberg received an invalid p-value at index ${i}: ${p}`);
    }
    present.push({ index: i, p });
  }

  const output: (number | null)[] = new Array(pValues.length).fill(null);
  const m = present.length;
  if (m === 0) return output;

  present.sort((a, b) => a.p - b.p);

  // Walk from largest to smallest keeping a running minimum, which enforces monotonicity.
  let runningMin = 1;
  for (let rank = m; rank >= 1; rank--) {
    const entry = present[rank - 1]!;
    const candidate = (m / rank) * entry.p;
    runningMin = Math.min(runningMin, candidate);
    output[entry.index] = Math.min(1, runningMin);
  }

  return output;
}

/**
 * Convenience wrapper returning both raw and adjusted values for the entries that had a
 * p-value, in original input order.
 */
export function adjustFamily(pValues: readonly (number | null)[]): AdjustedPValue[] {
  const adjusted = benjaminiHochberg(pValues);
  const results: AdjustedPValue[] = [];
  for (let i = 0; i < pValues.length; i++) {
    const raw = pValues[i];
    const adj = adjusted[i];
    if (raw === null || raw === undefined || adj === null || adj === undefined) continue;
    results.push({ index: i, raw, adjusted: adj });
  }
  return results;
}
