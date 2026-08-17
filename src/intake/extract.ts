/**
 * Brand-document pre-fill.
 *
 * Reads an uploaded brand guide and proposes answers to the intake questions. Every value it
 * produces is a *suggestion* — the intake engine keeps them separate from real answers, so the
 * client confirms or corrects each one. A document that says the wrong thing must be
 * correctable before it becomes the brand's permanent memory.
 *
 * The question list is built from the templates at call time, so a newly added industry gets
 * document pre-fill with no change here.
 */
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { listIndustries, questionsFor } from '../templates/registry.js';
import type { Question } from '../templates/schema.js';
import { validateAnswer, INDUSTRY_QUESTION_ID, type AnswerValue } from './engine.js';

export interface ExtractionResult {
  /** questionId -> proposed answer. Only questions the document actually addressed. */
  readonly prefilled: Record<string, AnswerValue>;
  /** Industry the document suggests, if it was clear enough to say. */
  readonly suggestedIndustry: string | null;
  readonly extractor: string;
  /** Questions the model attempted but produced an unusable answer for. */
  readonly rejected: { questionId: string; reason: string }[];
}

/** JSON Schema is built from the templates so a new industry needs no change here. */
function buildSchema(questions: Question[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    suggestedIndustry: {
      type: ['string', 'null'],
      description: `One of: ${listIndustries().map((i) => i.key).join(', ')}. Null if the document does not make it clear.`,
    },
  };

  for (const q of questions) {
    properties[q.id] = {
      type: ['string', 'null'],
      description: `${q.prompt} — answer only if the document states it. Null otherwise. ${
        q.type === 'multi_text' || q.type === 'multi_select'
          ? 'Return a comma-separated list.'
          : q.type === 'color_list'
            ? 'Return comma-separated "Name #HEX" pairs.'
            : q.type === 'font_pair'
              ? 'Return "DisplayFace / BodyFace".'
              : ''
      }`.trim(),
    };
  }

  return {
    type: 'object',
    properties,
    required: ['suggestedIndustry'],
    additionalProperties: false,
  };
}

