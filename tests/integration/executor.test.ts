/**
 * End-to-end tests for the execution path, against a real database and the deterministic mock
 * adapter. These verify the properties that unit tests structurally cannot: that the record is
 * committed before the platform is touched, that the spend ledger is transactional, and that a
 * retry cannot spend twice.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../../src/db/index.js';
import {
  adSets,
  decisionsLog,
  guardrailConfigs,
  platformActions,
  spendLedger,
} from '../../src/db/schema.js';
import {
  executeDecision,
  idempotencyKeyFor,
  listDeadLetters,
  reconcileInterrupted,
  type ExecutorDeps,
} from '../../src/decisions/executor.js';
import { parseGuardrailConfig } from '../../src/guardrails/config.js';
import type { GuardrailContext } from '../../src/guardrails/types.js';
import type { VariantDecision } from '../../src/decisions/types.js';
import { MockPlatformAdapter, type MockScenario } from '../../src/platform/mock/mockAdapter.js';
import { CircuitBreaker } from '../../src/platform/resilience.js';
import type { AdapterContext } from '../../src/platform/types.js';
import { seedWorld, truncateAll, type SeededWorld } from './helpers.js';

const NOW = new Date('2026-08-08T12:00:00Z');
const LEDGER_DATE = '2026-08-08';

beforeEach(truncateAll);
afterAll(async () => {
  await pool.end();
});

function adapterFor(scenario: Partial<MockScenario> = {}): MockPlatformAdapter {
  const adapter = new MockPlatformAdapter(
    { seed: 1, variants: [], ...scenario },
    NOW,
  );
  adapter.seedAdSet('as-1', 3_000, '2026-08-01');
  adapter.seedAd('ad-1', 'as-1', '2026-08-01');
  return adapter;
}

const adapterContext = (world: SeededWorld): AdapterContext => ({
  adAccountId: world.adAccountId,
  platformAccountId: 'acct-1',
  accessToken: 'token',
  currency: 'USD',
  timezone: 'UTC',
});

async function depsFor(
  world: SeededWorld,
  adapter: MockPlatformAdapter,
): Promise<ExecutorDeps> {
  return {
    db,
    adapter,
    adapterContext: adapterContext(world),
    breaker: new CircuitBreaker(5, 60_000),
    // No real waiting, deterministic jitter.
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0 },
    now: () => NOW,
  };
}

async function baseContextFor(
  world: SeededWorld,
  over: Partial<GuardrailContext> = {},
): Promise<Omit<GuardrailContext, 'todayAutonomousIncreaseCents' | 'clientTotalDailyBudgetCents'>> {
  const [row] = await db
    .select()
    .from(guardrailConfigs)
    .where(eq(guardrailConfigs.id, world.guardrailConfigId));

  return {
    config: parseGuardrailConfig(row as unknown as Record<string, unknown>),
    now: NOW,
    executionEnabled: true,
    client: {
      id: world.clientId,
      autonomousKillEnabled: true,
      autonomousScaleEnabled: true,
      autonomousMutateEnabled: true,
    },
    account: {
      id: world.adAccountId,
      status: 'ACTIVE',
      currency: 'USD',
      platformDailySpendCapCents: null,
    },
    activeCampaignCount: 2,
    activeVariantsInCampaign: 4,
    lastActionAtForVariant: null,
    actionsAlreadyThisCycle: 0,
    newestPerformanceFetchedAt: new Date(NOW.getTime() - 2 * 3_600_000),
    touchesTargeting: false,
    guardrailDenominationCurrency: 'USD',
    ...over,
  };
}

function scaleDecision(world: SeededWorld, targetBudgetCents = 3_600): VariantDecision {
  return {
    variantId: world.variantId,
    kind: 'SCALE',
    reasonCode: 'MEETS_OBJECTIVE_WITH_CONFIDENCE',
    humanSummary: 'Beating the $50.00 target at $25.00 per conversion. Raising budget.',
    evidence: {
      objective: { type: 'CPA', targetCpaCents: 5_000 },
      runtimeHours: 96,
      settled: { impressions: 150_000, clicks: 3_000, spendCents: 300_000, conversions: 120, conversionValueCents: 0 },
      proxy: { impressions: 150_000, clicks: 3_000, spendCents: 300_000, conversions: 120, conversionValueCents: 0 },
      observedCtr: 0.02,
      observedCvr: 0.04,
      observedCpaCents: 2_500,
      observedRoas: null,
      probabilityMeetsCpaTarget: 0.999,
      roasLowerBound: null,
      proxyTest: { worse: { result: null, fixedSampleP: null, alwaysValid: null, rawP: null, bhAdjustedP: null, threshold: null, significant: false } },
      outcomeTest: {
        worse: { result: null, fixedSampleP: null, alwaysValid: null, rawP: null, bhAdjustedP: null, threshold: null, significant: false },
        better: { result: null, fixedSampleP: 1e-9, alwaysValid: null, rawP: 1e-8, bhAdjustedP: 4e-8, threshold: 0.05, significant: true },
      },
      baselineArmCount: 3,
      notes: [],
    },
    proposedAction: {
      type: 'SCALE',
      variantId: world.variantId,
      adSetId: world.adSetId,
      campaignId: world.campaignId,
      platformEntityId: 'as-1',
      currentBudgetCents: 3_000,
      targetBudgetCents,
    },
    newEvaluationsProxy: 1,
    newEvaluationsOutcome: 1,
  };
}

const run = async (
  world: SeededWorld,
  adapter: MockPlatformAdapter,
  decision: VariantDecision,
  ctxOver: Partial<GuardrailContext> = {},
  cycleId = crypto.randomUUID(),
) =>
  executeDecision(
    await depsFor(world, adapter),
    decision,
    await baseContextFor(world, ctxOver),
    cycleId,
    LEDGER_DATE,
    world.adAccountId,
  );

// ---------------------------------------------------------------------------

describe('the happy path', () => {
  it('executes a scale and records everything', async () => {
    const world = await seedWorld();
    const adapter = adapterFor();

    const result = await run(world, adapter, scaleDecision(world));

    expect(result.outcome).toBe('EXECUTED');
    expect(adapter.currentBudget('as-1')).toBe(3_600);

    const [logged] = await db.select().from(decisionsLog).where(eq(decisionsLog.id, result.decisionId));
    expect(logged!.status).toBe('EXECUTED');
    expect(logged!.executedAt).not.toBeNull();
    expect(logged!.reasoning).toMatch(/Beating the/);
    expect(logged!.guardrailConfigId).toBe(world.guardrailConfigId);

    const ledger = await db.select().from(spendLedger);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.deltaCents).toBe(600); // only the increase, not the whole budget

    const [action] = await db.select().from(platformActions);
    expect(action!.status).toBe('SUCCEEDED');
  });

  it('records the full guardrail evaluation set, not just the failures', async () => {
    const world = await seedWorld();
    const result = await run(world, adapterFor(), scaleDecision(world));
    const [logged] = await db.select().from(decisionsLog).where(eq(decisionsLog.id, result.decisionId));
    const evaluations = logged!.guardrailEvaluations as { rule: string }[];
    expect(evaluations.length).toBeGreaterThan(10);
    expect(evaluations.some((e) => e.rule === 'DAILY_AUTONOMOUS_INCREASE_CAP')).toBe(true);
  });
});

describe('the ordering guarantee — logged before executed', () => {
  it('leaves a complete record even when the platform call fails outright', async () => {
    const world = await seedWorld();
    // Every attempt fails, so the mutation never happens. The record must exist regardless.
    const adapter = adapterFor({
      failureScript: { updateBudget: ['TRANSIENT', 'TRANSIENT', 'TRANSIENT'] },
    });

    const result = await run(world, adapter, scaleDecision(world));

    expect(result.outcome).toBe('DEAD_LETTERED');
    expect(adapter.currentBudget('as-1')).toBe(3_000); // untouched

    const [logged] = await db.select().from(decisionsLog).where(eq(decisionsLog.id, result.decisionId));
    expect(logged).toBeDefined();
    expect(logged!.status).toBe('FAILED');
    expect(logged!.failureReason).toMatch(/transient/i);
    // The evidence and reasoning survive the failure, so the attempt is explainable.
    expect(logged!.reasoning).toMatch(/Beating the/);
  });

  it('surfaces an unexecutable action as a dead letter rather than dropping it', async () => {
    const world = await seedWorld();
    const adapter = adapterFor({
      failureScript: { updateBudget: ['TRANSIENT', 'TRANSIENT', 'TRANSIENT'] },
    });
    await run(world, adapter, scaleDecision(world));

    const dead = await listDeadLetters(db);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.acknowledgedAt).toBeNull();
  });
});

describe('guardrails at the point of execution', () => {
  it('blocks an over-cap increase and never contacts the platform', async () => {
    const world = await seedWorld();
    const adapter = adapterFor();

    // +100% against a 20% cap.
    const result = await run(world, adapter, scaleDecision(world, 6_000));

    expect(result.outcome).toBe('BLOCKED');
    expect(result.blockedBy).toBe('MAX_BUDGET_INCREASE_PCT');
    expect(adapter.currentBudget('as-1')).toBe(3_000);

    const ledger = await db.select().from(spendLedger);
    expect(ledger).toHaveLength(0); // no headroom consumed by a refused action
    const actions = await db.select().from(platformActions);
    expect(actions).toHaveLength(0);
  });

  it('queues for approval instead of executing when the client is not promoted', async () => {
    const world = await seedWorld();
    const adapter = adapterFor();

    const result = await run(world, adapter, scaleDecision(world), {
      client: {
        id: world.clientId,
        autonomousKillEnabled: true,
        autonomousScaleEnabled: false,
        autonomousMutateEnabled: true,
      },
    });

    expect(result.outcome).toBe('PENDING_APPROVAL');
    expect(adapter.currentBudget('as-1')).toBe(3_000);

    const [logged] = await db.select().from(decisionsLog).where(eq(decisionsLog.id, result.decisionId));
    expect(logged!.status).toBe('PENDING_APPROVAL');
    expect(logged!.expiresAt).not.toBeNull(); // approvals go stale
    expect(await db.select().from(spendLedger)).toHaveLength(0);
  });

  it('blocks when the master switch is off', async () => {
    const world = await seedWorld();
    const adapter = adapterFor();
    const result = await run(world, adapter, scaleDecision(world), { executionEnabled: false });
    expect(result.outcome).toBe('BLOCKED');
    expect(result.blockedBy).toBe('EXECUTION_ENABLED');
    expect(adapter.currentBudget('as-1')).toBe(3_000);
  });
});

describe('the spend ledger is authoritative across cycles', () => {
  it('refuses a second increase once the daily cap is consumed', async () => {
    // Cap of $10 of new spend per day; each scale wants $6.
    const world = await seedWorld({ maxDailyAutonomousIncreaseCents: 1_000 });
    const adapter = adapterFor();

    const first = await run(world, adapter, scaleDecision(world));
    expect(first.outcome).toBe('EXECUTED');
    expect(adapter.currentBudget('as-1')).toBe(3_600);

    // Reflect the new live budget, as the next cycle would.
    await db.update(adSets).set({ dailyBudgetCents: 3_600 }).where(eq(adSets.id, world.adSetId));
    adapter.seedAdSet('as-2', 3_000, '2026-08-01');

    const second = scaleDecision(world);
    const secondResult = await run(world, adapter, {
      ...second,
      proposedAction: { ...second.proposedAction!, platformEntityId: 'as-2' } as never,
    });

    expect(secondResult.outcome).toBe('BLOCKED');
    expect(secondResult.blockedBy).toBe('DAILY_AUTONOMOUS_INCREASE_CAP');
    expect(adapter.currentBudget('as-2')).toBe(3_000);
  });

  it('releases the reservation when the platform rejects on a precondition', async () => {
    const world = await seedWorld();
    const adapter = adapterFor();
    // A human changed the budget in the platform UI after the decision was formed.
    adapter.externallySetBudget('as-1', 5_000);

    const result = await run(world, adapter, scaleDecision(world));

    expect(result.outcome).toBe('DEAD_LETTERED');
    expect(adapter.currentBudget('as-1')).toBe(5_000); // not stomped
    // The reservation must not stand, or the client silently loses headroom.
    expect(await db.select().from(spendLedger)).toHaveLength(0);
  });
});

describe('retry safety — the double-spend guarantee', () => {
  it('applies a budget change exactly once when the response is lost', async () => {
    const world = await seedWorld();
    // The mutation lands, then the response is lost. A naive retry would apply it twice.
    const adapter = adapterFor({
      failureScript: { updateBudget: ['APPLIED_THEN_LOST_RESPONSE'] },
    });

    const result = await run(world, adapter, scaleDecision(world));

    expect(result.outcome).toBe('EXECUTED');
    // The critical assertion: 3600, not 4320.
    expect(adapter.currentBudget('as-1')).toBe(3_600);
    expect(adapter.appliedMutationCount(result.idempotencyKey)).toBe(1);

    const [action] = await db.select().from(platformActions);
    expect(action!.status).toBe('SUCCEEDED');
  });

  it('derives a stable idempotency key from the intended effect', async () => {
    const world = await seedWorld();
    const action = scaleDecision(world).proposedAction!;
    const cycle = 'cycle-abc';
    expect(idempotencyKeyFor(cycle, action)).toBe(idempotencyKeyFor(cycle, action));
    // A different cycle is a genuinely different action, even with identical numbers.
    expect(idempotencyKeyFor('cycle-xyz', action)).not.toBe(idempotencyKeyFor(cycle, action));
  });

  it('recovers after transient failures without applying twice', async () => {
    const world = await seedWorld();
    const adapter = adapterFor({
      failureScript: { updateBudget: ['TRANSIENT', 'OK'] },
    });

    const result = await run(world, adapter, scaleDecision(world));

    expect(result.outcome).toBe('EXECUTED');
    expect(adapter.currentBudget('as-1')).toBe(3_600);
  });
});

describe('reconciliation after an interruption', () => {
  it('marks an interrupted action as executed when the platform confirms it landed', async () => {
    const world = await seedWorld();
    const adapter = adapterFor();
    const result = await run(world, adapter, scaleDecision(world));

    // Simulate a crash between the platform call and our status write.
    await db
      .update(platformActions)
      .set({ status: 'IN_FLIGHT', completedAt: null })
      .where(eq(platformActions.idempotencyKey, result.idempotencyKey));
    await db.update(decisionsLog).set({ status: 'EXECUTING' }).where(eq(decisionsLog.id, result.decisionId));

    const count = await reconcileInterrupted(await depsFor(world, adapter));
    expect(count).toBe(1);

    const [action] = await db.select().from(platformActions);
    expect(action!.status).toBe('SUCCEEDED');
    const [logged] = await db.select().from(decisionsLog).where(eq(decisionsLog.id, result.decisionId));
    expect(logged!.status).toBe('EXECUTED');
  });

  it('dead-letters an interrupted action the platform never received', async () => {
    const world = await seedWorld();
    const adapter = adapterFor();
    const result = await run(world, adapter, scaleDecision(world));

    // Strand it under a key the platform has never seen.
    await db
      .update(platformActions)
      .set({ status: 'IN_FLIGHT', completedAt: null, idempotencyKey: 'never-sent' })
      .where(eq(platformActions.idempotencyKey, result.idempotencyKey));

    await reconcileInterrupted(await depsFor(world, adapter));

    const [action] = await db.select().from(platformActions);
    expect(action!.status).toBe('DEAD');
    // The reservation is released, since the spend never happened.
    expect(await db.select().from(spendLedger)).toHaveLength(0);
  });

  it('leaves completed actions alone', async () => {
    const world = await seedWorld();
    const adapter = adapterFor();
    await run(world, adapter, scaleDecision(world));
    expect(await reconcileInterrupted(await depsFor(world, adapter))).toBe(0);
  });
});
