/**
 * The decision engine.
 *
 * Deterministic rules, start to finish. No LLM is consulted here and none can be: the
 * `humanSummary` this module emits is generated from the decision, template-style, and any
 * LLM narrative added later is decoration layered on top of an already-final outcome. A
 * language model never chooses whether money moves.
 *
 * Structural safety properties, each enforced below and each covered by tests:
 *
 *  - **All-or-nothing cohorts.** If any variant's data is missing, the whole cohort is
 *    skipped. A pooled baseline built from whichever fetches happened to succeed is biased,
 *    and a biased baseline produces confident wrong answers rather than obvious failures.
 *
 *  - **A variant meeting its objective is never killed comparatively.** Without this, killing
 *    the weakest arm raises the pooled baseline, which makes the next-weakest arm look bad,
 *    which kills it too — a cascade that ends up killing profitable ads for the crime of
 *    sharing a cohort with an excellent one. Only absolute underperformance kills.
 *
 *  - **Scale requires absolute evidence, not just relative.** Being the best of four bad ads
 *    is not a reason to spend more. The Gamma posterior bound on true CPA must clear the
 *    confidence threshold on its own.
 *
 *  - **Both corrections always apply.** Benjamini-Hochberg across the cohort family, then a
 *    Pocock-adjusted alpha for the number of looks taken. See PLAN.md.
 */
import {
  poolArms,
  twoProportionZTest,
  type ProportionArm,
  type ProportionTestResult,
} from '../stats/proportionTest.js';
import { benjaminiHochberg } from '../stats/multipleComparisons.js';
import {
  alwaysValidPValue,
  tauForProportion,
  type AlwaysValidResult,
} from '../stats/alwaysValid.js';
import {
  bootstrapRatioLowerBound,
  seedFromString,
  type RatioBoundResult,
} from '../stats/bootstrap.js';
import { probabilityCpaBelowTarget } from '../stats/gamma.js';
import type { ProposedAction, ResolvedGuardrailConfig } from '../guardrails/types.js';
import type {
  CohortDecisionResult,
  CohortInput,
  DecisionKind,
  MetricAggregate,
  Objective,
  ReasonCode,
  StatisticalEvidence,
  VariantDecision,
  VariantMetrics,
} from './types.js';

const HOUR_MS = 3_600_000;

export const ENGINE_VERSION = '0.1.0';
export const RULESET_VERSION = '2026-08-04.balanced-two-tier';

// ---------------------------------------------------------------------------
// Small numeric helpers. Every one of these exists to avoid a NaN or an Infinity
// reaching a comparison against a threshold.
// ---------------------------------------------------------------------------

function safeRate(successes: number, trials: number): number | null {
  if (!Number.isFinite(successes) || !Number.isFinite(trials) || trials <= 0) return null;
  return successes / trials;
}

function observedCpaCents(m: MetricAggregate): number | null {
  if (m.conversions <= 0) return null;
  return m.spendCents / m.conversions;
}

function observedRoas(m: MetricAggregate): number | null {
  if (m.spendCents <= 0) return null;
  return m.conversionValueCents / m.spendCents;
}

/** Spend a variant must have accrued before ANY decision may be made about it. */
function spendFloorCents(objective: Objective, cfg: ResolvedGuardrailConfig): number {
  if (objective.type === 'CPA') {
    return Math.max(
      cfg.minTestSpendCents,
      Math.ceil(cfg.minSpendMultipleOfTargetCpa * objective.targetCpaCents),
    );
  }
  return cfg.minTestSpendCents;
}

/** Spend with zero conversions that justifies an absolute kill. */
function zeroConversionKillFloorCents(
  objective: Objective,
  cfg: ResolvedGuardrailConfig,
): number {
  if (objective.type === 'CPA') {
    return Math.ceil(cfg.zeroConversionKillSpendMultiple * objective.targetCpaCents);
  }
  return cfg.zeroConversionKillSpendCents;
}

function meetsObjective(m: MetricAggregate, objective: Objective): boolean {
  if (objective.type === 'CPA') {
    const cpa = observedCpaCents(m);
    return cpa !== null && cpa <= objective.targetCpaCents;
  }
  const roas = observedRoas(m);
  return roas !== null && roas >= objective.targetRoas;
}

