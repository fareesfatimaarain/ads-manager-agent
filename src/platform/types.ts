/**
 * The PlatformAdapter contract.
 *
 * Everything platform-specific — field names, rate limits, auth refresh, pagination, the
 * fact that Meta wants budgets in account-currency minor units while another platform wants
 * micros — lives behind this boundary. Nothing above it may branch on `platform`.
 *
 * Two contract rules exist specifically to prevent double-spend:
 *
 *  1. **Budget updates are absolute, never relative.** `updateBudget` takes a target value,
 *     not a delta. A delta applied twice by a retry doubles the increase; an absolute value
 *     applied twice is a no-op. The decision engine computes the target; the adapter sets it.
 *
 *  2. **Every mutation carries an idempotency key and an expected current state.** Where a
 *     platform supports idempotency natively, the adapter forwards the key. Where it does
 *     not, the adapter MUST reconcile — read current state and detect whether a prior attempt
 *     already landed — before issuing a retry.
 */
import type { PlatformError } from './errors.js';

export type Platform = 'META' | 'GOOGLE' | 'TIKTOK' | 'MOCK';

/** Per-call context. Credentials are resolved by the caller and never read from the DB here. */
export interface AdapterContext {
  readonly adAccountId: string;
  readonly platformAccountId: string;
  readonly accessToken: string;
  readonly currency: string;
  readonly timezone: string;
  /** Abort signal so a hung platform call cannot stall a decision cycle indefinitely. */
  readonly signal?: AbortSignal;
  /**
   * Platform-specific, non-secret settings that don't fit the generic contract above — a Meta
   * pixel ID, a Facebook Page ID, a Google Ads customer ID. Optional and adapter-defined; the
   * mock and the decision engine never read it. Populated from `adAccounts.platformConfig`.
   */
  readonly platformConfig?: Record<string, unknown> | null;
}

/** Platform-neutral targeting. Adapters translate; the decision engine never inspects this. */
export interface TargetingSpec {
  readonly countries: readonly string[];
  readonly ageMin?: number;
  readonly ageMax?: number;
  readonly interests?: readonly string[];
  readonly customAudienceIds?: readonly string[];
  readonly excludedAudienceIds?: readonly string[];
  readonly placements?: readonly string[];
}

export interface CreateCampaignRequest {
  readonly idempotencyKey: string;
  readonly name: string;
  readonly objective: 'CONVERSIONS' | 'TRAFFIC' | 'AWARENESS';
  readonly dailyBudgetCents?: number;
  readonly startPaused: boolean;
}

export interface CreateAdSetRequest {
  readonly idempotencyKey: string;
  readonly platformCampaignId: string;
  readonly name: string;
  readonly dailyBudgetCents: number;
  readonly targeting: TargetingSpec;
  readonly startPaused: boolean;
}

export interface CreateAdRequest {
  readonly idempotencyKey: string;
  readonly platformAdSetId: string;
  readonly name: string;
  readonly headline: string;
  readonly primaryText: string;
  readonly cta: string;
  readonly imageUrl?: string;
  readonly videoUrl?: string;
  readonly landingPageUrl: string;
  readonly startPaused: boolean;
}

export interface UpdateBudgetRequest {
  readonly idempotencyKey: string;
  readonly platformAdSetId: string;
  /**
   * ABSOLUTE target daily budget in account-currency minor units. Not a delta. See the
   * contract note above — this is the single most important field in the interface.
   */
  readonly targetDailyBudgetCents: number;
  /**
   * What the engine believed the budget was when it made this decision. Adapters MUST
   * compare and throw PlatformPreconditionFailedError on mismatch. This is what stops the
   * system from stomping a change a human made in the platform UI five minutes ago.
   */
  readonly expectedCurrentDailyBudgetCents: number;
}

export interface PauseRequest {
  readonly idempotencyKey: string;
  readonly platformEntityId: string;
  readonly entityType: 'AD' | 'AD_SET' | 'CAMPAIGN';
}

export interface EntityRef {
  readonly platformId: string;
  readonly platform: Platform;
}

export interface BudgetUpdateResult {
  readonly platformAdSetId: string;
  readonly previousDailyBudgetCents: number;
  readonly newDailyBudgetCents: number;
  /** True when the adapter detected the change had already been applied by a prior attempt. */
  readonly wasAlreadyApplied: boolean;
}

export interface PauseResult {
  readonly platformEntityId: string;
  readonly wasAlreadyPaused: boolean;
}

/** One day of metrics for one ad, already normalised to internal units. */
export interface PerformanceRow {
  readonly platformAdId: string;
  /** ISO date (YYYY-MM-DD) in the ad account's timezone. */
  readonly statDate: string;
  readonly impressions: number;
  readonly clicks: number;
  readonly spendCents: number;
  readonly conversions: number;
  readonly conversionValueCents: number;
  readonly currency: string;
  /** Verbatim platform payload, retained for dispute resolution. */
  readonly raw?: unknown;
}

export interface PerformanceQuery {
  readonly platformAdIds: readonly string[];
  /** Inclusive ISO date range in account timezone. */
  readonly since: string;
  readonly until: string;
}

export interface AccountStatus {
  readonly platformAccountId: string;
  readonly isActive: boolean;
  readonly isSpendCapped: boolean;
  readonly currency: string;
  readonly timezone: string;
  /** Platform-imposed daily spend cap, if any. Guardrails must respect this as an upper bound. */
  readonly platformDailySpendCapCents: number | null;
  readonly disabledReason: string | null;
}

/** What a prior attempt with the same idempotency key did, if anything. */
export interface PriorAttempt {
  readonly found: boolean;
  readonly platformEntityId: string | null;
  readonly appliedAt: string | null;
}

export interface PlatformAdapter {
  readonly platform: Platform;

  createCampaign(req: CreateCampaignRequest, ctx: AdapterContext): Promise<EntityRef>;
  createAdSet(req: CreateAdSetRequest, ctx: AdapterContext): Promise<EntityRef>;
  createAd(req: CreateAdRequest, ctx: AdapterContext): Promise<EntityRef>;

  updateBudget(req: UpdateBudgetRequest, ctx: AdapterContext): Promise<BudgetUpdateResult>;
  pauseAd(req: PauseRequest, ctx: AdapterContext): Promise<PauseResult>;

  getPerformanceData(query: PerformanceQuery, ctx: AdapterContext): Promise<PerformanceRow[]>;
  getAccountStatus(ctx: AdapterContext): Promise<AccountStatus>;

  /** Current live daily budget, used to verify preconditions before a scale. */
  getAdSetBudget(platformAdSetId: string, ctx: AdapterContext): Promise<number>;

  /**
   * Reconciliation hook for retry safety. Called BEFORE re-attempting a mutation whose
   * outcome is unknown. Adapters for platforms without native idempotency must implement
   * this by inspecting platform state; returning `{ found: false }` blindly would defeat the
   * entire double-execution guarantee.
   */
  findPriorAttempt(idempotencyKey: string, ctx: AdapterContext): Promise<PriorAttempt>;
}

/** Narrowed view handed to read-only paths, so an ingestion job cannot mutate anything. */
export type ReadOnlyPlatformAdapter = Pick<
  PlatformAdapter,
  'platform' | 'getPerformanceData' | 'getAccountStatus' | 'getAdSetBudget'
>;

export type { PlatformError };