/** Turns the model's flat string answer into the shape the question expects. */
function coerce(question: Question, raw: string): unknown {
  const trimmed = raw.trim();
  switch (question.type) {
    case 'multi_text':
      return trimmed.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    case 'multi_select': {
      const allowed = new Set((question.options ?? []).map((o) => o.value));
      return trimmed
        .split(/[,;\n]/)
        .map((s) => s.trim())
        .filter((s) => allowed.has(s));
    }
    case 'single_select': {
      const allowed = (question.options ?? []).map((o) => o.value);
      const exact = allowed.find((v) => v.toLowerCase() === trimmed.toLowerCase());
      if (exact) return exact;
      // Fall back to a label match, which is what a model is more likely to emit.
      const byLabel = (question.options ?? []).find(
        (o) => o.label.toLowerCase() === trimmed.toLowerCase(),
      );
      return byLabel?.value ?? trimmed;
    }
    case 'color_list':
      return trimmed
        .split(/[,;\n]/)
        .map((chunk) => {
          const m = /^(.*?)\s*(#[0-9a-fA-F]{6})$/.exec(chunk.trim());
          return m ? { name: m[1]!.trim() || 'Colour', hex: m[2]! } : null;
        })
        .filter(Boolean);
    case 'font_pair': {
      const [display, body] = trimmed.split('/').map((s) => s.trim());
      return { display: display ?? '', body: body ?? display ?? '' };
    }
    case 'number':
      return Number(trimmed.replace(/[^\d.-]/g, ''));
    default:
      return trimmed;
  }
}

/**
 * Validates each proposed answer against its own question before offering it.
 *
 * An extracted value that would fail validation is dropped with a reason rather than shown —
 * offering a suggestion the client cannot accept is worse than offering none.
 */
function accept(
  questions: Question[],
  raw: Record<string, unknown>,
): { prefilled: Record<string, AnswerValue>; rejected: { questionId: string; reason: string }[] } {
  const prefilled: Record<string, AnswerValue> = {};
  const rejected: { questionId: string; reason: string }[] = [];

  for (const question of questions) {
    const value = raw[question.id];
    if (value === null || value === undefined || value === '') continue;

    try {
      const coerced = coerce(question, String(value));
      const validated = validateAnswer({ ...question, required: false }, coerced);
      if (validated !== null) prefilled[question.id] = validated;
    } catch (error) {
      rejected.push({
        questionId: question.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { prefilled, rejected };
}

/**
 * Reads a brand document and proposes intake answers.
 *
 * Runs against the generic question set plus every industry branch, because the industry is
 * usually stated *in* the document — asking only the core questions first would mean a second
 * pass once the industry is known.
 */
export async function extractFromDocument(
  documentText: string,
  options: { readonly industryHint?: string | null } = {},
): Promise<ExtractionResult> {
  if (documentText.trim().length < 40) {
    return { prefilled: {}, suggestedIndustry: null, extractor: 'none', rejected: [] };
  }

  const questions = questionsFor(options.industryHint ?? null);

  if (!env.anthropicApiKey) {
    return heuristicExtract(documentText, questions);
  }

  const client = new Anthropic({ apiKey: env.anthropicApiKey });

  try {
    const response = await client.beta.messages.create({
      model: env.copyModel,
      max_tokens: 8_000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: buildSchema(questions) },
      },
      system:
        'You extract brand facts from documents. You only report what the document actually ' +
        'states — you never infer, embellish, or fill a gap with something plausible. A field ' +
        'the document does not address is null.',
      messages: [
        {
          role: 'user',
          content: `Extract brand details from this document. Return null for anything it does not state.\n\n---\n${documentText.slice(0, 100_000)}\n---`,
        },
      ],
    } as Parameters<typeof client.beta.messages.create>[0]);

    const message = response as Anthropic.Beta.BetaMessage;
    if (message.stop_reason === 'refusal') {
      return { prefilled: {}, suggestedIndustry: null, extractor: 'refused', rejected: [] };
    }

    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const parsed = JSON.parse(text) as Record<string, unknown>;
    const { prefilled, rejected } = accept(questions, parsed);

    const suggested = parsed.suggestedIndustry;
    const industryKeys = new Set(listIndustries().map((i) => i.key));
    const suggestedIndustry =
      typeof suggested === 'string' && industryKeys.has(suggested) ? suggested : null;
    if (suggestedIndustry) prefilled[INDUSTRY_QUESTION_ID] = suggestedIndustry;

    return { prefilled, suggestedIndustry, extractor: 'claude', rejected };
  } catch {
    // A failed extraction must not block onboarding — fall back to the heuristic pass.
    return heuristicExtract(documentText, questions);
  }
}

/**
 * Dependency-free fallback.
 *
 * Finds the handful of things a regex can find reliably — hex colours, and headings that name
 * a field. Deliberately conservative: a wrong suggestion costs more trust than a missing one.
 */
export function heuristicExtract(documentText: string, questions: Question[]): ExtractionResult {
  const prefilled: Record<string, AnswerValue> = {};

  const paletteQuestion = questions.find((q) => q.type === 'color_list');
  if (paletteQuestion) {
    const hexes = [...new Set(documentText.match(/#[0-9a-fA-F]{6}\b/g) ?? [])].slice(0, 8);
    if (hexes.length > 0) {
      prefilled[paletteQuestion.id] = hexes.map((hex, i) => ({
        name: `Colour ${i + 1}`,
        hex: hex.toUpperCase(),
      }));
    }
  }

  // "Brand name: Foo" / "Brand: Foo" style lines, which brand guides very often contain.
  const nameMatch = /^\s*(?:brand(?:\s*name)?|company)\s*[:\-]\s*(.{2,60})$/im.exec(documentText);
  if (nameMatch && questions.some((q) => q.id === 'brandName')) {
    prefilled.brandName = nameMatch[1]!.trim();
  }

  return { prefilled, suggestedIndustry: null, extractor: 'heuristic', rejected: [] };
}
