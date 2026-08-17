/**
 * The boundary between a `guardrail_configs` row and a usable config object.
 *
 * Why this file exists: node-postgres returns `numeric` columns as STRINGS, deliberately, to
 * avoid silent precision loss. JavaScript then coerces them in most arithmetic — `"20" / 100`
 * is 0.2, which works — right up until an expression uses `+`, where `"20" + 5` is `"205"`.
 * A guardrail limit that silently becomes 205% instead of 25% is precisely the class of bug
 * this system cannot afford, and it would pass a type check, because the DB row type says
 * `string` and nobody looks.
 *
 * So: every numeric field is parsed explicitly, validated against a plausible range, and any
 * failure throws. A config that cannot be trusted must never reach the decision engine, and
 * failing at load time is far better than failing at spend time.
 */
import type { ResolvedGuardrailConfig } from './types.js';

export class GuardrailConfigError extends Error {
  constructor(
    message: string,
    readonly field: string,
    readonly rawValue: unknown,
  ) {
    super(`guardrail config field "${field}": ${message} (received ${JSON.stringify(rawValue)})`);
    this.name = 'GuardrailConfigError';
  }
}

function num(raw: unknown, field: string, min: number, max: number): number {
  if (raw === null || raw === undefined) {
    throw new GuardrailConfigError('is required but missing', field, raw);
  }
  // Accept a number or the string form a numeric column produces. Reject anything else,
  // including booleans and arrays, which would otherwise coerce to a plausible-looking value.
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new GuardrailConfigError('must be a number or numeric string', field, raw);
  }
  const parsed = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isFinite(parsed)) {
    throw new GuardrailConfigError('is not a finite number', field, raw);
  }
  if (parsed < min || parsed > max) {
    throw new GuardrailConfigError(`is outside the permitted range [${min}, ${max}]`, field, raw);
  }
  return parsed;
}

function int(raw: unknown, field: string, min: number, max: number): number {
  const parsed = num(raw, field, min, max);
  if (!Number.isInteger(parsed)) {
    throw new GuardrailConfigError('must be an integer', field, raw);
  }
  return parsed;
}

function bool(raw: unknown, field: string): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new GuardrailConfigError('must be a boolean', field, raw);
}

function str(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new GuardrailConfigError('must be a non-empty string', field, raw);
  }
  return raw;
}

/** Largest cent value we will accept anywhere: $10,000,000. A larger figure is a data error. */
const MAX_CENTS = 1_000_000_000;

