/**
 * The compliance gate.
 *
 * Every piece of generated content passes through here before a human ever sees it. Three
 * properties are load-bearing:
 *
 *  1. **It cannot fail open.** An industry with no template resolves to the generic rule set,
 *     never to an empty one. `evaluate` throws rather than returning "compliant" if it is
 *     handed a rule set it cannot apply — silently approving is the one outcome that must be
 *     impossible.
 *
 *  2. **Mandatory rules cannot be removed by the party they constrain.** Custom client rules
 *     are merged on top of template rules; a client may add and may disable non-mandatory
 *     rules, but a mandatory template rule survives every merge.
 *
 *  3. **Every finding carries its reason and its origin.** A block with no explanation is
 *     indistinguishable from a bug, and gets worked around rather than fixed.
 */
import {
  compilePattern,
  type ComplianceRule,
  type ContentField,
  type Match,
} from '../templates/schema.js';
import { complianceTemplateFor, resolveComplianceRules } from '../templates/registry.js';

export interface ReviewableContent {
  readonly headline: string;
  readonly primaryText: string;
  readonly cta: string;
  readonly imageConcept?: string;
}

export type RuleOrigin = 'TEMPLATE' | 'CUSTOM' | 'BRAND';

export interface EffectiveRule extends ComplianceRule {
  readonly origin: RuleOrigin;
  /** Which template contributed it, or null for a client-defined rule. */
  readonly sourceTemplate: string | null;
}

export interface Finding {
  readonly ruleId: string;
  readonly title: string;
  readonly severity: 'BLOCK' | 'FLAG';
  readonly field: ContentField;
  readonly reason: string;
  /** The text that triggered it, so a reviewer can see exactly what to change. */
  readonly matched: string | null;
  readonly origin: RuleOrigin;
  readonly sourceTemplate: string | null;
}

export interface ComplianceVerdict {
  /** True only when nothing blocked. Flags do not prevent review. */
  readonly passed: boolean;
  readonly blocked: boolean;
  readonly findings: readonly Finding[];
  readonly rulesApplied: number;
  readonly templateChain: readonly string[];
  readonly evaluatedAt: Date;
}

export class ComplianceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComplianceConfigurationError';
  }
}

// ---------------------------------------------------------------------------
// Rule set assembly
// ---------------------------------------------------------------------------

export interface CustomRuleInput {
  readonly id: string;
  readonly title: string;
  readonly severity: 'BLOCK' | 'FLAG';
  readonly reason: string;
  readonly appliesTo: readonly ContentField[];
  readonly match: Match;
  readonly enabled: boolean;
}

/** The parts of a brand profile that are enforceable as rules rather than as prose. */
export interface BrandConstraints {
  readonly bannedWords?: readonly string[] | undefined;
  readonly requiredDisclaimers?: readonly string[] | undefined;
}

/**
 * Reads the enforceable constraints out of a brand profile's `core` blob.
 *
 * `core` is untyped JSON by design — the intake templates decide its shape — so this is the one
 * place that reaches into it for compliance, and it tolerates a missing profile rather than
 * throwing: a deployment with no brand yet still gets its template rules.
 */
export function brandConstraintsOf(profile: { core: unknown } | null | undefined): BrandConstraints {
  const core = (profile?.core ?? {}) as Record<string, unknown>;
  const banned = core.bannedWords;
  const disclaimers = core.requiredDisclaimers;
  return {
    bannedWords: Array.isArray(banned) ? (banned as string[]) : undefined,
    requiredDisclaimers: Array.isArray(disclaimers) ? (disclaimers as string[]) : undefined,
  };
}

/**
 * Turns a brand's own constraints into real rules.
 *
 * Banned words and required disclaimers are stated in the generation prompt, but a prompt is a
 * request, not a guarantee — a model that ignores it would otherwise produce off-brand copy that
 * passes review silently. Expressing them as rules means the same engine that enforces
 * regulatory limits also enforces the brand's, deterministically and after the fact.
 *
 * Severity is BLOCK: the client wrote these down as absolutes, and softening them here would be
 * us deciding their brand rules matter less than they said.
 */
