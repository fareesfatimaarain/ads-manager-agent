/**
 * The autonomous decision cycle: one pass over every active client.
 *
 * This is the thing that makes the system run without a person driving it. It is deliberately
 * a plain function rather than a job handler, so it can be invoked from cron, from a queue
 * worker, or directly from a test with no infrastructure.
 *
 * Failure isolation is per-client and per-cohort: one client's expired token, or one cohort's
 * missing performance data, must not stop every other client's cycle. Errors are collected
 * and reported, never thrown out of the loop.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import {
  adAccounts,
  adSets,
  adVariants,
  campaigns,
  clients,
  guardrailConfigs,
  testCohorts,
} from '../db/schema.js';
import { parseGuardrailConfig } from '../guardrails/config.js';
import { decideCohort } from '../decisions/engine.js';
import { executeDecision, type ExecutorDeps } from '../decisions/executor.js';
import { loadVariantPerformance, variantsWithMissingData } from '../performance/reader.js';
import { currentDateInZone } from '../time/zonedDate.js';
import { CircuitBreaker } from '../platform/resilience.js';
import type { PlatformAdapter } from '../platform/types.js';
import type { CohortInput, VariantMetrics } from '../decisions/types.js';
import type { GuardrailContext } from '../guardrails/types.js';
import { env } from '../config/env.js';

export interface CycleOptions {
  readonly db: Database;
  /** Resolves the adapter for an ad account. Injected so tests can supply the mock. */
  readonly adapterFor: (adAccountId: string) => Promise<{
    adapter: PlatformAdapter;
    accessToken: string;
  }>;
  readonly now?: () => Date;
  readonly lookbackDays?: number;
}

export interface CycleResult {
  readonly cycleId: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly clientsProcessed: number;
  readonly cohortsEvaluated: number;
  readonly cohortsSkipped: number;
  readonly decisions: { kind: string; outcome: string; variantId: string }[];
  readonly errors: { scope: string; id: string; message: string }[];
}

