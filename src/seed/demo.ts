/**
 * Populates the database with a realistic worked example.
 *
 * Nothing here is fabricated. Performance data comes from the deterministic mock adapter, and
 * the decisions come from running the actual decision engine and executor over it. What the
 * dashboard displays is therefore what the system genuinely concluded from that data — if the
 * engine's behaviour changes, the demo changes with it.
 *
 *   npm run seed
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import {
  adAccounts,
  adSets,
  adVariants,
  brandKits,
  brandProfiles,
  campaigns,
  clients,
  dailyPerformance,
  guardrailConfigs,
  testCohorts,
} from '../db/schema.js';
import { MockPlatformAdapter, type MockVariantProfile } from '../platform/mock/mockAdapter.js';
import { loadVariantPerformance, variantsWithMissingData } from '../performance/reader.js';
import { decideCohort } from '../decisions/engine.js';
import { executeDecision } from '../decisions/executor.js';
import { parseGuardrailConfig } from '../guardrails/config.js';
import { CircuitBreaker } from '../platform/resilience.js';
import { addDays, currentDateInZone } from '../time/zonedDate.js';
import type { CohortInput, VariantMetrics } from '../decisions/types.js';
import { eq } from 'drizzle-orm';

const NOW = new Date();
const TZ = 'UTC';
const DAYS = 60;
const TARGET_CPA_CENTS = 5_000; // $50
const DAILY_BUDGET_CENTS = 3_000; // $30

/**
 * Four creative angles with different ground truths. The rates are chosen so the resulting
 * cost per acquisition lands either side of the $50 target, producing one of each decision.
 */
const PROFILES: { profile: MockVariantProfile; angle: string; headline: string; hook: string }[] = [
  {
    profile: { platformAdId: 'ad-time', trueCtr: 0.025, trueCvr: 0.014, avgOrderValueCents: 14_000, impressionsPerDollar: 200 },
    angle: 'time-saved',
    headline: 'Get your evenings back',
    hook: 'Cuts the job from three hours to twenty minutes.',
  },
  {
    profile: { platformAdId: 'ad-risk', trueCtr: 0.022, trueCvr: 0.0035, avgOrderValueCents: 14_000, impressionsPerDollar: 200 },
    angle: 'risk-avoided',
    headline: "Don't find out the expensive way",
    hook: 'Catches the problem before it costs you.',
  },
  {
    profile: { platformAdId: 'ad-social', trueCtr: 0.006, trueCvr: 0.005, avgOrderValueCents: 14_000, impressionsPerDollar: 200 },
    angle: 'social-proof',
    headline: 'Join 12,000 others',
    hook: 'Everyone else is already doing it.',
  },
  {
    profile: { platformAdId: 'ad-price', trueCtr: 0.022, trueCvr: 0.002, avgOrderValueCents: 14_000, impressionsPerDollar: 200 },
    angle: 'price-led',
    headline: 'Now 30% off',
    hook: 'Lead with the discount.',
  },
];

