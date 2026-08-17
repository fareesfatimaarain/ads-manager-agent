/**
 * Guardrail enforcement.
 *
 * Design rules, in order of importance:
 *
 *  1. **Guardrails block; they never clamp.** If the decision engine proposes a +30% increase
 *     against a +20% cap, that is a bug in the decision engine, and silently rewriting it to
 *     +20% would hide the bug while still moving money. Blocking surfaces it. The decision
 *     engine reads the same config and is responsible for proposing something already legal;
 *     this layer is independent verification at the point of execution, not a negotiator.
 *
 *  2. **Every rule is evaluated, always.** Short-circuiting on the first failure would produce
 *     an audit record that names one problem when there were four. The full evaluation set is
 *     what gets written to `decisions_log.guardrail_evaluations`.
 *
 *  3. **Unknown or missing state fails closed.** A null where a number was expected blocks the
 *     action. There is no code path where absent data is read as permission.
 *
 * This module is pure: no I/O, no clock reads, no DB. Everything arrives in the context, which
 * is what makes exhaustive testing of the money path possible.
 */
import type {
  GuardrailContext,
  GuardrailEvaluation,
  GuardrailRuleName,
  GuardrailVerdict,
  ProposedAction,
} from './types.js';

const HOUR_MS = 3_600_000;

function evaluation(
  rule: GuardrailRuleName,
  passed: boolean,
  applicable: boolean,
  detail: string,
  observed?: number | string | null,
  limit?: number | string | null,
): GuardrailEvaluation {
  return {
    rule,
    passed,
    applicable,
    detail,
    observed: observed ?? null,
    limit: limit ?? null,
  };
}

const skipped = (rule: GuardrailRuleName, why: string): GuardrailEvaluation =>
  evaluation(rule, true, false, `not applicable: ${why}`);

/** Rejects anything that is not a finite, non-negative, integral cent amount. */
function isSaneCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

