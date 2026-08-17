/**
 * Normal distribution primitives.
 *
 * Accuracy note: `erf` uses Abramowitz & Stegun 7.1.26, whose maximum absolute error is
 * ~1.5e-7. The decision thresholds compared against here are 0.05 and 0.10, so the
 * approximation error is six orders of magnitude below anything that could flip a decision.
 * P-values reported below ~1e-6 should be read as "vanishingly small" rather than exact —
 * they are clamped rather than presented with a precision the method does not have.
 *
 * Note these are the FIXED-SAMPLE p-values, which this system records for context but does
 * not act on; actions are driven by the always-valid p-values in alwaysValid.ts.
 */

const P = 0.3275911;
const A1 = 0.254829592;
const A2 = -0.284496736;
const A3 = 1.421413741;
const A4 = -1.453152027;
const A5 = 1.061405429;

/** Smallest p-value we are willing to report. Below this the approximation is noise. */
export const MIN_REPORTABLE_P = 1e-9;

export function erf(x: number): number {
  if (!Number.isFinite(x)) {
    throw new TypeError(`erf requires a finite argument, received ${x}`);
  }
  // erf(0) = 0 is exact by symmetry, but the A&S polynomial only gets within ~1e-9 of it.
  // Pinning it keeps normalCdf(0) exactly 0.5, which matters because z = 0 (two arms
  // performing identically) is a routine input, not an edge case.
  if (x === 0) return 0;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + P * z);
  const poly = ((((A5 * t + A4) * t + A3) * t + A2) * t + A1) * t;
  const y = 1 - poly * Math.exp(-z * z);
  return sign * y;
}

export function erfc(x: number): number {
  return 1 - erf(x);
}

const SQRT2 = Math.SQRT2;

/** P(Z <= z) for standard normal Z. */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) {
    throw new TypeError(`normalCdf requires a finite argument, received ${z}`);
  }
  const raw = 0.5 * (1 + erf(z / SQRT2));
  // Guard against the approximation drifting a hair outside [0, 1].
  return clampProbability(raw);
}

/** P(Z >= z) for standard normal Z. */
export function normalSf(z: number): number {
  return clampProbability(1 - normalCdf(z));
}

export function clampProbability(p: number): number {
  if (Number.isNaN(p)) {
    throw new RangeError('probability computation produced NaN');
  }
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

/**
 * Inverse standard normal CDF (Acklam's algorithm, refined by one Halley step).
 * Absolute error < 1e-9 across the usable range.
 */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) {
    throw new RangeError(`normalQuantile requires 0 < p < 1, received ${p}`);
  }

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ] as const;
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ] as const;
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ] as const;
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416,
  ] as const;

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let x: number;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  // One Halley refinement against our own CDF.
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  x = x - u / (1 + (x * u) / 2);
  return x;
}