async function main(): Promise<void> {
  console.log('clearing existing data...');
  await db.execute(
    sql.raw(
      `TRUNCATE TABLE daily_performance, spend_ledger, platform_actions, decisions_log,
       creative_reviews, campaign_briefs, ad_variants, ad_sets, test_cohorts, campaigns,
       creative_assets, brand_kits, brand_profiles, intake_sessions, reference_assets,
       compliance_rules, compliance_rule_overrides, guardrail_configs, ad_accounts, clients
       RESTART IDENTITY CASCADE`,
    ),
  );

  console.log('creating client and guardrails...');
  const [client] = await db
    .insert(clients)
    .values({
      name: 'Northwind Tools',
      slug: 'northwind-tools',
      timezone: TZ,
      defaultObjectiveType: 'CPA',
      defaultTargetCpaCents: TARGET_CPA_CENTS,
      // Tiered autonomy: stopping an ad is autonomous, anything that starts spend is not.
      // Mutation is gated here too because the creative pipeline is not built yet, so a
      // mutant cannot actually be produced — it queues for review instead.
      autonomousKillEnabled: true,
      autonomousScaleEnabled: false,
      autonomousMutateEnabled: false,
    })
    .returning({ id: clients.id });

  const [config] = await db
    .insert(guardrailConfigs)
    .values({
      clientId: client!.id,
      version: 1,
      maxDailyAutonomousIncreaseCents: 20_000,
      maxTotalDailyBudgetCents: 100_000,
      maxAdSetDailyBudgetCents: 50_000,
      createdBy: 'seed',
    })
    .returning({ id: guardrailConfigs.id });

  // The brand profile is the governed brand memory every generated ad is constrained by.
  // Seeded as a completed onboarding, so the demo starts where a real client would after intake.
  await db.insert(brandProfiles).values({
    clientId: client!.id,
    version: 1,
    industryKey: 'ecommerce',
    complianceTemplateKey: 'ecommerce',
    core: {
      brandName: 'Northwind Tools',
      offering: 'Professional-grade power tools sold direct, without the trade-counter markup.',
      targetAudience:
        'Working tradespeople — electricians, joiners, builders — who buy their own kit and resent being sold to.',
      toneKey: 'plain-direct',
      toneNotes: 'Plain, concrete, unhurried. No exclamation marks. Never talks down to the trade.',
      values: ['Built to last', 'Honest pricing', 'No nonsense'],
      palette: [
        { name: 'Ink', hex: '#1A1915' },
        { name: 'Paper', hex: '#FAF7F1' },
        { name: 'Rust', hex: '#9A4A28' },
        { name: 'Slate', hex: '#45505C' },
      ],
      fonts: { display: 'Georgia', body: 'Segoe UI' },
      bannedWords: ['revolutionary', 'unbeatable', 'game-changing'],
      requiredDisclaimers: [],
      competitors: ['Screwfix', 'Toolstation'],
      industryKey: 'ecommerce',
    },
    industry: {
      productCategories: ['Power tools', 'Hand tools', 'Site storage', 'Workwear'],
      heroSkus: ['18V combi drill', 'Site radio'],
      promoCadence: 'seasonal',
      shippingPromise: 'Ordered before 4pm, dispatched same day',
      returnsPolicy: '60 days, no questions',
    },
    locks: { palette: true, brandName: true },
    creativeDirection:
      'Lead with the job, not the tool. Show work in progress rather than studio product shots.',
    createdBy: 'seed',
    sourceKind: 'INTAKE',
  });

  // Legacy brand kit, retained while the older generation path still reads it.
  await db.insert(brandKits).values({
    clientId: client!.id,
    version: 1,
    palette: [
      { name: 'Ink', hex: '#1A1915' },
      { name: 'Paper', hex: '#FAF7F1' },
      { name: 'Rust', hex: '#9A4A28' },
      { name: 'Slate', hex: '#45505C' },
    ],
    fonts: { display: 'Georgia', body: 'Segoe UI' },
    tone: 'Plain, concrete, unhurried. Speaks to tradespeople who dislike being sold to.',
    bannedWords: ['guaranteed', 'cheapest', 'revolutionary', 'unbeatable'],
    bannedClaims: [
      'Any claim that the product is the best on the market.',
      'Any specific savings figure that is not backed by published data.',
      'Any suggestion that results are typical without a qualifier.',
    ],
    requiredDisclaimers: [],
  });

  const [account] = await db
    .insert(adAccounts)
    .values({
      clientId: client!.id,
      platform: 'MOCK',
      platformAccountId: 'act_demo_001',
      name: 'Northwind — Prospecting',
      currency: 'USD',
      timezone: TZ,
      status: 'ACTIVE',
      lastSyncedAt: NOW,
    })
    .returning({ id: adAccounts.id });

  const [campaign] = await db
    .insert(campaigns)
    .values({
      clientId: client!.id,
      adAccountId: account!.id,
      name: 'Q3 Prospecting — Cold Audience',
      platformCampaignId: 'camp_demo_001',
      status: 'ACTIVE',
      objectiveType: 'CPA',
      targetCpaCents: TARGET_CPA_CENTS,
    })
    .returning({ id: campaigns.id });

  const [cohort] = await db
    .insert(testCohorts)
    .values({
      campaignId: campaign!.id,
      name: 'Angle test — round 1',
      status: 'RUNNING',
      startedAt: new Date(NOW.getTime() - DAYS * 86_400_000),
    })
    .returning({ id: testCohorts.id });

  console.log('creating variants...');
  const adapter = new MockPlatformAdapter(
    { seed: 20260805, variants: PROFILES.map((p) => p.profile) },
    NOW,
  );

  const startDate = addDays(currentDateInZone(NOW, TZ), -DAYS);
  const created: { variantId: string; adSetId: string; platformAdId: string; angle: string }[] = [];

  for (const entry of PROFILES) {
    const [adSet] = await db
      .insert(adSets)
      .values({
        campaignId: campaign!.id,
        name: `Ad set — ${entry.angle}`,
        dailyBudgetCents: DAILY_BUDGET_CENTS,
        targeting: { countries: ['US'], ageMin: 25, ageMax: 55 },
        targetingHash: `hash-${entry.angle}`,
        status: 'ACTIVE',
        platformAdSetId: `as-${entry.angle}`,
      })
      .returning({ id: adSets.id });

    const [variant] = await db
      .insert(adVariants)
      .values({
        adSetId: adSet!.id,
        cohortId: cohort!.id,
        campaignId: campaign!.id,
        platformAdId: entry.profile.platformAdId,
        headline: entry.headline,
        primaryText: entry.hook,
        cta: 'Learn more',
        angleTag: entry.angle,
        hookType: entry.angle,
        generationReasoning: `Testing the "${entry.angle}" angle against a cold audience.`,
        status: 'TESTING',
        testStartedAt: new Date(NOW.getTime() - DAYS * 86_400_000),
      })
      .returning({ id: adVariants.id });

    adapter.seedAdSet(`as-${entry.angle}`, DAILY_BUDGET_CENTS, startDate);
    adapter.seedAd(entry.profile.platformAdId, `as-${entry.angle}`, startDate);

    created.push({
      variantId: variant!.id,
      adSetId: adSet!.id,
      platformAdId: entry.profile.platformAdId,
      angle: entry.angle,
    });
  }

  console.log(`generating ${DAYS} days of performance...`);
  const today = currentDateInZone(NOW, TZ);
  const rows = await adapter.getPerformanceData(
    { platformAdIds: PROFILES.map((p) => p.profile.platformAdId), since: startDate, until: today },
    {
      adAccountId: account!.id,
      platformAccountId: 'act_demo_001',
      accessToken: 'seed',
      currency: 'USD',
      timezone: TZ,
    },
  );

  const byPlatformAdId = new Map(created.map((c) => [c.platformAdId, c.variantId]));

  // The current snapshot of every day.
  for (const row of rows) {
    const variantId = byPlatformAdId.get(row.platformAdId);
    if (!variantId) continue;
    await db.insert(dailyPerformance).values({
      adVariantId: variantId,
      statDate: row.statDate,
      fetchedAt: NOW,
      impressions: row.impressions,
      clicks: row.clicks,
      spendCents: row.spendCents,
      conversions: row.conversions,
      conversionValueCents: row.conversionValueCents,
      currency: row.currency,
      source: 'MOCK',
      rawPayload: row.raw as object,
    });
  }

  // Earlier, under-reported snapshots for the most recent days, so the append-only history
  // shows attribution actually restating rather than merely claiming it does.
  const recent = new Set([today, addDays(today, -1), addDays(today, -2)]);
  for (const row of rows) {
    const variantId = byPlatformAdId.get(row.platformAdId);
    if (!variantId || !recent.has(row.statDate)) continue;
    await db.insert(dailyPerformance).values({
      adVariantId: variantId,
      statDate: row.statDate,
      fetchedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      impressions: row.impressions,
      clicks: row.clicks,
      spendCents: row.spendCents,
      conversions: Math.floor(row.conversions * 0.6),
      conversionValueCents: Math.floor(row.conversionValueCents * 0.6),
      currency: row.currency,
      source: 'MOCK',
    });
  }

  console.log('running a real decision cycle...');
  const parsedConfig = parseGuardrailConfig(
    (await db.select().from(guardrailConfigs).where(eq(guardrailConfigs.id, config!.id)))[0] as unknown as Record<string, unknown>,
  );

  const variantIds = created.map((c) => c.variantId);
  const performance = await loadVariantPerformance(db, variantIds, {
    timeZone: TZ,
    settlingHours: parsedConfig.attributionSettlingHours,
    now: NOW,
    lookbackDays: DAYS + 5,
  });

  const missing = variantsWithMissingData(performance, variantIds, parsedConfig.maxPerformanceStalenessHours, NOW);

  const variantMetrics: VariantMetrics[] = created.map((c) => {
    const p = performance.get(c.variantId)!;
    return {
      variantId: c.variantId,
      adSetId: c.adSetId,
      campaignId: campaign!.id,
      platformAdId: c.platformAdId,
      status: 'TESTING',
      settled: p.settled,
      proxy: p.proxy,
      settledDaily: p.settledDaily,
      testStartedAt: new Date(NOW.getTime() - DAYS * 86_400_000),
      currentBudgetCents: DAILY_BUDGET_CENTS,
      mutationDepth: 0,
      evaluationsProxy: 0,
      evaluationsOutcome: 0,
    };
  });

  const input: CohortInput = {
    cohortId: cohort!.id,
    clientId: client!.id,
    objective: { type: 'CPA', targetCpaCents: TARGET_CPA_CENTS },
    config: parsedConfig,
    variants: variantMetrics,
    variantsWithMissingData: missing,
    headroom: {
      todayAutonomousIncreaseCents: 0,
      clientTotalDailyBudgetCents: DAILY_BUDGET_CENTS * created.length,
      platformDailySpendCapCents: null,
    },
    now: NOW,
  };

  const result = decideCohort(input);
  if (result.skipped) {
    console.log(`cycle skipped: ${result.skipReason}`);
    await pool.end();
    return;
  }

  const cycleId = crypto.randomUUID();
  const ledgerDate = currentDateInZone(NOW, TZ);
  const breaker = new CircuitBreaker();

  let activeVariants = created.length;

  for (const decision of result.decisions) {
    const entry = created.find((c) => c.variantId === decision.variantId)!;
    console.log(`  ${entry.angle.padEnd(14)} ${decision.kind.padEnd(10)} ${decision.reasonCode}`);

    if (decision.proposedAction === null) continue;

    const outcome = await executeDecision(
      {
        db,
        adapter,
        adapterContext: {
          adAccountId: account!.id,
          platformAccountId: 'act_demo_001',
          accessToken: 'seed',
          currency: 'USD',
          timezone: TZ,
        },
        breaker,
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0 },
        now: () => NOW,
      },
      decision,
      {
        config: parsedConfig,
        now: NOW,
        executionEnabled: true,
        client: {
          id: client!.id,
          autonomousKillEnabled: true,
          autonomousScaleEnabled: false,
          autonomousMutateEnabled: false,
        },
        account: {
          id: account!.id,
          status: 'ACTIVE',
          currency: 'USD',
          platformDailySpendCapCents: null,
        },
        activeCampaignCount: 1,
        activeVariantsInCampaign: activeVariants,
        lastActionAtForVariant: null,
        actionsAlreadyThisCycle: 0,
        newestPerformanceFetchedAt: NOW,
        touchesTargeting: false,
        guardrailDenominationCurrency: 'USD',
      },
      cycleId,
      ledgerDate,
      account!.id,
    );

    console.log(`     -> ${outcome.outcome}${outcome.blockedBy ? ` (${outcome.blockedBy})` : ''}`);

    if (outcome.outcome === 'EXECUTED' && decision.kind === 'KILL') {
      await db.update(adVariants).set({ status: 'KILLED' }).where(eq(adVariants.id, decision.variantId));
      await db.update(adSets).set({ status: 'PAUSED' }).where(eq(adSets.id, entry.adSetId));
      activeVariants -= 1;
    }

    await db
      .update(adVariants)
      .set({
        evaluationsProxy: decision.newEvaluationsProxy,
        evaluationsOutcome: decision.newEvaluationsOutcome,
        lastEvaluatedAt: NOW,
      })
      .where(eq(adVariants.id, decision.variantId));
  }

  console.log('\nseed complete.');
  await pool.end();
}

main().catch((error: unknown) => {
  console.error('seed failed:', error);
  process.exitCode = 1;
  void pool.end();
});