export function evaluateGuardrails(
  action: ProposedAction,
  ctx: GuardrailContext,
): GuardrailVerdict {
  const cfg = ctx.config;
  const evaluations: GuardrailEvaluation[] = [];

  // -- 1. Master switch ------------------------------------------------------
  evaluations.push(
    evaluation(
      'EXECUTION_ENABLED',
      ctx.executionEnabled,
      true,
      ctx.executionEnabled
        ? 'execution is enabled'
        : 'EXECUTION_ENABLED is false; no mutation may proceed',
      String(ctx.executionEnabled),
      'true',
    ),
  );

  // -- 2. Account health -----------------------------------------------------
  const accountHealthy = ctx.account.status === 'ACTIVE';
  evaluations.push(
    evaluation(
      'ACCOUNT_HEALTHY',
      accountHealthy,
      true,
      accountHealthy
        ? 'ad account is ACTIVE'
        : `ad account status is ${ctx.account.status}; cannot mutate`,
      ctx.account.status,
      'ACTIVE',
    ),
  );

  // -- 3. Currency denomination ---------------------------------------------
  const movesMoney = action.type === 'SCALE' || action.type === 'MUTATE';
  if (!movesMoney) {
    evaluations.push(skipped('CURRENCY_DENOMINATION', 'action does not move money'));
  } else if (ctx.guardrailDenominationCurrency === null) {
    evaluations.push(
      evaluation(
        'CURRENCY_DENOMINATION',
        false,
        true,
        'client spans multiple account currencies; a single cent-denominated cap cannot be ' +
          'enforced without inventing an FX rate',
        ctx.account.currency,
        'single currency',
      ),
    );
  } else {
    const matches = ctx.guardrailDenominationCurrency === ctx.account.currency;
    evaluations.push(
      evaluation(
        'CURRENCY_DENOMINATION',
        matches,
        true,
        matches
          ? `limits and account are both denominated in ${ctx.account.currency}`
          : `guardrail limits are in ${ctx.guardrailDenominationCurrency} but the account is in ${ctx.account.currency}`,
        ctx.account.currency,
        ctx.guardrailDenominationCurrency,
      ),
    );
  }

  // -- 4. Data freshness -----------------------------------------------------
  if (ctx.newestPerformanceFetchedAt === null) {
    evaluations.push(
      evaluation(
        'DATA_FRESHNESS',
        false,
        true,
        'no performance snapshot backs this decision',
        null,
        `${cfg.maxPerformanceStalenessHours}h`,
      ),
    );
  } else {
    const ageHours = (ctx.now.getTime() - ctx.newestPerformanceFetchedAt.getTime()) / HOUR_MS;
    const fresh = ageHours <= cfg.maxPerformanceStalenessHours && ageHours >= 0;
    evaluations.push(
      evaluation(
        'DATA_FRESHNESS',
        fresh,
        true,
        fresh
          ? `performance data is ${ageHours.toFixed(1)}h old`
          : ageHours < 0
            ? 'performance snapshot is timestamped in the future; clock skew or corrupt data'
            : `performance data is ${ageHours.toFixed(1)}h old, exceeding the staleness limit`,
        Number(ageHours.toFixed(2)),
        cfg.maxPerformanceStalenessHours,
      ),
    );
  }

  // -- 5. Cooldown -----------------------------------------------------------
  if (ctx.lastActionAtForVariant === null) {
    evaluations.push(
      evaluation('ACTION_COOLDOWN', true, true, 'no prior action on this variant', null, cfg.actionCooldownHours),
    );
  } else {
    const sinceHours = (ctx.now.getTime() - ctx.lastActionAtForVariant.getTime()) / HOUR_MS;
    const passed = sinceHours >= cfg.actionCooldownHours;
    evaluations.push(
      evaluation(
        'ACTION_COOLDOWN',
        passed,
        true,
        passed
          ? `last action was ${sinceHours.toFixed(1)}h ago`
          : `last action was ${sinceHours.toFixed(1)}h ago, inside the ${cfg.actionCooldownHours}h cooldown`,
        Number(sinceHours.toFixed(2)),
        cfg.actionCooldownHours,
      ),
    );
  }

  // -- 6. Per-cycle action budget -------------------------------------------
  const underCycleCap = ctx.actionsAlreadyThisCycle < cfg.maxActionsPerCyclePerClient;
  evaluations.push(
    evaluation(
      'MAX_ACTIONS_PER_CYCLE',
      underCycleCap,
      true,
      underCycleCap
        ? `${ctx.actionsAlreadyThisCycle} of ${cfg.maxActionsPerCyclePerClient} cycle actions used`
        : `cycle action cap of ${cfg.maxActionsPerCyclePerClient} already reached`,
      ctx.actionsAlreadyThisCycle,
      cfg.maxActionsPerCyclePerClient,
    ),
  );

  // -- 7. Targeting is never touched autonomously ----------------------------
  // Hard blacklist. Note this ignores cfg.allowTargetingChanges entirely: the column exists so
  // the intent is auditable, but no configuration value can unlock this path.
  evaluations.push(
    evaluation(
      'NO_TARGETING_CHANGES',
      !ctx.touchesTargeting,
      true,
      ctx.touchesTargeting
        ? 'targeting changes always require human review and are refused unconditionally'
        : 'action does not alter targeting',
      String(ctx.touchesTargeting),
      'false',
    ),
  );

  // -- 8..13. Action-specific rules ------------------------------------------
  if (action.type === 'SCALE') {
    pushScaleRules(evaluations, action, ctx);
  } else {
    evaluations.push(skipped('MAX_BUDGET_INCREASE_PCT', 'not a scale'));
    evaluations.push(skipped('MAX_BUDGET_DECREASE_PCT', 'not a scale'));
  }

  if (action.type === 'SCALE' || action.type === 'MUTATE') {
    pushSpendRules(evaluations, action, ctx);
  } else {
    evaluations.push(skipped('AD_SET_BUDGET_BOUNDS', 'action does not set a budget'));
    evaluations.push(skipped('DAILY_AUTONOMOUS_INCREASE_CAP', 'action does not raise spend'));
    evaluations.push(skipped('TOTAL_DAILY_BUDGET_CEILING', 'action does not raise spend'));
    evaluations.push(skipped('PLATFORM_DAILY_SPEND_CAP', 'action does not raise spend'));
    evaluations.push(skipped('BUDGET_VALUE_SANITY', 'action carries no budget value'));
  }

  if (action.type === 'KILL') {
    pushKillRules(evaluations, ctx);
  } else {
    evaluations.push(skipped('MIN_ACTIVE_CAMPAIGNS', 'not a kill'));
    evaluations.push(skipped('NEVER_EMPTY_A_CAMPAIGN', 'not a kill'));
  }

  if (action.type === 'MUTATE') {
    const depthOk = action.parentMutationDepth < cfg.maxMutationDepth;
    evaluations.push(
      evaluation(
        'MAX_MUTATION_DEPTH',
        depthOk,
        true,
        depthOk
          ? `mutation depth ${action.parentMutationDepth} is within the limit`
          : `mutation depth ${action.parentMutationDepth} has reached the limit of ${cfg.maxMutationDepth}`,
        action.parentMutationDepth,
        cfg.maxMutationDepth,
      ),
    );
  } else {
    evaluations.push(skipped('MAX_MUTATION_DEPTH', 'not a mutate'));
  }

  // -- 14. Autonomy tier -----------------------------------------------------
  // This never blocks. It decides whether the action executes now or waits for a human.
  const autonomyAllowed =
    action.type === 'KILL'
      ? ctx.client.autonomousKillEnabled
      : action.type === 'SCALE'
        ? ctx.client.autonomousScaleEnabled
        : ctx.client.autonomousMutateEnabled;
  evaluations.push(
    evaluation(
      'AUTONOMY_TIER',
      true,
      true,
      autonomyAllowed
        ? `${action.type} may execute autonomously for this client`
        : `${action.type} requires human approval for this client`,
      String(autonomyAllowed),
      null,
    ),
  );

  const firstFailure = evaluations.find((e) => e.applicable && !e.passed);

  return {
    allowed: firstFailure === undefined,
    blockedBy: firstFailure?.rule ?? null,
    blockedReason: firstFailure?.detail ?? null,
    evaluations,
    requiresApproval: firstFailure === undefined && !autonomyAllowed,
  };
}