export async function runDecisionCycle(options: CycleOptions): Promise<CycleResult> {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const cycleId = randomUUID();
  const startedAt = now();

  const result: {
    clientsProcessed: number;
    cohortsEvaluated: number;
    cohortsSkipped: number;
    decisions: { kind: string; outcome: string; variantId: string }[];
    errors: { scope: string; id: string; message: string }[];
  } = {
    clientsProcessed: 0,
    cohortsEvaluated: 0,
    cohortsSkipped: 0,
    decisions: [],
    errors: [],
  };

  const activeClients = await db
    .select()
    .from(clients)
    .where(and(isNull(clients.archivedAt), isNull(clients.automationPausedAt)));

  for (const client of activeClients) {
    try {
      await runClientCycle(options, client, cycleId, now, result);
      result.clientsProcessed += 1;
    } catch (error) {
      // One client's failure must never stop the others.
      result.errors.push({
        scope: 'client',
        id: client.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { cycleId, startedAt, finishedAt: now(), ...result };
}

async function runClientCycle(
  options: CycleOptions,
  client: typeof clients.$inferSelect,
  cycleId: string,
  now: () => Date,
  result: {
    cohortsEvaluated: number;
    cohortsSkipped: number;
    decisions: { kind: string; outcome: string; variantId: string }[];
    errors: { scope: string; id: string; message: string }[];
  },
): Promise<void> {
  const { db } = options;

  const [configRow] = await db
    .select()
    .from(guardrailConfigs)
    .where(and(eq(guardrailConfigs.clientId, client.id), isNull(guardrailConfigs.effectiveTo)));
  if (!configRow) throw new Error('client has no live guardrail configuration');
  const config = parseGuardrailConfig(configRow as unknown as Record<string, unknown>);

  const accountRows = await db
    .select()
    .from(adAccounts)
    .where(eq(adAccounts.clientId, client.id));

  const healthy = accountRows.filter((a) => a.status === 'ACTIVE');
  if (healthy.length === 0) throw new Error('no healthy ad accounts');

  // A client whose accounts span currencies cannot have a single cent-denominated cap
  // enforced; the guardrail engine blocks money movement when this is null.
  const currencies = new Set(healthy.map((a) => a.currency));
  const denomination = currencies.size === 1 ? [...currencies][0]! : null;

  const account = healthy[0]!;
  const timeZone = account.timezone;

  const cohortRows = await db
    .select({
      cohortId: testCohorts.id,
      campaignId: testCohorts.campaignId,
      objectiveType: campaigns.objectiveType,
      targetCpaCents: campaigns.targetCpaCents,
      targetRoas: campaigns.targetRoas,
    })
    .from(testCohorts)
    .innerJoin(campaigns, eq(testCohorts.campaignId, campaigns.id))
    .where(
      and(
        eq(campaigns.clientId, client.id),
        eq(testCohorts.status, 'RUNNING'),
        eq(campaigns.status, 'ACTIVE'),
      ),
    );

  // Client-wide state the guardrails need, read once per client.
  const [budgetRow] = await db
    .select({ total: sql<string>`COALESCE(SUM(${adSets.dailyBudgetCents}), 0)` })
    .from(adSets)
    .innerJoin(campaigns, eq(adSets.campaignId, campaigns.id))
    .where(sql`${campaigns.clientId} = ${client.id} AND ${adSets.status} = 'ACTIVE'`);
  const clientTotalDailyBudgetCents = Number(budgetRow?.total ?? 0);

  const [campaignCountRow] = await db
    .select({ n: sql<string>`COUNT(DISTINCT ${campaigns.id})` })
    .from(campaigns)
    .innerJoin(adVariants, eq(adVariants.campaignId, campaigns.id))
    .where(
      sql`${campaigns.clientId} = ${client.id}
          AND ${campaigns.status} = 'ACTIVE'
          AND ${adVariants.status} IN ('TESTING', 'SCALING')`,
    );
  let activeCampaignCount = Number(campaignCountRow?.n ?? 0);

  const { adapter, accessToken } = await options.adapterFor(account.id);
  const breaker = new CircuitBreaker();
  let actionsThisCycle = 0;

  for (const cohort of cohortRows) {
    try {
      const variantRows = await db
        .select({
          id: adVariants.id,
          adSetId: adVariants.adSetId,
          campaignId: adVariants.campaignId,
          platformAdId: adVariants.platformAdId,
          status: adVariants.status,
          testStartedAt: adVariants.testStartedAt,
          mutationDepth: sql<number>`0`,
          evaluationsProxy: adVariants.evaluationsProxy,
          evaluationsOutcome: adVariants.evaluationsOutcome,
          lastActionAt: adVariants.lastActionAt,
          dailyBudgetCents: adSets.dailyBudgetCents,
        })
        .from(adVariants)
        .innerJoin(adSets, eq(adVariants.adSetId, adSets.id))
        .where(
          and(
            eq(adVariants.cohortId, cohort.cohortId),
            sql`${adVariants.status} IN ('TESTING', 'SCALING')`,
          ),
        );

      if (variantRows.length === 0) {
        result.cohortsSkipped += 1;
        continue;
      }

      const variantIds = variantRows.map((v) => v.id);
      const performance = await loadVariantPerformance(db, variantIds, {
        timeZone,
        settlingHours: config.attributionSettlingHours,
        now: now(),
        lookbackDays: options.lookbackDays ?? 120,
      });

      const missing = variantsWithMissingData(
        performance,
        variantIds,
        config.maxPerformanceStalenessHours,
        now(),
      );

      const metrics: VariantMetrics[] = variantRows.map((v) => {
        const p = performance.get(v.id)!;
        return {
          variantId: v.id,
          adSetId: v.adSetId,
          campaignId: v.campaignId,
          platformAdId: v.platformAdId ?? '',
          status: v.status === 'SCALING' ? 'SCALING' : 'TESTING',
          settled: p.settled,
          proxy: p.proxy,
          settledDaily: p.settledDaily,
          testStartedAt: v.testStartedAt ?? now(),
          currentBudgetCents: v.dailyBudgetCents,
          mutationDepth: Number(v.mutationDepth ?? 0),
          evaluationsProxy: v.evaluationsProxy,
          evaluationsOutcome: v.evaluationsOutcome,
        };
      });

      const objectiveType = cohort.objectiveType ?? client.defaultObjectiveType;
      const targetCpa = cohort.targetCpaCents ?? client.defaultTargetCpaCents;
      const targetRoas = Number(cohort.targetRoas ?? client.defaultTargetRoas ?? 0);

      if (objectiveType === 'CPA' && (targetCpa === null || targetCpa <= 0)) {
        throw new Error(`cohort ${cohort.cohortId} has a CPA objective but no target`);
      }

      const input: CohortInput = {
        cohortId: cohort.cohortId,
        clientId: client.id,
        objective:
          objectiveType === 'CPA'
            ? { type: 'CPA', targetCpaCents: targetCpa! }
            : { type: 'ROAS', targetRoas },
        config,
        variants: metrics,
        variantsWithMissingData: missing,
        headroom: {
          // Recomputed authoritatively inside the executor's transaction; this is only used
          // to shape the proposal.
          todayAutonomousIncreaseCents: 0,
          clientTotalDailyBudgetCents,
          platformDailySpendCapCents: null,
        },
        now: now(),
      };

      const decision = decideCohort(input);
      if (decision.skipped) {
        result.cohortsSkipped += 1;
        continue;
      }
      result.cohortsEvaluated += 1;

      const activeInCampaign = variantRows.length;
      const ledgerDate = currentDateInZone(now(), timeZone);

      for (const d of decision.decisions) {
        // Persist the audit counters regardless of whether an action followed.
        await db
          .update(adVariants)
          .set({
            evaluationsProxy: d.newEvaluationsProxy,
            evaluationsOutcome: d.newEvaluationsOutcome,
            lastEvaluatedAt: now(),
          })
          .where(eq(adVariants.id, d.variantId));

        if (d.proposedAction === null) continue;
        // MUTATE needs the creative pipeline to produce the mutant; the executor refuses it
        // rather than pretending. Skip here so it does not dead-letter every cycle.
        if (d.kind === 'MUTATE') continue;

        const variantRow = variantRows.find((v) => v.id === d.variantId)!;

        const baseContext: Omit<
          GuardrailContext,
          'todayAutonomousIncreaseCents' | 'clientTotalDailyBudgetCents'
        > = {
          config,
          now: now(),
          executionEnabled: env.executionEnabled,
          client: {
            id: client.id,
            autonomousKillEnabled: client.autonomousKillEnabled,
            autonomousScaleEnabled: client.autonomousScaleEnabled,
            autonomousMutateEnabled: client.autonomousMutateEnabled,
          },
          account: {
            id: account.id,
            status: account.status,
            currency: account.currency,
            platformDailySpendCapCents: null,
          },
          activeCampaignCount,
          activeVariantsInCampaign: activeInCampaign,
          lastActionAtForVariant: variantRow.lastActionAt,
          actionsAlreadyThisCycle: actionsThisCycle,
          newestPerformanceFetchedAt: performance.get(d.variantId)?.newestFetchedAt ?? null,
          touchesTargeting: false,
          guardrailDenominationCurrency: denomination,
        };

        const deps: ExecutorDeps = {
          db,
          adapter,
          adapterContext: {
            adAccountId: account.id,
            platformAccountId: account.platformAccountId,
            accessToken,
            currency: account.currency,
            timezone: timeZone,
          },
          breaker,
          now,
        };

        const outcome = await executeDecision(
          deps,
          d,
          baseContext,
          cycleId,
          ledgerDate,
          account.id,
        );

        result.decisions.push({ kind: d.kind, outcome: outcome.outcome, variantId: d.variantId });
        if (outcome.outcome === 'EXECUTED') {
          actionsThisCycle += 1;
          await db
            .update(adVariants)
            .set({ lastActionAt: now() })
            .where(eq(adVariants.id, d.variantId));

          if (d.kind === 'KILL') {
            await db
              .update(adVariants)
              .set({ status: 'KILLED' })
              .where(eq(adVariants.id, d.variantId));
            await db
              .update(adSets)
              .set({ status: 'PAUSED' })
              .where(eq(adSets.id, variantRow.adSetId));
            if (activeInCampaign - 1 <= 0) activeCampaignCount -= 1;
          }
        }
      }
    } catch (error) {
      result.errors.push({
        scope: 'cohort',
        id: cohort.cohortId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
