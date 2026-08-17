/**
 * Template contracts.
 *
 * These schemas are the entire interface between the product and an industry. Supporting a new
 * vertical means writing two JSON files that satisfy them — an intake question set and a
 * compliance rule set — and nothing in `src/` changes. If you find yourself adding an
 * `if (industry === ...)` anywhere outside a template file, the abstraction has failed.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Intake question sets
// ---------------------------------------------------------------------------

export const QuestionTypeSchema = z.enum([
  'text',
  'long_text',
  'multi_text',
  'single_select',
  'multi_select',
  'color_list',
  'font_pair',
  'number',
]);

export const QuestionOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  hint: z.string().optional(),
});

export const QuestionSchema = z
  .object({
    id: z.string().min(1),
    prompt: z.string().min(1),
    help: z.string().optional(),
    type: QuestionTypeSchema,
    required: z.boolean(),
    options: z.array(QuestionOptionSchema).optional(),
    minItems: z.number().int().nonnegative().optional(),
    maxItems: z.number().int().positive().optional(),
    placeholder: z.string().optional(),
    /** Dotted path into the brand profile where the answer is stored. */
    mapsTo: z.string().regex(/^(core|industry)\.[a-zA-Z][a-zA-Z0-9]*$/),
  })
  .superRefine((q, ctx) => {
    const needsOptions = q.type === 'single_select' || q.type === 'multi_select';
    if (needsOptions && (!q.options || q.options.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `question "${q.id}" is a ${q.type} but declares no options`,
      });
    }
    if (!needsOptions && q.options) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `question "${q.id}" declares options but its type (${q.type}) does not use them`,
      });
    }
  });

export const IndustryTemplateSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/),
  label: z.string().min(1),
  version: z.number().int().positive(),
  description: z.string().optional(),
  /** Which compliance template to apply. Omitted means the generic set. */
  complianceTemplate: z.string().regex(/^[a-z0-9-]+$/).optional(),
  questions: z.array(QuestionSchema).min(1),
});

export type Question = z.infer<typeof QuestionSchema>;
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;
export type IndustryTemplate = z.infer<typeof IndustryTemplateSchema>;
export type QuestionType = z.infer<typeof QuestionTypeSchema>;

// ---------------------------------------------------------------------------
// Compliance rule sets
// ---------------------------------------------------------------------------

/** Fields of a generated creative a rule can inspect. */
export const ContentFieldSchema = z.enum(['headline', 'primaryText', 'cta', 'imageConcept']);

/**
 * Match kinds.
 *
 * Deliberately a small, closed set. Every kind is data-driven and side-effect free, which is
 * what lets a non-engineer add a rule without a deployment. An "arbitrary code" rule kind was
 * considered and rejected: a compliance layer that can execute template-supplied code is a
 * remote code execution surface wearing a safety jacket.
 */
export const MatchSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('FORBID_TERMS'),
    terms: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal('FORBID_PATTERN'),
    pattern: z.string().min(1),
    flags: z.string().max(6).optional(),
  }),
  z.object({
    kind: z.literal('REQUIRE_ONE_OF'),
    terms: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal('REQUIRE_TEXT'),
    text: z.string().min(1),
  }),
  /** Conditional: only require something when a trigger pattern is present. */
  z.object({
    kind: z.literal('REQUIRE_WHEN'),
    whenPattern: z.string().min(1),
    whenFlags: z.string().max(6).optional(),
    requireOneOf: z.array(z.string().min(1)).min(1),
  }),
]);

export const ComplianceRuleSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** BLOCK stops content reaching review as usable; FLAG lets it through with the reason attached. */
  severity: z.enum(['BLOCK', 'FLAG']),
  /**
   * Mandatory rules cannot be removed by the client — only supplemented. This is what stops a
   * compliance layer from being switched off by the party it constrains.
   */
  mandatory: z.boolean(),
  reason: z.string().min(1),
  appliesTo: z.array(ContentFieldSchema).min(1),
  match: MatchSchema,
});

export const ComplianceTemplateSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/),
  label: z.string().min(1),
  version: z.number().int().positive(),
  description: z.string().optional(),
  /** Rule sets compose: this template's rules are applied on top of the named base. */
  basedOn: z.string().regex(/^[a-z0-9-]+$/).optional(),
  rules: z.array(ComplianceRuleSchema),
});

export type ComplianceRule = z.infer<typeof ComplianceRuleSchema>;
export type ComplianceTemplate = z.infer<typeof ComplianceTemplateSchema>;
export type ContentField = z.infer<typeof ContentFieldSchema>;
export type Match = z.infer<typeof MatchSchema>;

// ---------------------------------------------------------------------------

export class TemplateError extends Error {
  constructor(
    message: string,
    readonly templateKey: string,
    readonly file: string,
  ) {
    super(`template "${templateKey}" (${file}): ${message}`);
    this.name = 'TemplateError';
  }
}

/**
 * Compiles a rule's pattern once, with a guard against catastrophic backtracking.
 *
 * A template is authored by a person, not by an attacker, but a rule that hangs the generation
 * pipeline is still an outage. Rejecting nested unbounded quantifiers at load time turns a
 * runtime hang into a startup error.
 */
export function compilePattern(pattern: string, flags: string | undefined, context: string): RegExp {
  if (/(\(\?*[^)]*[+*]\)[+*])|(\[[^\]]*\][+*]){2,}/.test(pattern)) {
    throw new Error(
      `${context}: pattern contains nested unbounded quantifiers, which risk catastrophic backtracking`,
    );
  }
  try {
    return new RegExp(pattern, flags ?? '');
  } catch (error) {
    throw new Error(
      `${context}: invalid regular expression — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
