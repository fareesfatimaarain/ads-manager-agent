/**
 * Brand-governed generation.
 *
 * This replaces the thin brand-kit path. The differences that matter:
 *
 *  - Generation is constrained by the **stored brand profile**, including any locked elements,
 *    rather than by a handful of fields.
 *  - Uploaded **reference assets** (past ads, style guides, brand documents) are grounding
 *    context, so output resembles the brand's existing work rather than a generic house style.
 *  - Every generated item passes the **compliance gate** before a human sees it, and is written
 *    to the review queue carrying its verdict. Nothing reaches a campaign unreviewed, and a
 *    blocked item cannot be approved — the database refuses it.
 *  - The **campaign brief** (awareness / conversion / retargeting / launch / seasonal) and any
 *    per-campaign tone override shape the ask without touching the stored brand.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import {
  brandProfiles,
  campaignBriefs,
  complianceRuleOverrides,
  complianceRules,
  creativeAssets,
  creativeReviews,
  referenceAssets,
} from '../db/schema.js';
import {
  assembleRules,
  brandConstraintsOf,
  evaluate,
  type CustomRuleInput,
} from '../compliance/engine.js';
import { resolveIndustry } from '../templates/registry.js';
import type { ContentField, Match } from '../templates/schema.js';
import { MockCopyGenerator, ClaudeCopyGenerator } from './copy.js';
import { resolveImageProvider } from './providers.js';
import { env } from '../config/env.js';
import { CreativeGenerationError, type CopyGenerator, type CreativeProvider, type GeneratedCopy } from './types.js';

export interface LiveBrandProfile {
  readonly id: string;
  readonly version: number;
  readonly industryKey: string;
  readonly complianceTemplateKey: string;
  readonly core: Record<string, unknown>;
  readonly industry: Record<string, unknown>;
  readonly locks: Record<string, boolean>;
  readonly creativeDirection: string | null;
}

export async function loadLiveProfile(db: Database, clientId: string): Promise<LiveBrandProfile> {
  const [row] = await db
    .select()
    .from(brandProfiles)
    .where(and(eq(brandProfiles.clientId, clientId), isNull(brandProfiles.effectiveTo)));

  if (!row) {
    throw new CreativeGenerationError(
      'this client has no live brand profile — run brand onboarding before generating creative',
      'BRAND_CHECK',
      false,
    );
  }

  return {
    id: row.id,
    version: row.version,
    industryKey: row.industryKey,
    complianceTemplateKey: row.complianceTemplateKey,
    core: row.core as Record<string, unknown>,
    industry: row.industry as Record<string, unknown>,
    locks: row.locks as Record<string, boolean>,
    creativeDirection: row.creativeDirection,
  };
}

/** Client-defined rules plus any template rules they have switched off. */
export async function loadClientComplianceConfig(
  db: Database,
  clientId: string,
): Promise<{ customRules: CustomRuleInput[]; disabledRuleIds: string[] }> {
  const custom = await db
    .select()
    .from(complianceRules)
    .where(eq(complianceRules.clientId, clientId));

  const overrides = await db
    .select()
    .from(complianceRuleOverrides)
    .where(and(eq(complianceRuleOverrides.clientId, clientId), eq(complianceRuleOverrides.disabled, true)));

  return {
    customRules: custom.map((r) => ({
      id: r.ruleKey,
      title: r.title,
      severity: r.severity as 'BLOCK' | 'FLAG',
      reason: r.reason,
      appliesTo: r.appliesTo as ContentField[],
      match: r.match as Match,
      enabled: r.enabled,
    })),
    disabledRuleIds: overrides.map((o) => o.templateRuleId),
  };
}

/** Active grounding material, most recent first. */
export async function loadReferenceContext(db: Database, clientId: string) {
  return db
    .select({
      kind: referenceAssets.kind,
      filename: referenceAssets.filename,
      usageNote: referenceAssets.usageNote,
      extractedText: referenceAssets.extractedText,
    })
    .from(referenceAssets)
    .where(and(eq(referenceAssets.clientId, clientId), eq(referenceAssets.active, true)))
    .orderBy(desc(referenceAssets.createdAt))
    .limit(20);
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value
      .map((v) =>
        typeof v === 'object' && v !== null && 'name' in v && 'hex' in v
          ? `${(v as { name: string }).name} (${(v as { hex: string }).hex})`
          : String(v),
      )
      .join(', ');
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(', ');
  }
  return String(value);
}

/**
 * Turns the stored profile into the constraint block that governs generation.
 *
 * Industry answers are rendered generically from whatever the template defined, which is what
 * keeps this function industry-agnostic — it has no idea what "patientDemographics" means, only
 * that the brand answered it and it is context.
 */
