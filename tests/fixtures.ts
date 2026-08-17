import type {
  GuardrailContext,
  ResolvedGuardrailConfig,
  ProposedAction,
} from '../src/guardrails/types.js';
import type { CohortInput, MetricAggregate, VariantMetrics } from '../src/decisions/types.js';
export type { MetricAggregate };

/** The "balanced two-tier" preset, as agreed. Tests override individual fields. */
export function config(overrides: Partial<ResolvedGuardrailConfig> = {}): ResolvedGuardrailConfig {
  return {
    id: 'gc-1',
    clientId: 'client-1',
    version: 1,

    maxBudgetIncreasePct: 20,
    maxBudgetDecreasePct: 50,
    maxDailyAutonomousIncreaseCents: 20_000, // $200
    maxTotalDailyBudgetCents: 100_000, // $1000
    minAdSetDailyBudgetCents: 500, // $5
    maxAdSetDailyBudgetCents: 50_000, // $500

    minRuntimeHours: 72,
    minSpendMultipleOfTargetCpa: 1.0,
    minConversionsPerArm: 25,
    minTestSpendCents: 5_000, // $50
    zeroConversionKillSpendCents: 15_000, // $150

    killPThreshold: 0.1,
    scalePThreshold: 0.05,
    proxyKillMinImpressions: 3_000,
    proxyKillCtrDropPct: 50,
    zeroConversionKillSpendMultiple: 2.0,
    roasScaleSafetyMargin: 1.1,
    roasBootstrapMinDays: 5,
    roasBootstrapIterations: 2_000,
    mSprtTauRelative: 0.5,

    mutateCpaBandMultiple: 1.5,
    maxMutationDepth: 2,
    mutateTestBudgetCents: 3_000,
    allowScaleWithoutComparativeBaseline: true,

    actionCooldownHours: 24,
    maxActionsPerCyclePerClient: 10,

    minActiveCampaigns: 1,
    allowTargetingChanges: false,
    allowAudienceExpansion: false,
    allowCampaignCreation: false,

    attributionSettlingHours: 72,
    maxPerformanceStalenessHours: 36,
    approvalExpiryHours: 48,

    ...overrides,
  };
}

export const NOW = new Date('2026-08-04T12:00:00Z');

export function metrics(over: Partial<MetricAggregate> = {}): MetricAggregate {
  return {
    impressions: 0,
    clicks: 0,
    spendCents: 0,
    conversions: 0,
    conversionValueCents: 0,
    ...over,
  };
}

/**
 * Splits a settled aggregate into `days` equal daily rows. The ROAS bootstrap resamples days,
 * so a fixture with no daily breakdown could never clear the bound.
 */
export function evenDailySeries(
  settled: MetricAggregate,
  days: number,
): VariantMetrics['settledDaily'] {
  const out: { statDate: string; spendCents: number; conversionValueCents: number; conversions: number }[] = [];
  for (let i = 0; i < days; i++) {
    out.push({
      statDate: new Date(NOW.getTime() - (days - i) * 86_400_000).toISOString().slice(0, 10),
      spendCents: Math.round(settled.spendCents / days),
      conversionValueCents: Math.round(settled.conversionValueCents / days),
      conversions: Math.round(settled.conversions / days),
    });
  }
  return out;
}

export function variant(over: Partial<VariantMetrics> = {}): VariantMetrics {
  const settled = over.settled ?? metrics();
  return {
    variantId: 'v1',
    adSetId: 'as1',
    campaignId: 'c1',
    platformAdId: 'ad1',
    status: 'TESTING',
    settled,
    proxy: metrics(),
    settledDaily: evenDailySeries(settled, 7),
    testStartedAt: new Date(NOW.getTime() - 96 * 3_600_000), // 96h ago, past the 72h floor
    currentBudgetCents: 3_000, // $30/day
    mutationDepth: 0,
    evaluationsProxy: 0,
    evaluationsOutcome: 0,
    ...over,
  };
}

export function cohort(over: Partial<CohortInput> = {}): CohortInput {
  return {
    cohortId: 'co1',
    clientId: 'client-1',
    objective: { type: 'CPA', targetCpaCents: 5_000 }, // $50 target CPA
    config: config(),
    variants: [],
    variantsWithMissingData: [],
    headroom: {
      todayAutonomousIncreaseCents: 0,
      clientTotalDailyBudgetCents: 12_000,
      platformDailySpendCapCents: null,
    },
    now: NOW,
    ...over,
  };
}

export function guardrailContext(over: Partial<GuardrailContext> = {}): GuardrailContext {
  return {
    config: config(),
    now: NOW,
    executionEnabled: true,
    client: {
      id: 'client-1',
      autonomousKillEnabled: true,
      autonomousScaleEnabled: false, // tiered default: scale needs a human
      autonomousMutateEnabled: true,
    },
    account: {
      id: 'acc-1',
      status: 'ACTIVE',
      currency: 'USD',
      platformDailySpendCapCents: null,
    },
    activeCampaignCount: 2,
    activeVariantsInCampaign: 4,
    clientTotalDailyBudgetCents: 12_000,
    todayAutonomousIncreaseCents: 0,
    lastActionAtForVariant: null,
    actionsAlreadyThisCycle: 0,
    newestPerformanceFetchedAt: new Date(NOW.getTime() - 2 * 3_600_000),
    touchesTargeting: false,
    guardrailDenominationCurrency: 'USD',
    ...over,
  };
}

export const scaleAction = (over: Partial<Extract<ProposedAction, { type: 'SCALE' }>> = {}) =>
  ({
    type: 'SCALE',
    variantId: 'v1',
    adSetId: 'as1',
    campaignId: 'c1',
    platformEntityId: 'as1',
    currentBudgetCents: 3_000,
    targetBudgetCents: 3_600, // +20%
    ...over,
  }) as const;

export const killAction = (over: Partial<Extract<ProposedAction, { type: 'KILL' }>> = {}) =>
  ({
    type: 'KILL',
    variantId: 'v1',
    adSetId: 'as1',
    campaignId: 'c1',
    platformEntityId: 'ad1',
    ...over,
  }) as const;

export const mutateAction = (over: Partial<Extract<ProposedAction, { type: 'MUTATE' }>> = {}) =>
  ({
    type: 'MUTATE',
    variantId: 'v1',
    adSetId: 'as1',
    campaignId: 'c1',
    platformEntityId: 'as1',
    mutatedField: 'HEADLINE',
    parentMutationDepth: 0,
    newAdSetBudgetCents: 3_000,
    ...over,
  }) as const;
