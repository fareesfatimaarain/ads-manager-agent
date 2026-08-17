/**
 * Guardrail configuration writes.
 *
 * `guardrail_configs` is append-only and versioned, so "editing" limits never mutates a row.
 * A change closes the current version and inserts the next one, inside a transaction. That
 * matters because every `decisions_log` entry pins the config id it was judged under — a past
 * decision must remain interpretable against the limits that were actually in force when it
 * fired, not against whatever they were later changed to.
 *
 * Validation runs in three layers, deliberately:
 *   1. `parseGuardrailConfig` — types, ranges, and the string/number boundary
 *   2. `assertCoherent`       — cross-field combinations that are individually plausible
 *                               but jointly nonsensical
 *   3. the database CHECK constraints — the backstop that catches anything the first two miss
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { guardrailConfigs } from '../db/schema.js';
import {
  assertCoherent,
  GuardrailConfigError,
  parseGuardrailConfig,
} from '../guardrails/config.js';
import type { ResolvedGuardrailConfig } from '../guardrails/types.js';

/** Numeric columns arrive as strings from the driver and must be written back as strings. */
const NUMERIC_FIELDS = [
  'maxBudgetIncreasePct',
  'maxBudgetDecreasePct',
  'minSpendMultipleOfTargetCpa',
  'killPThreshold',
  'scalePThreshold',
  'proxyKillCtrDropPct',
  'zeroConversionKillSpendMultiple',
  'roasScaleSafetyMargin',
  'mutateCpaBandMultiple',
  'mSprtTauRelative',
] as const;

const EDITABLE = [
  ...NUMERIC_FIELDS,
  'maxDailyAutonomousIncreaseCents',
  'maxTotalDailyBudgetCents',
  'minAdSetDailyBudgetCents',
  'maxAdSetDailyBudgetCents',
  'minTestSpendCents',
  'zeroConversionKillSpendCents',
  'mutateTestBudgetCents',
  'minRuntimeHours',
  'minConversionsPerArm',
  'proxyKillMinImpressions',
  'maxMutationDepth',
  'actionCooldownHours',
  'maxActionsPerCyclePerClient',
  'minActiveCampaigns',
  'attributionSettlingHours',
  'maxPerformanceStalenessHours',
  'approvalExpiryHours',
  'roasBootstrapMinDays',
  'roasBootstrapIterations',
  'allowScaleWithoutComparativeBaseline',
  'allowTargetingChanges',
  'allowAudienceExpansion',
  'allowCampaignCreation',
] as const;

export type EditableField = (typeof EDITABLE)[number];

export const EDITABLE_FIELDS: readonly string[] = EDITABLE;

/** Turns a validated config into the column values Drizzle expects. */
function toInsertValues(
  config: ResolvedGuardrailConfig,
  clientId: string,
  version: number,
  createdBy: string,
): Record<string, unknown> {
  const values: Record<string, unknown> = { clientId, version, createdBy };
  for (const field of EDITABLE) {
    const value = (config as unknown as Record<string, unknown>)[field];
    values[field] = (NUMERIC_FIELDS as readonly string[]).includes(field)
      ? String(value)
      : value;
  }
  return values;
}

export class SettingsValidationError extends Error {
  constructor(
    message: string,
    readonly field: string | null,
  ) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

export interface UpdateResult {
  readonly config: ResolvedGuardrailConfig;
  readonly version: number;
  readonly changed: { field: string; from: unknown; to: unknown }[];
}

/**
 * Applies a partial update to a client's live guardrail config.
 *
 * Rejects the whole update if the resulting configuration would be invalid — there is no
 * partial application, because a half-applied set of limits is a state nobody reasoned about.
 */
export async function updateGuardrails(
  db: Database,
  clientId: string,
  patch: Record<string, unknown>,
  actor: string,
): Promise<UpdateResult> {
  const unknownKeys = Object.keys(patch).filter((k) => !EDITABLE_FIELDS.includes(k));
  if (unknownKeys.length > 0) {
    throw new SettingsValidationError(
      `not an editable setting: ${unknownKeys.join(', ')}`,
      unknownKeys[0] ?? null,
    );
  }

  return db.transaction(async (tx) => {
    // Serialise concurrent edits for this client so two saves cannot both close the same
    // version and race to insert.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${clientId}))`);

    const [current] = await tx
      .select()
      .from(guardrailConfigs)
      .where(and(eq(guardrailConfigs.clientId, clientId), isNull(guardrailConfigs.effectiveTo)));

    if (!current) {
      throw new SettingsValidationError('this client has no live guardrail configuration', null);
    }

    const currentParsed = parseGuardrailConfig(current as unknown as Record<string, unknown>);

    // Merge, then validate the RESULT rather than the patch — a change is only legal in the
    // context of the values it will sit alongside.
    const merged = { ...currentParsed, ...patch } as ResolvedGuardrailConfig;

    let validated: ResolvedGuardrailConfig;
    try {
      validated = parseGuardrailConfig({
        ...(merged as unknown as Record<string, unknown>),
        id: current.id,
        clientId,
        version: current.version + 1,
      });
      assertCoherent(validated);
    } catch (error) {
      if (error instanceof GuardrailConfigError) {
        throw new SettingsValidationError(error.message, error.field);
      }
      throw error;
    }

    const changed = EDITABLE.filter(
      (field) =>
        Object.hasOwn(patch, field) &&
        String((currentParsed as unknown as Record<string, unknown>)[field]) !==
          String((validated as unknown as Record<string, unknown>)[field]),
    ).map((field) => ({
      field,
      from: (currentParsed as unknown as Record<string, unknown>)[field],
      to: (validated as unknown as Record<string, unknown>)[field],
    }));

    if (changed.length === 0) {
      return { config: currentParsed, version: current.version, changed: [] };
    }

    const now = new Date();
    await tx
      .update(guardrailConfigs)
      .set({ effectiveTo: now })
      .where(eq(guardrailConfigs.id, current.id));

    const [inserted] = await tx
      .insert(guardrailConfigs)
      .values(
        toInsertValues(validated, clientId, current.version + 1, actor) as never,
      )
      .returning();

    return {
      config: parseGuardrailConfig(inserted as unknown as Record<string, unknown>),
      version: current.version + 1,
      changed,
    };
  });
}

/** Every version ever in force, newest first — the configuration audit trail. */
export async function guardrailHistory(db: Database, clientId: string) {
  return db
    .select({
      id: guardrailConfigs.id,
      version: guardrailConfigs.version,
      effectiveFrom: guardrailConfigs.effectiveFrom,
      effectiveTo: guardrailConfigs.effectiveTo,
      createdBy: guardrailConfigs.createdBy,
    })
    .from(guardrailConfigs)
    .where(eq(guardrailConfigs.clientId, clientId))
    .orderBy(desc(guardrailConfigs.version));
}
