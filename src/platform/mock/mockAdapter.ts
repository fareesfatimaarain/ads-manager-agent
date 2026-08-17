/**
 * Deterministic in-memory platform adapter.
 *
 * This is the reference implementation the decision engine is built and proven against,
 * before any live credential exists. It is deliberately more adversarial than a real
 * platform: it can simulate attribution lag, lost responses on applied mutations, rate
 * limits, and concurrent human edits — the situations that actually cause double-spend.
 *
 * Determinism contract: given the same seed, the same scenario and the same call sequence,
 * every number produced here is identical across runs and machines. Tests that assert on
 * money must never be flaky.
 */
import {
  PlatformConflictError,
  PlatformNotFoundError,
  PlatformPreconditionFailedError,
  PlatformRateLimitError,
  PlatformTransientError,
} from '../errors.js';
import type {
  AccountStatus,
  AdapterContext,
  BudgetUpdateResult,
  CreateAdRequest,
  CreateAdSetRequest,
  CreateCampaignRequest,
  EntityRef,
  PauseRequest,
  PauseResult,
  PerformanceQuery,
  PerformanceRow,
  PlatformAdapter,
  PriorAttempt,
  UpdateBudgetRequest,
} from '../types.js';

// ---------------------------------------------------------------------------
// Deterministic pseudo-randomness
// ---------------------------------------------------------------------------

function hashString(input: string): number {
  // FNV-1a, 32-bit.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic binomial draw. Exact for small n, normal-approximated for large n. */
function binomial(n: number, p: number, rand: () => number): number {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  if (n <= 1000) {
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (rand() < p) k++;
    }
    return k;
  }
  const mean = n * p;
  const sd = Math.sqrt(n * p * (1 - p));
  // Box-Muller from two uniforms.
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(0, Math.min(n, Math.round(mean + sd * z)));
}

// ---------------------------------------------------------------------------
// Scenario definition
// ---------------------------------------------------------------------------

export interface MockVariantProfile {
  readonly platformAdId: string;
  /** Ground-truth click-through rate. Tests assert the engine recovers the ordering. */
  readonly trueCtr: number;
  /** Ground-truth conversion rate, conditional on a click. */
  readonly trueCvr: number;
  readonly avgOrderValueCents: number;
  /** Impressions purchased per dollar of budget. Controls how fast samples accumulate. */
  readonly impressionsPerDollar: number;
}

export type MockFailureMode =
  | 'OK'
  /** Retryable 5xx. Nothing applied. */
  | 'TRANSIENT'
  /** Rate limited. Nothing applied. */
  | 'RATE_LIMIT'
  /**
   * The mutation IS applied but the response is lost. This is the scenario that produces
   * double-spend in naive systems: the caller sees a timeout and retries a mutation that
   * already succeeded.
   */
  | 'APPLIED_THEN_LOST_RESPONSE';

export interface MockScenario {
  readonly seed: number;
  readonly variants: readonly MockVariantProfile[];
  /**
   * Fraction of a day's true conversions visible when queried at N hours past end-of-day.
   * Models attribution settling. Defaults approximate Meta's observed behaviour.
   */
  readonly attributionCurve?: ReadonlyArray<{ hoursAfterDayEnd: number; visibleFraction: number }>;
  /** Per-method queue of failure modes, consumed one per call. */
  readonly failureScript?: Readonly<Partial<Record<string, readonly MockFailureMode[]>>>;
  readonly accountStatus?: Partial<AccountStatus>;
}

const DEFAULT_ATTRIBUTION_CURVE = [
  { hoursAfterDayEnd: 0, visibleFraction: 0.6 },
  { hoursAfterDayEnd: 24, visibleFraction: 0.85 },
  { hoursAfterDayEnd: 48, visibleFraction: 0.95 },
  { hoursAfterDayEnd: 72, visibleFraction: 1.0 },
] as const;

interface BudgetInterval {
  readonly fromDate: string;
  readonly dailyBudgetCents: number;
}

interface MockAdSetState {
  platformAdSetId: string;
  platformCampaignId: string;
  dailyBudgetCents: number;
  budgetHistory: BudgetInterval[];
  paused: boolean;
}

