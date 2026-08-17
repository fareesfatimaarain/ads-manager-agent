/**
 * Campaign planning and launch.
 *
 * Turns a brief into a live, structurally valid test: one campaign, one cohort, and one ad set
 * per variant. The one-ad-set-per-variant shape is a statistical requirement, not a convenience
 * — see PLAN.md #2. Sharing an ad set would let the platform's optimiser decide how to split
 * impressions, which is a non-random assignment and invalidates every comparison the decision
 * engine later makes.
 *
 * Launch is idempotent at every step. A crash halfway through leaves a partially-created
 * campaign that re-running completes rather than duplicates.
 */
import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import {
  adAccounts,
  adSets,
  adVariants,
  campaignBriefs,
  campaigns,
  clients,
  creativeAssets,
  creativeReviews,
  guardrailConfigs,
  testCohorts,
} from '../db/schema.js';
import { parseGuardrailConfig } from '../guardrails/config.js';
import type { PlatformAdapter, AdapterContext, TargetingSpec } from '../platform/types.js';
import { generateCreative, activeAngles } from '../creative/generate.js';
import type { CopyGenerator, CreativeProvider } from '../creative/types.js';

export interface LaunchPlan {
  readonly clientId: string;
  readonly adAccountId: string;
  readonly campaignName: string;
  readonly cohortName: string;
  readonly icp: string;
  readonly offer: string;
  readonly landingPageUrl: string;
  readonly targeting: TargetingSpec;
  readonly variantCount: number;
  readonly dailyBudgetPerVariantCents: number;
  /** Launch paused so a human can eyeball the creative before it spends. */
  readonly startPaused: boolean;
  /** Resolved by the caller (decrypted for a real account) — never read from the DB here. */
  readonly accessToken: string;
  /** Platform-specific settings a real adapter needs (Meta pixel/page id, etc). */
  readonly platformConfig?: Record<string, unknown> | null;
}

export interface LaunchResult {
  readonly campaignId: string;
  readonly cohortId: string;
  readonly variants: { id: string; angleTag: string; headline: string; adSetId: string }[];
  readonly rejected: readonly { angleTag: string; reasons: string[] }[];
  readonly totalDailyBudgetCents: number;
  readonly generator: string;
  readonly imageProvider: string;
}

export class LaunchError extends Error {
  constructor(
    message: string,
    readonly stage: string,
  ) {
    super(message);
    this.name = 'LaunchError';
  }
}

const stableKey = (...parts: string[]): string =>
  createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 48);

const hashTargeting = (t: TargetingSpec): string =>
  createHash('sha256').update(JSON.stringify(t, Object.keys(t).sort())).digest('hex').slice(0, 32);

/**
 * Validates a plan against the client's guardrails before anything is created.
 *
 * This runs first, on purpose: a plan that would breach the client's total daily budget should
 * be refused while it is still a plan, not after four ad sets exist on the platform.
 */
export async function validatePlan(db: Database, plan: LaunchPlan): Promise<void> {
  const [client] = await db.select().from(clients).where(eq(clients.id, plan.clientId));
  if (!client) throw new LaunchError(`unknown client ${plan.clientId}`, 'VALIDATE');
  if (client.automationPausedAt) {
    throw new LaunchError('automation is paused for this client', 'VALIDATE');
  }

  const [configRow] = await db
    .select()
    .from(guardrailConfigs)
    .where(and(eq(guardrailConfigs.clientId, plan.clientId), isNull(guardrailConfigs.effectiveTo)));
  if (!configRow) throw new LaunchError('client has no guardrail configuration', 'VALIDATE');

  const config = parseGuardrailConfig(configRow as unknown as Record<string, unknown>);

  if (plan.variantCount < 1) {
    throw new LaunchError('a test needs at least one variant', 'VALIDATE');
  }
  if (plan.dailyBudgetPerVariantCents < config.minAdSetDailyBudgetCents) {
    throw new LaunchError(
      `per-variant budget ${plan.dailyBudgetPerVariantCents} is below the ad set floor of ${config.minAdSetDailyBudgetCents}`,
      'VALIDATE',
    );
  }
  if (plan.dailyBudgetPerVariantCents > config.maxAdSetDailyBudgetCents) {
    throw new LaunchError(
      `per-variant budget ${plan.dailyBudgetPerVariantCents} exceeds the ad set ceiling of ${config.maxAdSetDailyBudgetCents}`,
      'VALIDATE',
    );
  }

  // Existing live budget plus what this launch would add must stay under the ceiling.
  const [existing] = await db
    .select({ total: sql<string>`COALESCE(SUM(${adSets.dailyBudgetCents}), 0)` })
    .from(adSets)
    .innerJoin(campaigns, eq(adSets.campaignId, campaigns.id))
    .where(sql`${campaigns.clientId} = ${plan.clientId} AND ${adSets.status} = 'ACTIVE'`);

  const current = Number(existing?.total ?? 0);
  const added = plan.dailyBudgetPerVariantCents * plan.variantCount;
  if (current + added > config.maxTotalDailyBudgetCents) {
    throw new LaunchError(
      `launching would take total daily budget to ${current + added}, over the ${config.maxTotalDailyBudgetCents} ceiling`,
      'VALIDATE',
    );
  }
}

