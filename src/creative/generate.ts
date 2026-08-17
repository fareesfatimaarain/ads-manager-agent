/**
 * Creative generation orchestration: brief in, launch-ready variants out.
 *
 * The loop that matters is at the top of this file — `loadAnglePerformance` reads what past
 * angles actually did and feeds it back into the next generation. Without it the system makes
 * new ads forever without ever learning what persuades the audience.
 */
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { brandKits, creativeAssets, clients } from '../db/schema.js';
import { partitionByCompliance } from './brandKit.js';
import { MockCopyGenerator, ClaudeCopyGenerator } from './copy.js';
import { resolveImageProvider } from './providers.js';
import { env } from '../config/env.js';
import {
  CreativeGenerationError,
  type AnglePerformance,
  type BrandKit,
  type CopyGenerator,
  type CreativeBrief,
  type CreativeProvider,
  type GeneratedCopy,
  type GeneratedImage,
} from './types.js';

export interface GeneratedVariant {
  readonly copy: GeneratedCopy;
  readonly image: GeneratedImage;
  readonly imageAssetId: string;
}

export interface GenerationReport {
  readonly variants: readonly GeneratedVariant[];
  readonly rejected: readonly { angleTag: string; reasons: string[] }[];
  readonly generator: string;
  readonly imageProvider: string;
}

/**
 * How each angle has performed, aggregated across every variant that ever carried it.
 *
 * The verdict is deliberately coarse — WINNER / MIXED / LOSER — because that is the
 * resolution the generator can actually use. Handing it precise CPAs invites it to
 * over-fit to noise in a way that a three-way verdict does not.
 */
export async function loadAnglePerformance(
  db: Database,
  clientId: string,
  targetCpaCents: number | null,
): Promise<AnglePerformance[]> {
  const rows = await db.execute(sql`
    SELECT v.angle_tag                                   AS angle_tag,
           COUNT(DISTINCT v.id)                          AS variants_tested,
           COALESCE(SUM(p.spend_cents), 0)::bigint       AS spend_cents,
           COALESCE(SUM(p.conversions), 0)::bigint       AS conversions
    FROM ad_variants v
    JOIN campaigns c ON c.id = v.campaign_id
    LEFT JOIN (
      SELECT DISTINCT ON (ad_variant_id, stat_date) *
      FROM daily_performance
      ORDER BY ad_variant_id, stat_date, fetched_at DESC
    ) p ON p.ad_variant_id = v.id
    WHERE c.client_id = ${clientId}
    GROUP BY v.angle_tag
    ORDER BY v.angle_tag
  `);

  return (rows.rows as Record<string, unknown>[]).map((row) => {
    const spendCents = Number(row.spend_cents ?? 0);
    const conversions = Number(row.conversions ?? 0);
    const cpaCents = conversions > 0 ? Math.round(spendCents / conversions) : null;

    let verdict: AnglePerformance['verdict'] = 'UNTESTED';
    if (spendCents > 0) {
      if (targetCpaCents === null || cpaCents === null) {
        // Spent money, produced nothing measurable against target.
        verdict = conversions === 0 ? 'LOSER' : 'MIXED';
      } else if (cpaCents <= targetCpaCents) {
        verdict = 'WINNER';
      } else if (cpaCents <= targetCpaCents * 1.5) {
        verdict = 'MIXED';
      } else {
        verdict = 'LOSER';
      }
    }

    return {
      angleTag: String(row.angle_tag),
      variantsTested: Number(row.variants_tested ?? 0),
      totalSpendCents: spendCents,
      totalConversions: conversions,
      cpaCents,
      verdict,
    };
  });
}

export async function loadBrandKit(db: Database, clientId: string): Promise<BrandKit> {
  const rows = await db
    .select()
    .from(brandKits)
    .where(eq(brandKits.clientId, clientId))
    .orderBy(sql`${brandKits.version} DESC`)
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new CreativeGenerationError(
      'this client has no brand kit; creative cannot be generated without one because the ' +
        'constraints are applied during generation, not afterwards',
      'BRAND_CHECK',
      false,
    );
  }

  return {
    id: row.id,
    clientId: row.clientId,
    version: row.version,
    palette: row.palette as BrandKit['palette'],
    fonts: row.fonts as BrandKit['fonts'],
    tone: row.tone,
    bannedWords: row.bannedWords as string[],
    bannedClaims: row.bannedClaims as string[],
    requiredDisclaimers: row.requiredDisclaimers as string[],
    logoAssetId: row.logoAssetId,
  };
}

