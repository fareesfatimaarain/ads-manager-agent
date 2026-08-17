import { describe, expect, it } from 'vitest';
import { MockPlatformAdapter, type MockScenario } from '../../src/platform/mock/mockAdapter.js';
import {
  PlatformConflictError,
  PlatformPreconditionFailedError,
  PlatformTransientError,
  isRetryable,
} from '../../src/platform/errors.js';
import type { AdapterContext } from '../../src/platform/types.js';

const ctx: AdapterContext = {
  adAccountId: 'acc-1',
  platformAccountId: 'plat-1',
  accessToken: 'token',
  currency: 'USD',
  timezone: 'UTC',
};

const scenario = (over: Partial<MockScenario> = {}): MockScenario => ({
  seed: 42,
  variants: [
    { platformAdId: 'ad-a', trueCtr: 0.02, trueCvr: 0.05, avgOrderValueCents: 8_000, impressionsPerDollar: 200 },
    { platformAdId: 'ad-b', trueCtr: 0.01, trueCvr: 0.02, avgOrderValueCents: 8_000, impressionsPerDollar: 200 },
  ],
  ...over,
});

function adapterWithAds(over: Partial<MockScenario> = {}): MockPlatformAdapter {
  const a = new MockPlatformAdapter(scenario(over), new Date('2026-01-10T00:00:00Z'));
  a.seedAdSet('as-a', 3_000, '2026-01-01');
  a.seedAdSet('as-b', 3_000, '2026-01-01');
  a.seedAd('ad-a', 'as-a', '2026-01-01');
  a.seedAd('ad-b', 'as-b', '2026-01-01');
  return a;
}