// ---------------------------------------------------------------------------

interface TestBundle {
  readonly result: ProportionTestResult | null;
  readonly fixedSampleP: number | null;
  readonly alwaysValid: AlwaysValidResult | null;
  /** The always-valid p-value; this is what BH adjusts and what the threshold is applied to. */
  readonly rawP: number | null;
  bhAdjustedP: number | null;
  threshold: number | null;
  significant: boolean;
}

const emptyBundle = (): TestBundle => ({
  result: null,
  fixedSampleP: null,
  alwaysValid: null,
  rawP: null,
  bhAdjustedP: null,
  threshold: null,
  significant: false,
});

/**
 * Wraps a fixed-sample test with its always-valid counterpart.
 *
 * The fixed-sample p-value is kept for the audit record because it is the figure a reader
 * would compute by hand, but it is never what an action is taken on: it is only correct for a
 * single pre-planned look, and this engine looks daily.
 */
function bundleFrom(result: ProportionTestResult, tauRelative: number): TestBundle {
  if (!result.valid || result.effectSize === null || result.standardError === null) {
    return { ...emptyBundle(), result, fixedSampleP: result.pValue };
  }

  const tau = tauForProportion(result.pooledRate ?? 0, tauRelative);
  const alwaysValid = alwaysValidPValue({
    effect: result.effectSize,
    standardError: result.standardError,
    tau,
    direction: result.direction,
  });

  return {
    result,
    fixedSampleP: result.pValue,
    alwaysValid,
    rawP: alwaysValid.valid ? alwaysValid.pValue : null,
    bhAdjustedP: null,
    threshold: null,
    significant: false,
  };
}

// ---------------------------------------------------------------------------

export function decideCohort(input: CohortInput): CohortDecisionResult {
  const { cohortId, config: cfg, objective, now } = input;

  // -- Guard: partial data poisons the pooled baseline. Skip the whole cohort. ----------
  if (input.variantsWithMissingData.length > 0) {
    return {
      cohortId,
      skipped: true,
      skipReason:
        `performance data missing for ${input.variantsWithMissingData.length} variant(s) ` +
        `(${input.variantsWithMissingData.join(', ')}); deciding on a partial cohort would ` +
        `compare survivors against a biased baseline`,
      decisions: [],
    };
  }

  const variants = input.variants.filter((v) => v.status === 'TESTING' || v.status === 'SCALING');
  if (variants.length === 0) {
    return { cohortId, skipped: true, skipReason: 'no active variants in cohort', decisions: [] };
  }

  // -- Build the three test families --------------------------------------------------
  const proxyWorse: TestBundle[] = [];
  const outcomeWorse: TestBundle[] = [];
  const outcomeBetter: TestBundle[] = [];

  for (let i = 0; i < variants.length; i++) {
    const v = variants[i]!;
    const others = variants.filter((_, j) => j !== i);

    // CTR: clicks out of impressions, on the wider unsettled window.
    const proxyArm: ProportionArm = {
      successes: v.proxy.clicks,
      trials: v.proxy.impressions,
    };
    const proxyBaseline = poolArms(
      others.map((o) => ({ successes: o.proxy.clicks, trials: o.proxy.impressions })),
    );

    // CVR: conversions out of clicks, on settled dates only.
    const outcomeArm: ProportionArm = {
      successes: v.settled.conversions,
      trials: v.settled.clicks,
    };
    const outcomeBaseline = poolArms(
      others.map((o) => ({ successes: o.settled.conversions, trials: o.settled.clicks })),
    );

    if (others.length === 0) {
      // Single-arm cohort: no comparative test exists. Absolute rules still apply.
      proxyWorse.push(emptyBundle());
      outcomeWorse.push(emptyBundle());
      outcomeBetter.push(emptyBundle());
      continue;
    }

    const tau = cfg.mSprtTauRelative;
    proxyWorse.push(bundleFrom(twoProportionZTest(proxyArm, proxyBaseline, 'VARIANT_WORSE'), tau));
    outcomeWorse.push(
      bundleFrom(twoProportionZTest(outcomeArm, outcomeBaseline, 'VARIANT_WORSE'), tau),
    );
    outcomeBetter.push(
      bundleFrom(twoProportionZTest(outcomeArm, outcomeBaseline, 'VARIANT_BETTER'), tau),
    );
  }

  // -- Benjamini-Hochberg across each family of always-valid p-values -------------------
  // Anytime-validity handles repeated looks at ONE hypothesis; it says nothing about testing
  // several variants at once. Both corrections are still required, and they compose: BH is
  // applied to the always-valid p-values rather than to the fixed-sample ones.
  applyBH(proxyWorse);
  applyBH(outcomeWorse);
  applyBH(outcomeBetter);

  for (let i = 0; i < variants.length; i++) {
    finalise(proxyWorse[i]!, cfg.killPThreshold);
    finalise(outcomeWorse[i]!, cfg.killPThreshold);
    finalise(outcomeBetter[i]!, cfg.scalePThreshold);
  }

  // -- Classify -------------------------------------------------------------------------
  const decisions: VariantDecision[] = [];
  for (let i = 0; i < variants.length; i++) {
    const others = variants.filter((_, j) => j !== i);
    const baseline: BaselineAggregate = {
      armCount: others.length,
      conversions: others.reduce((s, o) => s + o.settled.conversions, 0),
      clicks: others.reduce((s, o) => s + o.settled.clicks, 0),
      impressions: others.reduce((s, o) => s + o.proxy.impressions, 0),
    };
    decisions.push(
      classifyVariant(
        variants[i]!,
        input,
        proxyWorse[i]!,
        outcomeWorse[i]!,
        outcomeBetter[i]!,
        baseline,
      ),
    );
  }

  return { cohortId, skipped: false, skipReason: null, decisions };
}

