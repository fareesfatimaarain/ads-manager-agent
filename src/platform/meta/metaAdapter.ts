/**
 * Meta Marketing API adapter.
 *
 * IMPORTANT — status: implemented against Meta's documented Graph API shapes (v21.0), but this
 * repository has no live Meta app or ad account to test against. Everything here should be
 * run once against a real Meta sandbox account, with a trivial budget, and checked by a human
 * before it is trusted with real spend. Treat the request/response shaping as reviewed, not
 * verified.
 *
 * Two pieces of Meta-specific configuration have no other home in this codebase's data model
 * and must be supplied via `adAccounts.platformConfig` before launching anything for real:
 *   - `metaPixelId` — required for conversion-optimised ad sets (the only kind this system
 *     creates). Ad set creation fails with a clear PlatformValidationError if it is missing,
 *     rather than silently creating an ad set that cannot optimise for conversions.
 *   - `metaPageId` — the Facebook Page an ad is posted from. Required for every ad creative.
 * Both are account settings, not secrets, which is why they live in `platformConfig` rather
 * than the encrypted token columns.
 *
 * Idempotency: Meta has no client-supplied idempotency key on these endpoints. `updateBudget`
 * and `pauseAd` — the two mutations the executor can retry after a crash — are backed by
 * `platform_mutation_ledger` (see ledger.ts) so `findPriorAttempt` has something durable to
 * answer from. `createCampaign`/`createAdSet`/`createAd` are not: they run once inside
 * `launch.ts`, which fails the whole launch (not a silent partial state) if any step errors,
 * and a failed launch is simply retried as a new launch attempt.
 */
import type { Database } from '../../db/index.js';
import { env } from '../../config/env.js';
import {
  PlatformTransientError,
  PlatformValidationError,
} from '../errors.js';
import { budgetPreconditionError, classifyMetaError, type MetaGraphErrorBody } from './errors.js';
import { findApplied, recordApplied } from './ledger.js';
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
  TargetingSpec,
  UpdateBudgetRequest,
} from '../types.js';

const GRAPH_BASE = 'https://graph.facebook.com';

const OBJECTIVE_MAP: Record<CreateCampaignRequest['objective'], string> = {
  CONVERSIONS: 'OUTCOME_SALES',
  TRAFFIC: 'OUTCOME_TRAFFIC',
  AWARENESS: 'OUTCOME_AWARENESS',
};

/** Meta requires an enum CTA, not free text. Unrecognised copy falls back to LEARN_MORE — a
 *  cosmetic default, never a money-relevant one, so it degrades rather than blocking a launch. */
const CTA_MAP: Record<string, string> = {
  'shop now': 'SHOP_NOW',
  'buy now': 'SHOP_NOW',
  'learn more': 'LEARN_MORE',
  'sign up': 'SIGN_UP',
  'subscribe': 'SUBSCRIBE',
  'download': 'DOWNLOAD',
  'get quote': 'GET_QUOTE',
  'get offer': 'GET_OFFER',
  'book now': 'BOOK_TRAVEL',
  'contact us': 'CONTACT_US',
  'apply now': 'APPLY_NOW',
  'get started': 'GET_STARTED',
};

/** Meta account_status: 1 is the only value that means "can spend". */
const ACTIVE_ACCOUNT_STATUS = 1;

const DEFAULT_CONVERSION_ACTION_TYPES = [
  'omni_purchase',
  'offsite_conversion.fb_pixel_purchase',
  'purchase',
];

function ctaFor(text: string): string {
  return CTA_MAP[text.trim().toLowerCase()] ?? 'LEARN_MORE';
}

/** Meta wants form-encoded values; nested structures are passed as JSON strings. */
function encodeBody(fields: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    params.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return params;
}

function translateTargeting(spec: TargetingSpec): Record<string, unknown> {
  const targeting: Record<string, unknown> = {
    geo_locations: { countries: spec.countries },
  };
  if (spec.ageMin !== undefined) targeting.age_min = spec.ageMin;
  if (spec.ageMax !== undefined) targeting.age_max = spec.ageMax;
  if (spec.interests && spec.interests.length > 0) {
    // Meta's interest targeting needs numeric interest IDs resolved via the Targeting Search
    // endpoint, not free-text names. This system stores interests as plain strings (see
    // TargetingSpec), so passing them straight through here would be silently wrong.
    // Flagged rather than guessed: interest targeting is not wired end-to-end yet.
    throw new PlatformValidationError(
      'interest targeting requires resolving interest names to Meta targeting IDs first, ' +
        'which is not implemented — launch without interests, or resolve IDs upstream',
      { platform: 'META', method: 'translateTargeting' },
    );
  }
  if (spec.customAudienceIds && spec.customAudienceIds.length > 0) {
    targeting.custom_audiences = spec.customAudienceIds.map((id) => ({ id }));
  }
  if (spec.excludedAudienceIds && spec.excludedAudienceIds.length > 0) {
    targeting.excluded_custom_audiences = spec.excludedAudienceIds.map((id) => ({ id }));
  }
  return targeting;
}

