import { sql } from 'drizzle-orm';
import { db } from '../../src/db/index.js';
import {
  adAccounts,
  adSets,
  adVariants,
  campaigns,
  clients,
  guardrailConfigs,
  testCohorts,
} from '../../src/db/schema.js';

export const TABLES = [
  'daily_performance',
  'spend_ledger',
  'platform_actions',
  'decisions_log',
  'ad_variants',
  'ad_sets',
  'test_cohorts',
  'campaigns',
  'creative_assets',
  'brand_kits',
  'guardrail_configs',
  'ad_accounts',
  'clients',
  'admin_sessions',
  'admin_users',
  'platform_mutation_ledger',
] as const;

export async function truncateAll(): Promise<void> {
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`),
  );
}

export interface SeededWorld {
  clientId: string;
  adAccountId: string;
  campaignId: string;
  cohortId: string;
  adSetId: string;
  variantId: string;
  guardrailConfigId: string;
}

/** A minimal but complete client: one campaign, one cohort, one ad set at $30/day, one variant. */
export async function seedWorld(
  overrides: {
    readonly dailyBudgetCents?: number;
    readonly maxDailyAutonomousIncreaseCents?: number;
    readonly maxTotalDailyBudgetCents?: number;
    readonly autonomousScaleEnabled?: boolean;
  } = {},
): Promise<SeededWorld> {
  const [client] = await db
    .insert(clients)
    .values({
      name: 'Test Client',
      slug: `test-${Math.random().toString(36).slice(2, 10)}`,
      timezone: 'UTC',
      defaultObjectiveType: 'CPA',
      defaultTargetCpaCents: 5_000,
      autonomousKillEnabled: true,
      autonomousScaleEnabled: overrides.autonomousScaleEnabled ?? true,
      autonomousMutateEnabled: true,
    })
    .returning({ id: clients.id });

  const dailyIncreaseCap = overrides.maxDailyAutonomousIncreaseCents ?? 20_000;
  const [config] = await db
    .insert(guardrailConfigs)
    .values({
      clientId: client!.id,
      version: 1,
      maxDailyAutonomousIncreaseCents: dailyIncreaseCap,
      maxTotalDailyBudgetCents: overrides.maxTotalDailyBudgetCents ?? 100_000,
      maxAdSetDailyBudgetCents: 50_000,
      // Keep the fixture internally coherent: a mutant launch budget larger than the entire
      // daily increase cap would mean no mutation could ever execute, and parseGuardrailConfig
      // rightly refuses to load such a config.
      mutateTestBudgetCents: Math.min(3_000, dailyIncreaseCap),
      createdBy: 'integration-test',
    })
    .returning({ id: guardrailConfigs.id });

  const [account] = await db
    .insert(adAccounts)
    .values({
      clientId: client!.id,
      platform: 'MOCK',
      platformAccountId: `acct-${Math.random().toString(36).slice(2, 10)}`,
      name: 'Mock Account',
      currency: 'USD',
      timezone: 'UTC',
      status: 'ACTIVE',
    })
    .returning({ id: adAccounts.id });

  const [campaign] = await db
    .insert(campaigns)
    .values({
      clientId: client!.id,
      adAccountId: account!.id,
      name: 'Campaign',
      status: 'ACTIVE',
      platformCampaignId: 'camp-1',
    })
    .returning({ id: campaigns.id });

  const [cohort] = await db
    .insert(testCohorts)
    .values({ campaignId: campaign!.id, name: 'Cohort', status: 'RUNNING' })
    .returning({ id: testCohorts.id });

  const [adSet] = await db
    .insert(adSets)
    .values({
      campaignId: campaign!.id,
      name: 'Ad set',
      dailyBudgetCents: overrides.dailyBudgetCents ?? 3_000,
      targetingHash: 'hash-1',
      status: 'ACTIVE',
      platformAdSetId: 'as-1',
    })
    .returning({ id: adSets.id });

  const [variant] = await db
    .insert(adVariants)
    .values({
      adSetId: adSet!.id,
      cohortId: cohort!.id,
      campaignId: campaign!.id,
      headline: 'Headline',
      primaryText: 'Body',
      cta: 'Shop now',
      angleTag: 'time-saving',
      status: 'TESTING',
      platformAdId: 'ad-1',
    })
    .returning({ id: adVariants.id });

  return {
    clientId: client!.id,
    adAccountId: account!.id,
    campaignId: campaign!.id,
    cohortId: cohort!.id,
    adSetId: adSet!.id,
    variantId: variant!.id,
    guardrailConfigId: config!.id,
  };
}

/** Asserts that a promise rejects with a Postgres error naming the given constraint. */
export async function expectConstraintViolation(
  operation: Promise<unknown>,
  constraintName: string,
): Promise<void> {
  try {
    await operation;
    throw new Error(`expected constraint ${constraintName} to reject this row, but it succeeded`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(constraintName)) {
      throw new Error(
        `expected a violation of ${constraintName}, but got: ${message}`,
      );
    }
  }
}
