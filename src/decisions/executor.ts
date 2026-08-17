/**
 * The execution path: the only route from a decision to a change in a real ad account.
 *
 * ORDERING GUARANTEE
 * ------------------
 * A single database transaction commits, before any platform call is made:
 *
 *   - the `decisions_log` row, with its evidence, reasoning and guardrail results
 *   - the `spend_ledger` reservation, when the action increases spend
 *   - the `platform_actions` row carrying the idempotency key
 *
 * Only after that commit does anything reach the platform. This is the "logged before it
 * executes" non-negotiable made structural: there is no code path that mutates an account
 * without a committed record, because the record is written by a different, earlier statement
 * in a transaction the mutation cannot proceed without.
 *
 * The failure this ordering deliberately accepts is a record of an action that did not finish.
 * That is recoverable — `reconcileInterrupted` finds it and asks the platform what actually
 * happened. The opposite ordering would produce spend nobody can account for, which is not.
 *
 * CONCURRENCY
 * -----------
 * Headroom is recomputed from the ledger inside the transaction, under a per-client advisory
 * lock. Without the lock two concurrent cycles could each read the same remaining headroom and
 * each approve an increase that only fits once.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { adSets, campaigns, decisionsLog, platformActions, spendLedger } from '../db/schema.js';
import { evaluateGuardrails } from '../guardrails/engine.js';
import type { GuardrailContext, ProposedAction } from '../guardrails/types.js';
import type { PlatformAdapter, AdapterContext } from '../platform/types.js';
import { PlatformPreconditionFailedError } from '../platform/errors.js';
import { asPlatformError, CircuitBreaker, withRetry, type RetryOptions } from '../platform/resilience.js';
import { ENGINE_VERSION, RULESET_VERSION } from './engine.js';
import type { VariantDecision } from './types.js';
import { createHash } from 'node:crypto';

export type ExecutionOutcome =
  | 'EXECUTED'
  | 'PENDING_APPROVAL'
  | 'BLOCKED'
  | 'FAILED'
  | 'DEAD_LETTERED';

export interface ExecutionResult {
  readonly decisionId: string;
  readonly outcome: ExecutionOutcome;
  readonly blockedBy: string | null;
  readonly error: string | null;
  readonly idempotencyKey: string;
}

export interface ExecutorDeps {
  readonly db: Database;
  readonly adapter: PlatformAdapter;
  readonly adapterContext: AdapterContext;
  readonly breaker: CircuitBreaker;
  readonly retry?: RetryOptions;
  readonly now: () => Date;
}

/**
 * Deterministic idempotency key.
 *
 * Derived from the intended *effect*, not from a random value, so a cycle re-run after a crash
 * produces the same key and the platform (or our reconciliation) recognises the repeat. The
 * cycle id is included because a genuinely new decision in a later cycle must be a new action,
 * even if it happens to propose the same numbers.
 */
export function idempotencyKeyFor(
  cycleId: string,
  action: ProposedAction,
): string {
  const effect =
    action.type === 'SCALE'
      ? `SCALE:${action.adSetId}:${action.targetBudgetCents}`
      : action.type === 'KILL'
        ? `KILL:${action.platformEntityId}`
        : `MUTATE:${action.variantId}:${action.mutatedField}:${action.newAdSetBudgetCents}`;
  return createHash('sha256').update(`${cycleId}|${effect}`).digest('hex').slice(0, 48);
}

/** 64-bit advisory lock id derived from the client id. */
function advisoryLockKey(clientId: string): bigint {
  const digest = createHash('sha256').update(clientId).digest();
  // Take 63 bits so the value always fits a signed bigint.
  return BigInt(`0x${digest.subarray(0, 8).toString('hex')}`) & 0x7fffffffffffffffn;
}

interface PreparedDecision {
  readonly decisionId: string;
  readonly idempotencyKey: string;
  readonly shouldExecute: boolean;
  readonly outcome: ExecutionOutcome | null;
  readonly blockedBy: string | null;
}

/**
 * Phase one: evaluate guardrails against freshly-read state and commit the record.
 * Nothing here touches the platform.
 */