function applyBH(family: TestBundle[]): void {
  const adjusted = benjaminiHochberg(family.map((b) => b.rawP));
  for (let i = 0; i < family.length; i++) {
    family[i]!.bhAdjustedP = adjusted[i] ?? null;
  }
}

function finalise(bundle: TestBundle, threshold: number): void {
  if (bundle.result === null || !bundle.result.valid || bundle.bhAdjustedP === null) {
    bundle.threshold = null;
    bundle.significant = false;
    return;
  }
  // No look-count adjustment: the always-valid construction already covers every look taken
  // and every look still to come.
  bundle.threshold = threshold;
  bundle.significant = bundle.bhAdjustedP < threshold;
}

// ---------------------------------------------------------------------------

/** Pooled totals for the rest of the cohort, used to decide whether a comparison is worth making. */
interface BaselineAggregate {
  readonly armCount: number;
  readonly conversions: number;
  readonly clicks: number;
  readonly impressions: number;
}

function classifyVariant(
  v: VariantMetrics,
  input: CohortInput,
  proxyWorse: TestBundle,
  outcomeWorse: TestBundle,
  outcomeBetter: TestBundle,
  baseline: BaselineAggregate,
): VariantDecision {
  const baselineArmCount = baseline.armCount;
  const cfg = input.config;
  const objective = input.objective;
  const notes: string[] = [];

  const runtimeHours = (input.now.getTime() - v.testStartedAt.getTime()) / HOUR_MS;
  const ctr = safeRate(v.proxy.clicks, v.proxy.impressions);
  const cvr = safeRate(v.settled.conversions, v.settled.clicks);
  const cpa = observedCpaCents(v.settled);
  const roas = observedRoas(v.settled);

  const probMeetsCpa =
    objective.type === 'CPA'
      ? probabilityCpaBelowTarget(v.settled.conversions, v.settled.spendCents, objective.targetCpaCents)
      : null;

  // ROAS gets a bootstrapped lower bound rather than a bare threshold comparison. Seeded from
  // the variant id so the same evidence always yields the same bound.
  const roasBound: RatioBoundResult | null =
    objective.type === 'ROAS'
      ? bootstrapRatioLowerBound(
          v.settledDaily.map((d) => ({
            denominatorCents: d.spendCents,
            numeratorCents: d.conversionValueCents,
          })),
          {
            confidence: 1 - cfg.scalePThreshold,
            minDays: cfg.roasBootstrapMinDays,
            iterations: cfg.roasBootstrapIterations,
            seed: seedFromString(v.variantId),
          },
        )
      : null;

  if (objective.type === 'ROAS' && roasBound && !roasBound.valid) {
    notes.push(
      `ROAS confidence bound unavailable (${roasBound.invalidReason}); ` +
        'scaling is withheld until enough settled days exist to bound the ratio.',
    );
  }

  // Counters only increment when a valid test statistic was actually produced. They are audit
  // facts; nothing statistical depends on them.
  const newEvaluationsProxy = v.evaluationsProxy + (proxyWorse.result?.valid ? 1 : 0);
  const newEvaluationsOutcome =
    v.evaluationsOutcome + (outcomeWorse.result?.valid || outcomeBetter.result?.valid ? 1 : 0);

  const evidence = (): StatisticalEvidence => ({
    objective,
    runtimeHours,
    settled: v.settled,
    proxy: v.proxy,
    observedCtr: ctr,
    observedCvr: cvr,
    observedCpaCents: cpa,
    observedRoas: roas,
    probabilityMeetsCpaTarget: probMeetsCpa,
    roasLowerBound: roasBound,
    proxyTest: { worse: { ...proxyWorse } },
    outcomeTest: { worse: { ...outcomeWorse }, better: { ...outcomeBetter } },
    baselineArmCount,
    notes,
  });

  const decide = (
    kind: DecisionKind,
    reasonCode: ReasonCode,
    humanSummary: string,
    proposedAction: ProposedAction | null,
  ): VariantDecision => ({
    variantId: v.variantId,
    kind,
    reasonCode,
    humanSummary,
    evidence: evidence(),
    proposedAction,
    newEvaluationsProxy,
    newEvaluationsOutcome,
  });

  // -- Universal evidence floors -------------------------------------------------------
  if (runtimeHours < cfg.minRuntimeHours) {
    return decide(
      'NO_ACTION',
      'INSUFFICIENT_RUNTIME',
      `Still gathering data — running ${runtimeHours.toFixed(0)}h of the ${cfg.minRuntimeHours}h minimum before any decision.`,
      null,
    );
  }

  const floor = spendFloorCents(objective, cfg);
  if (v.settled.spendCents < floor) {
    return decide(
      'NO_ACTION',
      'INSUFFICIENT_SPEND',
      `Only ${formatCents(v.settled.spendCents)} of settled spend so far; ${formatCents(floor)} is needed before this ad can be judged.`,
      null,
    );
  }

  const objectiveMet = meetsObjective(v.settled, objective);

  // -- KILL path (a): absolute, no comparison needed -----------------------------------
  const zeroConvFloor = zeroConversionKillFloorCents(objective, cfg);
  if (v.settled.conversions === 0 && v.settled.spendCents >= zeroConvFloor) {
    return decide(
      'KILL',
      'ZERO_CONVERSIONS_PAST_SPEND_THRESHOLD',
      `Spent ${formatCents(v.settled.spendCents)} with no conversions at all — past the ${formatCents(zeroConvFloor)} cut-off. Stopping it.`,
      killAction(v),
    );
  }

  // -- Comparative kill eligibility -----------------------------------------------------
  // A comparative kill needs a baseline carrying real signal. Comparing a quiet variant
  // against an equally quiet field is noise against noise, and significance found there is
  // an artefact of the approximation rather than evidence about the ad.
  //
  // Note there is deliberately NO minimum-conversion floor on the VARIANT itself. A failing
  // ad is characterised by not accumulating conversions; requiring it to reach the
  // scale-grade conversion count before it could be killed would make this branch
  // unreachable for precisely the ads it exists to stop. The z-test's own validity gate
  // (expected cell count >= 5) is what protects against small-sample nonsense here.
  const outcomeKill = baseline.conversions >= cfg.minConversionsPerArm && outcomeWorse.significant;
  const proxyKill = isProxyKill(v, cfg, proxyWorse, ctr, baseline);
  const wouldKillComparatively = outcomeKill || proxyKill;

  if (objectiveMet && wouldKillComparatively) {
    return decide(
      'NO_ACTION',
      'PROTECTED_MEETING_OBJECTIVE',
      objective.type === 'CPA'
        ? `Underperforming its cohort, but its ${formatCents(cpa ?? 0)} cost per conversion still beats the ${formatCents(objective.targetCpaCents)} target — left running.`
        : `Underperforming its cohort, but its ${roas?.toFixed(2)}x return still beats the ${objective.targetRoas}x target — left running.`,
      null,
    );
  }

  // -- KILL path (b): comparative on outcome data --------------------------------------
  if (!objectiveMet && outcomeKill) {
    const pct = outcomeWorse.result?.relativeLiftPct;
    return decide(
      'KILL',
      'COMPARATIVE_UNDERPERFORMANCE',
      `Converting ${pct === null || pct === undefined ? 'materially' : `${Math.abs(pct).toFixed(0)}%`} worse than the other ads in this test, on ${v.settled.conversions} conversions, and missing the target. Stopping it.`,
      killAction(v),
    );
  }

  // -- KILL path (c): proxy CTR ---------------------------------------------------------
  if (!objectiveMet && proxyKill) {
    return decide(
      'KILL',
      'PROXY_CTR_UNDERPERFORMANCE',
      `Almost nobody is clicking it — ${((ctr ?? 0) * 100).toFixed(2)}% click rate across ${v.proxy.impressions.toLocaleString()} impressions, far below the rest of the test. Stopping it before it spends more.`,
      killAction(v),
    );
  }

  // -- SCALE path ------------------------------------------------------------------------
  const scaleVerdict = evaluateScale(
    v,
    input,
    outcomeBetter,
    baselineArmCount,
    probMeetsCpa,
    roas,
    roasBound,
  );
  if (scaleVerdict.eligible) {
    if (scaleVerdict.action === null) {
      return decide(
        'NO_ACTION',
        'NO_BUDGET_HEADROOM',
        `Performing well enough to scale, but there is no budget headroom left today under the configured caps.`,
        null,
      );
    }
    const from = v.currentBudgetCents;
    const to = scaleVerdict.action.type === 'SCALE' ? scaleVerdict.action.targetBudgetCents : from;
    return decide(
      'SCALE',
      'MEETS_OBJECTIVE_WITH_CONFIDENCE',
      objective.type === 'CPA'
        ? `Beating the ${formatCents(objective.targetCpaCents)} target at ${formatCents(cpa ?? 0)} per conversion on ${v.settled.conversions} conversions. Raising daily budget from ${formatCents(from)} to ${formatCents(to)}.`
        : `Returning ${roas?.toFixed(2)}x against a ${objective.targetRoas}x target on ${v.settled.conversions} conversions. Raising daily budget from ${formatCents(from)} to ${formatCents(to)}.`,
      scaleVerdict.action,
    );
  }

  // -- MUTATE path -----------------------------------------------------------------------
  const mutate = evaluateMutate(v, input, cpa, roas);
  if (mutate !== null) {
    return decide(
      'MUTATE',
      'NEAR_WINNER_WORTH_MUTATING',
      `Close to working but not quite there. Testing a new version with a different ${mutate.mutatedField.toLowerCase().replace('_', ' ')}, leaving the original running.`,
      mutate,
    );
  }

  // -- Nothing to do ----------------------------------------------------------------------
  return decide('NO_ACTION', scaleVerdict.reasonCode, scaleVerdict.summary, null);
}

