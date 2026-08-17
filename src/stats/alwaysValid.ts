/**
 * Always-valid (anytime-valid) sequential testing via a mixture sequential probability ratio
 * test (mSPRT).
 *
 * WHY THIS REPLACED ALPHA SPENDING
 * --------------------------------
 * The earlier implementation used Pocock boundaries, which tighten the threshold according to
 * how many looks have been taken. Pocock's guarantee, however, assumes the number of looks K
 * is fixed *in advance* and that looks are equally spaced in information. Neither holds here:
 * a test's look count grows for as long as the ad keeps running, and the decision cycle has no
 * idea at the outset how many times it will end up evaluating a given variant. Feeding a
 * growing K into a fixed-K formula produces a number that looks principled and isn't.
 *
 * An mSPRT has no such assumption. Under the null, the mixture likelihood ratio is a
 * non-negative martingale with expectation 1, so by Ville's inequality
 *
 *     P( there exists any n such that 1/Lambda_n <= alpha )  <=  alpha
 *
 * That is a guarantee over the *entire* sequence of looks, however many there turn out to be
 * and whenever we choose to stop. The engine may therefore evaluate as often as it likes
 * without inflating its error rate, and the look count stops being a statistical input at all
 * — it is retained purely as an audit fact.
 *
 * OPERATIONAL CHOICE: CURRENT p, NOT RUNNING MINIMUM
 * -------------------------------------------------
 * The running minimum of an always-valid p-value is itself always-valid, and using it is
 * common. We deliberately do NOT. If evidence dipped below the threshold at look 3 and has
 * since reverted to nothing at look 12, the running minimum would still authorise a spend
 * increase today on the strength of a moment that has passed. We use the p-value as it stands
 * at the current look, so an action is only ever taken while the evidence for it still holds.
 * This is strictly more conservative than the guarantee requires.
 *
 * CHOOSING TAU
 * ------------
 * Tau is the standard deviation of the mixing prior over the true effect — in effect, the
 * size of difference the test is tuned to detect. It is expressed relative to the pooled base
 * rate: tau = tauRelative * pooledRate. At a 2% pooled conversion rate, tauRelative = 0.5
 * means the test is tuned for absolute differences of about one percentage point, i.e. effects
 * on the order of +/-50% relative. Mis-setting tau costs sensitivity, never validity: the
 * error guarantee holds for any tau > 0.
 */

export interface AlwaysValidInput {
  /** Observed effect: variantRate - baselineRate. */
  readonly effect: number;
  /** Standard error of that effect at the current sample size. Must be > 0. */
  readonly standardError: number;
  /** Mixing prior scale. Must be > 0. */
  readonly tau: number;
  /**
   * Which direction counts as evidence. An effect pointing the other way yields p = 1 rather
   * than a small p-value, because a variant doing better is not evidence that it is worse.
   */
  readonly direction: 'VARIANT_WORSE' | 'VARIANT_BETTER';
}

export type AlwaysValidInvalidReason =
  | 'NON_FINITE_INPUT'
  | 'NON_POSITIVE_STANDARD_ERROR'
  | 'NON_POSITIVE_TAU';

export interface AlwaysValidResult {
  readonly valid: boolean;
  readonly invalidReason: AlwaysValidInvalidReason | null;
  /** Anytime-valid p-value in (0, 1]. Null when the inputs were unusable. */
  readonly pValue: number | null;
  /** The mixture likelihood ratio. Large means strong evidence against the null. */
  readonly likelihoodRatio: number | null;
  readonly tau: number;
  /** True when the observed effect points away from the hypothesised direction. */
  readonly wrongDirection: boolean;
}

/** Smallest p-value we report; below this the floating-point exponent is not meaningful. */
export const MIN_ALWAYS_VALID_P = 1e-12;

function invalid(reason: AlwaysValidInvalidReason, tau: number): AlwaysValidResult {
  return {
    valid: false,
    invalidReason: reason,
    pValue: null,
    likelihoodRatio: null,
    tau,
    wrongDirection: false,
  };
}

/**
 * Anytime-valid p-value for a single hypothesis at the current look.
 *
 * Lambda = sqrt( s2 / (s2 + t2) ) * exp( t2 * effect^2 / ( 2 * s2 * (s2 + t2) ) )
 * p      = min(1, 1 / Lambda)
 *
 * where s2 is the squared standard error and t2 the squared mixing scale.
 */
export function alwaysValidPValue(input: AlwaysValidInput): AlwaysValidResult {
  const { effect, standardError, tau, direction } = input;

  if (![effect, standardError, tau].every((v) => Number.isFinite(v))) {
    return invalid('NON_FINITE_INPUT', tau);
  }
  if (standardError <= 0) return invalid('NON_POSITIVE_STANDARD_ERROR', tau);
  if (tau <= 0) return invalid('NON_POSITIVE_TAU', tau);

  // Evidence must point the right way. A variant outperforming the field is not evidence
  // that it is underperforming, and vice versa.
  const wrongDirection =
    (direction === 'VARIANT_WORSE' && effect >= 0) ||
    (direction === 'VARIANT_BETTER' && effect <= 0);

  if (wrongDirection) {
    return {
      valid: true,
      invalidReason: null,
      pValue: 1,
      likelihoodRatio: 1,
      tau,
      wrongDirection: true,
    };
  }

  const s2 = standardError * standardError;
  const t2 = tau * tau;

  const shrinkage = Math.sqrt(s2 / (s2 + t2));
  const exponent = (t2 * effect * effect) / (2 * s2 * (s2 + t2));

  // exp() overflows to Infinity around 709. An overflowing exponent means overwhelming
  // evidence, so clamp to the floor p-value rather than propagating Infinity.
  if (exponent > 700) {
    return {
      valid: true,
      invalidReason: null,
      pValue: MIN_ALWAYS_VALID_P,
      likelihoodRatio: Number.MAX_VALUE,
      tau,
      wrongDirection: false,
    };
  }

  const likelihoodRatio = shrinkage * Math.exp(exponent);
  const raw = likelihoodRatio > 0 ? 1 / likelihoodRatio : 1;
  const pValue = Math.min(1, Math.max(MIN_ALWAYS_VALID_P, raw));

  return { valid: true, invalidReason: null, pValue, likelihoodRatio, tau, wrongDirection: false };
}

/**
 * Mixing scale for a proportion comparison, derived from the pooled base rate.
 * Falls back to a small positive floor so a near-zero pooled rate cannot produce tau = 0.
 */
export function tauForProportion(pooledRate: number, tauRelative: number): number {
  if (!Number.isFinite(pooledRate) || !Number.isFinite(tauRelative)) return 1e-6;
  return Math.max(1e-6, Math.abs(pooledRate * tauRelative));
}