async function prepare(
  deps: ExecutorDeps,
  decision: VariantDecision,
  baseContext: Omit<GuardrailContext, 'todayAutonomousIncreaseCents' | 'clientTotalDailyBudgetCents'>,
  cycleId: string,
  ledgerDate: string,
  adAccountId: string,
): Promise<PreparedDecision> {
  const action = decision.proposedAction;
  if (action === null) throw new Error('prepare() called for a decision with no action');

  const idempotencyKey = idempotencyKeyFor(cycleId, action);
  const clientId = baseContext.client.id;

  return deps.db.transaction(async (tx) => {
    // Serialise all spend accounting for this client.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${advisoryLockKey(clientId)})`);

    // Recompute headroom from committed state rather than trusting what the cycle computed
    // earlier — another cycle, or a human, may have moved things in between.
    const ledgerRows = await tx
      .select({
        total: sql<string>`COALESCE(SUM(${spendLedger.deltaCents}), 0)`,
      })
      .from(spendLedger)
      .where(and(eq(spendLedger.clientId, clientId), eq(spendLedger.ledgerDate, ledgerDate)));
    const todayIncrease = Number(ledgerRows[0]?.total ?? 0);

    // Must be scoped to THIS client. Summing every client's ad sets would compare one
    // client's proposed increase against the whole platform's spend, making the ceiling
    // meaningless for small clients and unreachable for large ones.
    const budgetRows = await tx
      .select({ total: sql<string>`COALESCE(SUM(${adSets.dailyBudgetCents}), 0)` })
      .from(adSets)
      .innerJoin(campaigns, eq(adSets.campaignId, campaigns.id))
      .where(and(eq(adSets.status, 'ACTIVE'), eq(campaigns.clientId, clientId)));
    const clientTotalDailyBudgetCents = Number(budgetRows[0]?.total ?? 0);

    const ctx: GuardrailContext = {
      ...baseContext,
      todayAutonomousIncreaseCents: todayIncrease,
      clientTotalDailyBudgetCents,
    };

    const verdict = evaluateGuardrails(action, ctx);

    const status = !verdict.allowed
      ? 'BLOCKED'
      : verdict.requiresApproval
        ? 'PENDING_APPROVAL'
        : 'PENDING_EXECUTION';

    const expiresAt =
      status === 'PENDING_APPROVAL'
        ? new Date(deps.now().getTime() + ctx.config.approvalExpiryHours * 3_600_000)
        : null;

    const inserted = await tx
      .insert(decisionsLog)
      .values({
        clientId,
        adVariantId: decision.variantId,
        guardrailConfigId: ctx.config.id,
        cycleId,
        decisionType: decision.kind === 'NO_ACTION' ? 'NO_ACTION' : decision.kind,
        status,
        triggeringData: decision.evidence as unknown as object,
        statisticalEvidence: {
          reasonCode: decision.reasonCode,
          proxyTest: decision.evidence.proxyTest,
          outcomeTest: decision.evidence.outcomeTest,
          probabilityMeetsCpaTarget: decision.evidence.probabilityMeetsCpaTarget,
          roasLowerBound: decision.evidence.roasLowerBound,
          evaluationsProxy: decision.newEvaluationsProxy,
          evaluationsOutcome: decision.newEvaluationsOutcome,
        } as unknown as object,
        guardrailEvaluations: verdict.evaluations as unknown as object,
        proposedAction: action as unknown as object,
        reasoning: decision.humanSummary,
        blockedByRule: verdict.blockedBy,
        blockedReason: verdict.blockedReason,
        idempotencyKey,
        engineVersion: ENGINE_VERSION,
        rulesetVersion: RULESET_VERSION,
        expiresAt,
      })
      .returning({ id: decisionsLog.id });

    const decisionId = inserted[0]!.id;

    if (status !== 'PENDING_EXECUTION') {
      return {
        decisionId,
        idempotencyKey,
        shouldExecute: false,
        outcome: status === 'BLOCKED' ? ('BLOCKED' as const) : ('PENDING_APPROVAL' as const),
        blockedBy: verdict.blockedBy,
      };
    }

    // Reserve the spend now, in the same transaction. Reserving after the platform call would
    // leave a window in which a concurrent cycle sees headroom that is already committed.
    const increase =
      action.type === 'SCALE'
        ? Math.max(0, action.targetBudgetCents - action.currentBudgetCents)
        : action.type === 'MUTATE'
          ? action.newAdSetBudgetCents
          : 0;

    if (increase > 0) {
      await tx.insert(spendLedger).values({
        clientId,
        adAccountId,
        decisionId,
        ledgerDate,
        deltaCents: increase,
        currency: ctx.account.currency,
      });
    }

    await tx.insert(platformActions).values({
      decisionId,
      adAccountId,
      platform: deps.adapter.platform,
      method: action.type === 'SCALE' ? 'updateBudget' : action.type === 'KILL' ? 'pauseAd' : 'createAdSet',
      requestPayload: action as unknown as object,
      idempotencyKey,
      status: 'PENDING',
      maxAttempts: deps.retry?.maxAttempts ?? 5,
    });

    return { decisionId, idempotencyKey, shouldExecute: true, outcome: null, blockedBy: null };
  });
}

