/**
 * Gamma / Poisson machinery, used for the absolute CPA confidence bound.
 *
 * Why a Poisson model: conversions arriving over a spend interval are well modelled as a
 * Poisson process with rate lambda (conversions per dollar). Observing k conversions from
 * spend S gives a Gamma(k + 1/2, S) posterior for lambda under the Jeffreys prior. Since
 * CPA = 1/lambda, a confidence statement about CPA falls straight out of the Gamma CDF.
 *
 * This matters because "observed CPA is under target" is not the same claim as "true CPA is
 * under target". At 3 conversions the observed CPA is nearly meaningless; at 40 it is solid.
 * A single ratio cannot express that difference — a posterior can.
 */

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
] as const;

const EPS = 1e-14;
const FPMIN = Number.MIN_VALUE / EPS;
const MAX_ITERATIONS = 1000;

/** Natural log of the gamma function (Lanczos, g=7, n=9). */
export function lnGamma(z: number): number {
  if (!Number.isFinite(z) || z <= 0) {
    throw new RangeError(`lnGamma requires z > 0, received ${z}`);
  }
  if (z < 0.5) {
    // Reflection formula, for completeness — our call sites stay above 0.5.
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }
  const x = z - 1;
  let series = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++) {
    series += LANCZOS[i]! / (x + i);
  }
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(series);
}

/** Regularized lower incomplete gamma P(a, x) via series expansion. Valid for x < a+1. */
function gammaPSeries(a: number, x: number): number {
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 0; n < MAX_ITERATIONS; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) {
      return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
    }
  }
  throw new Error(`gammaPSeries failed to converge for a=${a}, x=${x}`);
}

/** Regularized upper incomplete gamma Q(a, x) via continued fraction. Valid for x >= a+1. */
function gammaQContinuedFraction(a: number, x: number): number {
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) {
      return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
    }
  }
  throw new Error(`gammaQContinuedFraction failed to converge for a=${a}, x=${x}`);
}

/** Regularized lower incomplete gamma P(a, x) = P(X <= x) for X ~ Gamma(shape=a, rate=1). */
export function gammaP(a: number, x: number): number {
  if (!Number.isFinite(a) || a <= 0) {
    throw new RangeError(`gammaP requires a > 0, received ${a}`);
  }
  if (!Number.isFinite(x) || x < 0) {
    throw new RangeError(`gammaP requires x >= 0, received ${x}`);
  }
  if (x === 0) return 0;
  const result = x < a + 1 ? gammaPSeries(a, x) : 1 - gammaQContinuedFraction(a, x);
  // Numerical drift at the extremes can push a hair outside [0,1].
  if (result < 0) return 0;
  if (result > 1) return 1;
  return result;
}

/** CDF of Gamma(shape, rate) evaluated at x. */
export function gammaCdf(x: number, shape: number, rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new RangeError(`gammaCdf requires rate > 0, received ${rate}`);
  }
  return gammaP(shape, rate * x);
}

/**
 * Posterior probability that the TRUE cost per acquisition is at or below `targetCpaCents`,
 * having observed `conversions` conversions from `spendCents` of spend.
 *
 * Returns 0 (no confidence) when there is no evidence to reason from, rather than throwing,
 * because "we cannot tell" and "it is not below target" lead to the same safe action: don't
 * scale. Callers must still check the evidence floors separately — a high probability from a
 * tiny sample is not licence to act, and the decision engine enforces that.
 */
export function probabilityCpaBelowTarget(
  conversions: number,
  spendCents: number,
  targetCpaCents: number,
): number {
  if (!Number.isInteger(conversions) || conversions < 0) {
    throw new RangeError(`conversions must be a non-negative integer, received ${conversions}`);
  }
  if (!Number.isFinite(spendCents) || spendCents < 0) {
    throw new RangeError(`spendCents must be non-negative, received ${spendCents}`);
  }
  if (!Number.isFinite(targetCpaCents) || targetCpaCents <= 0) {
    throw new RangeError(`targetCpaCents must be positive, received ${targetCpaCents}`);
  }
  if (spendCents === 0) return 0;

  // lambda ~ Gamma(shape = k + 0.5, rate = S)   [Jeffreys prior on a Poisson rate]
  // P(CPA <= T) = P(lambda >= 1/T) = 1 - GammaCDF(1/T; shape, rate)
  const shape = conversions + 0.5;
  const x = 1 / targetCpaCents;
  return 1 - gammaCdf(x, shape, spendCents);
}

/**
 * Mirror of the above: posterior probability that true CPA is at or ABOVE target.
 * Used for kill reasoning, where we want confidence that a variant is genuinely bad rather
 * than merely unlucky.
 */
export function probabilityCpaAboveTarget(
  conversions: number,
  spendCents: number,
  targetCpaCents: number,
): number {
  return 1 - probabilityCpaBelowTarget(conversions, spendCents, targetCpaCents);
}
