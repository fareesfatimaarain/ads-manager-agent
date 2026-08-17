import { describe, expect, it } from 'vitest';
import { evaluateGuardrails } from '../../src/guardrails/engine.js';
import type { GuardrailRuleName } from '../../src/guardrails/types.js';
import {
  config,
  guardrailContext,
  killAction,
  mutateAction,
  NOW,
  scaleAction,
} from '../fixtures.js';

const ruleOf = (v: ReturnType<typeof evaluateGuardrails>, rule: GuardrailRuleName) => {
  const found = v.evaluations.find((e) => e.rule === rule);
  if (!found) throw new Error(`rule ${rule} was not evaluated at all`);
  return found;
};

describe('guardrails — happy paths', () => {
  it('allows a compliant kill and executes it autonomously', () => {
    const v = evaluateGuardrails(killAction(), guardrailContext());
    expect(v.allowed).toBe(true);
    expect(v.blockedBy).toBeNull();
    expect(v.requiresApproval).toBe(false);
  });

  it('allows a compliant scale but routes it to approval under the tiered default', () => {
    const v = evaluateGuardrails(scaleAction(), guardrailContext());
    expect(v.allowed).toBe(true);
    expect(v.requiresApproval).toBe(true);
  });

  it('executes a scale autonomously once the client is promoted', () => {
    const v = evaluateGuardrails(
      scaleAction(),
      guardrailContext({
        client: {
          id: 'client-1',
          autonomousKillEnabled: true,
          autonomousScaleEnabled: true,
          autonomousMutateEnabled: true,
        },
      }),
    );
    expect(v.allowed).toBe(true);
    expect(v.requiresApproval).toBe(false);
  });

  it('evaluates every rule on every action, so the audit record is complete', () => {
    const expected: GuardrailRuleName[] = [
      'EXECUTION_ENABLED',
      'ACCOUNT_HEALTHY',
      'AUTONOMY_TIER',
      'CURRENCY_DENOMINATION',
      'DATA_FRESHNESS',
      'ACTION_COOLDOWN',
      'MAX_ACTIONS_PER_CYCLE',
      'NO_TARGETING_CHANGES',
      'MAX_BUDGET_INCREASE_PCT',
      'MAX_BUDGET_DECREASE_PCT',
      'AD_SET_BUDGET_BOUNDS',
      'DAILY_AUTONOMOUS_INCREASE_CAP',
      'TOTAL_DAILY_BUDGET_CEILING',
      'PLATFORM_DAILY_SPEND_CAP',
      'MIN_ACTIVE_CAMPAIGNS',
      'NEVER_EMPTY_A_CAMPAIGN',
      'MAX_MUTATION_DEPTH',
      'BUDGET_VALUE_SANITY',
    ];
    for (const action of [killAction(), scaleAction(), mutateAction()]) {
      const v = evaluateGuardrails(action, guardrailContext());
      const seen = new Set(v.evaluations.map((e) => e.rule));
      for (const rule of expected) {
        expect(seen.has(rule), `${action.type} missing ${rule}`).toBe(true);
      }
    }
  });
});

describe('guardrails — the master switch and account health', () => {
  it('blocks everything when execution is disabled', () => {
    for (const action of [killAction(), scaleAction(), mutateAction()]) {
      const v = evaluateGuardrails(action, guardrailContext({ executionEnabled: false }));
      expect(v.allowed).toBe(false);
      expect(v.blockedBy).toBe('EXECUTION_ENABLED');
    }
  });

  it('blocks when the ad account token has expired', () => {
    const v = evaluateGuardrails(
      scaleAction(),
      guardrailContext({
        account: { id: 'a', status: 'TOKEN_EXPIRED', currency: 'USD', platformDailySpendCapCents: null },
      }),
    );
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe('ACCOUNT_HEALTHY');
  });
});

