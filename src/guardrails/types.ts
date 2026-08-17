/**
 * Guardrail configuration, resolved into plain numbers.
 *
 * The DB stores percentages and thresholds in `numeric` columns, which the driver hands back
 * as strings. Doing arithmetic on those strings is a category of bug that silently produces
 * "20" + 5 = "205". This type is the parsed, validated form, and `parseGuardrailConfig` is
 * the only sanctioned way to produce one.
 */

export interface ResolvedGuardrailConfig {
  readonly id: string;
  readonly clientId: string;
  readonly version: number;

  // Budget movement
  readonly maxBudgetIncreasePct: number;
  readonly maxBudgetDecreasePct: number;
  readonly maxDailyAutonomousIncreaseCents: number;
  readonly maxTotalDailyBudgetCents: number;
  readonly minAdSetDailyBudgetCents: number;
  readonly maxAdSetDailyBudgetCents: number;

  // Evidence floors
  readonly minRuntimeHours: number;
  readonly minSpendMultipleOfTargetCpa: number;
  readonly minConversionsPerArm: number;
  readonly minTestSpendCents: number;
  readonly zeroConversionKillSpendCents: number;

  // Significance
  readonly killPThreshold: number;
  readonly scalePThreshold: number;
  readonly proxyKillMinImpressions: number;
  readonly proxyKillCtrDropPct: number;
  readonly zeroConversionKillSpendMultiple: number;
  readonly roasScaleSafetyMargin: number;
  readonly roasBootstrapMinDays: number;
  readonly roasBootstrapIterations: number;
  readonly mSprtTauRelative: number;

  // Mutation
  readonly mutateCpaBandMultiple: number;
  readonly maxMutationDepth: number;
  readonly mutateTestBudgetCents: number;
  readonly allowScaleWithoutComparativeBaseline: boolean;

  // Rate limiting
  readonly actionCooldownHours: number;
  readonly maxActionsPerCyclePerClient: number;

  // Hard blacklist
  readonly minActiveCampaigns: number;
  readonly allowTargetingChanges: boolean;
  readonly allowAudienceExpansion: boolean;
  readonly allowCampaignCreation: boolean;

  // Freshness
  readonly attributionSettlingHours: number;
  readonly maxPerformanceStalenessHours: number;

  // Approval
  readonly approvalExpiryHours: number;
}

export type ActionType = 'KILL' | 'SCALE' | 'MUTATE';

export interface ProposedKill {
  readonly type: 'KILL';
  readonly variantId: string;
  readonly adSetId: string;
  readonly campaignId: string;
  readonly platformEntityId: string;
}

export interface ProposedScale {
  readonly type: 'SCALE';
  readonly variantId: string;
  readonly adSetId: string;
  readonly campaignId: string;
  readonly platformEntityId: string;
  readonly currentBudgetCents: number;
  /** Absolute target, already capped by the engine. Guardrails verify, never clamp. */
  readonly targetBudgetCents: number;
}

export interface ProposedMutate {
  readonly type: 'MUTATE';
  readonly variantId: string;
  readonly adSetId: string;
  readonly campaignId: string;
  readonly platformEntityId: string;
  readonly mutatedField: 'HEADLINE' | 'PRIMARY_TEXT' | 'CTA' | 'IMAGE';
  readonly parentMutationDepth: number;
  /** A mutant launches a new ad set, so it consumes daily increase headroom. */
  readonly newAdSetBudgetCents: number;
}

export type ProposedAction = ProposedKill | ProposedScale | ProposedMutate;

/** Everything the guardrail engine needs. Assembled by the caller; the engine reads only this. */
export interface GuardrailContext {
  readonly config: ResolvedGuardrailConfig;
  readonly now: Date;

  /** Master kill switch from the environment. False blocks every mutation, full stop. */
  readonly executionEnabled: boolean;

  readonly client: {
    readonly id: string;
    readonly autonomousKillEnabled: boolean;
    readonly autonomousScaleEnabled: boolean;
    readonly autonomousMutateEnabled: boolean;
  };

  readonly account: {
    readonly id: string;
    readonly status: 'ACTIVE' | 'TOKEN_EXPIRED' | 'DISABLED' | 'ERROR';
    readonly currency: string;
    /** Platform-imposed cap, when the platform reports one. */
    readonly platformDailySpendCapCents: number | null;
  };

  /** Campaigns for this client currently ACTIVE with at least one active variant. */
  readonly activeCampaignCount: number;
  /** Active (TESTING or SCALING) variants in the campaign this action targets. */
  readonly activeVariantsInCampaign: number;
  /** Sum of daily budgets across the client's live ad sets, in account currency. */
  readonly clientTotalDailyBudgetCents: number;
  /** Autonomous increases already committed today, from the spend ledger. */
  readonly todayAutonomousIncreaseCents: number;

  readonly lastActionAtForVariant: Date | null;
  readonly actionsAlreadyThisCycle: number;

  /** Timestamp of the newest performance snapshot backing this decision. */
  readonly newestPerformanceFetchedAt: Date | null;

  /** True when the action would alter targeting. Always blocked; present for auditability. */
  readonly touchesTargeting: boolean;

  /**
   * Currency the config's cent-denominated limits are expressed in. The caller sets this to
   * null when the client's ad accounts span multiple currencies, because a single client-level
   * cap cannot be enforced across currencies without an FX rate this system deliberately does
   * not invent. Null blocks every money-moving action for that client. See PLAN.md #5.
   */
  readonly guardrailDenominationCurrency: string | null;
}

export type GuardrailRuleName =
  | 'EXECUTION_ENABLED'
  | 'ACCOUNT_HEALTHY'
  | 'AUTONOMY_TIER'
  | 'CURRENCY_DENOMINATION'
  | 'DATA_FRESHNESS'
  | 'ACTION_COOLDOWN'
  | 'MAX_ACTIONS_PER_CYCLE'
  | 'NO_TARGETING_CHANGES'
  | 'MAX_BUDGET_INCREASE_PCT'
  | 'MAX_BUDGET_DECREASE_PCT'
  | 'AD_SET_BUDGET_BOUNDS'
  | 'DAILY_AUTONOMOUS_INCREASE_CAP'
  | 'TOTAL_DAILY_BUDGET_CEILING'
  | 'PLATFORM_DAILY_SPEND_CAP'
  | 'MIN_ACTIVE_CAMPAIGNS'
  | 'NEVER_EMPTY_A_CAMPAIGN'
  | 'MAX_MUTATION_DEPTH'
  | 'BUDGET_VALUE_SANITY';

export interface GuardrailEvaluation {
  readonly rule: GuardrailRuleName;
  readonly passed: boolean;
  /** Whether this rule applied to the action at all. Skipped rules always pass. */
  readonly applicable: boolean;
  readonly detail: string;
  readonly observed?: number | string | null;
  readonly limit?: number | string | null;
}

export interface GuardrailVerdict {
  readonly allowed: boolean;
  /** First failing rule, in evaluation order. Null when allowed. */
  readonly blockedBy: GuardrailRuleName | null;
  readonly blockedReason: string | null;
  /** Every rule considered, whether or not it applied. This is the audit payload. */
  readonly evaluations: readonly GuardrailEvaluation[];
  /**
   * True when the action is permitted but must be queued for human approval rather than
   * executed. Distinct from `allowed: false` — the decision is sound, the tier requires a human.
   */
  readonly requiresApproval: boolean;
}