interface MockAdState {
  platformAdId: string;
  platformAdSetId: string;
  paused: boolean;
  createdOnDate: string;
}

interface IdempotencyRecord {
  readonly method: string;
  readonly payloadFingerprint: string;
  readonly result: unknown;
  readonly appliedAt: string;
  readonly platformEntityId: string | null;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class MockPlatformAdapter implements PlatformAdapter {
  readonly platform = 'MOCK' as const;

  private readonly adSets = new Map<string, MockAdSetState>();
  private readonly ads = new Map<string, MockAdState>();
  private readonly campaigns = new Set<string>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly failureCursor = new Map<string, number>();
  private readonly variants = new Map<string, MockVariantProfile>();
  private sequence = 0;

  /** Virtual clock. Tests advance this rather than waiting. */
  private now: Date;

  constructor(
    private readonly scenario: MockScenario,
    startTime: Date = new Date('2026-01-01T00:00:00Z'),
  ) {
    this.now = new Date(startTime);
    for (const v of scenario.variants) {
      this.variants.set(v.platformAdId, v);
    }
  }

  // --- test controls -------------------------------------------------------

  setNow(t: Date): void {
    this.now = new Date(t);
  }

  advanceHours(hours: number): void {
    this.now = new Date(this.now.getTime() + hours * 3_600_000);
  }

  getNow(): Date {
    return new Date(this.now);
  }

  /** Simulates a human editing a budget directly in the platform UI. */
  externallySetBudget(platformAdSetId: string, cents: number): void {
    const adSet = this.adSets.get(platformAdSetId);
    if (!adSet) throw new Error(`unknown ad set ${platformAdSetId}`);
    adSet.dailyBudgetCents = cents;
    adSet.budgetHistory.push({ fromDate: this.isoDate(this.now), dailyBudgetCents: cents });
  }

  /** Registers an ad set without going through createAdSet, for test fixtures. */
  seedAdSet(platformAdSetId: string, dailyBudgetCents: number, fromDate: string): void {
    this.adSets.set(platformAdSetId, {
      platformAdSetId,
      platformCampaignId: 'camp_seeded',
      dailyBudgetCents,
      budgetHistory: [{ fromDate, dailyBudgetCents }],
      paused: false,
    });
  }

  seedAd(platformAdId: string, platformAdSetId: string, createdOnDate: string): void {
    this.ads.set(platformAdId, {
      platformAdId,
      platformAdSetId,
      paused: false,
      createdOnDate,
    });
  }

  isPaused(platformEntityId: string): boolean {
    return (
      this.ads.get(platformEntityId)?.paused ?? this.adSets.get(platformEntityId)?.paused ?? false
    );
  }

  currentBudget(platformAdSetId: string): number {
    const adSet = this.adSets.get(platformAdSetId);
    if (!adSet) throw new Error(`unknown ad set ${platformAdSetId}`);
    return adSet.dailyBudgetCents;
  }

  /** Number of times a mutation actually applied. Tests assert this is exactly 1 on retry. */
  appliedMutationCount(idempotencyKey: string): number {
    return this.idempotency.has(idempotencyKey) ? 1 : 0;
  }

  // --- failure injection ---------------------------------------------------

  private nextFailureMode(method: string): MockFailureMode {
    const script = this.scenario.failureScript?.[method];
    if (!script || script.length === 0) return 'OK';
    const cursor = this.failureCursor.get(method) ?? 0;
    this.failureCursor.set(method, cursor + 1);
    return script[cursor] ?? 'OK';
  }

  private throwFor(mode: MockFailureMode, method: string, idempotencyKey?: string): void {
    const context = { platform: 'MOCK', method, ...(idempotencyKey ? { idempotencyKey } : {}) };
    if (mode === 'TRANSIENT') {
      throw new PlatformTransientError('mock transient failure', context);
    }
    if (mode === 'RATE_LIMIT') {
      throw new PlatformRateLimitError('mock rate limit', context, 1000);
    }
  }

  // --- idempotency ---------------------------------------------------------

  private fingerprint(payload: unknown): string {
    return JSON.stringify(payload, Object.keys(payload as object).sort());
  }

  /**
   * Returns a cached result when this exact key+payload already ran. Throws on a key reused
   * with a DIFFERENT payload, which indicates a caller bug serious enough that continuing
   * would be worse than failing.
   */
  private checkIdempotency<T>(key: string, method: string, payload: unknown): T | null {
    const existing = this.idempotency.get(key);
    if (!existing) return null;
    const fp = this.fingerprint(payload);
    if (existing.payloadFingerprint !== fp) {
      throw new PlatformConflictError(
        `idempotency key ${key} was already used with a different payload`,
        { platform: 'MOCK', method, idempotencyKey: key },
      );
    }
    return existing.result as T;
  }

  private recordIdempotency(
    key: string,
    method: string,
    payload: unknown,
    result: unknown,
    platformEntityId: string | null,
  ): void {
    this.idempotency.set(key, {
      method,
      payloadFingerprint: this.fingerprint(payload),
      result,
      appliedAt: this.now.toISOString(),
      platformEntityId,
    });
  }

  async findPriorAttempt(idempotencyKey: string, _ctx: AdapterContext): Promise<PriorAttempt> {
    const record = this.idempotency.get(idempotencyKey);
    if (!record) return { found: false, platformEntityId: null, appliedAt: null };
    return {
      found: true,
      platformEntityId: record.platformEntityId,
      appliedAt: record.appliedAt,
    };
  }

  // --- mutations -----------------------------------------------------------

  async createCampaign(req: CreateCampaignRequest, _ctx: AdapterContext): Promise<EntityRef> {
    const cached = this.checkIdempotency<EntityRef>(req.idempotencyKey, 'createCampaign', req);
    if (cached) return cached;
    this.throwFor(this.nextFailureMode('createCampaign'), 'createCampaign', req.idempotencyKey);

    const id = `camp_${++this.sequence}`;
    this.campaigns.add(id);
    const result: EntityRef = { platformId: id, platform: 'MOCK' };
    this.recordIdempotency(req.idempotencyKey, 'createCampaign', req, result, id);
    return result;
  }

  async createAdSet(req: CreateAdSetRequest, _ctx: AdapterContext): Promise<EntityRef> {
    const cached = this.checkIdempotency<EntityRef>(req.idempotencyKey, 'createAdSet', req);
    if (cached) return cached;
    this.throwFor(this.nextFailureMode('createAdSet'), 'createAdSet', req.idempotencyKey);

    const id = `adset_${++this.sequence}`;
    this.adSets.set(id, {
      platformAdSetId: id,
      platformCampaignId: req.platformCampaignId,
      dailyBudgetCents: req.dailyBudgetCents,
      budgetHistory: [
        { fromDate: this.isoDate(this.now), dailyBudgetCents: req.dailyBudgetCents },
      ],
      paused: req.startPaused,
    });
    const result: EntityRef = { platformId: id, platform: 'MOCK' };
    this.recordIdempotency(req.idempotencyKey, 'createAdSet', req, result, id);
    return result;
  }

  async createAd(req: CreateAdRequest, _ctx: AdapterContext): Promise<EntityRef> {
    const cached = this.checkIdempotency<EntityRef>(req.idempotencyKey, 'createAd', req);
    if (cached) return cached;
    this.throwFor(this.nextFailureMode('createAd'), 'createAd', req.idempotencyKey);

    const id = `ad_${++this.sequence}`;
    this.ads.set(id, {
      platformAdId: id,
      platformAdSetId: req.platformAdSetId,
      paused: req.startPaused,
      createdOnDate: this.isoDate(this.now),
    });
    const result: EntityRef = { platformId: id, platform: 'MOCK' };
    this.recordIdempotency(req.idempotencyKey, 'createAd', req, result, id);
    return result;
  }

  async updateBudget(req: UpdateBudgetRequest, _ctx: AdapterContext): Promise<BudgetUpdateResult> {
    const cached = this.checkIdempotency<BudgetUpdateResult>(
      req.idempotencyKey,
      'updateBudget',
      req,
    );
    if (cached) {
      return { ...cached, wasAlreadyApplied: true };
    }

    const adSet = this.adSets.get(req.platformAdSetId);
    if (!adSet) {
      throw new PlatformNotFoundError(`unknown ad set ${req.platformAdSetId}`, {
        platform: 'MOCK',
        method: 'updateBudget',
        idempotencyKey: req.idempotencyKey,
      });
    }

    // Optimistic concurrency: refuse if the live value drifted from what the decision assumed.
    if (adSet.dailyBudgetCents !== req.expectedCurrentDailyBudgetCents) {
      throw new PlatformPreconditionFailedError(
        `budget precondition failed: expected ${req.expectedCurrentDailyBudgetCents}, found ${adSet.dailyBudgetCents}`,
        { platform: 'MOCK', method: 'updateBudget', idempotencyKey: req.idempotencyKey },
      );
    }

    const mode = this.nextFailureMode('updateBudget');
    this.throwFor(mode, 'updateBudget', req.idempotencyKey);

    const previous = adSet.dailyBudgetCents;
    adSet.dailyBudgetCents = req.targetDailyBudgetCents;
    adSet.budgetHistory.push({
      fromDate: this.isoDate(this.now),
      dailyBudgetCents: req.targetDailyBudgetCents,
    });

    const result: BudgetUpdateResult = {
      platformAdSetId: req.platformAdSetId,
      previousDailyBudgetCents: previous,
      newDailyBudgetCents: req.targetDailyBudgetCents,
      wasAlreadyApplied: false,
    };
    this.recordIdempotency(req.idempotencyKey, 'updateBudget', req, result, req.platformAdSetId);

    // The mutation is now durably applied. Losing the response here is exactly the
    // double-execution trap the caller must survive.
    if (mode === 'APPLIED_THEN_LOST_RESPONSE') {
      throw new PlatformTransientError('mock: response lost after mutation applied', {
        platform: 'MOCK',
        method: 'updateBudget',
        idempotencyKey: req.idempotencyKey,
      });
    }

    return result;
  }

  async pauseAd(req: PauseRequest, _ctx: AdapterContext): Promise<PauseResult> {
    const cached = this.checkIdempotency<PauseResult>(req.idempotencyKey, 'pauseAd', req);
    if (cached) return { ...cached, wasAlreadyPaused: true };

    const mode = this.nextFailureMode('pauseAd');
    this.throwFor(mode, 'pauseAd', req.idempotencyKey);

    const ad = this.ads.get(req.platformEntityId);
    const adSet = this.adSets.get(req.platformEntityId);
    if (!ad && !adSet) {
      throw new PlatformNotFoundError(`unknown entity ${req.platformEntityId}`, {
        platform: 'MOCK',
        method: 'pauseAd',
        idempotencyKey: req.idempotencyKey,
      });
    }

    const wasAlreadyPaused = ad ? ad.paused : adSet!.paused;
    if (ad) ad.paused = true;
    if (adSet) adSet.paused = true;

    const result: PauseResult = { platformEntityId: req.platformEntityId, wasAlreadyPaused };
    this.recordIdempotency(req.idempotencyKey, 'pauseAd', req, result, req.platformEntityId);

    if (mode === 'APPLIED_THEN_LOST_RESPONSE') {
      throw new PlatformTransientError('mock: response lost after pause applied', {
        platform: 'MOCK',
        method: 'pauseAd',
        idempotencyKey: req.idempotencyKey,
      });
    }
    return result;
  }

  // --- reads ---------------------------------------------------------------

  async getAdSetBudget(platformAdSetId: string, _ctx: AdapterContext): Promise<number> {
    const adSet = this.adSets.get(platformAdSetId);
    if (!adSet) {
      throw new PlatformNotFoundError(`unknown ad set ${platformAdSetId}`, {
        platform: 'MOCK',
        method: 'getAdSetBudget',
      });
    }
    return adSet.dailyBudgetCents;
  }

  async getAccountStatus(ctx: AdapterContext): Promise<AccountStatus> {
    this.throwFor(this.nextFailureMode('getAccountStatus'), 'getAccountStatus');
    return {
      platformAccountId: ctx.platformAccountId,
      isActive: true,
      isSpendCapped: false,
      currency: ctx.currency,
      timezone: ctx.timezone,
      platformDailySpendCapCents: null,
      disabledReason: null,
      ...this.scenario.accountStatus,
    };
  }

  async getPerformanceData(
    query: PerformanceQuery,
    ctx: AdapterContext,
  ): Promise<PerformanceRow[]> {
    this.throwFor(this.nextFailureMode('getPerformanceData'), 'getPerformanceData');

    const rows: PerformanceRow[] = [];
    for (const adId of query.platformAdIds) {
      const ad = this.ads.get(adId);
      const profile = this.variants.get(adId);
      if (!ad || !profile) continue;

      for (const date of this.dateRange(query.since, query.until)) {
        if (date < ad.createdOnDate) continue;
        // A paused ad stops accruing from the day it was paused onward. The mock has no
        // intra-day resolution, so "paused" simply truncates future days.
        if (ad.paused && date > this.isoDate(this.now)) continue;
        const row = this.generateRow(ad, profile, date, ctx.currency);
        if (row) rows.push(row);
      }
    }
    return rows;
  }

  // --- generation ----------------------------------------------------------

  private generateRow(
    ad: MockAdState,
    profile: MockVariantProfile,
    date: string,
    currency: string,
  ): PerformanceRow | null {
    const budgetCents = this.budgetOnDate(ad.platformAdSetId, date);
    if (budgetCents <= 0) return null;

    const rand = mulberry32(hashString(`${this.scenario.seed}|${ad.platformAdId}|${date}`));

    // Delivery is imperfect: spend lands between 90% and 100% of budget.
    const deliveryRatio = 0.9 + rand() * 0.1;
    const spendCents = Math.round(budgetCents * deliveryRatio);
    const impressions = Math.max(
      0,
      Math.round((spendCents / 100) * profile.impressionsPerDollar),
    );

    const clicks = binomial(impressions, profile.trueCtr, rand);
    const trueConversions = binomial(clicks, profile.trueCvr, rand);

    // Attribution settling: recent days under-report.
    const visible = this.visibleFraction(date);
    const conversions = Math.floor(trueConversions * visible);
    const conversionValueCents = conversions * profile.avgOrderValueCents;

    return {
      platformAdId: ad.platformAdId,
      statDate: date,
      impressions,
      clicks,
      spendCents,
      conversions,
      conversionValueCents,
      currency,
      raw: { mock: true, trueConversions, visibleFraction: visible },
    };
  }

  /** Fraction of a day's conversions currently visible, per the attribution curve. */
  private visibleFraction(date: string): number {
    const curve = this.scenario.attributionCurve ?? DEFAULT_ATTRIBUTION_CURVE;
    const dayEnd = new Date(`${date}T00:00:00Z`).getTime() + 24 * 3_600_000;
    const hoursSince = (this.now.getTime() - dayEnd) / 3_600_000;
    if (hoursSince < 0) {
      // Mid-day: scale the first curve point by how much of the day has elapsed.
      const elapsed = Math.max(0, 24 + hoursSince) / 24;
      return (curve[0]?.visibleFraction ?? 1) * elapsed;
    }
    let fraction = curve[0]?.visibleFraction ?? 1;
    for (const point of curve) {
      if (hoursSince >= point.hoursAfterDayEnd) fraction = point.visibleFraction;
    }
    return fraction;
  }

  private budgetOnDate(platformAdSetId: string, date: string): number {
    const adSet = this.adSets.get(platformAdSetId);
    if (!adSet) return 0;
    let budget = 0;
    for (const interval of adSet.budgetHistory) {
      if (interval.fromDate <= date) budget = interval.dailyBudgetCents;
    }
    return budget;
  }

  private isoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  private *dateRange(since: string, until: string): Generator<string> {
    const start = new Date(`${since}T00:00:00Z`);
    const end = new Date(`${until}T00:00:00Z`);
    for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
      yield new Date(t).toISOString().slice(0, 10);
    }
  }
}
