/**
 * Proves the compliance gate is enforced by the database, not only by the code path that
 * writes to it. A gate that only exists in application code is bypassed the first time
 * someone adds a second write path.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../../src/db/index.js';
import { brandProfiles, campaignBriefs, creativeReviews } from '../../src/db/schema.js';
import { seedWorld, truncateAll, type SeededWorld } from './helpers.js';

beforeEach(truncateAll);
afterAll(async () => {
  await pool.end();
});

async function seedProfile(world: SeededWorld, industryKey = 'healthcare'): Promise<string> {
  const [profile] = await db
    .insert(brandProfiles)
    .values({
      clientId: world.clientId,
      version: 1,
      industryKey,
      complianceTemplateKey: industryKey,
      core: { brandName: 'Test Clinic' },
      industry: {},
      locks: {},
      createdBy: 'test',
    })
    .returning({ id: brandProfiles.id });
  return profile!.id;
}

const review = (clientId: string, profileId: string, over: Record<string, unknown> = {}) => ({
  clientId,
  brandProfileId: profileId,
  status: 'PENDING_REVIEW' as const,
  angleTag: 'test',
  headline: 'A headline',
  primaryText: 'Body copy',
  cta: 'Learn more',
  complianceVerdict: {},
  complianceBlocked: false,
  ...over,
});

describe('the database refuses to approve blocked content', () => {
  it('rejects an APPROVED row that is also flagged as blocked', async () => {
    const world = await seedWorld();
    const profileId = await seedProfile(world);

    await expect(
      db.insert(creativeReviews).values(
        review(world.clientId, profileId, {
          status: 'APPROVED',
          complianceBlocked: true,
          reviewedBy: 'someone',
          reviewedAt: new Date(),
        }),
      ),
    ).rejects.toThrow(/creative_reviews_blocked_not_approved_ck/);
  });

  it('rejects an UPDATE that approves an existing blocked row', async () => {
    const world = await seedWorld();
    const profileId = await seedProfile(world);

    const [row] = await db
      .insert(creativeReviews)
      .values(review(world.clientId, profileId, { status: 'BLOCKED', complianceBlocked: true }))
      .returning({ id: creativeReviews.id });

    // This is the realistic bypass attempt: a second code path flipping status directly.
    await expect(
      db
        .update(creativeReviews)
        .set({ status: 'APPROVED', reviewedBy: 'someone', reviewedAt: new Date() })
        .where(eq(creativeReviews.id, row!.id)),
    ).rejects.toThrow(/creative_reviews_blocked_not_approved_ck/);
  });

  it('allows approval once the block is cleared by an edit', async () => {
    const world = await seedWorld();
    const profileId = await seedProfile(world);

    const [row] = await db
      .insert(creativeReviews)
      .values(review(world.clientId, profileId, { status: 'BLOCKED', complianceBlocked: true }))
      .returning({ id: creativeReviews.id });

    await db
      .update(creativeReviews)
      .set({ complianceBlocked: false, status: 'EDITED', editedBy: 'reviewer', editedAt: new Date() })
      .where(eq(creativeReviews.id, row!.id));

    await expect(
      db
        .update(creativeReviews)
        .set({ status: 'APPROVED', reviewedBy: 'reviewer', reviewedAt: new Date() })
        .where(eq(creativeReviews.id, row!.id)),
    ).resolves.toBeDefined();
  });

  it('requires an approver to be recorded', async () => {
    const world = await seedWorld();
    const profileId = await seedProfile(world);

    await expect(
      db.insert(creativeReviews).values(
        review(world.clientId, profileId, { status: 'APPROVED', reviewedBy: null }),
      ),
    ).rejects.toThrow(/creative_reviews_approved_ck/);
  });
});

describe('brand profile versioning', () => {
  it('allows only one live profile per client', async () => {
    const world = await seedWorld();
    await seedProfile(world);

    await expect(
      db.insert(brandProfiles).values({
        clientId: world.clientId,
        version: 2,
        industryKey: 'healthcare',
        complianceTemplateKey: 'healthcare',
        core: {},
        createdBy: 'test',
      }),
    ).rejects.toThrow(/brand_profiles_one_live_key/);
  });

  it('permits a new live version once the previous one is closed', async () => {
    const world = await seedWorld();
    const first = await seedProfile(world);

    await db
      .update(brandProfiles)
      .set({ effectiveTo: new Date() })
      .where(eq(brandProfiles.id, first));

    await expect(
      db.insert(brandProfiles).values({
        clientId: world.clientId,
        version: 2,
        industryKey: 'finance',
        complianceTemplateKey: 'finance',
        core: {},
        createdBy: 'test',
      }),
    ).resolves.toBeDefined();
  });
});

describe('campaign briefs', () => {
  it('rejects an unknown campaign type', async () => {
    const world = await seedWorld();
    const profileId = await seedProfile(world);

    await expect(
      db.insert(campaignBriefs).values({
        clientId: world.clientId,
        brandProfileId: profileId,
        name: 'Bad',
        campaignType: 'telepathy',
        placements: [],
        landingPageUrl: 'https://example.com',
        dailyBudgetPerVariantCents: 3000,
        createdBy: 'test',
      }),
    ).rejects.toThrow(/campaign_briefs_type_ck/);
  });

  it('accepts each supported campaign type', async () => {
    const world = await seedWorld();
    const profileId = await seedProfile(world);

    for (const type of ['awareness', 'conversion', 'retargeting', 'launch', 'seasonal']) {
      await expect(
        db.insert(campaignBriefs).values({
          clientId: world.clientId,
          brandProfileId: profileId,
          name: `Brief ${type}`,
          campaignType: type,
          placements: [{ platform: 'META', formats: ['FEED_1_1'] }],
          landingPageUrl: 'https://example.com',
          dailyBudgetPerVariantCents: 3000,
          createdBy: 'test',
        }),
      ).resolves.toBeDefined();
    }
  });
});
