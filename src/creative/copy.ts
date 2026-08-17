/**
 * Ad copy generation via Claude.
 *
 * Two things make this more than a wrapper around a completion call:
 *
 *  1. **The brand kit is part of the instruction**, not a filter applied afterwards. A banned
 *     claim that never gets written cannot slip past a regex that didn't anticipate its
 *     phrasing.
 *
 *  2. **Past angle performance is an input.** Each generation is told which angles have won,
 *     lost, or never been tried, so the system explores away from dead ends and toward what
 *     has worked. This is what makes it learn which *arguments* persuade the audience rather
 *     than only which specific ads happened to do well.
 *
 * Output is constrained with structured outputs, so the response is a validated object rather
 * than prose that has to be parsed out of a paragraph.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env, assertCreativeConfigured } from '../config/env.js';
import { renderBrandConstraints } from './brandKit.js';
import {
  CreativeGenerationError,
  type BrandKit,
  type CopyGenerator,
  type CreativeBrief,
  type GeneratedCopy,
} from './types.js';

const VariantSchema = z.object({
  angleTag: z.string().min(1),
  hookType: z.string().min(1),
  headline: z.string().min(1),
  primaryText: z.string().min(1),
  cta: z.string().min(1),
  reasoning: z.string().min(1),
  imageConcept: z.string().min(1),
});

const ResponseSchema = z.object({ variants: z.array(VariantSchema) });

/** JSON Schema for structured outputs. Every object needs `additionalProperties: false`. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    variants: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          angleTag: {
            type: 'string',
            description: 'Short kebab-case identifier for the angle, e.g. "time-saved".',
          },
          hookType: {
            type: 'string',
            description: 'The rhetorical device the opening uses, e.g. "question", "stat".',
          },
          headline: { type: 'string' },
          primaryText: { type: 'string' },
          cta: { type: 'string' },
          reasoning: {
            type: 'string',
            description: 'Why this angle is worth testing on this audience, in one or two sentences.',
          },
          imageConcept: {
            type: 'string',
            description: 'What the accompanying image should show, as a visual brief.',
          },
        },
        required: ['angleTag', 'hookType', 'headline', 'primaryText', 'cta', 'reasoning', 'imageConcept'],
        additionalProperties: false,
      },
    },
  },
  required: ['variants'],
  additionalProperties: false,
} as const;

function renderAngleHistory(brief: CreativeBrief): string {
  if (brief.anglePerformance.length === 0) {
    return 'No angles have been tested for this client yet. Explore broadly.';
  }

  const rows = brief.anglePerformance.map((a) => {
    const cpa = a.cpaCents === null ? 'no conversions' : `$${(a.cpaCents / 100).toFixed(2)} per conversion`;
    return `  - ${a.angleTag}: ${a.verdict}, ${a.variantsTested} variant(s) tested, ${cpa}`;
  });

  return (
    'Angles already tested, and how they did:\n' +
    rows.join('\n') +
    '\n\nLean into what the winners have in common. Do not re-test a losing angle with only ' +
    'cosmetic changes — if an angle lost, the argument failed, not the wording.'
  );
}

function buildPrompt(brief: CreativeBrief, kit: BrandKit): string {
  const exclusions =
    brief.excludeAngles.length > 0
      ? `\nThese angles are already live and must not be duplicated: ${brief.excludeAngles.join(', ')}`
      : '';

  return `Write ${brief.variantCount} ad variants for ${brief.clientName}.

Who they are for:
${brief.icp}

What is being sold:
${brief.offer}

${renderAngleHistory(brief)}${exclusions}

Brand constraints — these are hard requirements, not preferences:
${renderBrandConstraints(kit)}

Each variant must test a genuinely different *argument* for why someone should act — not the
same argument reworded. Two variants that both lead on price are one variant with two
headlines, and they waste a test slot. Give each one an angleTag naming the argument it makes.

The reasoning field is read by the system later to work out which arguments persuade this
audience, so write it for that purpose: name the underlying claim and who it should land with.`;
}

export class ClaudeCopyGenerator implements CopyGenerator {
  readonly name = 'claude';
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    assertCreativeConfigured();
    this.client = new Anthropic({ apiKey: apiKey ?? env.anthropicApiKey ?? undefined });
  }

  async generate(brief: CreativeBrief, brandKit: BrandKit): Promise<GeneratedCopy[]> {
    let response;
    try {
      response = await this.client.beta.messages.create({
        model: env.copyModel,
        max_tokens: 16_000,
        // Server-side fallback: if safety classifiers decline the request, the API re-runs it
        // on the recommended fallback model rather than returning nothing. Ad copy rarely
        // trips them, but a creative pipeline that silently produces zero variants overnight
        // is worse than one that quietly used a different model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: {
          effort: 'high',
          format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
        },
        system:
          'You write direct-response advertising. You are precise about the difference ' +
          'between an angle (the argument) and a variation (the wording), and you never ' +
          'breach a brand constraint even when it would make for a stronger ad.',
        messages: [{ role: 'user', content: buildPrompt(brief, brandKit) }],
      } as Parameters<typeof this.client.beta.messages.create>[0]);
    } catch (error) {
      throw new CreativeGenerationError(
        `copy generation request failed: ${error instanceof Error ? error.message : String(error)}`,
        'COPY',
        error instanceof Anthropic.APIError
          ? error.status === 429 || (error.status ?? 0) >= 500
          : false,
        error,
      );
    }

    const message = response as Anthropic.Beta.BetaMessage;

    // Check stop_reason before touching content — on a refusal, content is empty or partial.
    if (message.stop_reason === 'refusal') {
      throw new CreativeGenerationError(
        'copy generation was declined by safety classifiers, and the fallback model also declined',
        'COPY',
        false,
      );
    }
    if (message.stop_reason === 'max_tokens') {
      throw new CreativeGenerationError(
        'copy generation hit the output limit before completing; raise max_tokens or request fewer variants',
        'COPY',
        false,
      );
    }

    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    if (text.length === 0) {
      throw new CreativeGenerationError('copy generation returned no text content', 'COPY', true);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new CreativeGenerationError(
        'copy generation returned text that is not valid JSON despite the schema constraint',
        'COPY',
        true,
        error,
      );
    }

    const validated = ResponseSchema.safeParse(parsed);
    if (!validated.success) {
      throw new CreativeGenerationError(
        `copy generation output failed validation: ${validated.error.message}`,
        'COPY',
        true,
      );
    }

    return validated.data.variants;
  }
}

/**
 * Deterministic generator for tests and for running the pipeline without an API key.
 *
 * Produces structurally valid, brand-compliant copy from a fixed angle pool, so the launch and
 * decision paths can be exercised end to end offline.
 */