/**
 * Plans, generates and launches a test in one operation.
 *
 * Ordering is deliberate: validate → generate creative → create platform objects → record.
 * Creative is generated before anything is created on the platform so a generation failure
 * costs nothing and leaves no half-built campaign behind.
 */
export async function planAndLaunch(
  db: Database,
  adapter: PlatformAdapter,
  plan: LaunchPlan,
  options: {
    readonly copyGenerator?: CopyGenerator;
    readonly imageProvider?: CreativeProvider;
    readonly now?: () => Date;
  } = {},
): Promise<LaunchResult> {
  const now = options.now ?? (() => new Date());
  await validatePlan(db, plan);

  const [account] = await db.select().from(adAccounts).where(eq(adAccounts.id, plan.adAccountId));
  if (!account) throw new LaunchError(`unknown ad account ${plan.adAccountId}`, 'VALIDATE');
  if (account.status !== 'ACTIVE') {
    throw new LaunchError(`ad account is ${account.status}; reconnect it before launching`, 'VALIDATE');
  }

  const ctx: AdapterContext = {
    adAccountId: account.id,
    platformAccountId: account.platformAccountId,
    accessToken: plan.accessToken,
    currency: account.currency,
    timezone: account.timezone,
    ...(plan.platformConfig ? { platformConfig: plan.platformConfig } : {}),
  };

  // --- creative first, before anything exists on the platform ---------------
  const excluded = await activeAngles(db, plan.clientId);
  const creative = await generateCreative(db, {
    clientId: plan.clientId,
    icp: plan.icp,
    offer: plan.offer,
    landingPageUrl: plan.landingPageUrl,
    variantCount: plan.variantCount,
    excludeAngles: excluded,
    ...(options.copyGenerator ? { copyGenerator: options.copyGenerator } : {}),
    ...(options.imageProvider ? { imageProvider: options.imageProvider } : {}),
  });

  if (creative.variants.length === 0) {
    throw new LaunchError(
      `no variants survived brand compliance (${creative.rejected.length} rejected); nothing was launched`,
      'GENERATE',
    );
  }

  // --- platform objects -----------------------------------------------------
  const campaignKey = stableKey(plan.clientId, plan.campaignName);
  const platformCampaign = await adapter.createCampaign(
    {
      idempotencyKey: campaignKey,
      name: plan.campaignName,
      objective: 'CONVERSIONS',
      startPaused: plan.startPaused,
    },
    ctx,
  );

  const [campaign] = await db
    .insert(campaigns)
    .values({
      clientId: plan.clientId,
      adAccountId: plan.adAccountId,
      name: plan.campaignName,
      platformCampaignId: platformCampaign.platformId,
      status: plan.startPaused ? 'PAUSED' : 'ACTIVE',
    })
    .returning({ id: campaigns.id });

  const [cohort] = await db
    .insert(testCohorts)
    .values({
      campaignId: campaign!.id,
      name: plan.cohortName,
      status: 'RUNNING',
      startedAt: now(),
    })
    .returning({ id: testCohorts.id });

  const targetingHash = hashTargeting(plan.targeting);
  const launched: LaunchResult['variants'] = [];

  for (const variant of creative.variants) {
    const adSetKey = stableKey(campaignKey, variant.copy.angleTag);

    const platformAdSet = await adapter.createAdSet(
      {
        idempotencyKey: adSetKey,
        platformCampaignId: platformCampaign.platformId,
        name: `${plan.cohortName} — ${variant.copy.angleTag}`,
        dailyBudgetCents: plan.dailyBudgetPerVariantCents,
        targeting: plan.targeting,
        startPaused: plan.startPaused,
      },
      ctx,
    );

    const platformAd = await adapter.createAd(
      {
        idempotencyKey: stableKey(adSetKey, 'ad'),
        platformAdSetId: platformAdSet.platformId,
        name: variant.copy.headline.slice(0, 60),
        headline: variant.copy.headline,
        primaryText: variant.copy.primaryText,
        cta: variant.copy.cta,
        imageUrl: variant.image.url,
        landingPageUrl: plan.landingPageUrl,
        startPaused: plan.startPaused,
      },
      ctx,
    );

    const [adSet] = await db
      .insert(adSets)
      .values({
        campaignId: campaign!.id,
        name: `${plan.cohortName} — ${variant.copy.angleTag}`,
        dailyBudgetCents: plan.dailyBudgetPerVariantCents,
        targeting: plan.targeting as unknown as object,
        targetingHash,
        status: plan.startPaused ? 'PAUSED' : 'ACTIVE',
        platformAdSetId: platformAdSet.platformId,
      })
      .returning({ id: adSets.id });

    const [row] = await db
      .insert(adVariants)
      .values({
        adSetId: adSet!.id,
        cohortId: cohort!.id,
        campaignId: campaign!.id,
        platformAdId: platformAd.platformId,
        headline: variant.copy.headline,
        primaryText: variant.copy.primaryText,
        cta: variant.copy.cta,
        imageAssetId: variant.imageAssetId,
        angleTag: variant.copy.angleTag,
        hookType: variant.copy.hookType,
        generationReasoning: variant.copy.reasoning,
        status: plan.startPaused ? 'PENDING_LAUNCH' : 'TESTING',
        testStartedAt: plan.startPaused ? null : now(),
      })
      .returning({ id: adVariants.id });

    launched.push({
      id: row!.id,
      angleTag: variant.copy.angleTag,
      headline: variant.copy.headline,
      adSetId: adSet!.id,
    });
  }

  return {
    campaignId: campaign!.id,
    cohortId: cohort!.id,
    variants: launched,
    rejected: creative.rejected,
    totalDailyBudgetCents: plan.dailyBudgetPerVariantCents * launched.length,
    generator: creative.generator,
    imageProvider: creative.imageProvider,
  };
}