describe('guardrails — budget movement', () => {
  it('permits exactly the capped increase', () => {
    // 3000 -> 3600 is exactly +20%.
    const v = evaluateGuardrails(scaleAction({ targetBudgetCents: 3_600 }), guardrailContext());
    expect(ruleOf(v, 'MAX_BUDGET_INCREASE_PCT').passed).toBe(true);
    expect(v.allowed).toBe(true);
  });

  it('blocks one cent past the cap', () => {
    const v = evaluateGuardrails(scaleAction({ targetBudgetCents: 3_601 }), guardrailContext());
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe('MAX_BUDGET_INCREASE_PCT');
  });

  it('blocks a lump jump outright rather than clamping it', () => {
    const v = evaluateGuardrails(scaleAction({ targetBudgetCents: 30_000 }), guardrailContext());
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe('MAX_BUDGET_INCREASE_PCT');
    // The verdict carries no rewritten budget — guardrails never negotiate.
    expect(v).not.toHaveProperty('adjustedAction');
  });

  it('blocks a budget below the per-ad-set floor', () => {
    const v = evaluateGuardrails(
      scaleAction({ currentBudgetCents: 400, targetBudgetCents: 450 }),
      guardrailContext(),
    );
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe('AD_SET_BUDGET_BOUNDS');
  });

  it('blocks a budget above the per-ad-set ceiling', () => {
    const v = evaluateGuardrails(
      scaleAction({ currentBudgetCents: 45_000, targetBudgetCents: 54_000 }),
      guardrailContext({ clientTotalDailyBudgetCents: 45_000 }),
    );
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe('AD_SET_BUDGET_BOUNDS');
  });

  it('fails closed on a zero current budget instead of dividing by zero', () => {
    const v = evaluateGuardrails(
      scaleAction({ currentBudgetCents: 0, targetBudgetCents: 1_000 }),
      guardrailContext(),
    );
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe('MAX_BUDGET_INCREASE_PCT');
    expect(ruleOf(v, 'MAX_BUDGET_INCREASE_PCT').detail).toMatch(/cannot compute a percentage/);
  });

  it('rejects NaN and Infinity budgets rather than comparing them to a limit', () => {
    for (const bad of [NaN, Infinity, -1, 1.5]) {
      const v = evaluateGuardrails(
        scaleAction({ currentBudgetCents: 3_000, targetBudgetCents: bad }),
        guardrailContext(),
      );
      expect(v.allowed, `budget ${bad} should be refused`).toBe(false);
    }
  });

  it('checks the decrease cap when a scale action lowers a budget', () => {
    const v = evaluateGuardrails(
      scaleAction({ currentBudgetCents: 10_000, targetBudgetCents: 1_000 }),
      guardrailContext({ clientTotalDailyBudgetCents: 20_000 }),
    );
    expect(ruleOf(v, 'MAX_BUDGET_DECREASE_PCT').passed).toBe(false);
    expect(v.allowed).toBe(false);
  });
});