export function parseGuardrailConfig(row: Record<string, unknown>): ResolvedGuardrailConfig {
  const cfg: ResolvedGuardrailConfig = {
    id: str(row.id, 'id'),
    clientId: str(row.clientId, 'clientId'),
    version: int(row.version, 'version', 1, 1_000_000),

    maxBudgetIncreasePct: num(row.maxBudgetIncreasePct, 'maxBudgetIncreasePct', 0.01, 100),
    maxBudgetDecreasePct: num(row.maxBudgetDecreasePct, 'maxBudgetDecreasePct', 0.01, 100),
    maxDailyAutonomousIncreaseCents: int(
      row.maxDailyAutonomousIncreaseCents,
      'maxDailyAutonomousIncreaseCents',
      0,
      MAX_CENTS,
    ),
    maxTotalDailyBudgetCents: int(
      row.maxTotalDailyBudgetCents,
      'maxTotalDailyBudgetCents',
      1,
      MAX_CENTS,
    ),
    minAdSetDailyBudgetCents: int(
      row.minAdSetDailyBudgetCents,
      'minAdSetDailyBudgetCents',
      1,
      MAX_CENTS,
    ),
    maxAdSetDailyBudgetCents: int(
      row.maxAdSetDailyBudgetCents,
      'maxAdSetDailyBudgetCents',
      1,
      MAX_CENTS,
    ),

    minRuntimeHours: int(row.minRuntimeHours, 'minRuntimeHours', 24, 24 * 365),
    minSpendMultipleOfTargetCpa: num(
      row.minSpendMultipleOfTargetCpa,
      'minSpendMultipleOfTargetCpa',
      0,
      100,
    ),
    minConversionsPerArm: int(row.minConversionsPerArm, 'minConversionsPerArm', 1, 100_000),
    minTestSpendCents: int(row.minTestSpendCents, 'minTestSpendCents', 1, MAX_CENTS),
    zeroConversionKillSpendCents: int(
      row.zeroConversionKillSpendCents,
      'zeroConversionKillSpendCents',
      1,
      MAX_CENTS,
    ),

    // Alpha bounds mirror the DB CHECK constraint. Anything looser than 0.2 is not a
    // significance test in any meaningful sense.
    killPThreshold: num(row.killPThreshold, 'killPThreshold', 0.0001, 0.2),
    scalePThreshold: num(row.scalePThreshold, 'scalePThreshold', 0.0001, 0.1),
    proxyKillMinImpressions: int(
      row.proxyKillMinImpressions,
      'proxyKillMinImpressions',
      500,
      10_000_000,
    ),
    proxyKillCtrDropPct: num(row.proxyKillCtrDropPct, 'proxyKillCtrDropPct', 1, 100),
    zeroConversionKillSpendMultiple: num(
      row.zeroConversionKillSpendMultiple,
      'zeroConversionKillSpendMultiple',
      0.1,
      100,
    ),
    roasScaleSafetyMargin: num(row.roasScaleSafetyMargin, 'roasScaleSafetyMargin', 1, 10),
    roasBootstrapMinDays: int(row.roasBootstrapMinDays, 'roasBootstrapMinDays', 2, 365),
    roasBootstrapIterations: int(row.roasBootstrapIterations, 'roasBootstrapIterations', 100, 100_000),
    mSprtTauRelative: num(row.mSprtTauRelative, 'mSprtTauRelative', 0.01, 10),

    mutateCpaBandMultiple: num(row.mutateCpaBandMultiple, 'mutateCpaBandMultiple', 1, 10),
    maxMutationDepth: int(row.maxMutationDepth, 'maxMutationDepth', 0, 10),
    mutateTestBudgetCents: int(row.mutateTestBudgetCents, 'mutateTestBudgetCents', 1, MAX_CENTS),
    allowScaleWithoutComparativeBaseline: bool(
      row.allowScaleWithoutComparativeBaseline,
      'allowScaleWithoutComparativeBaseline',
    ),

    actionCooldownHours: int(row.actionCooldownHours, 'actionCooldownHours', 0, 24 * 365),
    maxActionsPerCyclePerClient: int(
      row.maxActionsPerCyclePerClient,
      'maxActionsPerCyclePerClient',
      0,
      10_000,
    ),

    minActiveCampaigns: int(row.minActiveCampaigns, 'minActiveCampaigns', 0, 10_000),
    allowTargetingChanges: bool(row.allowTargetingChanges, 'allowTargetingChanges'),
    allowAudienceExpansion: bool(row.allowAudienceExpansion, 'allowAudienceExpansion'),
    allowCampaignCreation: bool(row.allowCampaignCreation, 'allowCampaignCreation'),

    attributionSettlingHours: int(
      row.attributionSettlingHours,
      'attributionSettlingHours',
      0,
      24 * 30,
    ),
    maxPerformanceStalenessHours: int(
      row.maxPerformanceStalenessHours,
      'maxPerformanceStalenessHours',
      1,
      24 * 30,
    ),

    approvalExpiryHours: int(row.approvalExpiryHours, 'approvalExpiryHours', 1, 24 * 30),
  };

  assertCoherent(cfg);
  return cfg;
}

/**
 * Cross-field invariants that no single-column CHECK can express.
 * These are the combinations that are individually plausible but jointly nonsensical.
 */
export function assertCoherent(cfg: ResolvedGuardrailConfig): void {
  if (cfg.maxAdSetDailyBudgetCents < cfg.minAdSetDailyBudgetCents) {
    throw new GuardrailConfigError(
      'ad set budget ceiling is below its floor',
      'maxAdSetDailyBudgetCents',
      cfg.maxAdSetDailyBudgetCents,
    );
  }
  if (cfg.maxAdSetDailyBudgetCents > cfg.maxTotalDailyBudgetCents) {
    throw new GuardrailConfigError(
      'a single ad set may not be permitted more than the client total ceiling',
      'maxAdSetDailyBudgetCents',
      cfg.maxAdSetDailyBudgetCents,
    );
  }
  if (cfg.scalePThreshold > cfg.killPThreshold) {
    throw new GuardrailConfigError(
      'scale must be held to a stricter threshold than kill; a wrong scale costs money, ' +
        'a wrong kill costs opportunity',
      'scalePThreshold',
      cfg.scalePThreshold,
    );
  }
  if (cfg.mutateTestBudgetCents > cfg.maxDailyAutonomousIncreaseCents) {
    throw new GuardrailConfigError(
      'a single mutant launch would exceed the entire daily autonomous increase cap, so no ' +
        'mutation could ever execute',
      'mutateTestBudgetCents',
      cfg.mutateTestBudgetCents,
    );
  }
  if (cfg.mutateTestBudgetCents < cfg.minAdSetDailyBudgetCents) {
    throw new GuardrailConfigError(
      'mutant launch budget is below the ad set floor, so every mutation would be blocked',
      'mutateTestBudgetCents',
      cfg.mutateTestBudgetCents,
    );
  }
}