// ---------------------------------------------------------------------------
// Launching already-generated, already-approved creative
// ---------------------------------------------------------------------------

export interface LaunchApprovedPlan {
  readonly clientId: string;
  readonly campaignBriefId: string;
  readonly adAccountId: string;
  readonly campaignName: string;
  readonly cohortName: string;
  readonly targeting: TargetingSpec;
  /** Launch paused so a human can eyeball the creative before it spends. */
  readonly startPaused: boolean;
  /** Resolved by the caller (decrypted for a real account) — never read from the DB here. */
  readonly accessToken: string;
  /** Platform-specific settings a real adapter needs (Meta pixel/page id, etc). */
  readonly platformConfig?: Record<string, unknown> | null;
}

export interface LaunchApprovedResult {
  readonly campaignId: string;
  readonly cohortId: string;
  readonly variants: { id: string; reviewId: string; angleTag: string; headline: string; adSetId: string }[];
  readonly totalDailyBudgetCents: number;
}

/**
 * Turns every APPROVED, not-yet-launched review under a campaign brief into a live (or
 * paused-for-eyeballing) test.
 *
 * This is deliberately a separate path from `planAndLaunch`, not a variant of it: that
 * function generates creative and launches it in the same breath, with no review gate. This
 * one launches creative that has already been generated, brand-compliance-checked, and
 * approved by a person in the review queue — nothing here calls a copy or image provider.
 *
 * Re-runnable: a brief already partially launched reuses its existing campaign and cohort
 * (recorded on the brief after the first launch) rather than creating a duplicate, so
 * approving and launching a second batch of creative for the same brief extends the same
 * test instead of starting a competing one.
 */