// ---------------------------------------------------------------------------

function pushScaleRules(
  out: GuardrailEvaluation[],
  action: Extract<ProposedAction, { type: 'SCALE' }>,
  ctx: GuardrailContext,
): void {
  const cfg = ctx.config;
  const current = action.currentBudgetCents;
  const target = action.targetBudgetCents;

  // A zero or negative current budget makes a percentage meaningless. Fail closed rather
  // than dividing by zero and producing Infinity, which would compare as "over the limit"
  // by luck rather than by design.
  if (!isSaneCents(current) || current <= 0) {
    out.push(
      evaluation(
        'MAX_BUDGET_INCREASE_PCT',
        false,
        true,
        `current budget ${String(current)} is not a positive integer cent amount; cannot compute a percentage change`,
        String(current),
        '> 0',
      ),
    );
    out.push(skipped('MAX_BUDGET_DECREASE_PCT', 'current budget invalid'));
    return;
  }

  const deltaPct = ((target - current) / current) * 100;

  if (target >= current) {
    const passed = deltaPct <= cfg.maxBudgetIncreasePct + 1e-9;
    out.push(
      evaluation(
        'MAX_BUDGET_INCREASE_PCT',
        passed,
        true,
        passed
          ? `+${deltaPct.toFixed(2)}% is within the ${cfg.maxBudgetIncreasePct}% cap`
          : `+${deltaPct.toFixed(2)}% exceeds the ${cfg.maxBudgetIncreasePct}% per-action cap`,
        Number(deltaPct.toFixed(4)),
        cfg.maxBudgetIncreasePct,
      ),
    );
    out.push(skipped('MAX_BUDGET_DECREASE_PCT', 'action increases budget'));
  } else {
    const dropPct = -deltaPct;
    const passed = dropPct <= cfg.maxBudgetDecreasePct + 1e-9;
    out.push(skipped('MAX_BUDGET_INCREASE_PCT', 'action decreases budget'));
    out.push(
      evaluation(
        'MAX_BUDGET_DECREASE_PCT',
        passed,
        true,
        passed
          ? `-${dropPct.toFixed(2)}% is within the ${cfg.maxBudgetDecreasePct}% cap`
          : `-${dropPct.toFixed(2)}% exceeds the ${cfg.maxBudgetDecreasePct}% per-action cap`,
        Number(dropPct.toFixed(4)),
        cfg.maxBudgetDecreasePct,
      ),
    );
  }
}