export function resolveCopyGenerator(): CopyGenerator {
  // Fall back to the deterministic generator rather than failing, so the rest of the pipeline
  // stays exercisable without an API key. The report names which one ran.
  if (!env.anthropicApiKey) return new MockCopyGenerator();
  return new ClaudeCopyGenerator();
}

/**
 * Generates a cohort's worth of creative.
 *
 * Non-compliant variants are dropped, not silently patched — the report says which and why.
 * Topping the batch back up with near-duplicates would quietly break the test design, since
 * cohort members are supposed to be genuinely distinct arguments.
 */
export async function generateCreative(
  db: Database,
  options: {
    readonly clientId: string;
    readonly icp: string;
    readonly offer: string;
    readonly landingPageUrl: string;
    readonly variantCount: number;
    readonly excludeAngles?: readonly string[];
    readonly copyGenerator?: CopyGenerator;
    readonly imageProvider?: CreativeProvider;
  },
): Promise<GenerationReport> {
  const [client] = await db.select().from(clients).where(eq(clients.id, options.clientId));
  if (!client) throw new CreativeGenerationError(`unknown client ${options.clientId}`, 'COPY', false);

  const brandKit = await loadBrandKit(db, options.clientId);
  const anglePerformance = await loadAnglePerformance(
    db,
    options.clientId,
    client.defaultTargetCpaCents,
  );

  const brief: CreativeBrief = {
    clientName: client.name,
    icp: options.icp,
    offer: options.offer,
    landingPageUrl: options.landingPageUrl,
    objective: client.defaultObjectiveType,
    anglePerformance,
    excludeAngles: options.excludeAngles ?? [],
    variantCount: options.variantCount,
  };

  const generator = options.copyGenerator ?? resolveCopyGenerator();
  const imageProvider = options.imageProvider ?? resolveImageProvider();

  const draft = await generator.generate(brief, brandKit);
  const { compliant, rejected } = partitionByCompliance(draft, brandKit);

  const variants: GeneratedVariant[] = [];
  for (const copy of compliant) {
    const image = await imageProvider.generateImage({
      concept: copy.imageConcept,
      palette: brandKit.palette.map((p) => p.hex),
      aspectRatio: '4:5',
      // Stable across retries: the same concept for the same client never pays twice.
      idempotencyKey: `${options.clientId}:${copy.angleTag}:${copy.imageConcept}`,
    });

    const [asset] = await db
      .insert(creativeAssets)
      .values({
        clientId: options.clientId,
        kind: 'IMAGE',
        provider: image.provider,
        providerAssetId: image.providerAssetId,
        url: image.url,
        prompt: image.prompt,
        brandKitVersion: brandKit.version,
        metadata: { widthPx: image.widthPx, heightPx: image.heightPx, angleTag: copy.angleTag },
      })
      .returning({ id: creativeAssets.id });

    variants.push({ copy, image, imageAssetId: asset!.id });
  }

  return {
    variants,
    rejected: rejected.map((r) => ({
      angleTag: r.copy.angleTag,
      reasons: r.result.violations.map((v) => `${v.field} ${v.detail}`),
    })),
    generator: generator.name,
    imageProvider: imageProvider.name,
  };
}

/** Angles currently live for a client, so a new cohort does not duplicate them. */
export async function activeAngles(db: Database, clientId: string): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT v.angle_tag
    FROM ad_variants v
    JOIN campaigns c ON c.id = v.campaign_id
    WHERE c.client_id = ${clientId}
      AND v.status IN ('TESTING', 'SCALING', 'PENDING_LAUNCH')
  `);
  return (rows.rows as { angle_tag: string }[]).map((r) => r.angle_tag);
}

export { partitionByCompliance, checkCompliance } from './brandKit.js';
export type { GeneratedCopy, BrandKit, CreativeBrief } from './types.js';