export function renderBrandGovernance(
  profile: LiveBrandProfile,
  references: { kind: string; filename: string; usageNote: string | null; extractedText: string | null }[],
  brief: { campaignType: string; toneOverride: string | null; briefNotes: string | null } | null,
): string {
  const industry = resolveIndustry(profile.industryKey);
  const sections: string[] = [];

  sections.push(`Brand: ${renderValue(profile.core.brandName)}`);
  sections.push(`Industry: ${industry.label}`);

  const coreLines = Object.entries(profile.core)
    .filter(([key]) => key !== 'brandName' && key !== 'industryKey')
    .map(([key, value]) => `  ${key}: ${renderValue(value)}`)
    .filter((l) => l.split(': ')[1]?.length);
  if (coreLines.length > 0) sections.push(`Brand identity:\n${coreLines.join('\n')}`);

  const industryLines = Object.entries(profile.industry)
    .map(([key, value]) => `  ${key}: ${renderValue(value)}`)
    .filter((l) => l.split(': ')[1]?.length);
  if (industryLines.length > 0) {
    sections.push(`Industry-specific context:\n${industryLines.join('\n')}`);
  }

  const locked = Object.entries(profile.locks)
    .filter(([, isLocked]) => isLocked)
    .map(([element]) => element);
  if (locked.length > 0) {
    sections.push(
      `Locked elements — these are fixed and must be used exactly as stored, never reinterpreted: ${locked.join(', ')}`,
    );
  }

  if (profile.creativeDirection) {
    sections.push(`Standing creative direction:\n${profile.creativeDirection}`);
  }

  if (brief) {
    const campaignIntent: Record<string, string> = {
      awareness: 'introduce the brand to people who do not know it; do not push for an immediate purchase',
      conversion: 'move someone who already understands the offer to act now',
      retargeting: 'speak to someone who has already engaged; assume familiarity, address hesitation',
      launch: 'announce something new; lead with what has changed',
      seasonal: 'tie the offer to a moment in time without manufacturing false urgency',
    };
    sections.push(
      `Campaign type: ${brief.campaignType} — ${campaignIntent[brief.campaignType] ?? 'follow the brief'}`,
    );
    if (brief.toneOverride) {
      sections.push(`Tone for this campaign only (overrides the brand default): ${brief.toneOverride}`);
    }
    if (brief.briefNotes) sections.push(`Brief notes:\n${brief.briefNotes}`);
  }

  if (references.length > 0) {
    const lines = references.map((r) => {
      const note = r.usageNote ? ` — ${r.usageNote}` : '';
      const excerpt = r.extractedText
        ? `\n    excerpt: ${r.extractedText.slice(0, 600).replace(/\s+/g, ' ')}`
        : '';
      return `  [${r.kind}] ${r.filename}${note}${excerpt}`;
    });
    sections.push(
      `Reference material the brand has supplied. Match its register and vocabulary:\n${lines.join('\n')}`,
    );
  }

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface GovernedGenerationResult {
  readonly reviewIds: string[];
  readonly generated: number;
  readonly blocked: number;
  readonly flagged: number;
  readonly clean: number;
  readonly generator: string;
  readonly imageProvider: string;
  readonly refusedDisables: string[];
}

/**
 * Generates creative under the brand profile and files everything into the review queue.
 *
 * Blocked items are still written — deliberately. A client needs to see what was rejected and
 * why, both to trust the gate and to notice when a rule is mis-tuned. Discarding them silently
 * would make the compliance layer invisible and therefore unaccountable.
 */
export async function generateGoverned(
  db: Database,
  options: {
    readonly clientId: string;
    readonly campaignBriefId?: string;
    readonly variantCount?: number;
    readonly copyGenerator?: CopyGenerator;
    readonly imageProvider?: CreativeProvider;
    readonly now?: () => Date;
  },
): Promise<GovernedGenerationResult> {
  const now = options.now ?? (() => new Date());
  const profile = await loadLiveProfile(db, options.clientId);
  const references = await loadReferenceContext(db, options.clientId);
  const clientRules = await loadClientComplianceConfig(db, options.clientId);

  let brief: typeof campaignBriefs.$inferSelect | null = null;
  if (options.campaignBriefId) {
    const [row] = await db
      .select()
      .from(campaignBriefs)
      .where(eq(campaignBriefs.id, options.campaignBriefId));
    brief = row ?? null;
  }

  const variantCount = options.variantCount ?? brief?.variantCount ?? 4;

  // Assemble the rule set first. If compliance cannot be configured, nothing is generated —
  // producing content we then cannot check is worse than producing none.
  const { rules, chain, refusedDisables } = assembleRules({
    industryKey: profile.industryKey,
    customRules: clientRules.customRules,
    disabledRuleIds: clientRules.disabledRuleIds,
    brand: brandConstraintsOf(profile),
  });

  const governance = renderBrandGovernance(
    profile,
    references,
    brief
      ? {
          campaignType: brief.campaignType,
          toneOverride: brief.toneOverride,
          briefNotes: brief.briefNotes,
        }
      : null,
  );

  const generator = options.copyGenerator ?? (env.anthropicApiKey ? new ClaudeCopyGenerator() : new MockCopyGenerator());
  const imageProvider = options.imageProvider ?? resolveImageProvider();

  const palette = (profile.core.palette as { name: string; hex: string }[] | undefined) ?? [];
  const bannedWords = (profile.core.bannedWords as string[] | undefined) ?? [];
  const requiredDisclaimers = (profile.core.requiredDisclaimers as string[] | undefined) ?? [];

  const drafts: GeneratedCopy[] = await generator.generate(
    {
      clientName: String(profile.core.brandName ?? 'the brand'),
      icp: String(profile.core.targetAudience ?? ''),
      // The governance block carries the whole brand; the offer line keeps the ask concrete.
      offer: `${String(profile.core.offering ?? '')}\n\n${governance}`,
      landingPageUrl: brief?.landingPageUrl ?? '',
      objective: 'CPA',
      anglePerformance: [],
      excludeAngles: [],
      variantCount,
    },
    {
      id: profile.id,
      clientId: options.clientId,
      version: profile.version,
      palette,
      fonts: (profile.core.fonts as { display: string; body: string } | undefined) ?? {
        display: 'Georgia',
        body: 'Segoe UI',
      },
      tone: String(profile.core.toneNotes ?? profile.core.toneKey ?? ''),
      bannedWords,
      bannedClaims: [],
      requiredDisclaimers,
      logoAssetId: null,
    },
  );

  const reviewIds: string[] = [];
  let blocked = 0;
  let flagged = 0;
  let clean = 0;

  for (const copy of drafts) {
    const verdict = evaluate(
      {
        headline: copy.headline,
        primaryText: copy.primaryText,
        cta: copy.cta,
        imageConcept: copy.imageConcept,
      },
      rules,
      chain,
      now(),
    );

    // Imagery is only produced for content that can actually be used. Generating a picture for
    // a blocked ad spends money on something nobody may approve.
    let imageAssetId: string | null = null;
    if (!verdict.blocked) {
      const image = await imageProvider.generateImage({
        concept: copy.imageConcept,
        palette: palette.map((p) => p.hex),
        aspectRatio: '4:5',
        idempotencyKey: `${options.clientId}:${profile.version}:${copy.angleTag}:${copy.imageConcept}`,
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
          brandKitVersion: profile.version,
          metadata: { angleTag: copy.angleTag, widthPx: image.widthPx, heightPx: image.heightPx },
        })
        .returning({ id: creativeAssets.id });
      imageAssetId = asset!.id;
    }

    const [review] = await db
      .insert(creativeReviews)
      .values({
        clientId: options.clientId,
        brandProfileId: profile.id,
        campaignBriefId: brief?.id ?? null,
        status: verdict.blocked ? 'BLOCKED' : 'PENDING_REVIEW',
        angleTag: copy.angleTag,
        hookType: copy.hookType,
        headline: copy.headline,
        primaryText: copy.primaryText,
        cta: copy.cta,
        imageConcept: copy.imageConcept,
        imageAssetId,
        generationReasoning: copy.reasoning,
        complianceVerdict: verdict as unknown as object,
        complianceBlocked: verdict.blocked,
      })
      .returning({ id: creativeReviews.id });

    reviewIds.push(review!.id);
    if (verdict.blocked) blocked += 1;
    else if (verdict.findings.length > 0) flagged += 1;
    else clean += 1;
  }

  return {
    reviewIds,
    generated: drafts.length,
    blocked,
    flagged,
    clean,
    generator: generator.name,
    imageProvider: imageProvider.name,
    refusedDisables,
  };
}

/**
 * Re-checks edited copy before approval.
 *
 * A reviewer editing a blocked item must have the edit re-evaluated — otherwise the gate is
 * bypassed by the act of fixing it.
 */
export async function recheckReview(
  db: Database,
  reviewId: string,
  edited: { headline: string; primaryText: string; cta: string; imageConcept?: string },
  editor: string,
): Promise<{ blocked: boolean; findings: number }> {
  const [review] = await db.select().from(creativeReviews).where(eq(creativeReviews.id, reviewId));
  if (!review) throw new Error(`unknown review ${reviewId}`);

  const [profile] = await db
    .select()
    .from(brandProfiles)
    .where(eq(brandProfiles.id, review.brandProfileId));
  if (!profile) throw new Error('review references a brand profile that no longer exists');

  const clientRules = await loadClientComplianceConfig(db, review.clientId);
  // Re-checked against the profile version this ad was generated under, not the live one — an
  // edit is judged by the rules that were in force when the ad was made.
  const { rules, chain } = assembleRules({
    industryKey: profile.industryKey,
    customRules: clientRules.customRules,
    disabledRuleIds: clientRules.disabledRuleIds,
    brand: brandConstraintsOf(profile),
  });

  const verdict = evaluate(edited, rules, chain);

  await db
    .update(creativeReviews)
    .set({
      headline: edited.headline,
      primaryText: edited.primaryText,
      cta: edited.cta,
      imageConcept: edited.imageConcept ?? review.imageConcept,
      complianceVerdict: verdict as unknown as object,
      complianceBlocked: verdict.blocked,
      status: verdict.blocked ? 'BLOCKED' : 'EDITED',
      editedBy: editor,
      editedAt: new Date(),
    })
    .where(eq(creativeReviews.id, reviewId));

  return { blocked: verdict.blocked, findings: verdict.findings.length };
}