export class MockCopyGenerator implements CopyGenerator {
  readonly name = 'mock';

  private static readonly ANGLES = [
    { tag: 'time-saved', hook: 'outcome', headline: 'Get your evenings back', body: 'Cuts the job from three hours to twenty minutes.' },
    { tag: 'risk-avoided', hook: 'warning', headline: "Don't find out the expensive way", body: 'Catches the problem before it costs you.' },
    { tag: 'social-proof', hook: 'stat', headline: 'Join 12,000 others', body: 'The tool teams switch to and stay on.' },
    { tag: 'price-led', hook: 'offer', headline: 'Now 30% off', body: 'Same product, lower price, this month only.' },
    { tag: 'authority', hook: 'credential', headline: 'Built by the people who wrote the standard', body: 'Fifteen years of doing this properly.' },
    { tag: 'ease-of-start', hook: 'objection', headline: 'Set up in four minutes', body: 'No migration, no training, no IT ticket.' },
  ] as const;

  // eslint-disable-next-line @typescript-eslint/require-await
  async generate(brief: CreativeBrief, _brandKit: BrandKit): Promise<GeneratedCopy[]> {
    const available = MockCopyGenerator.ANGLES.filter(
      (a) => !brief.excludeAngles.includes(a.tag),
    );
    return available.slice(0, brief.variantCount).map((a) => ({
      angleTag: a.tag,
      hookType: a.hook,
      headline: a.headline,
      primaryText: a.body,
      cta: 'Learn more',
      reasoning: `Tests the "${a.tag}" argument against ${brief.icp}.`,
      imageConcept: `A clean product shot conveying ${a.tag.replace(/-/g, ' ')}.`,
    }));
  }
}