describe('guardrails — spend caps', () => {
  it('blocks when the daily autonomous increase cap is exhausted', () => {
    const v = evaluateGuardrails(
      scaleAction({ currentBudgetCents: 3_000, targetBudgetCents: 3_600 }),
      guardrailContext({ todayAutonomousIncreaseCents: 19_900 }),
    );
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe('DAILY_AUTONOMOUS_INCREASE_CAP');
  });

  it('allows an increase that exactly consumes the remaining daily headroom', () => {
    const v = evaluateGuardrails(
      scaleAction({ currentBudgetCents: 3_000, targetBudgetCents: 3_600 }),
      guardrailContext({ todayAutonomousIncreaseCents: 19_400 }),
    );
    expect(ruleOf(v, 'DAILY_AUTONOMOUS_INCREASE_CAP').passed).toBe(true);
  });

  it('counts only the increase, not the whole budget, against the daily cap', () => {
    // A $30 -> $36 move consumes $6 of headroom, not $36.
    const v = evaluateGuardrails(
      scaleAction({ currentBudgetCents: 3_000, targetBudgetCents: 3_600 }),
      guardrailContext({ todayAutonomousIncreaseCents: 0 }),
    );
    expect(ruleOf(v, 'DAILY_AUTONOMOUS_INCREASE_CAP').observed).toBe(600);
  });

  it('counts a mutant launch budget in full against the daily cap', () => {
    // A new ad set is entirely new spend, so all of it consumes headroom.
    const v = evaluateGuardrails(
      mutateAction({ newAdSetBudgetCents: 3_000 }),
      guardrailContext({ todayAutonomousIncreaseCents: 0 }),
    );
    expect(ruleOf(v, 'DAILY_AUTONOMOUS_INCREASE_CAP').observed).toBe(3_000);
  });

  it('blocks when the absolute total daily budget ceiling would be breached', () => {
    const v = evaluateGuardrails(
      scaleAction({ currentBudgetCents: 3_000, targetBudgetCents: 3_600 }),
      guardrailContext({ clientTotalDailyBudgetCents: 99_800 }),
    );
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe('TOTAL_DAILY_BUDGET_CEILING');
  });

  it('enforces the daily cap and the absolute ceiling independently', () => {
    // Under the delta cap, over the absolute ceiling.
    const v = evaluateGuardrails(
      scaleAction({ currentBudgetCents: 3_000, targetBudgetCents: 3_100 }),
      guardrailContext({
        todayAutonomousIncreaseCents: 0,
        clientTotalDailyBudgetCents: 99_950,
      }),
    );
    expect(ruleOf(v, 'DAILY_AUTONOMOUS_INCREASE_CAP').passed).toBe(true);
    expect(ruleOf(v, 'TOTAL_DAILY_BUDGET_CEILING').passed).toBe(false);
    expect(v.allowed).toBe(false);
  });

  it('respects a platform-imposed daily cap below our own ceiling', () => {
    const v = evaluateGuardrails(
      scaleAction({ currentBudgetCents: 3_000, targetBudgetCents: 3_600 }),
      guardrailContext({
        clientTotalDailyBudgetCents: 20_000,
        account: {
          id: 'a',
          status: 'ACTIVE',
          currency: 'USD',
          platformDailySpendCapCents: 20_100,
        },
      }),
    );
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe('PLATFORM_DAILY_SPEND_CAP');
  });
});

describe('guardrails — the hard blacklist', () => {
  it('refuses to kill the last active variant in a campaign', () => {
    const v = evaluateGuardrails(
      killAction(),
      guardrailContext({ activeVariantsInCampaign: 1 }),
    );
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe('NEVER_EMPTY_A_CAMPAIGN');
  });

  it('refuses to drop the client below the active-campaign floor', () => {
    const v = evaluateGuardrails(
      killAction(),
      guardrailContext({ activeVariantsInCampaign: 1, activeCampaignCount: 1 }),
    );
    expect(v.allowed).toBe(false);
    // Both protections fire; the first in evaluation order is reported.
    expect(ruleOf(v, 'MIN_ACTIVE_CAMPAIGNS').passed).toBe(false);
    expect(ruleOf(v, 'NEVER_EMPTY_A_CAMPAIGN').passed).toBe(false);
  });

  it('refuses any targeting change regardless of configuration', () => {
    // Even with the permissive column set true, the action is refused.
    const v = evaluateGuardrails(
      scaleAction(),
      guardrailContext({
        touchesTargeting: true,
        config: config({ allowTargetingChanges: true }),
      }),
    );
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe('NO_TARGETING_CHANGES');
  });

  it('stops a mutation chain at the configured depth', () => {
    const v = evaluateGuardrails(
      mutateAction({ parentMutationDepth: 2 }),
      guardrailContext(),
    );
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe('MAX_MUTATION_DEPTH');
  });
});

