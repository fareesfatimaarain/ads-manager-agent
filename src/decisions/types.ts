import type { ProposedAction, ResolvedGuardrailConfig } from '../guardrails/types.js';
import type { ProportionTestResult } from '../stats/proportionTest.js';
import type { AlwaysValidResult } from '../stats/alwaysValid.js';
import type { RatioBoundResult } from '../stats/bootstrap.js';

export type Objective =
  | { readonly type: 'CPA'; readonly targetCpaCents: number }
  | { readonly type: 'ROAS'; readonly targetRoas: number };

/** Aggregated metrics over a window. All money in integer cents. */
export interface MetricAggregate {
  readonly impressions: number;
  readonly clicks: number;
  readonly spendCents: number;
  readonly conversions: number;
  readonly conversionValueCents: number;
}

export interface VariantMetrics {
  readonly variantId: string;
  readonly adSetId: string;
  readonly campaignId: string;
  readonly platformAdId: string;
  readonly status: 'TESTING' | 'SCALING';

  /**
   * Aggregate over SETTLED dates only — dates old enough that attribution has finished
   * restating them. Conversion and revenue decisions read this and nothing else.
   */
  readonly settled: MetricAggregate;
  /**
   * Aggregate over ALL dates including unsettled ones. Impressions and clicks stabilise
   * almost immediately, so proxy tests may use the wider, fresher window.
   */
  readonly proxy: MetricAggregate;

  /**
   * Per-day settled figures, oldest first. Required for the ROAS bootstrap, which resamples
   * whole days; ignored for CPA objectives, which have a parametric bound instead.
   */
  readonly settledDaily: readonly {
    readonly statDate: string;
    readonly spendCents: number;
    readonly conversionValueCents: number;
    readonly conversions: number;
  }[];

  readonly testStartedAt: Date;
  readonly currentBudgetCents: number;
  readonly mutationDepth: number;
  /** Audit counters only — the always-valid test does not consume them. */
  readonly evaluationsProxy: number;
  readonly evaluationsOutcome: number;
}

export interface BudgetHeadroom {
  readonly todayAutonomousIncreaseCents: number;
  readonly clientTotalDailyBudgetCents: number;
  readonly platformDailySpendCapCents: number | null;
}

export interface CohortInput {
  readonly cohortId: string;
  readonly clientId: string;
  readonly objective: Objective;
  readonly config: ResolvedGuardrailConfig;
  readonly variants: readonly VariantMetrics[];
  /**
   * Variants whose performance fetch failed this cycle. Any entry here skips the WHOLE
   * cohort: a baseline computed from the subset that happened to succeed is a biased
   * baseline, and deciding on it is worse than not deciding at all.
   */
  readonly variantsWithMissingData: readonly string[];
  readonly headroom: BudgetHeadroom;
  readonly now: Date;
}

export type DecisionKind = 'KILL' | 'SCALE' | 'MUTATE' | 'NO_ACTION';

export type ReasonCode =
  | 'INSUFFICIENT_RUNTIME'
  | 'INSUFFICIENT_SPEND'
  | 'ZERO_CONVERSIONS_PAST_SPEND_THRESHOLD'
  | 'COMPARATIVE_UNDERPERFORMANCE'
  | 'PROXY_CTR_UNDERPERFORMANCE'
  | 'MEETS_OBJECTIVE_WITH_CONFIDENCE'
  | 'NEAR_WINNER_WORTH_MUTATING'
  | 'MUTATION_DEPTH_EXHAUSTED'
  | 'NO_BUDGET_HEADROOM'
  | 'PROTECTED_MEETING_OBJECTIVE'
  | 'INSUFFICIENT_CONVERSIONS'
  | 'NOT_SIGNIFICANT'
  | 'NO_COMPARATIVE_BASELINE';

/** One hypothesis test, with every correction applied to it recorded alongside the raw result. */
export interface TestReport {
  readonly result: ProportionTestResult | null;
  /** Fixed-sample p-value. Reported for context; NOT what the decision is made on. */
  readonly fixedSampleP: number | null;
  /** Anytime-valid p-value from the mSPRT. This is the figure that drives the decision. */
  readonly alwaysValid: AlwaysValidResult | null;
  readonly rawP: number | null;
  /** Always-valid p after Benjamini-Hochberg across the cohort family. */
  readonly bhAdjustedP: number | null;
  /** The threshold `bhAdjustedP` was compared against. */
  readonly threshold: number | null;
  readonly significant: boolean;
}

export interface StatisticalEvidence {
  readonly objective: Objective;
  readonly runtimeHours: number;

  readonly settled: MetricAggregate;
  readonly proxy: MetricAggregate;

  readonly observedCtr: number | null;
  readonly observedCvr: number | null;
  readonly observedCpaCents: number | null;
  readonly observedRoas: number | null;

  /** Posterior P(true CPA <= target). Null for ROAS clients. */
  readonly probabilityMeetsCpaTarget: number | null;
  /** Bootstrapped one-sided lower bound on true ROAS. Null for CPA clients. */
  readonly roasLowerBound: RatioBoundResult | null;

  /**
   * Both directions are always reported, never merged into one slot. An audit record that
   * showed "the outcome test" without saying which tail it was would be unreadable after the
   * fact — and the two tails carry different alphas, since kill and scale are held to
   * different thresholds by design.
   */
  readonly proxyTest: { readonly worse: TestReport };
  readonly outcomeTest: { readonly worse: TestReport; readonly better: TestReport };

  readonly baselineArmCount: number;
  /** Warnings that do not block a decision but belong in the audit record. */
  readonly notes: readonly string[];
}

export interface VariantDecision {
  readonly variantId: string;
  readonly kind: DecisionKind;
  readonly reasonCode: ReasonCode;
  readonly humanSummary: string;
  readonly evidence: StatisticalEvidence;
  readonly proposedAction: ProposedAction | null;
  /** Persisted back to ad_variants after the cycle. */
  readonly newEvaluationsProxy: number;
  readonly newEvaluationsOutcome: number;
}

export interface CohortDecisionResult {
  readonly cohortId: string;
  readonly skipped: boolean;
  readonly skipReason: string | null;
  readonly decisions: readonly VariantDecision[];
}