export function brandRules(constraints: BrandConstraints): EffectiveRule[] {
  const rules: EffectiveRule[] = [];

  const banned = (constraints.bannedWords ?? []).map((w) => w.trim()).filter(Boolean);
  if (banned.length > 0) {
    rules.push({
      id: 'brand-banned-words',
      title: 'Words this brand does not use',
      severity: 'BLOCK',
      mandatory: false,
      reason: `The brand guidelines forbid these words: ${banned.join(', ')}. Rewrite without them.`,
      appliesTo: ['headline', 'primaryText', 'cta', 'imageConcept'],
      match: { kind: 'FORBID_TERMS', terms: banned },
      origin: 'BRAND',
      sourceTemplate: null,
    });
  }

  // Each disclaimer is its own rule so a finding names the specific missing line rather than
  // reporting that "a disclaimer" is absent.
  for (const [i, text] of (constraints.requiredDisclaimers ?? []).entries()) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    rules.push({
      id: `brand-disclaimer-${i + 1}`,
      title: 'Required disclaimer missing',
      severity: 'BLOCK',
      mandatory: false,
      reason: `The brand requires this line to appear in the body copy: "${trimmed}"`,
      appliesTo: ['primaryText'],
      match: { kind: 'REQUIRE_TEXT', text: trimmed },
      origin: 'BRAND',
      sourceTemplate: null,
    });
  }

  return rules;
}

/**
 * Merges template rules with the brand's own constraints and the client's custom rules.
 *
 * `disabledRuleIds` may switch off non-mandatory template rules. A mandatory rule named there
 * is ignored — and the caller is told, so the UI can explain why the switch did nothing rather
 * than appearing broken.
 */