/** Phase two: perform the platform call. Only reached once phase one has committed. */
async function performAction(
  deps: ExecutorDeps,
  decision: VariantDecision,
  prepared: PreparedDecision,
): Promise<void> {
  const action = decision.proposedAction!;
  const breakerKey = `${deps.adapter.platform}:${deps.adapterContext.adAccountId}`;

  await deps.db
    .update(platformActions)
    .set({ status: 'IN_FLIGHT', startedAt: deps.now() })
    .where(eq(platformActions.idempotencyKey, prepared.idempotencyKey));

  await deps.breaker.run(breakerKey, async () => {
    await withRetry(async (attempt) => {
      // Before any RETRY, ask the platform whether the previous attempt actually landed.
      // Skipping this is precisely how a timed-out-but-applied budget change gets doubled.
      if (attempt > 1) {
        const prior = await deps.adapter.findPriorAttempt(
          prepared.idempotencyKey,
          deps.adapterContext,
        );
        if (prior.found) return;
      }

      await deps.db
        .update(platformActions)
        .set({ attempts: sql`${platformActions.attempts} + 1` })
        .where(eq(platformActions.idempotencyKey, prepared.idempotencyKey));

      if (action.type === 'SCALE') {
        await deps.adapter.updateBudget(
          {
            idempotencyKey: prepared.idempotencyKey,
            platformAdSetId: action.platformEntityId,
            targetDailyBudgetCents: action.targetBudgetCents,
            expectedCurrentDailyBudgetCents: action.currentBudgetCents,
          },
          deps.adapterContext,
        );
      } else if (action.type === 'KILL') {
        await deps.adapter.pauseAd(
          {
            idempotencyKey: prepared.idempotencyKey,
            platformEntityId: action.platformEntityId,
            entityType: 'AD',
          },
          deps.adapterContext,
        );
      } else {
        // A mutant's new ad set is created here; its creative is produced upstream.
        throw new Error('MUTATE execution is handled by the creative pipeline, not the executor');
      }
    }, deps.retry ?? undefined);
  });
}

/**
 * Runs one decision end to end.
 *
 * Never throws for an expected failure — every outcome, including a dead letter, is recorded
 * and returned. An action that could not complete is surfaced to a human rather than lost.
 */