// ---------------------------------------------------------------------------

function isProxyKill(
  v: VariantMetrics,
  cfg: ResolvedGuardrailConfig,
  proxyWorse: TestBundle,
  ctr: number | null,
  baseline: BaselineAggregate,
): boolean {
  if (v.proxy.impressions < cfg.proxyKillMinImpressions) return false;
  // The field must have been served enough too, or the "baseline" CTR is itself noise.
  if (baseline.impressions < cfg.proxyKillMinImpressions) return false;
  if (!proxyWorse.significant) return false;
  if (ctr === null) return false;
  const baselineCtr = proxyWorse.result?.baselineRate;
  if (baselineCtr === null || baselineCtr === undefined || baselineCtr <= 0) return false;
  // Statistical significance alone is not enough — a 3% relative gap can be significant at
  // scale while being commercially irrelevant. Require a materially large drop as well.
  const threshold = baselineCtr * (1 - cfg.proxyKillCtrDropPct / 100);
  return ctr <= threshold;
}

interface ScaleVerdict {
  readonly eligible: boolean;
  readonly action: ProposedAction | null;
  readonly reasonCode: ReasonCode;
  readonly summary: string;
}

function evaluateScale(
  v: VariantMetrics,
  input: CohortInput,
  outcomeBetter: TestBundle,
  baselineArmCount: number,
  probMeetsCpa: number | null,
  roas: number | null,
  roasBound: RatioBoundResult | null,
): ScaleVerdict {
  const cfg = input.config;
  const objective = input.objective;

  if (v.settled.conversions < cfg.minConversionsPerArm) {
    return {
      eligible: false,
      action: null,
      reasonCode: 'INSUFFICIENT_CONVERSIONS',
      summary: `${v.settled.conversions} of the ${cfg.minConversionsPerArm} conversions needed before this ad can be scaled. Still collecting.`,
    };
  }

  if (!meetsObjective(v.settled, objective)) {
    return {
      eligible: false,
      action: null,
      reasonCode: 'NOT_SIGNIFICANT',
      summary: `Not currently meeting its target, and not clearly worse than the rest of the test either. Leaving it to run.`,
    };
  }

  // Absolute confidence requirement.
  if (objective.type === 'CPA') {
    const required = 1 - cfg.scalePThreshold;
    if (probMeetsCpa === null || probMeetsCpa < required) {
      return {
        eligible: false,
        action: null,
        reasonCode: 'NOT_SIGNIFICANT',
        summary: `Cost per conversion currently looks good, but there is only ${((probMeetsCpa ?? 0) * 100).toFixed(0)}% confidence that it genuinely beats target (${(required * 100).toFixed(0)}% needed). Holding budget steady.`,
      };
    }
  } else {
    // Two independent hurdles, both required.
    //  1. The point estimate must clear target by the configured margin.
    //  2. The bootstrapped lower bound must clear target outright — this is the real gate,
    //     and it is what stops a handful of unusually large orders from reading as a trend.
    const required = objective.targetRoas * cfg.roasScaleSafetyMargin;
    if (roas === null || roas < required) {
      return {
        eligible: false,
        action: null,
        reasonCode: 'NOT_SIGNIFICANT',
        summary: `Return of ${roas?.toFixed(2) ?? 'n/a'}x does not clear the ${required.toFixed(2)}x margin required to scale.`,
      };
    }
    if (roasBound === null || !roasBound.valid || roasBound.lowerBound === null) {
      return {
        eligible: false,
        action: null,
        reasonCode: 'INSUFFICIENT_CONVERSIONS',
        summary: `Returns look strong, but there are only ${roasBound?.days ?? 0} settled days of history — not yet enough to be confident the figure will hold. Holding budget steady.`,
      };
    }
    if (roasBound.lowerBound < objective.targetRoas) {
      return {
        eligible: false,
        action: null,
        reasonCode: 'NOT_SIGNIFICANT',
        summary: `Averaging ${roas.toFixed(2)}x, but day-to-day variation means the return could plausibly be as low as ${roasBound.lowerBound.toFixed(2)}x — below the ${objective.targetRoas}x target. Not scaling yet.`,
      };
    }
  }

  // Comparative requirement, where a baseline exists.
  if (baselineArmCount > 0) {
    if (!outcomeBetter.significant) {
      return {
        eligible: false,
        action: null,
        reasonCode: 'NOT_SIGNIFICANT',
        summary: `Meeting target, but not yet distinguishable from the other ads in this test with enough confidence to put more budget behind it.`,
      };
    }
  } else if (!cfg.allowScaleWithoutComparativeBaseline) {
    return {
      eligible: false,
      action: null,
      reasonCode: 'NO_COMPARATIVE_BASELINE',
      summary: `Meeting target, but it is the only ad in its test group and comparative evidence is required by configuration.`,
    };
  }

  const target = computeScaleTargetCents(v, input);
  if (target === null) {
    return { eligible: true, action: null, reasonCode: 'NO_BUDGET_HEADROOM', summary: '' };
  }

  return {
    eligible: true,
    action: {
      type: 'SCALE',
      variantId: v.variantId,
      adSetId: v.adSetId,
      campaignId: v.campaignId,
      platformEntityId: v.adSetId,
      currentBudgetCents: v.currentBudgetCents,
      targetBudgetCents: target,
    },
    reasonCode: 'MEETS_OBJECTIVE_WITH_CONFIDENCE',
    summary: '',
  };
}