describe('idempotency — the double-spend guarantee', () => {
  it('applies a budget change exactly once when the same key is replayed', async () => {
    const a = adapterWithAds();
    const req = {
      idempotencyKey: 'key-1',
      platformAdSetId: 'as-a',
      targetDailyBudgetCents: 3_600,
      expectedCurrentDailyBudgetCents: 3_000,
    };

    const first = await a.updateBudget(req, ctx);
    expect(first.wasAlreadyApplied).toBe(false);
    expect(a.currentBudget('as-a')).toBe(3_600);

    // Replay the identical request, as a retry would.
    const second = await a.updateBudget(req, ctx);
    expect(second.wasAlreadyApplied).toBe(true);
    // The critical assertion: the budget did NOT go to 4320.
    expect(a.currentBudget('as-a')).toBe(3_600);
  });

  it('survives a mutation that applied but lost its response', async () => {
    // The classic double-spend trap: the write lands, the caller sees a timeout, retries.
    const a = adapterWithAds({
      failureScript: { updateBudget: ['APPLIED_THEN_LOST_RESPONSE'] },
    });
    const req = {
      idempotencyKey: 'key-2',
      platformAdSetId: 'as-a',
      targetDailyBudgetCents: 3_600,
      expectedCurrentDailyBudgetCents: 3_000,
    };

    await expect(a.updateBudget(req, ctx)).rejects.toBeInstanceOf(PlatformTransientError);
    // The mutation really did apply, despite the error.
    expect(a.currentBudget('as-a')).toBe(3_600);

    // A caller that reconciles before retrying discovers the prior attempt.
    const prior = await a.findPriorAttempt('key-2', ctx);
    expect(prior.found).toBe(true);
    expect(prior.platformEntityId).toBe('as-a');

    // And a blind retry is still safe.
    const retry = await a.updateBudget(req, ctx);
    expect(retry.wasAlreadyApplied).toBe(true);
    expect(a.currentBudget('as-a')).toBe(3_600);
  });

  it('refuses a key reused with a different payload', async () => {
    const a = adapterWithAds();
    await a.updateBudget(
      {
        idempotencyKey: 'key-3',
        platformAdSetId: 'as-a',
        targetDailyBudgetCents: 3_600,
        expectedCurrentDailyBudgetCents: 3_000,
      },
      ctx,
    );
    await expect(
      a.updateBudget(
        {
          idempotencyKey: 'key-3',
          platformAdSetId: 'as-a',
          targetDailyBudgetCents: 9_000,
          expectedCurrentDailyBudgetCents: 3_600,
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(PlatformConflictError);
  });

  it('pauses exactly once on replay', async () => {
    const a = adapterWithAds();
    const req = { idempotencyKey: 'p-1', platformEntityId: 'ad-a', entityType: 'AD' as const };
    const first = await a.pauseAd(req, ctx);
    expect(first.wasAlreadyPaused).toBe(false);
    const second = await a.pauseAd(req, ctx);
    expect(second.wasAlreadyPaused).toBe(true);
    expect(a.isPaused('ad-a')).toBe(true);
  });

  it('reports no prior attempt for an unused key', async () => {
    const a = adapterWithAds();
    expect(await a.findPriorAttempt('never-used', ctx)).toMatchObject({ found: false });
  });
});

describe('optimistic concurrency', () => {
  it('refuses to stomp a budget a human changed underneath us', async () => {
    const a = adapterWithAds();
    // Someone edits the budget in the platform UI after the decision was made.
    a.externallySetBudget('as-a', 5_000);

    await expect(
      a.updateBudget(
        {
          idempotencyKey: 'key-4',
          platformAdSetId: 'as-a',
          targetDailyBudgetCents: 3_600,
          expectedCurrentDailyBudgetCents: 3_000, // what the engine believed
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(PlatformPreconditionFailedError);

    expect(a.currentBudget('as-a')).toBe(5_000); // untouched
  });

  it('classifies a precondition failure as non-retryable', async () => {
    const a = adapterWithAds();
    a.externallySetBudget('as-a', 5_000);
    try {
      await a.updateBudget(
        {
          idempotencyKey: 'key-5',
          platformAdSetId: 'as-a',
          targetDailyBudgetCents: 3_600,
          expectedCurrentDailyBudgetCents: 3_000,
        },
        ctx,
      );
      expect.unreachable('should have thrown');
    } catch (e) {
      // Retrying would just re-stomp. The decision must be re-derived from fresh data.
      expect(isRetryable(e)).toBe(false);
    }
  });
});

describe('error classification', () => {
  it('marks transient failures retryable and validation failures not', async () => {
    const a = adapterWithAds({ failureScript: { getAccountStatus: ['TRANSIENT', 'RATE_LIMIT'] } });
    await expect(a.getAccountStatus(ctx)).rejects.toSatisfy((e: unknown) => isRetryable(e));
    await expect(a.getAccountStatus(ctx)).rejects.toSatisfy((e: unknown) => isRetryable(e));
    // Script exhausted; the third call succeeds.
    await expect(a.getAccountStatus(ctx)).resolves.toMatchObject({ isActive: true });
  });
});

describe('determinism', () => {
  it('produces identical performance data across runs with the same seed', async () => {
    const query = { platformAdIds: ['ad-a', 'ad-b'], since: '2026-01-01', until: '2026-01-07' };
    const one = await adapterWithAds().getPerformanceData(query, ctx);
    const two = await adapterWithAds().getPerformanceData(query, ctx);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    expect(one.length).toBeGreaterThan(0);
  });

  it('produces different data for a different seed', async () => {
    const query = { platformAdIds: ['ad-a'], since: '2026-01-01', until: '2026-01-07' };
    const one = await adapterWithAds().getPerformanceData(query, ctx);
    const two = await adapterWithAds({ seed: 99 }).getPerformanceData(query, ctx);
    expect(JSON.stringify(one)).not.toBe(JSON.stringify(two));
  });

  it('recovers the ground-truth ordering of variants over enough days', async () => {
    // ad-a has double the true CTR of ad-b. Over a week that must be visible.
    const rows = await adapterWithAds().getPerformanceData(
      { platformAdIds: ['ad-a', 'ad-b'], since: '2026-01-01', until: '2026-01-07' },
      ctx,
    );
    const ctrOf = (id: string) => {
      const mine = rows.filter((r) => r.platformAdId === id);
      const imp = mine.reduce((s, r) => s + r.impressions, 0);
      const clk = mine.reduce((s, r) => s + r.clicks, 0);
      return clk / imp;
    };
    expect(ctrOf('ad-a')).toBeGreaterThan(ctrOf('ad-b'));
  });

  it('never emits a row violating the daily_performance invariants', async () => {
    const rows = await adapterWithAds().getPerformanceData(
      { platformAdIds: ['ad-a', 'ad-b'], since: '2026-01-01', until: '2026-01-09' },
      ctx,
    );
    for (const r of rows) {
      expect(r.clicks).toBeLessThanOrEqual(r.impressions);
      expect(r.impressions).toBeGreaterThanOrEqual(0);
      expect(r.spendCents).toBeGreaterThanOrEqual(0);
      expect(r.conversions).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.spendCents)).toBe(true);
      expect(Number.isInteger(r.conversions)).toBe(true);
    }
  });
});

describe('attribution settling', () => {
  it('under-reports conversions for recent days and restates them as they settle', async () => {
    const a = adapterWithAds();
    const query = { platformAdIds: ['ad-a'], since: '2026-01-08', until: '2026-01-08' };

    // Queried the morning after: only ~60% of conversions are visible.
    a.setNow(new Date('2026-01-09T06:00:00Z'));
    const early = await a.getPerformanceData(query, ctx);

    // Queried four days later: fully settled.
    a.setNow(new Date('2026-01-12T06:00:00Z'));
    const settled = await a.getPerformanceData(query, ctx);

    expect(early[0]!.conversions).toBeLessThan(settled[0]!.conversions);
    // Impressions and clicks do not move — only conversions restate.
    expect(early[0]!.impressions).toBe(settled[0]!.impressions);
    expect(early[0]!.clicks).toBe(settled[0]!.clicks);
  });

  it('demonstrates why the settling window exists', async () => {
    // A same-day read sees a fraction of the truth. Deciding on it would systematically
    // under-count conversions and over-kill good ads.
    const a = adapterWithAds();
    const query = { platformAdIds: ['ad-a'], since: '2026-01-08', until: '2026-01-08' };

    a.setNow(new Date('2026-01-09T00:00:00Z'));
    const fresh = (await a.getPerformanceData(query, ctx))[0]!;
    a.setNow(new Date('2026-01-13T00:00:00Z'));
    const final = (await a.getPerformanceData(query, ctx))[0]!;

    const understatementPct = (1 - fresh.conversions / final.conversions) * 100;
    expect(understatementPct).toBeGreaterThan(20);
  });
});

describe('budget history', () => {
  it('generates performance against the budget in force on each day', async () => {
    const a = adapterWithAds();
    a.setNow(new Date('2026-01-05T00:00:00Z'));
    await a.updateBudget(
      {
        idempotencyKey: 'b-1',
        platformAdSetId: 'as-a',
        targetDailyBudgetCents: 6_000,
        expectedCurrentDailyBudgetCents: 3_000,
      },
      ctx,
    );
    a.setNow(new Date('2026-01-10T00:00:00Z'));

    const rows = await a.getPerformanceData(
      { platformAdIds: ['ad-a'], since: '2026-01-02', until: '2026-01-08' },
      ctx,
    );
    const before = rows.find((r) => r.statDate === '2026-01-02')!;
    const after = rows.find((r) => r.statDate === '2026-01-08')!;
    expect(after.spendCents).toBeGreaterThan(before.spendCents * 1.5);
  });
});