interface ErrorContext {
  method: string;
  idempotencyKey?: string;
}

export class MetaPlatformAdapter implements PlatformAdapter {
  readonly platform = 'META' as const;

  constructor(
    private readonly db: Database,
    private readonly apiVersion: string = env.metaApiVersion,
    /** Overridable for tests; defaults to the platform's global fetch. */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    ctx: AdapterContext,
    errorCtx: ErrorContext,
    options: { body?: Record<string, unknown>; query?: Record<string, string> } = {},
  ): Promise<T> {
    const url = new URL(`${GRAPH_BASE}/${this.apiVersion}${path}`);
    url.searchParams.set('access_token', ctx.accessToken);
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) url.searchParams.set(k, v);
    }
    if (method === 'GET' && options.body) {
      for (const [k, v] of Object.entries(options.body)) {
        url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        ...(method === 'POST' && options.body
          ? {
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: encodeBody(options.body),
            }
          : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (networkError) {
      throw new PlatformTransientError(
        networkError instanceof Error ? networkError.message : 'network error calling Meta',
        { platform: 'META', ...errorCtx },
      );
    }

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      // A non-JSON body (proxy error page, etc.) — fall through to the status-code path below.
    }

    if (!response.ok) {
      throw classifyMetaError(response.status, parsed as MetaGraphErrorBody, {
        platform: 'META',
        ...errorCtx,
      });
    }
    return parsed as T;
  }

  private pixelId(ctx: AdapterContext, errorCtx: ErrorContext): string {
    const id = ctx.platformConfig?.metaPixelId;
    if (typeof id !== 'string' || id.length === 0) {
      throw new PlatformValidationError(
        'this ad account has no metaPixelId configured — set adAccounts.platformConfig.metaPixelId ' +
          'before launching a conversion campaign',
        { platform: 'META', ...errorCtx },
      );
    }
    return id;
  }

  private pageId(ctx: AdapterContext, errorCtx: ErrorContext): string {
    const id = ctx.platformConfig?.metaPageId;
    if (typeof id !== 'string' || id.length === 0) {
      throw new PlatformValidationError(
        'this ad account has no metaPageId configured — set adAccounts.platformConfig.metaPageId ' +
          'before creating an ad',
        { platform: 'META', ...errorCtx },
      );
    }
    return id;
  }

  private conversionActionTypes(ctx: AdapterContext): string[] {
    const configured = ctx.platformConfig?.metaConversionActionTypes;
    return Array.isArray(configured) && configured.every((t) => typeof t === 'string')
      ? (configured as string[])
      : DEFAULT_CONVERSION_ACTION_TYPES;
  }

  // --- mutations -------------------------------------------------------------

  async createCampaign(req: CreateCampaignRequest, ctx: AdapterContext): Promise<EntityRef> {
    const errorCtx = { method: 'createCampaign', idempotencyKey: req.idempotencyKey };
    const body = await this.call<{ id: string }>(
      'POST',
      `/act_${ctx.platformAccountId}/campaigns`,
      ctx,
      errorCtx,
      {
        body: {
          name: req.name,
          objective: OBJECTIVE_MAP[req.objective],
          status: req.startPaused ? 'PAUSED' : 'ACTIVE',
          special_ad_categories: [],
        },
      },
    );
    return { platformId: body.id, platform: 'META' };
  }

  async createAdSet(req: CreateAdSetRequest, ctx: AdapterContext): Promise<EntityRef> {
    const errorCtx = { method: 'createAdSet', idempotencyKey: req.idempotencyKey };
    const pixelId = this.pixelId(ctx, errorCtx);

    const body = await this.call<{ id: string }>(
      'POST',
      `/act_${ctx.platformAccountId}/adsets`,
      ctx,
      errorCtx,
      {
        body: {
          name: req.name,
          campaign_id: req.platformCampaignId,
          daily_budget: req.dailyBudgetCents,
          billing_event: 'IMPRESSIONS',
          optimization_goal: 'OFFSITE_CONVERSIONS',
          bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
          promoted_object: { pixel_id: pixelId, custom_event_type: 'PURCHASE' },
          targeting: translateTargeting(req.targeting),
          status: req.startPaused ? 'PAUSED' : 'ACTIVE',
        },
      },
    );
    return { platformId: body.id, platform: 'META' };
  }

  async createAd(req: CreateAdRequest, ctx: AdapterContext): Promise<EntityRef> {
    const errorCtx = { method: 'createAd', idempotencyKey: req.idempotencyKey };
    const pageId = this.pageId(ctx, errorCtx);

    // An Ad references a Creative object, which must exist first. See the file header note
    // on why a failure between these two calls is an accepted, non-monetary leak.
    const creative = await this.call<{ id: string }>(
      'POST',
      `/act_${ctx.platformAccountId}/adcreatives`,
      ctx,
      errorCtx,
      {
        body: {
          name: `${req.name} — creative`,
          object_story_spec: {
            page_id: pageId,
            link_data: {
              message: req.primaryText,
              name: req.headline,
              link: req.landingPageUrl,
              ...(req.imageUrl ? { picture: req.imageUrl } : {}),
              call_to_action: {
                type: ctaFor(req.cta),
                value: { link: req.landingPageUrl },
              },
            },
          },
        },
      },
    );

    const ad = await this.call<{ id: string }>(
      'POST',
      `/act_${ctx.platformAccountId}/ads`,
      ctx,
      errorCtx,
      {
        body: {
          name: req.name,
          adset_id: req.platformAdSetId,
          creative: { creative_id: creative.id },
          status: req.startPaused ? 'PAUSED' : 'ACTIVE',
        },
      },
    );
    return { platformId: ad.id, platform: 'META' };
  }

  async updateBudget(req: UpdateBudgetRequest, ctx: AdapterContext): Promise<BudgetUpdateResult> {
    const errorCtx = { method: 'updateBudget', idempotencyKey: req.idempotencyKey };

    const prior = await findApplied(this.db, req.idempotencyKey);
    if (prior.found) {
      return {
        platformAdSetId: req.platformAdSetId,
        previousDailyBudgetCents: req.expectedCurrentDailyBudgetCents,
        newDailyBudgetCents: req.targetDailyBudgetCents,
        wasAlreadyApplied: true,
      };
    }

    // Meta has no compare-and-swap. Read current state and compare ourselves before writing —
    // the same precondition the mock enforces, done as an explicit extra round trip here
    // because a real platform can't do it atomically with the write.
    const current = await this.call<{ daily_budget: string }>(
      'GET',
      `/${req.platformAdSetId}`,
      ctx,
      errorCtx,
      { query: { fields: 'daily_budget' } },
    );
    const currentCents = Number(current.daily_budget);
    if (currentCents !== req.expectedCurrentDailyBudgetCents) {
      throw budgetPreconditionError(req.expectedCurrentDailyBudgetCents, currentCents, {
        platform: 'META',
        ...errorCtx,
      });
    }

    await this.call<{ success: boolean }>('POST', `/${req.platformAdSetId}`, ctx, errorCtx, {
      body: { daily_budget: req.targetDailyBudgetCents },
    });

    const result: BudgetUpdateResult = {
      platformAdSetId: req.platformAdSetId,
      previousDailyBudgetCents: currentCents,
      newDailyBudgetCents: req.targetDailyBudgetCents,
      wasAlreadyApplied: false,
    };
    await recordApplied(
      this.db,
      'META',
      req.idempotencyKey,
      'updateBudget',
      req.platformAdSetId,
      result,
      new Date(),
    );
    return result;
  }

  async pauseAd(req: PauseRequest, ctx: AdapterContext): Promise<PauseResult> {
    const errorCtx = { method: 'pauseAd', idempotencyKey: req.idempotencyKey };

    const prior = await findApplied(this.db, req.idempotencyKey);
    if (prior.found) {
      return { platformEntityId: req.platformEntityId, wasAlreadyPaused: true };
    }

    const current = await this.call<{ effective_status?: string; status?: string }>(
      'GET',
      `/${req.platformEntityId}`,
      ctx,
      errorCtx,
      { query: { fields: 'effective_status' } },
    );
    const wasAlreadyPaused = (current.effective_status ?? current.status) === 'PAUSED';

    await this.call<{ success: boolean }>('POST', `/${req.platformEntityId}`, ctx, errorCtx, {
      body: { status: 'PAUSED' },
    });

    const result: PauseResult = { platformEntityId: req.platformEntityId, wasAlreadyPaused };
    await recordApplied(
      this.db,
      'META',
      req.idempotencyKey,
      'pauseAd',
      req.platformEntityId,
      result,
      new Date(),
    );
    return result;
  }

  async findPriorAttempt(idempotencyKey: string, _ctx: AdapterContext): Promise<PriorAttempt> {
    return findApplied(this.db, idempotencyKey);
  }

  // --- reads -------------------------------------------------------------

  async getAdSetBudget(platformAdSetId: string, ctx: AdapterContext): Promise<number> {
    const result = await this.call<{ daily_budget: string }>(
      'GET',
      `/${platformAdSetId}`,
      ctx,
      { method: 'getAdSetBudget' },
      { query: { fields: 'daily_budget' } },
    );
    return Number(result.daily_budget);
  }

  async getAccountStatus(ctx: AdapterContext): Promise<AccountStatus> {
    const result = await this.call<{
      account_status: number;
      disable_reason?: number;
      currency: string;
      timezone_name: string;
      spend_cap?: string;
    }>('GET', `/act_${ctx.platformAccountId}`, ctx, { method: 'getAccountStatus' }, {
      query: { fields: 'account_status,disable_reason,currency,timezone_name,spend_cap' },
    });

    return {
      platformAccountId: ctx.platformAccountId,
      isActive: result.account_status === ACTIVE_ACCOUNT_STATUS,
      isSpendCapped: false,
      currency: result.currency,
      timezone: result.timezone_name,
      platformDailySpendCapCents: result.spend_cap ? Number(result.spend_cap) : null,
      disabledReason:
        result.account_status !== ACTIVE_ACCOUNT_STATUS
          ? `account_status=${result.account_status}${result.disable_reason ? ` disable_reason=${result.disable_reason}` : ''}`
          : null,
    };
  }

  async getPerformanceData(query: PerformanceQuery, ctx: AdapterContext): Promise<PerformanceRow[]> {
    if (query.platformAdIds.length === 0) return [];
    const conversionTypes = new Set(this.conversionActionTypes(ctx));

    type InsightRow = {
      ad_id: string;
      date_start: string;
      impressions?: string;
      clicks?: string;
      spend?: string;
      actions?: { action_type: string; value: string }[];
      action_values?: { action_type: string; value: string }[];
    };

    const rows: PerformanceRow[] = [];
    let after: string | undefined;

    // Paginate until Meta stops returning a next cursor. A single decision cycle's date range
    // times variant count is small enough that this is a handful of pages at most.
    for (let page = 0; page < 50; page += 1) {
      const body = await this.call<{ data: InsightRow[]; paging?: { cursors?: { after?: string }; next?: string } }>(
        'GET',
        `/act_${ctx.platformAccountId}/insights`,
        ctx,
        { method: 'getPerformanceData' },
        {
          query: {
            level: 'ad',
            time_increment: '1',
            fields: 'ad_id,impressions,clicks,spend,actions,action_values',
            time_range: JSON.stringify({ since: query.since, until: query.until }),
            filtering: JSON.stringify([{ field: 'ad.id', operator: 'IN', value: query.platformAdIds }]),
            ...(after ? { after } : {}),
          },
        },
      );

      for (const row of body.data) {
        const conversions = (row.actions ?? [])
          .filter((a) => conversionTypes.has(a.action_type))
          .reduce((sum, a) => sum + Number(a.value), 0);
        const conversionValue = (row.action_values ?? [])
          .filter((a) => conversionTypes.has(a.action_type))
          .reduce((sum, a) => sum + Number(a.value), 0);

        rows.push({
          platformAdId: row.ad_id,
          statDate: row.date_start,
          impressions: Number(row.impressions ?? 0),
          clicks: Number(row.clicks ?? 0),
          spendCents: Math.round(Number(row.spend ?? 0) * 100),
          conversions: Math.round(conversions),
          conversionValueCents: Math.round(conversionValue * 100),
          currency: ctx.currency,
          raw: row,
        });
      }

      if (!body.paging?.next) break;
      after = body.paging.cursors?.after;
      if (!after) break;
    }

    return rows;
  }
}
