/**
 * Proves the database CHECK constraints actually reject bad data.
 *
 * These were previously "present in the schema", which is not the same claim — an earlier
 * revision of this project defined fourteen constraints that drizzle-kit silently dropped, so
 * they existed in the source and nowhere else. Asserting the rejection behaviour is the only
 * way to know the last line of defence is real.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pool } from '../../src/db/index.js';
import {
  adAccounts,
  adSets,
  adVariants,
  clients,
  dailyPerformance,
  decisionsLog,
  guardrailConfigs,
} from '../../src/db/schema.js';
import { expectConstraintViolation, seedWorld, truncateAll } from './helpers.js';

beforeEach(truncateAll);
afterAll(async () => {
  await pool.end();
});

describe('clients', () => {
  it('rejects a CPA client with no target CPA', async () => {
    await expectConstraintViolation(
      db.insert(clients).values({
        name: 'Bad',
        slug: 'bad-cpa',
        defaultObjectiveType: 'CPA',
        defaultTargetCpaCents: null,
      }),
      'clients_objective_target_ck',
    );
  });

  it('rejects a ROAS client with no target ROAS', async () => {
    await expectConstraintViolation(
      db.insert(clients).values({
        name: 'Bad',
        slug: 'bad-roas',
        defaultObjectiveType: 'ROAS',
        defaultTargetRoas: null,
      }),
      'clients_objective_target_ck',
    );
  });

  it('rejects a non-positive target', async () => {
    await expectConstraintViolation(
      db.insert(clients).values({
        name: 'Bad',
        slug: 'zero-cpa',
        defaultObjectiveType: 'CPA',
        defaultTargetCpaCents: 0,
      }),
      'clients_objective_target_ck',
    );
  });
});

describe('ad_accounts', () => {
  it('rejects a malformed currency code', async () => {
    const world = await seedWorld();
    await expectConstraintViolation(
      db.insert(adAccounts).values({
        clientId: world.clientId,
        platform: 'MOCK',
        platformAccountId: 'x-1',
        name: 'Bad currency',
        currency: 'dollars',
        timezone: 'UTC',
      }),
      'ad_accounts_currency_ck',
    );
  });
});

describe('daily_performance — the figures decisions are made on', () => {
  it('rejects negative spend', async () => {
    const world = await seedWorld();
    await expectConstraintViolation(
      db.insert(dailyPerformance).values({
        adVariantId: world.variantId,
        statDate: '2026-08-01',
        impressions: 100,
        clicks: 10,
        spendCents: -500,
        conversions: 1,
        currency: 'USD',
        source: 'MOCK',
      }),
      'daily_performance_nonneg_ck',
    );
  });

  it('rejects negative conversions', async () => {
    const world = await seedWorld();
    await expectConstraintViolation(
      db.insert(dailyPerformance).values({
        adVariantId: world.variantId,
        statDate: '2026-08-01',
        impressions: 100,
        clicks: 10,
        spendCents: 500,
        conversions: -1,
        currency: 'USD',
        source: 'MOCK',
      }),
      'daily_performance_nonneg_ck',
    );
  });

  it('rejects clicks exceeding impressions — an adapter field-mapping error', async () => {
    const world = await seedWorld();
    await expectConstraintViolation(
      db.insert(dailyPerformance).values({
        adVariantId: world.variantId,
        statDate: '2026-08-01',
        impressions: 10,
        clicks: 100,
        spendCents: 500,
        conversions: 1,
        currency: 'USD',
        source: 'MOCK',
      }),
      'daily_performance_clicks_ck',
    );
  });

  it('accepts a well-formed row', async () => {
    const world = await seedWorld();
    await expect(
      db.insert(dailyPerformance).values({
        adVariantId: world.variantId,
        statDate: '2026-08-01',
        impressions: 1_000,
        clicks: 20,
        spendCents: 3_000,
        conversions: 2,
        conversionValueCents: 12_000,
        currency: 'USD',
        source: 'MOCK',
      }),
    ).resolves.toBeDefined();
  });

  it('keeps restatements as separate rows rather than overwriting', async () => {
    const world = await seedWorld();
    const base = {
      adVariantId: world.variantId,
      statDate: '2026-08-01' as const,
      impressions: 1_000,
      clicks: 20,
      spendCents: 3_000,
      currency: 'USD',
      source: 'MOCK' as const,
    };
    await db.insert(dailyPerformance).values({ ...base, fetchedAt: new Date('2026-08-02T00:00:00Z'), conversions: 2 });
    await db.insert(dailyPerformance).values({ ...base, fetchedAt: new Date('2026-08-05T00:00:00Z'), conversions: 5 });

    const rows = await db.select().from(dailyPerformance);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.conversions).sort()).toEqual([2, 5]);
  });
});

describe('guardrail_configs — a misconfigured limit must not be storable', () => {
  const base = (clientId: string) => ({
    clientId,
    version: 2,
    maxDailyAutonomousIncreaseCents: 20_000,
    maxTotalDailyBudgetCents: 100_000,
    maxAdSetDailyBudgetCents: 50_000,
    createdBy: 'test',
  });

  it('rejects a budget increase above 100%', async () => {
    const world = await seedWorld();
    await expectConstraintViolation(
      db.insert(guardrailConfigs).values({ ...base(world.clientId), maxBudgetIncreasePct: '150.00' }),
      'guardrail_pct_bounds_ck',
    );
  });

  it('rejects a scale threshold looser than the kill threshold', async () => {
    // Scaling on weaker evidence than killing is backwards: it makes the expensive mistake
    // easier to reach than the cheap one.
    const world = await seedWorld();
    await expectConstraintViolation(
      db.insert(guardrailConfigs).values({
        ...base(world.clientId),
        killPThreshold: '0.0500',
        scalePThreshold: '0.1000',
      }),
      'guardrail_p_bounds_ck',
    );
  });

  it('rejects an ad set ceiling above the client total ceiling', async () => {
    const world = await seedWorld();
    await expectConstraintViolation(
      db.insert(guardrailConfigs).values({
        ...base(world.clientId),
        maxTotalDailyBudgetCents: 10_000,
        maxAdSetDailyBudgetCents: 50_000,
      }),
      'guardrail_money_bounds_ck',
    );
  });

  it('rejects a runtime floor below 24 hours', async () => {
    const world = await seedWorld();
    await expectConstraintViolation(
      db.insert(guardrailConfigs).values({ ...base(world.clientId), minRuntimeHours: 2 }),
      'guardrail_evidence_bounds_ck',
    );
  });

  it('rejects a non-positive mSPRT tau', async () => {
    const world = await seedWorld();
    await expectConstraintViolation(
      db.insert(guardrailConfigs).values({ ...base(world.clientId), mSprtTauRelative: '0.000' }),
      'guardrail_evidence_bounds_ck',
    );
  });

  it('allows only one live config per client', async () => {
    const world = await seedWorld();
    await expectConstraintViolation(
      db.insert(guardrailConfigs).values(base(world.clientId)),
      'guardrail_configs_one_live_key',
    );
  });
});

describe('ad_variants', () => {
  it('rejects a mutation lineage missing its mutated field', async () => {
    const world = await seedWorld();
    await expectConstraintViolation(
      db.insert(adVariants).values({
        adSetId: world.adSetId,
        cohortId: world.cohortId,
        campaignId: world.campaignId,
        headline: 'H',
        primaryText: 'B',
        cta: 'Go',
        angleTag: 'angle',
        parentVariantId: world.variantId,
        mutatedField: null,
      }),
      'ad_variants_mutation_ck',
    );
  });

  it('rejects a negative evaluation counter', async () => {
    const world = await seedWorld();
    await expectConstraintViolation(
      db.update(adVariants).set({ evaluationsProxy: -1 }),
      'ad_variants_evaluations_ck',
    );
    expect(world.variantId).toBeDefined();
  });
});

describe('ad_sets', () => {
  it('rejects a non-positive daily budget', async () => {
    const world = await seedWorld();
    await expectConstraintViolation(
      db.insert(adSets).values({
        campaignId: world.campaignId,
        name: 'Zero budget',
        dailyBudgetCents: 0,
        targetingHash: 'h',
      }),
      'ad_sets_budget_positive_ck',
    );
  });
});

describe('decisions_log — the audit record cannot lie', () => {
  const row = (world: Awaited<ReturnType<typeof seedWorld>>) => ({
    clientId: world.clientId,
    guardrailConfigId: world.guardrailConfigId,
    cycleId: crypto.randomUUID(),
    decisionType: 'KILL' as const,
    triggeringData: {},
    statisticalEvidence: {},
    guardrailEvaluations: {},
    proposedAction: {},
    idempotencyKey: crypto.randomUUID(),
    engineVersion: '0.1.0',
    rulesetVersion: 'test',
  });

  it('refuses an EXECUTED decision with no execution timestamp', async () => {
    const world = await seedWorld();
    await expectConstraintViolation(
      db.insert(decisionsLog).values({ ...row(world), status: 'EXECUTED', executedAt: null }),
      'decisions_log_executed_ck',
    );
  });

  it('refuses a BLOCKED decision that does not name the rule that blocked it', async () => {
    const world = await seedWorld();
    await expectConstraintViolation(
      db.insert(decisionsLog).values({ ...row(world), status: 'BLOCKED', blockedByRule: null }),
      'decisions_log_blocked_ck',
    );
  });

  it('refuses an APPROVED decision with no approver', async () => {
    const world = await seedWorld();
    await expectConstraintViolation(
      db.insert(decisionsLog).values({ ...row(world), status: 'APPROVED', approvedBy: null }),
      'decisions_log_approved_ck',
    );
  });

  it('enforces idempotency key uniqueness', async () => {
    const world = await seedWorld();
    const shared = row(world);
    await db.insert(decisionsLog).values({ ...shared, status: 'PENDING_EXECUTION' });
    await expectConstraintViolation(
      db.insert(decisionsLog).values({ ...shared, status: 'PENDING_EXECUTION' }),
      'decisions_log_idempotency_key',
    );
  });
});