export function assembleRules(options: {
  readonly industryKey: string | null | undefined;
  readonly customRules?: readonly CustomRuleInput[];
  readonly disabledRuleIds?: readonly string[];
  readonly brand?: BrandConstraints;
}): { rules: EffectiveRule[]; chain: string[]; refusedDisables: string[] } {
  const templateKey = complianceTemplateFor(options.industryKey);
  const { rules: templateRules, chain } = resolveComplianceRules(templateKey);

  const disabled = new Set(options.disabledRuleIds ?? []);
  const refusedDisables: string[] = [];

  const effective: EffectiveRule[] = [];

  for (const rule of templateRules) {
    if (disabled.has(rule.id)) {
      if (rule.mandatory) {
        // Recorded, not obeyed. A mandatory rule that can be switched off is not a rule.
        refusedDisables.push(rule.id);
      } else {
        continue;
      }
    }
    effective.push({ ...rule, origin: 'TEMPLATE', sourceTemplate: templateKey });
  }

  // Brand constraints go on before custom rules, so a client-defined rule that happens to reuse
  // a reserved brand id is rejected by the same collision check as a template collision.
  for (const rule of brandRules(options.brand ?? {})) {
    if (effective.some((r) => r.id === rule.id)) continue;
    effective.push(rule);
  }

  for (const custom of options.customRules ?? []) {
    if (!custom.enabled) continue;
    if (effective.some((r) => r.id === custom.id)) {
      throw new ComplianceConfigurationError(
        `custom rule "${custom.id}" collides with a template rule of the same id; rename it`,
      );
    }
    effective.push({
      id: custom.id,
      title: custom.title,
      severity: custom.severity,
      mandatory: false,
      reason: custom.reason,
      appliesTo: [...custom.appliesTo],
      match: custom.match,
      origin: 'CUSTOM',
      sourceTemplate: null,
    });
  }

  if (effective.length === 0) {
    // Reachable only if every template rule is non-mandatory and disabled, and no custom rules
    // exist. Approving content against zero rules is not a pass; it is an unchecked generation.
    throw new ComplianceConfigurationError(
      'no compliance rules would apply — refusing to evaluate content against an empty rule set',
    );
  }

  return { rules: effective, chain, refusedDisables };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Word-boundary containment, so "cure" does not fire inside "secure" or "accurate". */
function findTerm(haystack: string, term: string): string | null {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A multi-word term needs flexible internal whitespace.
  const body = escaped.replace(/\s+/g, '\\s+');
  const match = new RegExp(`\\b${body}\\b`, 'i').exec(haystack);
  return match ? match[0] : null;
}

function containsAny(haystack: string, terms: readonly string[]): boolean {
  return terms.some((t) => haystack.toLowerCase().includes(t.toLowerCase()));
}

interface FieldResult {
  readonly violated: boolean;
  readonly matched: string | null;
}

function applyMatch(match: Match, text: string, ruleId: string): FieldResult {
  switch (match.kind) {
    case 'FORBID_TERMS': {
      for (const term of match.terms) {
        const hit = findTerm(text, term);
        if (hit) return { violated: true, matched: hit };
      }
      return { violated: false, matched: null };
    }

    case 'FORBID_PATTERN': {
      const re = compilePattern(match.pattern, match.flags, `rule "${ruleId}"`);
      const hit = re.exec(text);
      return hit ? { violated: true, matched: hit[0] } : { violated: false, matched: null };
    }

    case 'REQUIRE_ONE_OF': {
      return containsAny(text, match.terms)
        ? { violated: false, matched: null }
        : { violated: true, matched: null };
    }

    case 'REQUIRE_TEXT': {
      return text.includes(match.text)
        ? { violated: false, matched: null }
        : { violated: true, matched: null };
    }

    case 'REQUIRE_WHEN': {
      const trigger = compilePattern(match.whenPattern, match.whenFlags, `rule "${ruleId}"`);
      const triggered = trigger.exec(text);
      if (!triggered) return { violated: false, matched: null };
      return containsAny(text, match.requireOneOf)
        ? { violated: false, matched: null }
        : { violated: true, matched: triggered[0] };
    }
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const FIELD_ACCESSORS: Record<ContentField, (c: ReviewableContent) => string | undefined> = {
  headline: (c) => c.headline,
  primaryText: (c) => c.primaryText,
  cta: (c) => c.cta,
  imageConcept: (c) => c.imageConcept,
};

/**
 * Evaluates one piece of content against an assembled rule set.
 *
 * Every rule is applied to every field it declares — evaluation never short-circuits on the
 * first block, because a reviewer fixing one problem should see all of them rather than
 * discovering the next one on resubmission.
 */
export function evaluate(
  content: ReviewableContent,
  rules: readonly EffectiveRule[],
  chain: readonly string[] = [],
  now: Date = new Date(),
): ComplianceVerdict {
  if (rules.length === 0) {
    throw new ComplianceConfigurationError(
      'evaluate() was called with no rules; this would approve content unchecked',
    );
  }

  const findings: Finding[] = [];

  for (const rule of rules) {
    for (const field of rule.appliesTo) {
      const text = FIELD_ACCESSORS[field](content);
      // A field the content does not carry (e.g. no image concept) cannot violate a rule about
      // it — but a REQUIRE rule on a missing required field is a real gap, so absent text is
      // treated as empty rather than skipped for REQUIRE kinds.
      const isRequire =
        rule.match.kind === 'REQUIRE_ONE_OF' ||
        rule.match.kind === 'REQUIRE_TEXT' ||
        rule.match.kind === 'REQUIRE_WHEN';
      if (text === undefined && !isRequire) continue;

      const result = applyMatch(rule.match, text ?? '', rule.id);
      if (!result.violated) continue;

      findings.push({
        ruleId: rule.id,
        title: rule.title,
        severity: rule.severity,
        field,
        reason: rule.reason,
        matched: result.matched,
        origin: rule.origin,
        sourceTemplate: rule.sourceTemplate,
      });
    }
  }

  const blocked = findings.some((f) => f.severity === 'BLOCK');

  return {
    passed: !blocked,
    blocked,
    findings,
    rulesApplied: rules.length,
    templateChain: chain,
    evaluatedAt: now,
  };
}

/** Convenience: assemble and evaluate in one call. */
export function checkContent(
  content: ReviewableContent,
  options: {
    readonly industryKey: string | null | undefined;
    readonly customRules?: readonly CustomRuleInput[];
    readonly disabledRuleIds?: readonly string[];
    readonly brand?: BrandConstraints;
    readonly now?: Date;
  },
): ComplianceVerdict & { refusedDisables: string[] } {
  const { rules, chain, refusedDisables } = assembleRules(options);
  const verdict = evaluate(content, rules, chain, options.now);
  return { ...verdict, refusedDisables };
}

/** Groups findings for display: blocks first, then flags, each in rule order. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'BLOCK' ? -1 : 1;
    return a.ruleId.localeCompare(b.ruleId);
  });
}