export async function executeDecision(
  deps: ExecutorDeps,
  decision: VariantDecision,
  baseContext: Omit<GuardrailContext, 'todayAutonomousIncreaseCents' | 'clientTotalDailyBudgetCents'>,
  cycleId: string,
  ledgerDate: string,
  adAccountId: string,
): Promise<ExecutionResult> {
  if (decision.proposedAction === null) {
    throw new Error(`decision for ${decision.variantId} carries no action`);
  }

  const prepared = await prepare(deps, decision, baseContext, cycleId, ledgerDate, adAccountId);

  if (!prepared.shouldExecute) {
    return {
      decisionId: prepared.decisionId,
      outcome: prepared.outcome!,
      blockedBy: prepared.blockedBy,
      error: null,
      idempotencyKey: prepared.idempotencyKey,
    };
  }

  await deps.db
    .update(decisionsLog)
    .set({ status: 'EXECUTING', executionStartedAt: deps.now() })
    .where(eq(decisionsLog.id, prepared.decisionId));

  try {
    await performAction(deps, decision, prepared);

    await deps.db
      .update(decisionsLog)
      .set({ status: 'EXECUTED', executedAt: deps.now() })
      .where(eq(decisionsLog.id, prepared.decisionId));
    await deps.db
      .update(platformActions)
      .set({ status: 'SUCCEEDED', completedAt: deps.now() })
      .where(eq(platformActions.idempotencyKey, prepared.idempotencyKey));

    return {
      decisionId: prepared.decisionId,
      outcome: 'EXECUTED',
      blockedBy: null,
      error: null,
      idempotencyKey: prepared.idempotencyKey,
    };
  } catch (error) {
    const platformError = asPlatformError(error, {
      platform: deps.adapter.platform,
      method: decision.kind,
      idempotencyKey: prepared.idempotencyKey,
    });

    // Reaching here means retries were exhausted, or the error was one we refuse to retry.
    // Either way the action is over and a human must look at it; nothing is retried silently
    // on the next cycle, because the original evidence is by then stale.
    await deps.db
      .update(decisionsLog)
      .set({ status: 'FAILED', failureReason: platformError.message })
      .where(eq(decisionsLog.id, prepared.decisionId));

    await deps.db
      .update(platformActions)
      .set({ status: 'DEAD', lastError: platformError.message, completedAt: deps.now() })
      .where(eq(platformActions.idempotencyKey, prepared.idempotencyKey));

    // A precondition failure means the platform state moved; the reservation must not stand,
    // or the client loses headroom for a change that never happened.
    if (platformError instanceof PlatformPreconditionFailedError) {
      await deps.db.delete(spendLedger).where(eq(spendLedger.decisionId, prepared.decisionId));
    }

    return {
      decisionId: prepared.decisionId,
      outcome: 'DEAD_LETTERED',
      blockedBy: null,
      error: platformError.message,
      idempotencyKey: prepared.idempotencyKey,
    };
  }
}

/**
 * Startup recovery for actions interrupted mid-flight.
 *
 * A crash between the phase-one commit and the platform responding leaves a row in EXECUTING
 * or IN_FLIGHT. We cannot tell from our own records whether the platform applied the change,
 * so we ask it. This is the reason `findPriorAttempt` is part of the adapter contract rather
 * than an optimisation.
 */
export async function reconcileInterrupted(deps: ExecutorDeps): Promise<number> {
  const stranded = await deps.db
    .select({
      id: platformActions.id,
      decisionId: platformActions.decisionId,
      idempotencyKey: platformActions.idempotencyKey,
    })
    .from(platformActions)
    .where(and(eq(platformActions.status, 'IN_FLIGHT'), isNull(platformActions.completedAt)));

  let reconciled = 0;
  for (const row of stranded) {
    const prior = await deps.adapter.findPriorAttempt(row.idempotencyKey, deps.adapterContext);

    if (prior.found) {
      await deps.db
        .update(platformActions)
        .set({ status: 'SUCCEEDED', completedAt: deps.now() })
        .where(eq(platformActions.id, row.id));
      await deps.db
        .update(decisionsLog)
        .set({ status: 'EXECUTED', executedAt: deps.now() })
        .where(eq(decisionsLog.id, row.decisionId));
    } else {
      // Genuinely never applied. Dead-letter it and release the reservation rather than
      // silently retrying something whose original context is now stale.
      await deps.db
        .update(platformActions)
        .set({
          status: 'DEAD',
          lastError: 'interrupted before completion; platform reports no prior attempt',
          completedAt: deps.now(),
        })
        .where(eq(platformActions.id, row.id));
      await deps.db
        .update(decisionsLog)
        .set({ status: 'FAILED', failureReason: 'interrupted before completion' })
        .where(eq(decisionsLog.id, row.decisionId));
      await deps.db.delete(spendLedger).where(eq(spendLedger.decisionId, row.decisionId));
    }
    reconciled += 1;
  }
  return reconciled;
}

/** Actions awaiting human attention. Nothing is ever dropped silently. */
export async function listDeadLetters(db: Database) {
  return db
    .select()
    .from(platformActions)
    .where(and(eq(platformActions.status, 'DEAD'), isNull(platformActions.acknowledgedAt)));
}