describe('guardrails — data freshness and rate limiting', () => {
  it('blocks when no performance snapshot backs the decision', () => {
    const v = evaluateGuardrails(
      killAction(),
      guardrailContext({ newestPerformanceFetchedAt: null }),
    );
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe('DATA_FRESHNESS');
  });

  it('blocks on stale performance data', () => {
    const v = evaluateGuardrails(
      killAction(),
      guardrailContext({
        newestPerformanceFetchedAt: new Date(NOW.getTime() - 48 * 3_600_000),
      }),
    );
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe('DATA_FRESHNESS');
  });

  it('blocks on a future-dated snapshot rather than treating it as very fresh', () => {
    const v = evaluateGuardrails(
      killAction(),
      guardrailContext({
        newestPerformanceFetchedAt: new Date(NOW.getTime() + 5 * 3_600_000),
      }),
    );
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe('DATA_FRESHNESS');
    expect(ruleOf(v, 'DATA_FRESHNESS').detail).toMatch(/future/);
  });

  it('blocks a second action on the same variant inside the cooldown', () => {
    const v = evaluateGuardrails(
      killAction(),
      guardrailContext({ lastActionAtForVariant: new Date(NOW.getTime() - 3 * 3_600_000) }),
    );
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe('ACTION_COOLDOWN');
  });

  it('allows once the cooldown has elapsed', () => {
    const v = evaluateGuardrails(
      killAction(),
      guardrailContext({ lastActionAtForVariant: new Date(NOW.getTime() - 25 * 3_600_000) }),
    );
    expect(v.allowed).toBe(true);
  });

  it('blocks once the per-cycle action cap is reached', () => {
    const v = evaluateGuardrails(
      killAction(),
      guardrailContext({ actionsAlreadyThisCycle: 10 }),
    );
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe('MAX_ACTIONS_PER_CYCLE');
  });
});

describe('guardrails — currency', () => {
  it('blocks money movement for a client spanning multiple currencies', () => {
    const v = evaluateGuardrails(
      scaleAction(),
      guardrailContext({ guardrailDenominationCurrency: null }),
    );
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe('CURRENCY_DENOMINATION');
  });

  it('still permits a kill for a multi-currency client, since it moves no money', () => {
    const v = evaluateGuardrails(
      killAction(),
      guardrailContext({ guardrailDenominationCurrency: null }),
    );
    expect(v.allowed).toBe(true);
  });

  it('blocks a mismatch between limit currency and account currency', () => {
    const v = evaluateGuardrails(
      scaleAction(),
      guardrailContext({
        guardrailDenominationCurrency: 'USD',
        account: { id: 'a', status: 'ACTIVE', currency: 'EUR', platformDailySpendCapCents: null },
      }),
    );
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe('CURRENCY_DENOMINATION');
  });
});

describe('guardrails — structural properties', () => {
  it('reports the first failing rule but records all of them', () => {
    const v = evaluateGuardrails(
      scaleAction({ targetBudgetCents: 99_999 }),
      guardrailContext({ executionEnabled: false, actionsAlreadyThisCycle: 99 }),
    );
    expect(v.blockedBy).toBe('EXECUTION_ENABLED');
    const failures = v.evaluations.filter((e) => e.applicable && !e.passed);
    expect(failures.length).toBeGreaterThan(1);
  });

  it('never sets requiresApproval on a blocked action', () => {
    const v = evaluateGuardrails(
      scaleAction({ targetBudgetCents: 99_999 }),
      guardrailContext(),
    );
    expect(v.allowed).toBe(false);
    expect(v.requiresApproval).toBe(false);
  });

  it('treats skipped rules as passing without marking them applicable', () => {
    const v = evaluateGuardrails(killAction(), guardrailContext());
    const skippedRule = ruleOf(v, 'MAX_BUDGET_INCREASE_PCT');
    expect(skippedRule.applicable).toBe(false);
    expect(skippedRule.passed).toBe(true);
  });
});