function pushSpendRules(
  out: GuardrailEvaluation[],
  action: Extract<ProposedAction, { type: 'SCALE' | 'MUTATE' }>,
  ctx: GuardrailContext,
): void {
  const cfg = ctx.config;

  const targetBudget =
    action.type === 'SCALE' ? action.targetBudgetCents : action.newAdSetBudgetCents;
  const currentBudget = action.type === 'SCALE' ? action.currentBudgetCents : 0;

  // Trust boundary: refuse anything that is not a clean integer cent value before it can be
  // compared against a limit. NaN in particular fails every `>` comparison, which would make
  // an unbounded value look compliant.
  const sane = isSaneCents(targetBudget) && targetBudget > 0;
  out.push(
    evaluation(
      'BUDGET_VALUE_SANITY',
      sane,
      true,
      sane
        ? `target budget ${targetBudget} is a valid positive integer cent amount`
        : `target budget ${String(targetBudget)} is not a valid positive integer cent amount`,
      String(targetBudget),
      'positive integer',
    ),
  );
  if (!sane) {
    out.push(skipped('AD_SET_BUDGET_BOUNDS', 'budget value failed sanity check'));
    out.push(skipped('DAILY_AUTONOMOUS_INCREASE_CAP', 'budget value failed sanity check'));
    out.push(skipped('TOTAL_DAILY_BUDGET_CEILING', 'budget value failed sanity check'));
    out.push(skipped('PLATFORM_DAILY_SPEND_CAP', 'budget value failed sanity check'));
    return;
  }

  // Per-ad-set bounds.
  const withinBounds =
    targetBudget >= cfg.minAdSetDailyBudgetCents && targetBudget <= cfg.maxAdSetDailyBudgetCents;
  out.push(
    evaluation(
      'AD_SET_BUDGET_BOUNDS',
      withinBounds,
      true,
      withinBounds
        ? `${targetBudget} sits within [${cfg.minAdSetDailyBudgetCents}, ${cfg.maxAdSetDailyBudgetCents}]`
        : `${targetBudget} is outside the permitted ad set range [${cfg.minAdSetDailyBudgetCents}, ${cfg.maxAdSetDailyBudgetCents}]`,
      targetBudget,
      `${cfg.minAdSetDailyBudgetCents}..${cfg.maxAdSetDailyBudgetCents}`,
    ),
  );

  // Daily autonomous increase cap. Only the *increase* consumes headroom.
  const increase = Math.max(0, targetBudget - currentBudget);
  const projectedIncrease = ctx.todayAutonomousIncreaseCents + increase;
  const underDailyCap = projectedIncrease <= cfg.maxDailyAutonomousIncreaseCents;
  out.push(
    evaluation(
      'DAILY_AUTONOMOUS_INCREASE_CAP',
      underDailyCap,
      true,
      underDailyCap
        ? `today's autonomous increases would reach ${projectedIncrease} of ${cfg.maxDailyAutonomousIncreaseCents}`
        : `this +${increase} would push today's autonomous increases to ${projectedIncrease}, over the ${cfg.maxDailyAutonomousIncreaseCents} cap`,
      projectedIncrease,
      cfg.maxDailyAutonomousIncreaseCents,
    ),
  );

  // Absolute ceiling on total live daily budget.
  const projectedTotal = ctx.clientTotalDailyBudgetCents - currentBudget + targetBudget;
  const underCeiling = projectedTotal <= cfg.maxTotalDailyBudgetCents;
  out.push(
    evaluation(
      'TOTAL_DAILY_BUDGET_CEILING',
      underCeiling,
      true,
      underCeiling
        ? `client total daily budget would be ${projectedTotal} of ${cfg.maxTotalDailyBudgetCents}`
        : `client total daily budget would reach ${projectedTotal}, over the ${cfg.maxTotalDailyBudgetCents} ceiling`,
      projectedTotal,
      cfg.maxTotalDailyBudgetCents,
    ),
  );

  // Platform-imposed cap, when the platform reports one.
  if (ctx.account.platformDailySpendCapCents === null) {
    out.push(skipped('PLATFORM_DAILY_SPEND_CAP', 'platform reports no daily spend cap'));
  } else {
    const underPlatformCap = projectedTotal <= ctx.account.platformDailySpendCapCents;
    out.push(
      evaluation(
        'PLATFORM_DAILY_SPEND_CAP',
        underPlatformCap,
        true,
        underPlatformCap
          ? `projected ${projectedTotal} is within the platform cap of ${ctx.account.platformDailySpendCapCents}`
          : `projected ${projectedTotal} exceeds the platform daily cap of ${ctx.account.platformDailySpendCapCents}`,
        projectedTotal,
        ctx.account.platformDailySpendCapCents,
      ),
    );
  }
}

function pushKillRules(out: GuardrailEvaluation[], ctx: GuardrailContext): void {
  const cfg = ctx.config;

  // Killing the last active variant in a campaign is functionally pausing that campaign.
  // The engine kills ads; humans pause campaigns. This is unconditional.
  const wouldEmptyCampaign = ctx.activeVariantsInCampaign <= 1;
  out.push(
    evaluation(
      'NEVER_EMPTY_A_CAMPAIGN',
      !wouldEmptyCampaign,
      true,
      wouldEmptyCampaign
        ? 'this is the last active variant in its campaign; killing it would pause the campaign, which requires a human'
        : `${ctx.activeVariantsInCampaign} active variants remain in this campaign`,
      ctx.activeVariantsInCampaign,
      '> 1',
    ),
  );

  // Belt and braces: even if the campaign would survive, never drop the client below the
  // configured floor of active campaigns.
  const campaignsAfter = wouldEmptyCampaign
    ? ctx.activeCampaignCount - 1
    : ctx.activeCampaignCount;
  const enoughCampaigns = campaignsAfter >= cfg.minActiveCampaigns;
  out.push(
    evaluation(
      'MIN_ACTIVE_CAMPAIGNS',
      enoughCampaigns,
      true,
      enoughCampaigns
        ? `${campaignsAfter} active campaigns would remain`
        : `only ${campaignsAfter} active campaigns would remain, below the floor of ${cfg.minActiveCampaigns}`,
      campaignsAfter,
      cfg.minActiveCampaigns,
    ),
  );
}
