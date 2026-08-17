/**
 * The Meta adapter against a mocked `fetch` — this verifies request shaping, response
 * parsing, and error classification without a live Meta account (see the file header note
 * in metaAdapter.ts on what that does and doesn't prove). The idempotency ledger side is
 * real: it hits actual Postgres, because that's the property that can't be faked.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pool } from '../../src/db/index.js';
import { MetaPlatformAdapter } from '../../src/platform/meta/metaAdapter.js';
import {
  PlatformAuthError,
  PlatformPreconditionFailedError,
  PlatformRateLimitError,
  PlatformTransientError,
  PlatformValidationError,
} from '../../src/platform/errors.js';
import type { AdapterContext } from '../../src/platform/types.js';
import { truncateAll } from './helpers.js';

beforeEach(truncateAll);
afterAll(async () => {
  await pool.end();
});

interface Call {
  url: string;
  method: string;
  body: string | null;
}

function mockFetch(responses: { status: number; json: unknown }[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? String(init.body) : null,
    });
    const next = responses[i] ?? responses[responses.length - 1]!;
    i += 1;
    return new Response(JSON.stringify(next.json), { status: next.status });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const baseCtx: AdapterContext = {
  adAccountId: 'internal-id',
  platformAccountId: '123456',
  accessToken: 'test-token',
  currency: 'USD',
  timezone: 'UTC',
};

describe('MetaPlatformAdapter — campaigns and ad sets', () => {
  it('creates a campaign with the mapped objective and status', async () => {
    const { fetch: f, calls } = mockFetch([{ status: 200, json: { id: 'camp_1' } }]);
    const adapter = new MetaPlatformAdapter(db, 'v21.0', f);

    const result = await adapter.createCampaign(
      { idempotencyKey: 'k1', name: 'Test Campaign', objective: 'CONVERSIONS', startPaused: true },
      baseCtx,
    );

    expect(result).toEqual({ platformId: 'camp_1', platform: 'META' });
    expect(calls[0]!.url).toContain('/act_123456/campaigns');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toContain('OUTCOME_SALES');
    expect(calls[0]!.body).toContain('PAUSED');
  });

  it('refuses to create an ad set with no pixel configured, before calling Meta', async () => {
    const { fetch: f, calls } = mockFetch([{ status: 200, json: { id: 'as_1' } }]);
    const adapter = new MetaPlatformAdapter(db, 'v21.0', f);

    await expect(
      adapter.createAdSet(
        {
          idempotencyKey: 'k2',
          platformCampaignId: 'camp_1',
          name: 'Ad set',
          dailyBudgetCents: 3000,
          targeting: { countries: ['US'] },
          startPaused: true,
        },
        baseCtx,
      ),
    ).rejects.toBeInstanceOf(PlatformValidationError);
    expect(calls.length).toBe(0);
  });

  it('creates an ad set carrying the pixel and translated targeting once configured', async () => {
    const { fetch: f, calls } = mockFetch([{ status: 200, json: { id: 'as_1' } }]);
    const adapter = new MetaPlatformAdapter(db, 'v21.0', f);
    const ctx: AdapterContext = { ...baseCtx, platformConfig: { metaPixelId: 'px_1' } };

    const result = await adapter.createAdSet(
      {
        idempotencyKey: 'k3',
        platformCampaignId: 'camp_1',
        name: 'Ad set',
        dailyBudgetCents: 3000,
        targeting: { countries: ['US', 'CA'], ageMin: 25, ageMax: 55 },
        startPaused: false,
      },
      ctx,
    );

    expect(result.platformId).toBe('as_1');
    expect(calls[0]!.body).toContain('px_1');
    expect(calls[0]!.body).toContain('US');
    expect(calls[0]!.body).toContain('25');
  });

  it('rejects interest targeting rather than silently mistranslating it', async () => {
    const { fetch: f } = mockFetch([{ status: 200, json: { id: 'as_1' } }]);
    const adapter = new MetaPlatformAdapter(db, 'v21.0', f);
    const ctx: AdapterContext = { ...baseCtx, platformConfig: { metaPixelId: 'px_1' } };

    await expect(
      adapter.createAdSet(
        {
          idempotencyKey: 'k4',
          platformCampaignId: 'camp_1',
          name: 'Ad set',
          dailyBudgetCents: 3000,
          targeting: { countries: ['US'], interests: ['fitness'] },
          startPaused: true,
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(PlatformValidationError);
  });
});

describe('MetaPlatformAdapter — ads', () => {
  it('creates a creative then an ad, mapping a recognised CTA', async () => {
    const { fetch: f, calls } = mockFetch([
      { status: 200, json: { id: 'creative_1' } },
      { status: 200, json: { id: 'ad_1' } },
    ]);
    const adapter = new MetaPlatformAdapter(db, 'v21.0', f);
    const ctx: AdapterContext = { ...baseCtx, platformConfig: { metaPageId: 'page_1' } };

    const result = await adapter.createAd(
      {
        idempotencyKey: 'k5',
        platformAdSetId: 'as_1',
        name: 'Ad',
        headline: 'Headline',
        primaryText: 'Body',
        cta: 'Shop Now',
        landingPageUrl: 'https://example.com',
        startPaused: true,
      },
      ctx,
    );

    expect(result.platformId).toBe('ad_1');
    expect(calls[0]!.url).toContain('/adcreatives');
    expect(calls[0]!.body).toContain('page_1');
    expect(calls[0]!.body).toContain('SHOP_NOW');
    expect(calls[1]!.url).toContain('/ads');
    expect(calls[1]!.body).toContain('creative_1');
  });

  it('falls back to LEARN_MORE for an unrecognised CTA rather than failing the launch', async () => {
    const { fetch: f, calls } = mockFetch([
      { status: 200, json: { id: 'creative_1' } },
      { status: 200, json: { id: 'ad_1' } },
    ]);
    const adapter = new MetaPlatformAdapter(db, 'v21.0', f);
    const ctx: AdapterContext = { ...baseCtx, platformConfig: { metaPageId: 'page_1' } };

    await adapter.createAd(
      {
        idempotencyKey: 'k6',
        platformAdSetId: 'as_1',
        name: 'Ad',
        headline: 'Headline',
        primaryText: 'Body',
        cta: 'Grab yours today',
        landingPageUrl: 'https://example.com',
        startPaused: true,
      },
      ctx,
    );
    expect(calls[0]!.body).toContain('LEARN_MORE');
  });
});

describe('MetaPlatformAdapter — budget updates (idempotency-critical)', () => {
  it('reads current budget, checks the precondition, then writes and records the ledger', async () => {
    const { fetch: f, calls } = mockFetch([
      { status: 200, json: { daily_budget: '3000' } }, // GET current
      { status: 200, json: { success: true } }, // POST update
    ]);
    const adapter = new MetaPlatformAdapter(db, 'v21.0', f);

    const result = await adapter.updateBudget(
      {
        idempotencyKey: 'budget-k1',
        platformAdSetId: 'as_1',
        targetDailyBudgetCents: 4000,
        expectedCurrentDailyBudgetCents: 3000,
      },
      baseCtx,
    );

    expect(result).toEqual({
      platformAdSetId: 'as_1',
      previousDailyBudgetCents: 3000,
      newDailyBudgetCents: 4000,
      wasAlreadyApplied: false,
    });
    expect(calls[1]!.body).toContain('4000');

    const again = await adapter.findPriorAttempt('budget-k1', baseCtx);
    expect(again.found).toBe(true);
    expect(again.platformEntityId).toBe('as_1');
  });

  it('refuses to apply when the live budget does not match what the decision assumed', async () => {
    const { fetch: f, calls } = mockFetch([{ status: 200, json: { daily_budget: '5000' } }]);
    const adapter = new MetaPlatformAdapter(db, 'v21.0', f);

    await expect(
      adapter.updateBudget(
        {
          idempotencyKey: 'budget-k2',
          platformAdSetId: 'as_1',
          targetDailyBudgetCents: 4000,
          expectedCurrentDailyBudgetCents: 3000,
        },
        baseCtx,
      ),
    ).rejects.toBeInstanceOf(PlatformPreconditionFailedError);

    // Never reached the write call.
    expect(calls.length).toBe(1);
  });

  it('returns the cached outcome on retry without calling Meta again', async () => {
    const { fetch: f, calls } = mockFetch([
      { status: 200, json: { daily_budget: '3000' } },
      { status: 200, json: { success: true } },
    ]);
    const adapter = new MetaPlatformAdapter(db, 'v21.0', f);
    await adapter.updateBudget(
      {
        idempotencyKey: 'budget-k3',
        platformAdSetId: 'as_1',
        targetDailyBudgetCents: 4000,
        expectedCurrentDailyBudgetCents: 3000,
      },
      baseCtx,
    );
    expect(calls.length).toBe(2);

    const retryResult = await adapter.updateBudget(
      {
        idempotencyKey: 'budget-k3',
        platformAdSetId: 'as_1',
        targetDailyBudgetCents: 4000,
        expectedCurrentDailyBudgetCents: 3000,
      },
      baseCtx,
    );
    expect(retryResult.wasAlreadyApplied).toBe(true);
    // No new calls to Meta on the retry.
    expect(calls.length).toBe(2);
  });
});

describe('MetaPlatformAdapter — pause', () => {
  it('pauses and records the ledger, reporting it was not already paused', async () => {
    const { fetch: f } = mockFetch([
      { status: 200, json: { effective_status: 'ACTIVE' } },
      { status: 200, json: { success: true } },
    ]);
    const adapter = new MetaPlatformAdapter(db, 'v21.0', f);

    const result = await adapter.pauseAd(
      { idempotencyKey: 'pause-k1', platformEntityId: 'ad_1', entityType: 'AD' },
      baseCtx,
    );
    expect(result).toEqual({ platformEntityId: 'ad_1', wasAlreadyPaused: false });
  });

  it('reports wasAlreadyPaused honestly when it was', async () => {
    const { fetch: f } = mockFetch([
      { status: 200, json: { effective_status: 'PAUSED' } },
      { status: 200, json: { success: true } },
    ]);
    const adapter = new MetaPlatformAdapter(db, 'v21.0', f);

    const result = await adapter.pauseAd(
      { idempotencyKey: 'pause-k2', platformEntityId: 'ad_1', entityType: 'AD' },
      baseCtx,
    );
    expect(result.wasAlreadyPaused).toBe(true);
  });
});

describe('MetaPlatformAdapter — reads', () => {
  it('maps account_status 1 to active', async () => {
    const { fetch: f } = mockFetch([
      { status: 200, json: { account_status: 1, currency: 'USD', timezone_name: 'UTC' } },
    ]);
    const adapter = new MetaPlatformAdapter(db, 'v21.0', f);
    const status = await adapter.getAccountStatus(baseCtx);
    expect(status.isActive).toBe(true);
    expect(status.disabledReason).toBeNull();
  });

  it('maps a non-1 account_status to inactive with a reason', async () => {
    const { fetch: f } = mockFetch([
      { status: 200, json: { account_status: 2, disable_reason: 3, currency: 'USD', timezone_name: 'UTC' } },
    ]);
    const adapter = new MetaPlatformAdapter(db, 'v21.0', f);
    const status = await adapter.getAccountStatus(baseCtx);
    expect(status.isActive).toBe(false);
    expect(status.disabledReason).toContain('account_status=2');
  });

  it('converts insights spend and action values from dollars to cents', async () => {
    const { fetch: f } = mockFetch([
      {
        status: 200,
        json: {
          data: [
            {
              ad_id: 'ad_1',
              date_start: '2026-08-01',
              impressions: '1000',
              clicks: '20',
              spend: '12.34',
              actions: [{ action_type: 'omni_purchase', value: '3' }],
              action_values: [{ action_type: 'omni_purchase', value: '150.00' }],
            },
          ],
          paging: {},
        },
      },
    ]);
    const adapter = new MetaPlatformAdapter(db, 'v21.0', f);

    const rows = await adapter.getPerformanceData(
      { platformAdIds: ['ad_1'], since: '2026-08-01', until: '2026-08-01' },
      baseCtx,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      platformAdId: 'ad_1',
      spendCents: 1234,
      conversions: 3,
      conversionValueCents: 15000,
    });
  });

  it('ignores non-conversion action types', async () => {
    const { fetch: f } = mockFetch([
      {
        status: 200,
        json: {
          data: [
            {
              ad_id: 'ad_1',
              date_start: '2026-08-01',
              impressions: '1000',
              clicks: '20',
              spend: '10.00',
              actions: [
                { action_type: 'link_click', value: '20' },
                { action_type: 'omni_purchase', value: '2' },
              ],
              action_values: [{ action_type: 'omni_purchase', value: '80.00' }],
            },
          ],
          paging: {},
        },
      },
    ]);
    const adapter = new MetaPlatformAdapter(db, 'v21.0', f);
    const rows = await adapter.getPerformanceData(
      { platformAdIds: ['ad_1'], since: '2026-08-01', until: '2026-08-01' },
      baseCtx,
    );
    expect(rows[0]!.conversions).toBe(2);
  });
});

describe('MetaPlatformAdapter — error classification', () => {
  it('classifies an expired token as a non-retryable auth error', async () => {
    const { fetch: f } = mockFetch([
      { status: 401, json: { error: { code: 190, message: 'Error validating access token' } } },
    ]);
    const adapter = new MetaPlatformAdapter(db, 'v21.0', f);
    const error = await adapter.getAccountStatus(baseCtx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformAuthError);
  });

  it('classifies a 500 as retryable transient', async () => {
    const { fetch: f } = mockFetch([{ status: 500, json: { error: { message: 'internal' } } }]);
    const adapter = new MetaPlatformAdapter(db, 'v21.0', f);
    const error = await adapter.getAccountStatus(baseCtx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformTransientError);
    expect((error as PlatformTransientError).retryable).toBe(true);
  });

  it('classifies application rate limiting as retryable with a backoff hint', async () => {
    const { fetch: f } = mockFetch([{ status: 400, json: { error: { code: 17, message: 'rate limit' } } }]);
    const adapter = new MetaPlatformAdapter(db, 'v21.0', f);
    const error = await adapter.getAccountStatus(baseCtx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformRateLimitError);
  });
});