export async function launchApprovedReviews(
  db: Database,
  adapter: PlatformAdapter,
  plan: LaunchApprovedPlan,
  options: { now?: () => Date } = {},
): Promise<LaunchApprovedResult> {
  const now = options.now ?? (() => new Date());

  const [client] = await db.select().from(clients).where(eq(clients.id, plan.clientId));
  if (!client) throw new LaunchError(`unknown client ${plan.clientId}`, 'VALIDATE');
  if (client.automationPausedAt) {
    throw new LaunchError('automation is paused for this client', 'VALIDATE');
  }

  const [brief] = await db
    .select()
    .from(campaignBriefs)
    .where(eq(campaignBriefs.id, plan.campaignBriefId));
  if (!brief) throw new LaunchError(`unknown campaign brief ${plan.campaignBriefId}`, 'VALIDATE');
  if (brief.clientId !== plan.clientId) {
    throw new LaunchError('that brief belongs to a different client', 'VALIDATE');
  }

  const pending = await db
    .select()
    .from(creativeReviews)
    .where(
      and(
        eq(creativeReviews.campaignBriefId, plan.campaignBriefId),
        eq(creativeReviews.status, 'APPROVED'),
        isNull(creativeReviews.launchedAt),
      ),
    );
  if (pending.length === 0) {
    throw new LaunchError(
      'no approved, unlaunched creative exists for this brief — approve items in the review queue first',
      'VALIDATE',
    );
  }

  const [configRow] = await db
    .select()
    .from(guardrailConfigs)
    .where(and(eq(guardrailConfigs.clientId, plan.clientId), isNull(guardrailConfigs.effectiveTo)));
  if (!configRow) throw new LaunchError('client has no guardrail configuration', 'VALIDATE');
  const config = parseGuardrailConfig(configRow as unknown as Record<string, unknown>);

  if (brief.dailyBudgetPerVariantCents < config.minAdSetDailyBudgetCents) {
    throw new LaunchError(
      `per-variant budget ${brief.dailyBudgetPerVariantCents} is below the ad set floor of ${config.minAdSetDailyBudgetCents}`,
      'VALIDATE',
    );
  }
  if (brief.dailyBudgetPerVariantCents > config.maxAdSetDailyBudgetCents) {
    throw new LaunchError(
      `per-variant budget ${brief.dailyBudgetPerVariantCents} exceeds the ad set ceiling of ${config.maxAdSetDailyBudgetCents}`,
      'VALIDATE',
    );
  }

  const [existing] = await db
    .select({ total: sql<string>`COALESCE(SUM(${adSets.dailyBudgetCents}), 0)` })
    .from(adSets)
    .innerJoin(campaigns, eq(adSets.campaignId, campaigns.id))
    .where(sql`${campaigns.clientId} = ${plan.clientId} AND ${adSets.status} = 'ACTIVE'`);

  const current = Number(existing?.total ?? 0);
  const added = brief.dailyBudgetPerVariantCents * pending.length;
  if (current + added > config.maxTotalDailyBudgetCents) {
    throw new LaunchError(
      `launching would take total daily budget to ${current + added}, over the ${config.maxTotalDailyBudgetCents} ceiling`,
      'VALIDATE',
    );
  }

  const [account] = await db.select().from(adAccounts).where(eq(adAccounts.id, plan.adAccountId));
  if (!account) throw new LaunchError(`unknown ad account ${plan.adAccountId}`, 'VALIDATE');
  if (account.clientId !== plan.clientId) {
    throw new LaunchError('that ad account belongs to a different client', 'VALIDATE');
  }
  if (account.status !== 'ACTIVE') {
    throw new LaunchError(`ad account is ${account.status}; reconnect it before launching`, 'VALIDATE');
  }

  const ctx: AdapterContext = {
    adAccountId: account.id,
    platformAccountId: account.platformAccountId,
    accessToken: plan.accessToken,
    currency: account.currency,
    timezone: account.timezone,
    ...(plan.platformConfig ? { platformConfig: plan.platformConfig } : {}),
  };

  let campaignId: string;
  let cohortId: string;
  let platformCampaignId: string;

  if (brief.launchedCampaignId && brief.launchedCohortId) {
    const [existingCampaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, brief.launchedCampaignId));
    if (!existingCampaign) {
      throw new LaunchError('this brief refers to a campaign that no longer exists', 'PLATFORM');
    }
    if (!existingCampaign.platformCampaignId) {
      throw new LaunchError('this brief\'s campaign has no platform id on record', 'PLATFORM');
    }
    campaignId = existingCampaign.id;
    platformCampaignId = existingCampaign.platformCampaignId;
    cohortId = brief.launchedCohortId;
  } else {
    const campaignKey = stableKey(plan.clientId, plan.campaignBriefId, plan.campaignName);
    const platformCampaign = await adapter.createCampaign(
      {
        idempotencyKey: campaignKey,
        name: plan.campaignName,
        objective: 'CONVERSIONS',
        startPaused: plan.startPaused,
      },
      ctx,
    );

    const [campaign] = await db
      .insert(campaigns)
      .values({
        clientId: plan.clientId,
        adAccountId: plan.adAccountId,
        name: plan.campaignName,
        platformCampaignId: platformCampaign.platformId,
        status: plan.startPaused ? 'PAUSED' : 'ACTIVE',
      })
      .returning({ id: campaigns.id });

    const [cohort] = await db
      .insert(testCohorts)
      .values({
        campaignId: campaign!.id,
        name: plan.cohortName,
        status: 'RUNNING',
        startedAt: now(),
      })
      .returning({ id: testCohorts.id });

    campaignId = campaign!.id;
    cohortId = cohort!.id;
    platformCampaignId = platformCampaign.platformId;

    await db
      .update(campaignBriefs)
      .set({ launchedCampaignId: campaignId, launchedCohortId: cohortId })
      .where(eq(campaignBriefs.id, brief.id));
  }

  const targetingHash = hashTargeting(plan.targeting);
  const launched: LaunchApprovedResult['variants'] = [];

  for (const review of pending) {
    const adSetKey = stableKey(platformCampaignId, review.id);

    const platformAdSet = await adapter.createAdSet(
      {
        idempotencyKey: adSetKey,
        platformCampaignId,
        name: `${plan.cohortName} — ${review.angleTag}`,
        dailyBudgetCents: brief.dailyBudgetPerVariantCents,
        targeting: plan.targeting,
        startPaused: plan.startPaused,
      },
      ctx,
    );

    let imageUrl: string | undefined;
    if (review.imageAssetId) {
      const [asset] = await db
        .select({ url: creativeAssets.url })
        .from(creativeAssets)
        .where(eq(creativeAssets.id, review.imageAssetId));
      imageUrl = asset?.url ?? undefined;
    }

    const platformAd = await adapter.createAd(
      {
        idempotencyKey: stableKey(adSetKey, 'ad'),
        platformAdSetId: platformAdSet.platformId,
        name: review.headline.slice(0, 60),
        headline: review.headline,
        primaryText: review.primaryText,
        cta: review.cta,
        ...(imageUrl ? { imageUrl } : {}),
        landingPageUrl: brief.landingPageUrl,
        startPaused: plan.startPaused,
      },
      ctx,
    );

    const [adSet] = await db
      .insert(adSets)
      .values({
        campaignId,
        name: `${plan.cohortName} — ${review.angleTag}`,
        dailyBudgetCents: brief.dailyBudgetPerVariantCents,
        targeting: plan.targeting as unknown as object,
        targetingHash,
        status: plan.startPaused ? 'PAUSED' : 'ACTIVE',
        platformAdSetId: platformAdSet.platformId,
      })
      .returning({ id: adSets.id });

    const [row] = await db
      .insert(adVariants)
      .values({
        adSetId: adSet!.id,
        cohortId,
        campaignId,
        platformAdId: platformAd.platformId,
        headline: review.headline,
        primaryText: review.primaryText,
        cta: review.cta,
        imageAssetId: review.imageAssetId,
        angleTag: review.angleTag,
        hookType: review.hookType,
        generationReasoning: review.generationReasoning,
        status: plan.startPaused ? 'PENDING_LAUNCH' : 'TESTING',
        testStartedAt: plan.startPaused ? null : now(),
      })
      .returning({ id: adVariants.id });

    await db
      .update(creativeReviews)
      .set({ launchedAt: now(), launchedVariantId: row!.id })
      .where(eq(creativeReviews.id, review.id));

    launched.push({
      id: row!.id,
      reviewId: review.id,
      angleTag: review.angleTag,
      headline: review.headline,
      adSetId: adSet!.id,
    });
  }

  return {
    campaignId,
    cohortId,
    variants: launched,
    totalDailyBudgetCents: brief.dailyBudgetPerVariantCents * launched.length,
  };
}
