/**
 * Platform-neutral internal data model.
 *
 * Hard rules enforced by this schema:
 *  - All money is stored as integer minor units (cents). No floats touch the money path.
 *  - No platform-specific field ever appears here. Platform quirks live in adapters.
 *  - `daily_performance` is append-only. Rows are never updated or deleted, because
 *    reconstructing what the engine knew at decision time is what makes the audit trail real.
 *  - `guardrail_configs` is append-only and versioned, so a decision can be replayed against
 *    the exact limits that were in force when it fired.
 */
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const platformEnum = pgEnum('platform', ['META', 'GOOGLE', 'TIKTOK', 'MOCK']);

export const objectiveTypeEnum = pgEnum('objective_type', ['CPA', 'ROAS']);

export const adAccountStatusEnum = pgEnum('ad_account_status', [
  'ACTIVE',
  'TOKEN_EXPIRED',
  'DISABLED',
  'ERROR',
]);

export const campaignStatusEnum = pgEnum('campaign_status', [
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'ARCHIVED',
]);

export const adSetStatusEnum = pgEnum('ad_set_status', ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED']);

export const cohortStatusEnum = pgEnum('cohort_status', ['RUNNING', 'CONCLUDED', 'ABANDONED']);

export const variantStatusEnum = pgEnum('variant_status', [
  'DRAFT',
  'PENDING_LAUNCH',
  'TESTING',
  'SCALING',
  'PAUSED',
  'KILLED',
  'FAILED',
]);

export const mutatedFieldEnum = pgEnum('mutated_field', [
  'HEADLINE',
  'PRIMARY_TEXT',
  'CTA',
  'IMAGE',
]);

export const decisionTypeEnum = pgEnum('decision_type', [
  'KILL',
  'SCALE',
  'MUTATE',
  'NO_ACTION',
  'ESCALATE',
]);

/**
 * Decision lifecycle. The only paths to EXECUTED are:
 *   PENDING_APPROVAL -> APPROVED -> EXECUTING -> EXECUTED   (scale; human in the loop)
 *   PENDING_EXECUTION -> EXECUTING -> EXECUTED              (kill/mutate; autonomous)
 * BLOCKED is terminal and means a guardrail refused the action.
 */
export const decisionStatusEnum = pgEnum('decision_status', [
  'PENDING_APPROVAL',
  'PENDING_EXECUTION',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'EXECUTING',
  'EXECUTED',
  'FAILED',
  'BLOCKED',
  'RECORDED_ONLY',
]);

export const performanceSourceEnum = pgEnum('performance_source', ['PLATFORM', 'MOCK', 'BACKFILL']);

export const platformActionStatusEnum = pgEnum('platform_action_status', [
  'PENDING',
  'IN_FLIGHT',
  'SUCCEEDED',
  'FAILED',
  'DEAD',
]);

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export const clients = pgTable(
  'clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    timezone: text('timezone').notNull().default('UTC'),

    /** Default objective; a campaign may override. */
    defaultObjectiveType: objectiveTypeEnum('default_objective_type').notNull(),
    defaultTargetCpaCents: bigint('default_target_cpa_cents', { mode: 'number' }),
    defaultTargetRoas: numeric('default_target_roas', { precision: 10, scale: 4 }),

    /**
     * Tiered autonomy. Kills stop spend, so they are allowed to run unattended by default.
     * Scales start spend, so they require an explicit human approval unless a client is
     * deliberately promoted to full autonomy after its numbers have been observed.
     */
    autonomousKillEnabled: boolean('autonomous_kill_enabled').notNull().default(true),
    autonomousScaleEnabled: boolean('autonomous_scale_enabled').notNull().default(false),
    autonomousMutateEnabled: boolean('autonomous_mutate_enabled').notNull().default(true),

    /**
     * Per-client pause. When set, the engine still gathers data and forms opinions but makes
     * no changes to this client's account.
     *
     * Distinct from the EXECUTION_ENABLED environment switch, which is deployment-level and
     * deliberately NOT reachable from the UI — a global stop should require someone with
     * access to the deployment, not a misplaced click.
     */
    automationPausedAt: timestamp('automation_paused_at', { withTimezone: true }),
    automationPausedBy: text('automation_paused_by'),

    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('clients_slug_key').on(t.slug),
    // A client must carry a usable target for whichever objective it declares.
    // Enforced in the DB so a half-configured client cannot reach the decision engine.
    check(
      'clients_objective_target_ck',
      sql`(default_objective_type = 'CPA'  AND default_target_cpa_cents IS NOT NULL AND default_target_cpa_cents > 0)
          OR
          (default_objective_type = 'ROAS' AND default_target_roas IS NOT NULL AND default_target_roas > 0)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Ad accounts (platform connection + encrypted credentials)
// ---------------------------------------------------------------------------

export const adAccounts = pgTable(
  'ad_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    platform: platformEnum('platform').notNull(),
    platformAccountId: text('platform_account_id').notNull(),
    name: text('name').notNull(),

    /** ISO 4217. Guardrail money limits are denominated in this currency — no FX in v1. */
    currency: text('currency').notNull(),
    /** IANA tz. Stat dates are bucketed in this zone, matching platform reporting. */
    timezone: text('timezone').notNull(),

    /**
     * AES-256-GCM ciphertext, base64. Never logged, never returned by any API surface.
     * keyVersion supports rotation without a flag-day re-encrypt.
     */
    accessTokenCiphertext: text('access_token_ciphertext'),
    refreshTokenCiphertext: text('refresh_token_ciphertext'),
    tokenKeyVersion: smallint('token_key_version'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),

    /**
     * Non-secret, platform-specific settings an adapter needs that don't fit the generic
     * contract: a Meta pixel ID and Page ID, a Google Ads customer ID, and so on. Never a
     * credential — those live only in the ciphertext columns above.
     */
    platformConfig: jsonb('platform_config'),

    status: adAccountStatusEnum('status').notNull().default('ACTIVE'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    lastError: text('last_error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ad_accounts_platform_account_key').on(t.platform, t.platformAccountId),
    index('ad_accounts_client_idx').on(t.clientId),
    check('ad_accounts_currency_ck', sql`currency ~ '^[A-Z]{3}$'`),
  ],
);

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    adAccountId: uuid('ad_account_id')
      .notNull()
      .references(() => adAccounts.id, { onDelete: 'restrict' }),

    /** Null until the campaign has actually been created on the platform. */
    platformCampaignId: text('platform_campaign_id'),
    name: text('name').notNull(),

    /** Null means inherit the client default. Resolved once per decision cycle. */
    objectiveType: objectiveTypeEnum('objective_type'),
    targetCpaCents: bigint('target_cpa_cents', { mode: 'number' }),
    targetRoas: numeric('target_roas', { precision: 10, scale: 4 }),

    status: campaignStatusEnum('status').notNull().default('DRAFT'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('campaigns_client_idx').on(t.clientId),
    index('campaigns_account_idx').on(t.adAccountId),
    uniqueIndex('campaigns_platform_id_key')
      .on(t.adAccountId, t.platformCampaignId)
      .where(sql`platform_campaign_id IS NOT NULL`),
  ],
);

// ---------------------------------------------------------------------------
// Test cohorts — the explicit comparison family
// ---------------------------------------------------------------------------

/**
 * A cohort is the set of variants that are legitimately compared against each other.
 * Making this explicit (rather than "everything in the campaign") matters for two reasons:
 *   1. The pooled baseline for a variant is the other members of its cohort.
 *   2. It defines the family for the Benjamini-Hochberg correction. Get the family wrong
 *      and the multiple-comparisons correction is wrong too.
 */
export const testCohorts = pgTable(
  'test_cohorts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    status: cohortStatusEnum('status').notNull().default('RUNNING'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    concludedAt: timestamp('concluded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('test_cohorts_campaign_idx').on(t.campaignId)],
);

// ---------------------------------------------------------------------------
// Ad sets — budget + targeting. One variant per ad set during testing (see PLAN.md #2).
// ---------------------------------------------------------------------------

export const adSets = pgTable(
  'ad_sets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'restrict' }),
    platformAdSetId: text('platform_ad_set_id'),
    name: text('name').notNull(),

    dailyBudgetCents: bigint('daily_budget_cents', { mode: 'number' }).notNull(),
    /** Platform-neutral targeting spec. Changing this autonomously is blacklisted. */
    targeting: jsonb('targeting').notNull().default(sql`'{}'::jsonb`),
    /** Hash of `targeting`, used to detect any drift from the human-approved spec. */
    targetingHash: text('targeting_hash').notNull(),

    status: adSetStatusEnum('status').notNull().default('DRAFT'),
    lastBudgetChangeAt: timestamp('last_budget_change_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ad_sets_campaign_idx').on(t.campaignId),
    uniqueIndex('ad_sets_platform_id_key')
      .on(t.campaignId, t.platformAdSetId)
      .where(sql`platform_ad_set_id IS NOT NULL`),
    check('ad_sets_budget_positive_ck', sql`daily_budget_cents > 0`),
  ],
);

// ---------------------------------------------------------------------------
// Ad variants — creative + copy, and the reasoning behind them
// ---------------------------------------------------------------------------

export const adVariants = pgTable(
  'ad_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adSetId: uuid('ad_set_id')
      .notNull()
      .references(() => adSets.id, { onDelete: 'restrict' }),
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => testCohorts.id, { onDelete: 'restrict' }),
    /** Denormalised for cheap cycle queries; must always agree with adSet -> campaign. */
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'restrict' }),

    platformAdId: text('platform_ad_id'),

    headline: text('headline').notNull(),
    primaryText: text('primary_text').notNull(),
    cta: text('cta').notNull(),
    imageAssetId: uuid('image_asset_id'),
    videoAssetId: uuid('video_asset_id'),

    /**
     * Why this variant exists. This is the payload that lets the system learn which
     * *angles* work rather than only which specific ads won.
     */
    angleTag: text('angle_tag').notNull(),
    hookType: text('hook_type'),
    generationReasoning: text('generation_reasoning'),
    generationRunId: uuid('generation_run_id'),

    /** Mutation lineage. Exactly one field differs from the parent. */
    parentVariantId: uuid('parent_variant_id'),
    mutatedField: mutatedFieldEnum('mutated_field'),

    status: variantStatusEnum('status').notNull().default('DRAFT'),
    testStartedAt: timestamp('test_started_at', { withTimezone: true }),

    /**
     * How many times a valid significance test has been computed, per hypothesis.
     *
     * AUDIT ONLY. These once drove an alpha-spending correction; the engine now uses an
     * always-valid sequential test (see stats/alwaysValid.ts) whose error guarantee holds for
     * any number of looks, so the count is no longer a statistical input. It is retained
     * because "this ad has been assessed 34 times" is genuinely useful when reading back a
     * decision, and because losing the history would make past records harder to interpret.
     */
    evaluationsProxy: integer('evaluations_proxy').notNull().default(0),
    evaluationsOutcome: integer('evaluations_outcome').notNull().default(0),
    lastEvaluatedAt: timestamp('last_evaluated_at', { withTimezone: true }),
    lastActionAt: timestamp('last_action_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ad_variants_cohort_idx').on(t.cohortId),
    index('ad_variants_campaign_status_idx').on(t.campaignId, t.status),
    index('ad_variants_angle_idx').on(t.angleTag),
    uniqueIndex('ad_variants_platform_id_key')
      .on(t.adSetId, t.platformAdId)
      .where(sql`platform_ad_id IS NOT NULL`),
    check(
      'ad_variants_mutation_ck',
      sql`(parent_variant_id IS NULL AND mutated_field IS NULL)
          OR
          (parent_variant_id IS NOT NULL AND mutated_field IS NOT NULL)`,
    ),
    check('ad_variants_evaluations_ck', sql`evaluations_proxy >= 0 AND evaluations_outcome >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// Daily performance — APPEND ONLY
// ---------------------------------------------------------------------------

/**
 * One row per (variant, stat_date, fetched_at). Platforms restate history as attribution
 * settles, so the same stat_date will accumulate several rows over time with different
 * numbers. We keep all of them.
 *
 * Reading rules (enforced in src/performance/reader.ts, not here):
 *  - Latest snapshot per (variant, stat_date) is the current truth.
 *  - Conversion/revenue metrics may only be read for *settled* dates:
 *      now() >= end_of_day(stat_date, account_tz) + settling_hours
 *  - Proxy metrics (impressions, clicks) settle almost immediately and may read fresh dates.
 */
export const dailyPerformance = pgTable(
  'daily_performance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adVariantId: uuid('ad_variant_id')
      .notNull()
      .references(() => adVariants.id, { onDelete: 'restrict' }),

    /** Date bucket in the ad account's timezone, as reported by the platform. */
    statDate: date('stat_date').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),

    impressions: bigint('impressions', { mode: 'number' }).notNull(),
    clicks: bigint('clicks', { mode: 'number' }).notNull(),
    spendCents: bigint('spend_cents', { mode: 'number' }).notNull(),
    conversions: bigint('conversions', { mode: 'number' }).notNull(),
    conversionValueCents: bigint('conversion_value_cents', { mode: 'number' }).notNull().default(0),

    currency: text('currency').notNull(),
    source: performanceSourceEnum('source').notNull(),
    /** Verbatim platform response for this row, for after-the-fact dispute resolution. */
    rawPayload: jsonb('raw_payload'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('daily_performance_snapshot_key').on(t.adVariantId, t.statDate, t.fetchedAt),
    index('daily_performance_variant_date_idx').on(t.adVariantId, t.statDate),
    index('daily_performance_date_idx').on(t.statDate),
    // Counters cannot be negative. A platform returning negative spend is a bug we want
    // to fail loudly on at write time, not silently average into a decision.
    check(
      'daily_performance_nonneg_ck',
      sql`impressions >= 0 AND clicks >= 0 AND spend_cents >= 0
          AND conversions >= 0 AND conversion_value_cents >= 0`,
    ),
    // Clicks cannot exceed impressions. Violations indicate adapter field-mapping errors.
    check('daily_performance_clicks_ck', sql`clicks <= impressions`),
  ],
);

// ---------------------------------------------------------------------------
// Guardrail configs — APPEND ONLY, versioned
// ---------------------------------------------------------------------------

export const guardrailConfigs = pgTable(
  'guardrail_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),

    // --- Budget movement limits -------------------------------------------------
    /** Max % a single scale action may raise a budget. Never a lump jump. */
    maxBudgetIncreasePct: numeric('max_budget_increase_pct', { precision: 5, scale: 2 })
      .notNull()
      .default('20.00'),
    maxBudgetDecreasePct: numeric('max_budget_decrease_pct', { precision: 5, scale: 2 })
      .notNull()
      .default('50.00'),
    /** Sum of autonomous budget *increases* permitted per client per day. */
    maxDailyAutonomousIncreaseCents: bigint('max_daily_autonomous_increase_cents', {
      mode: 'number',
    }).notNull(),
    /** Absolute ceiling on total live daily budget across the client's accounts. */
    maxTotalDailyBudgetCents: bigint('max_total_daily_budget_cents', {
      mode: 'number',
    }).notNull(),
    /** Per-ad-set floor and ceiling, so a single entity cannot absorb the whole cap. */
    minAdSetDailyBudgetCents: bigint('min_ad_set_daily_budget_cents', { mode: 'number' })
      .notNull()
      .default(500),
    maxAdSetDailyBudgetCents: bigint('max_ad_set_daily_budget_cents', { mode: 'number' }).notNull(),

    // --- Evidence floors --------------------------------------------------------
    minRuntimeHours: integer('min_runtime_hours').notNull().default(72),
    minSpendMultipleOfTargetCpa: numeric('min_spend_multiple_of_target_cpa', {
      precision: 6,
      scale: 2,
    })
      .notNull()
      .default('1.00'),
    minConversionsPerArm: integer('min_conversions_per_arm').notNull().default(25),
    /**
     * Absolute per-variant spend floor, applied to every client. CPA clients additionally
     * face the multiple-of-target-CPA floor above; ROAS clients have no target CPA to
     * multiply, so this is what stops a decision on trivial spend. Default $50.
     */
    minTestSpendCents: bigint('min_test_spend_cents', { mode: 'number' }).notNull().default(5000),
    /**
     * Absolute spend-with-zero-conversions kill threshold for ROAS clients, who have no
     * target CPA for the multiple-based rule to reference. Default $150.
     */
    zeroConversionKillSpendCents: bigint('zero_conversion_kill_spend_cents', { mode: 'number' })
      .notNull()
      .default(15000),

    // --- Significance thresholds ------------------------------------------------
    killPThreshold: numeric('kill_p_threshold', { precision: 5, scale: 4 })
      .notNull()
      .default('0.1000'),
    scalePThreshold: numeric('scale_p_threshold', { precision: 5, scale: 4 })
      .notNull()
      .default('0.0500'),
    /** Proxy kill: needs this many impressions per arm before CTR is even looked at. */
    proxyKillMinImpressions: integer('proxy_kill_min_impressions').notNull().default(3000),
    /** Proxy kill: variant CTR must be at least this far below the pooled baseline. */
    proxyKillCtrDropPct: numeric('proxy_kill_ctr_drop_pct', { precision: 5, scale: 2 })
      .notNull()
      .default('50.00'),
    /** Absolute kill: this multiple of target CPA spent with zero conversions. */
    zeroConversionKillSpendMultiple: numeric('zero_conversion_kill_spend_multiple', {
      precision: 6,
      scale: 2,
    })
      .notNull()
      .default('2.00'),
    /** ROAS clients: the observed point estimate must clear target by this factor to scale.
     *  Applied in addition to the bootstrap lower bound, which is the primary gate. */
    roasScaleSafetyMargin: numeric('roas_scale_safety_margin', { precision: 5, scale: 3 })
      .notNull()
      .default('1.100'),
    /** Minimum settled days of history before a ROAS bootstrap bound is computed at all. */
    roasBootstrapMinDays: integer('roas_bootstrap_min_days').notNull().default(5),
    /** Resamples per bootstrap. Higher is smoother; 2000 is ample for a one-sided bound. */
    roasBootstrapIterations: integer('roas_bootstrap_iterations').notNull().default(2000),

    /**
     * Mixing scale for the always-valid sequential test, relative to the pooled base rate.
     * tau = mSprtTauRelative * pooledRate. Tunes the effect size the test is most sensitive
     * to; the error guarantee holds for any positive value, so this trades sensitivity only.
     */
    mSprtTauRelative: numeric('msprt_tau_relative', { precision: 6, scale: 3 })
      .notNull()
      .default('0.500'),

    // --- Mutation ---------------------------------------------------------------
    /** A "near-winner" is a variant whose CPA sits between target and target * this. */
    mutateCpaBandMultiple: numeric('mutate_cpa_band_multiple', { precision: 6, scale: 2 })
      .notNull()
      .default('1.50'),
    /** Cap on mutation chain length, so a variant cannot spawn descendants forever. */
    maxMutationDepth: integer('max_mutation_depth').notNull().default(2),
    /** Daily budget a mutant launches at. Counts against the daily autonomous increase cap. */
    mutateTestBudgetCents: bigint('mutate_test_budget_cents', { mode: 'number' })
      .notNull()
      .default(3000),
    /**
     * Whether a lone variant with no cohort peers may scale on absolute CPA confidence alone.
     * With one arm there is no comparative test to run; the Gamma posterior bound is still a
     * valid claim about true CPA, so this defaults on. Turn off for strictly comparative testing.
     */
    allowScaleWithoutComparativeBaseline: boolean('allow_scale_without_comparative_baseline')
      .notNull()
      .default(true),

    // --- Rate limiting ----------------------------------------------------------
    actionCooldownHours: integer('action_cooldown_hours').notNull().default(24),
    maxActionsPerCyclePerClient: integer('max_actions_per_cycle_per_client').notNull().default(10),

    // --- Hard blacklist ---------------------------------------------------------
    /** Engine may never leave a client with fewer than this many active campaigns. */
    minActiveCampaigns: integer('min_active_campaigns').notNull().default(1),
    /** Targeting changes always require a human. Present as a column so it is auditable,
     *  but the executor refuses targeting mutations regardless of this value. */
    allowTargetingChanges: boolean('allow_targeting_changes').notNull().default(false),
    allowAudienceExpansion: boolean('allow_audience_expansion').notNull().default(false),
    allowCampaignCreation: boolean('allow_campaign_creation').notNull().default(false),

    // --- Data freshness ---------------------------------------------------------
    attributionSettlingHours: integer('attribution_settling_hours').notNull().default(72),
    maxPerformanceStalenessHours: integer('max_performance_staleness_hours').notNull().default(36),

    // --- Approval ---------------------------------------------------------------
    approvalExpiryHours: integer('approval_expiry_hours').notNull().default(48),

    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    /** Null = currently in force. */
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('guardrail_configs_client_version_key').on(t.clientId, t.version),
    // Exactly one live config per client.
    uniqueIndex('guardrail_configs_one_live_key')
      .on(t.clientId)
      .where(sql`effective_to IS NULL`),
    // Sanity bounds. These are the outer limits of what any config may express; a
    // misconfigured row cannot even be inserted, let alone reach the decision engine.
    check(
      'guardrail_pct_bounds_ck',
      sql`max_budget_increase_pct > 0 AND max_budget_increase_pct <= 100
          AND max_budget_decrease_pct > 0 AND max_budget_decrease_pct <= 100`,
    ),
    check(
      'guardrail_p_bounds_ck',
      sql`kill_p_threshold > 0 AND kill_p_threshold <= 0.2
          AND scale_p_threshold > 0 AND scale_p_threshold <= 0.1
          AND scale_p_threshold <= kill_p_threshold`,
    ),
    check(
      'guardrail_money_bounds_ck',
      sql`max_daily_autonomous_increase_cents >= 0
          AND max_total_daily_budget_cents > 0
          AND min_ad_set_daily_budget_cents > 0
          AND max_ad_set_daily_budget_cents >= min_ad_set_daily_budget_cents
          AND max_ad_set_daily_budget_cents <= max_total_daily_budget_cents
          AND min_test_spend_cents > 0
          AND zero_conversion_kill_spend_cents > 0
          AND mutate_test_budget_cents > 0`,
    ),
    check(
      'guardrail_evidence_bounds_ck',
      sql`min_runtime_hours >= 24
          AND min_conversions_per_arm >= 1
          AND proxy_kill_min_impressions >= 500
          AND attribution_settling_hours >= 0
          AND approval_expiry_hours > 0
          AND max_mutation_depth >= 0
          AND action_cooldown_hours >= 0
          AND max_actions_per_cycle_per_client >= 0
          AND min_active_campaigns >= 0
          AND roas_bootstrap_min_days >= 2
          AND roas_bootstrap_iterations >= 100
          AND msprt_tau_relative > 0`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Decisions log — written BEFORE execution, always
// ---------------------------------------------------------------------------

export const decisionsLog = pgTable(
  'decisions_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    adVariantId: uuid('ad_variant_id').references(() => adVariants.id, { onDelete: 'restrict' }),
    cohortId: uuid('cohort_id').references(() => testCohorts.id, { onDelete: 'restrict' }),

    /** Which guardrail version authorised this. Pins the decision for later replay. */
    guardrailConfigId: uuid('guardrail_config_id')
      .notNull()
      .references(() => guardrailConfigs.id, { onDelete: 'restrict' }),

    cycleId: uuid('cycle_id').notNull(),
    decisionType: decisionTypeEnum('decision_type').notNull(),
    status: decisionStatusEnum('status').notNull(),

    /** Exact metric aggregates that triggered this, plus the snapshot ids they came from. */
    triggeringData: jsonb('triggering_data').notNull(),
    /** Test used, n per arm, raw p, BH-adjusted p, effective alpha, looks count, power. */
    statisticalEvidence: jsonb('statistical_evidence').notNull(),
    /** Every guardrail evaluated, with pass/fail and the numbers behind each. */
    guardrailEvaluations: jsonb('guardrail_evaluations').notNull(),
    /** The concrete mutation proposed, e.g. { type, fromCents, toCents }. */
    proposedAction: jsonb('proposed_action').notNull(),

    /** Human-readable explanation. Generated *from* the decision; never drives it. */
    reasoning: text('reasoning'),
    /** Set when a guardrail refused the action. */
    blockedByRule: text('blocked_by_rule'),
    blockedReason: text('blocked_reason'),

    /** Unique per intended effect. The anti-double-execution primitive. */
    idempotencyKey: text('idempotency_key').notNull(),

    engineVersion: text('engine_version').notNull(),
    rulesetVersion: text('ruleset_version').notNull(),

    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedBy: text('rejected_by'),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    executionStartedAt: timestamp('execution_started_at', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    failureReason: text('failure_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('decisions_log_idempotency_key').on(t.idempotencyKey),
    index('decisions_log_client_decided_idx').on(t.clientId, t.decidedAt),
    index('decisions_log_variant_idx').on(t.adVariantId),
    index('decisions_log_status_idx').on(t.status),
    index('decisions_log_cycle_idx').on(t.cycleId),
    // Anything that reached the platform must carry an execution timestamp.
    check('decisions_log_executed_ck', sql`status <> 'EXECUTED' OR executed_at IS NOT NULL`),
    // A blocked decision must say which rule blocked it.
    check('decisions_log_blocked_ck', sql`status <> 'BLOCKED' OR blocked_by_rule IS NOT NULL`),
    // Approval-gated decisions must record who approved them.
    check(
      'decisions_log_approved_ck',
      sql`status <> 'APPROVED' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Spend ledger — atomic accounting for the daily autonomous increase cap
// ---------------------------------------------------------------------------

/**
 * Append-only record of every autonomous budget increase. The daily cap is enforced by
 * summing this table under a row lock inside the same transaction that writes the decision,
 * so two concurrent cycles cannot each see headroom that only exists once.
 */
export const spendLedger = pgTable(
  'spend_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    adAccountId: uuid('ad_account_id')
      .notNull()
      .references(() => adAccounts.id, { onDelete: 'restrict' }),
    decisionId: uuid('decision_id')
      .notNull()
      .references(() => decisionsLog.id, { onDelete: 'restrict' }),

    /** Ledger day in the ad account's timezone. */
    ledgerDate: date('ledger_date').notNull(),
    /** Positive = budget increase committed. Denominated in the ad account's currency. */
    deltaCents: bigint('delta_cents', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('spend_ledger_client_date_idx').on(t.clientId, t.ledgerDate),
    uniqueIndex('spend_ledger_decision_key').on(t.decisionId),
  ],
);

// ---------------------------------------------------------------------------
// Platform actions — retries, circuit breaking, dead letters
// ---------------------------------------------------------------------------

export const platformActions = pgTable(
  'platform_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    decisionId: uuid('decision_id')
      .notNull()
      .references(() => decisionsLog.id, { onDelete: 'restrict' }),
    adAccountId: uuid('ad_account_id')
      .notNull()
      .references(() => adAccounts.id, { onDelete: 'restrict' }),

    platform: platformEnum('platform').notNull(),
    method: text('method').notNull(),
    requestPayload: jsonb('request_payload').notNull(),
    responsePayload: jsonb('response_payload'),

    /** Sent to the platform where supported; used for local reconciliation where not. */
    idempotencyKey: text('idempotency_key').notNull(),

    status: platformActionStatusEnum('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lastError: text('last_error'),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),

    /** Set when a human has dealt with a dead-lettered action. */
    acknowledgedBy: text('acknowledged_by'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),

    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('platform_actions_idempotency_key').on(t.idempotencyKey),
    index('platform_actions_decision_idx').on(t.decisionId),
    index('platform_actions_status_retry_idx').on(t.status, t.nextRetryAt),
    // Dead letters must never be invisible: this partial index is what the DLQ view reads.
    index('platform_actions_dead_idx')
      .on(t.createdAt)
      .where(sql`status = 'DEAD' AND acknowledged_at IS NULL`),
  ],
);

// ---------------------------------------------------------------------------
// Creative assets
// ---------------------------------------------------------------------------

export const creativeAssets = pgTable(
  'creative_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    provider: text('provider').notNull(),
    providerAssetId: text('provider_asset_id'),
    url: text('url'),
    prompt: text('prompt'),
    /** Which brand-kit version this was generated under, for enforcement audits. */
    brandKitVersion: integer('brand_kit_version'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('creative_assets_client_idx').on(t.clientId)],
);

/**
 * What is being advertised. Creative generation reads this plus the brand kit; nothing is
 * written without both, because an ad generated without a stated audience or offer is a
 * guess dressed up as output.
 */
export const offers = pgTable(
  'offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description').notNull(),
    /** Who this is for, in plain language. Feeds the generation prompt directly. */
    icpDescription: text('icp_description').notNull(),
    /** The reasons to buy, as discrete claims the copy may draw on. */
    valueProps: jsonb('value_props').notNull().default(sql`'[]'::jsonb`),
    landingPageUrl: text('landing_page_url').notNull(),
    priceCents: bigint('price_cents', { mode: 'number' }),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('offers_client_idx').on(t.clientId)],
);

/** One batch of creative generation, kept so any ad can be traced back to how it was made. */
export const generationRuns = pgTable(
  'generation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id, { onDelete: 'restrict' }),
    brandKitId: uuid('brand_kit_id').references(() => brandKits.id, { onDelete: 'restrict' }),
    copyProvider: text('copy_provider').notNull(),
    imageProvider: text('image_provider'),
    requestedCount: integer('requested_count').notNull(),
    producedCount: integer('produced_count').notNull().default(0),
    status: text('status').notNull().default('PENDING'),
    error: text('error'),
    /** Verbatim prompt sent, so a bad batch can be diagnosed rather than guessed at. */
    promptSnapshot: jsonb('prompt_snapshot'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [index('generation_runs_client_idx').on(t.clientId)],
);

/**
 * Generated creative awaiting review. Deliberately separate from `ad_variants`: a draft is an
 * idea, a variant is money being spent. Keeping them in one table would mean every live ad
 * carried nullable columns for a state it passed through weeks ago.
 */
export const creativeDrafts = pgTable(
  'creative_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id, { onDelete: 'restrict' }),
    generationRunId: uuid('generation_run_id')
      .notNull()
      .references(() => generationRuns.id, { onDelete: 'restrict' }),

    headline: text('headline').notNull(),
    primaryText: text('primary_text').notNull(),
    cta: text('cta').notNull(),

    /** The argument this creative is making — the thing actually being tested. */
    angleTag: text('angle_tag').notNull(),
    hookType: text('hook_type'),
    reasoning: text('reasoning').notNull(),

    imageAssetId: uuid('image_asset_id').references(() => creativeAssets.id, {
      onDelete: 'set null',
    }),

    /** DRAFT -> APPROVED -> LAUNCHED, or DRAFT -> REJECTED. */
    status: text('status').notNull().default('DRAFT'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    launchedVariantId: uuid('launched_variant_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('creative_drafts_client_status_idx').on(t.clientId, t.status),
    index('creative_drafts_run_idx').on(t.generationRunId),
    check(
      'creative_drafts_status_ck',
      sql`status IN ('DRAFT','APPROVED','REJECTED','LAUNCHED')`,
    ),
    check(
      'creative_drafts_launched_ck',
      sql`status <> 'LAUNCHED' OR launched_variant_id IS NOT NULL`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Brand governance
// ---------------------------------------------------------------------------

export const intakeStatusEnum = pgEnum('intake_status', [
  'IN_PROGRESS',
  'COMPLETED',
  'ABANDONED',
]);

export const reviewStatusEnum = pgEnum('review_status', [
  'PENDING_REVIEW',
  'BLOCKED',
  'APPROVED',
  'REJECTED',
  'EDITED',
]);

export const assetKindEnum = pgEnum('reference_asset_kind', [
  'LOGO',
  'PAST_AD',
  'POSTER',
  'BRAND_VIDEO',
  'STYLE_GUIDE',
  'BRAND_DOCUMENT',
  'OTHER',
]);

/**
 * The brand profile — persistent, versioned brand memory.
 *
 * Append-only and versioned for the same reason guardrail configs are: a creative generated
 * six months ago must remain interpretable against the brand as it stood then, not as it
 * stands now. `core` holds the universal answers, `industry` the branch-specific ones, and
 * `locks` records which elements the client has declared non-negotiable.
 */
export const brandProfiles = pgTable(
  'brand_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),

    /** Template key, e.g. "healthcare". Falls back to "generic" when unlisted. */
    industryKey: text('industry_key').notNull(),
    /** Which compliance template this industry resolved to when the profile was written. */
    complianceTemplateKey: text('compliance_template_key').notNull(),

    /** Universal answers, keyed by the `mapsTo` suffix from the core template. */
    core: jsonb('core').notNull(),
    /** Industry-branch answers. Shape varies by template, deliberately unconstrained here. */
    industry: jsonb('industry').notNull().default(sql`'{}'::jsonb`),

    /**
     * Elements the client has locked. A locked element is never altered by generation and is
     * passed through verbatim — the manual override that outranks autonomy.
     */
    locks: jsonb('locks').notNull().default(sql`'{}'::jsonb`),

    /** Free-text creative direction that applies to every campaign until changed. */
    creativeDirection: text('creative_direction'),

    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    /** Where this version came from: chat intake, document upload, or a manual edit. */
    sourceKind: text('source_kind').notNull().default('INTAKE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('brand_profiles_client_version_key').on(t.clientId, t.version),
    uniqueIndex('brand_profiles_one_live_key')
      .on(t.clientId)
      .where(sql`effective_to IS NULL`),
    index('brand_profiles_client_idx').on(t.clientId),
  ],
);

/** Chat-based onboarding state. One row per attempt, so a half-finished intake is resumable. */
export const intakeSessions = pgTable(
  'intake_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    status: intakeStatusEnum('status').notNull().default('IN_PROGRESS'),
    /** Null until the industry question is answered; drives which branch is asked. */
    industryKey: text('industry_key'),
    /** questionId -> answer. Partial until complete. */
    answers: jsonb('answers').notNull().default(sql`'{}'::jsonb`),
    /** Values extracted from an uploaded brand document, used to pre-fill and shown as such. */
    prefilled: jsonb('prefilled').notNull().default(sql`'{}'::jsonb`),
    /** The conversation, for resumption and for showing the client what they told us. */
    transcript: jsonb('transcript').notNull().default(sql`'[]'::jsonb`),
    resultingProfileId: uuid('resulting_profile_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('intake_sessions_client_idx').on(t.clientId, t.status)],
);

/**
 * Uploaded grounding material — logos, past ads, posters, style guides, brand videos.
 * Used as context for generation regardless of industry.
 */
export const referenceAssets = pgTable(
  'reference_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    kind: assetKindEnum('kind').notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    /** Where the bytes live. Local path or object-store key depending on deployment. */
    storageKey: text('storage_key').notNull(),
    /** Human note on how this should influence generation. */
    usageNote: text('usage_note'),
    /** Extracted text, for documents that can be read. Feeds the generation prompt. */
    extractedText: text('extracted_text'),
    /** Whether generation should treat this as grounding context. */
    active: boolean('active').notNull().default(true),
    uploadedBy: text('uploaded_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('reference_assets_client_idx').on(t.clientId, t.active),
    check('reference_assets_size_ck', sql`size_bytes >= 0`),
  ],
);

/**
 * Client-defined compliance rules, layered on top of the industry template.
 *
 * Template rules are NOT stored here — they live in the template files and are resolved at
 * evaluation time, so a template update reaches every deployment without a data migration.
 * This table holds only what the client added.
 */
export const complianceRules = pgTable(
  'compliance_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    /** Stable key used in findings; must not collide with a template rule id. */
    ruleKey: text('rule_key').notNull(),
    title: text('title').notNull(),
    severity: text('severity').notNull(),
    reason: text('reason').notNull(),
    appliesTo: jsonb('applies_to').notNull(),
    match: jsonb('match').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('compliance_rules_client_key').on(t.clientId, t.ruleKey),
    check('compliance_rules_severity_ck', sql`severity IN ('BLOCK', 'FLAG')`),
  ],
);

/** Template rules a client has switched off. Mandatory ones are refused at evaluation time. */
export const complianceRuleOverrides = pgTable(
  'compliance_rule_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    templateRuleId: text('template_rule_id').notNull(),
    disabled: boolean('disabled').notNull().default(true),
    justification: text('justification'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('compliance_overrides_client_rule_key').on(t.clientId, t.templateRuleId)],
);

/**
 * Generated creative awaiting a human, with its compliance verdict attached.
 *
 * Nothing reaches a campaign without passing through here. A BLOCKED row cannot be approved;
 * it must be edited or discarded, which is what makes the compliance layer more than advisory.
 */
export const creativeReviews = pgTable(
  'creative_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    brandProfileId: uuid('brand_profile_id')
      .notNull()
      .references(() => brandProfiles.id, { onDelete: 'restrict' }),
    campaignBriefId: uuid('campaign_brief_id'),

    status: reviewStatusEnum('status').notNull().default('PENDING_REVIEW'),

    angleTag: text('angle_tag').notNull(),
    hookType: text('hook_type'),
    headline: text('headline').notNull(),
    primaryText: text('primary_text').notNull(),
    cta: text('cta').notNull(),
    imageConcept: text('image_concept'),
    imageAssetId: uuid('image_asset_id'),
    generationReasoning: text('generation_reasoning'),

    /** Full verdict: findings, rules applied, template chain. */
    complianceVerdict: jsonb('compliance_verdict').notNull(),
    /** Convenience mirror of the verdict, so the queue can filter without parsing JSON. */
    complianceBlocked: boolean('compliance_blocked').notNull(),

    /** Set when a human edited the copy before approving. */
    editedBy: text('edited_by'),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),

    /**
     * Set once this approved item has been turned into a live ad set + ad on a platform.
     * Nullable rather than a status value, because "launched" is orthogonal to the review
     * verdict — an APPROVED item may sit unlaunched for a while, and the compliance history
     * (status/reviewedBy/reviewedAt) must stay intact regardless of launch state.
     */
    launchedAt: timestamp('launched_at', { withTimezone: true }),
    launchedVariantId: uuid('launched_variant_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('creative_reviews_client_status_idx').on(t.clientId, t.status),
    // A blocked item may never sit in an approved state. The gate is enforced by the database,
    // not only by the code path that writes it.
    check(
      'creative_reviews_blocked_not_approved_ck',
      sql`NOT (compliance_blocked AND status = 'APPROVED')`,
    ),
    check(
      'creative_reviews_approved_ck',
      sql`status <> 'APPROVED' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)`,
    ),
    // Only an approved item can ever be launched.
    check(
      'creative_reviews_launch_requires_approval_ck',
      sql`launched_at IS NULL OR status = 'APPROVED'`,
    ),
  ],
);

/**
 * What kind of campaign to run. Industry-neutral by default; the intake answers refine what
 * the generator does with it.
 */
export const campaignBriefs = pgTable(
  'campaign_briefs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    brandProfileId: uuid('brand_profile_id')
      .notNull()
      .references(() => brandProfiles.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** awareness | conversion | retargeting | launch | seasonal */
    campaignType: text('campaign_type').notNull(),
    /** Platform + format pairs, e.g. [{platform:"META", formats:["FEED_1_1"]}]. */
    placements: jsonb('placements').notNull(),
    /** Overrides the brand tone for this campaign only. Null means inherit. */
    toneOverride: text('tone_override'),
    /** Extra direction for this campaign only. */
    briefNotes: text('brief_notes'),
    landingPageUrl: text('landing_page_url').notNull(),
    variantCount: integer('variant_count').notNull().default(4),
    dailyBudgetPerVariantCents: bigint('daily_budget_per_variant_cents', { mode: 'number' }).notNull(),
    createdBy: text('created_by').notNull(),

    /**
     * Set on the first successful launch of any review under this brief. A second launch
     * (more approved creative added later) reuses the same campaign and cohort rather than
     * creating a parallel test — the brief is one test, launched in one or more batches.
     */
    launchedCampaignId: uuid('launched_campaign_id'),
    launchedCohortId: uuid('launched_cohort_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('campaign_briefs_client_idx').on(t.clientId),
    check(
      'campaign_briefs_type_ck',
      sql`campaign_type IN ('awareness', 'conversion', 'retargeting', 'launch', 'seasonal')`,
    ),
    check('campaign_briefs_variants_ck', sql`variant_count BETWEEN 1 AND 20`),
  ],
);

export const brandKits = pgTable(
  'brand_kits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    palette: jsonb('palette').notNull(),
    fonts: jsonb('fonts').notNull(),
    tone: text('tone').notNull(),
    logoAssetId: uuid('logo_asset_id'),
    /** Enforced at generation time, not filtered afterwards. */
    bannedWords: jsonb('banned_words').notNull().default(sql`'[]'::jsonb`),
    bannedClaims: jsonb('banned_claims').notNull().default(sql`'[]'::jsonb`),
    requiredDisclaimers: jsonb('required_disclaimers').notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('brand_kits_client_version_key').on(t.clientId, t.version)],
);

// ---------------------------------------------------------------------------
// Dashboard authentication
//
// Single-tenant by construction, but "single-tenant" describes the client data model, not
// who may act on it — the dashboard controls real spend and guardrail limits, so it needs
// real accounts. Passwords are scrypt-hashed (salt embedded in the stored string, standard
// library only). Sessions are opaque server-side tokens, not JWTs: revocation has to be
// immediate (an offboarded admin's session must die the moment it is revoked), which a
// self-verifying token cannot do without an additional denylist that is just this table
// by another name.
// ---------------------------------------------------------------------------

export const adminRoleEnum = pgEnum('admin_role', ['ADMIN']);

export const adminUsers = pgTable(
  'admin_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    /** scrypt: `${saltHex}:${hashHex}`. Never a plaintext password, never reversible. */
    passwordHash: text('password_hash').notNull(),
    role: adminRoleEnum('role').notNull().default('ADMIN'),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('admin_users_email_key').on(t.email)],
);

// ---------------------------------------------------------------------------
// Platform mutation ledger
//
// Meta (and most real ad platforms) has no notion of a client-supplied idempotency key on
// its mutating endpoints — unlike the deterministic mock, a real adapter cannot just keep an
// in-memory map, because that map has to survive a process crash to be any use at all. This
// table is the durable version of that map: a real adapter writes one row here immediately
// after a mutation is confirmed applied, and `findPriorAttempt` reads it back. It is
// deliberately generic across platforms rather than Meta-specific, since any future adapter
// without native idempotency needs exactly the same thing.
//
// This closes the double-execution gap for the ordinary case (a crash before the caller's own
// `platform_actions` row is marked complete). It does not close the much narrower window
// between "the platform confirmed the mutation" and "this row is committed" — a crash exactly
// there is indistinguishable from a mutation that never applied, and is handled the same way
// the rest of this system handles any unresolvable outcome: parked as a dead letter for a
// human, never guessed at.
// ---------------------------------------------------------------------------

export const platformMutationLedger = pgTable(
  'platform_mutation_ledger',
  {
    idempotencyKey: text('idempotency_key').primaryKey(),
    platform: platformEnum('platform').notNull(),
    method: text('method').notNull(),
    platformEntityId: text('platform_entity_id'),
    resultJson: jsonb('result_json').notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('platform_mutation_ledger_platform_idx').on(t.platform)],
);

export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    /** SHA-256 of the bearer token in the cookie. The raw token is never stored. */
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent'),
  },
  (t) => [
    uniqueIndex('admin_sessions_token_hash_key').on(t.tokenHash),
    index('admin_sessions_user_idx').on(t.userId),
  ],
);