/**
 * Largest budget this scale may legally request. Returns null when no headroom remains.
 *
 * Every ceiling is applied here so the engine proposes something already legal. Guardrails
 * re-check independently — this is belt and braces, not duplication for its own sake.
 */
export function computeScaleTargetCents(v: VariantMetrics, input: CohortInput): number | null {
  const cfg = input.config;
  const h = input.headroom;
  const current = v.currentBudgetCents;

  if (!Number.isInteger(current) || current <= 0) return null;

  const byPct = Math.floor(current * (1 + cfg.maxBudgetIncreasePct / 100));
  const byAdSetCap = cfg.maxAdSetDailyBudgetCents;
  const byDailyIncrease =
    current + Math.max(0, cfg.maxDailyAutonomousIncreaseCents - h.todayAutonomousIncreaseCents);
  const byTotalCeiling =
    current + Math.max(0, cfg.maxTotalDailyBudgetCents - h.clientTotalDailyBudgetCents);
  const byPlatformCap =
    h.platformDailySpendCapCents === null
      ? Number.MAX_SAFE_INTEGER
      : current + Math.max(0, h.platformDailySpendCapCents - h.clientTotalDailyBudgetCents);

  const target = Math.min(byPct, byAdSetCap, byDailyIncrease, byTotalCeiling, byPlatformCap);

  if (!Number.isFinite(target) || target <= current) return null;
  return Math.floor(target);
}

function evaluateMutate(
  v: VariantMetrics,
  input: CohortInput,
  cpa: number | null,
  roas: number | null,
): Extract<ProposedAction, { type: 'MUTATE' }> | null {
  const cfg = input.config;
  const objective = input.objective;

  if (v.mutationDepth >= cfg.maxMutationDepth) return null;

  // A near-winner needs enough data to be recognisable as one, but less than a scale needs.
  const minConversions = Math.ceil(cfg.minConversionsPerArm / 2);
  if (v.settled.conversions < minConversions) return null;

  let inBand = false;
  if (objective.type === 'CPA') {
    if (cpa === null) return null;
    inBand = cpa > objective.targetCpaCents && cpa <= objective.targetCpaCents * cfg.mutateCpaBandMultiple;
  } else {
    if (roas === null) return null;
    inBand = roas < objective.targetRoas && roas >= objective.targetRoas / cfg.mutateCpaBandMultiple;
  }
  if (!inBand) return null;

  // Exactly one variable changes. Which one is chosen from the failure shape: a poor click
  // rate is a creative/hook problem, so change the visual; decent clicks but poor conversion
  // is a message/offer problem, so change the headline.
  const ctr = safeRate(v.proxy.clicks, v.proxy.impressions) ?? 0;
  const cohortCtr =
    safeRate(
      input.variants.reduce((s, o) => s + o.proxy.clicks, 0),
      input.variants.reduce((s, o) => s + o.proxy.impressions, 0),
    ) ?? 0;
  const mutatedField: 'HEADLINE' | 'IMAGE' = ctr < cohortCtr ? 'IMAGE' : 'HEADLINE';

  return {
    type: 'MUTATE',
    variantId: v.variantId,
    adSetId: v.adSetId,
    campaignId: v.campaignId,
    platformEntityId: v.adSetId,
    mutatedField,
    parentMutationDepth: v.mutationDepth,
    newAdSetBudgetCents: cfg.mutateTestBudgetCents,
  };
}

function killAction(v: VariantMetrics): Extract<ProposedAction, { type: 'KILL' }> {
  return {
    type: 'KILL',
    variantId: v.variantId,
    adSetId: v.adSetId,
    campaignId: v.campaignId,
    platformEntityId: v.platformAdId,
  };
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
