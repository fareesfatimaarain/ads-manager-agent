/**
 * Template discovery and validation.
 *
 * Templates are read from disk, not compiled in. A deployment adds an industry by dropping two
 * JSON files into `templates/` and restarting — no rebuild, no code change, no per-vertical
 * branch anywhere in `src/`.
 *
 * Validation happens once at load. A malformed template is a startup failure rather than a
 * surprise during generation, and the error names the file and the field.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ComplianceTemplateSchema,
  compilePattern,
  IndustryTemplateSchema,
  TemplateError,
  type ComplianceRule,
  type ComplianceTemplate,
  type IndustryTemplate,
  type Question,
} from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Overridable so a deployment can point at a mounted template volume. */
export const TEMPLATE_ROOT =
  process.env.TEMPLATE_ROOT ?? resolve(here, '../../templates');

export const CORE_KEY = 'core';
export const GENERIC_KEY = 'generic';

interface Registry {
  readonly core: IndustryTemplate;
  readonly industries: Map<string, IndustryTemplate>;
  readonly compliance: Map<string, ComplianceTemplate>;
}

let cached: Registry | null = null;

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function loadDirectory<T>(
  dir: string,
  parse: (raw: unknown) => { success: true; data: T } | { success: false; error: { message: string } },
  keyOf: (value: T) => string,
): Map<string, T> {
  if (!existsSync(dir)) {
    throw new Error(`template directory not found: ${dir}`);
  }

  const out = new Map<string, T>();
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

  if (files.length === 0) {
    throw new Error(`no templates found in ${dir}`);
  }

  for (const file of files) {
    const path = join(dir, file);
    const parsed = parse(readJson(path));
    if (!parsed.success) {
      throw new TemplateError(parsed.error.message, file.replace(/\.json$/, ''), path);
    }
    const key = keyOf(parsed.data);
    // The filename must match the key, so a template is findable from its key without a scan.
    if (`${key}.json` !== file) {
      throw new TemplateError(`declares key "${key}" but the file is named "${file}"`, key, path);
    }
    if (out.has(key)) {
      throw new TemplateError('duplicate key', key, path);
    }
    out.set(key, parsed.data);
  }

  return out;
}

/** Loads and validates every template. Throws on the first problem. */
export function loadRegistry(force = false): Registry {
  if (cached && !force) return cached;

  const industries = loadDirectory(
    join(TEMPLATE_ROOT, 'industries'),
    (raw) => IndustryTemplateSchema.safeParse(raw),
    (t) => t.key,
  );

  const compliance = loadDirectory(
    join(TEMPLATE_ROOT, 'compliance'),
    (raw) => ComplianceTemplateSchema.safeParse(raw),
    (t) => t.key,
  );

  const core = industries.get(CORE_KEY);
  if (!core) {
    throw new Error(`the universal core template (${CORE_KEY}.json) is required but missing`);
  }
  if (!industries.has(GENERIC_KEY)) {
    throw new Error(
      `the fallback industry template (${GENERIC_KEY}.json) is required — without it, an ` +
        `unlisted industry would have nowhere to go`,
    );
  }
  if (!compliance.has(GENERIC_KEY)) {
    throw new Error(
      `the fallback compliance template (${GENERIC_KEY}.json) is required — without it, an ` +
        `unlisted industry would generate unchecked content`,
    );
  }

  // Referential integrity, checked once so a broken reference cannot surface mid-generation.
  for (const industry of industries.values()) {
    if (industry.key === CORE_KEY) continue;
    const ref = industry.complianceTemplate ?? GENERIC_KEY;
    if (!compliance.has(ref)) {
      throw new TemplateError(
        `references compliance template "${ref}", which does not exist`,
        industry.key,
        `industries/${industry.key}.json`,
      );
    }
  }

  for (const template of compliance.values()) {
    if (template.basedOn && !compliance.has(template.basedOn)) {
      throw new TemplateError(
        `is based on "${template.basedOn}", which does not exist`,
        template.key,
        `compliance/${template.key}.json`,
      );
    }
    // Compile every pattern now so a bad regex fails at startup, not at generation time.
    for (const rule of template.rules) {
      const context = `rule "${rule.id}"`;
      if (rule.match.kind === 'FORBID_PATTERN') {
        compilePattern(rule.match.pattern, rule.match.flags, context);
      }
      if (rule.match.kind === 'REQUIRE_WHEN') {
        compilePattern(rule.match.whenPattern, rule.match.whenFlags, context);
      }
    }
  }

  // Duplicate question ids across core + a branch would make answers ambiguous.
  for (const industry of industries.values()) {
    if (industry.key === CORE_KEY) continue;
    const coreIds = new Set(core.questions.map((q) => q.id));
    for (const q of industry.questions) {
      if (coreIds.has(q.id)) {
        throw new TemplateError(
          `question "${q.id}" collides with a core question of the same id`,
          industry.key,
          `industries/${industry.key}.json`,
        );
      }
    }
  }

  cached = { core, industries, compliance };
  return cached;
}

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

export interface IndustryOption {
  readonly key: string;
  readonly label: string;
  readonly description: string | null;
  readonly complianceTemplate: string;
}

/** Selectable industries, excluding the core (which is not a choice). */
export function listIndustries(): IndustryOption[] {
  const { industries } = loadRegistry();
  return [...industries.values()]
    .filter((t) => t.key !== CORE_KEY)
    .map((t) => ({
      key: t.key,
      label: t.label,
      description: t.description ?? null,
      complianceTemplate: t.complianceTemplate ?? GENERIC_KEY,
    }))
    // Generic sorts last: it is the fallback, not a peer.
    .sort((a, b) =>
      a.key === GENERIC_KEY ? 1 : b.key === GENERIC_KEY ? -1 : a.label.localeCompare(b.label),
    );
}

/**
 * Resolves an industry key to a template, falling back to generic.
 *
 * Never throws for an unknown key. An unlisted industry is an expected situation in a product
 * sold across verticals, and the correct response is the fallback branch — not an error page
 * during a client's first five minutes with the system.
 */
export function resolveIndustry(key: string | null | undefined): IndustryTemplate {
  const { industries } = loadRegistry();
  if (key && key !== CORE_KEY) {
    const found = industries.get(key);
    if (found) return found;
  }
  return industries.get(GENERIC_KEY)!;
}

/** Core questions followed by the industry branch, in the order they should be asked. */
export function questionsFor(industryKey: string | null | undefined): Question[] {
  const { core } = loadRegistry();
  return [...core.questions, ...resolveIndustry(industryKey).questions];
}

export function findQuestion(industryKey: string | null | undefined, questionId: string): Question | null {
  return questionsFor(industryKey).find((q) => q.id === questionId) ?? null;
}

/**
 * Flattens a compliance template and its bases into one rule list.
 *
 * A rule id defined in a derived template replaces the same id from its base, which lets an
 * industry tighten a generic rule without duplicating it. Cycles are detected rather than
 * hung on.
 */
export function resolveComplianceRules(templateKey: string): {
  rules: ComplianceRule[];
  chain: string[];
} {
  const { compliance } = loadRegistry();
  const chain: string[] = [];
  const seen = new Set<string>();

  let current = compliance.get(templateKey) ?? compliance.get(GENERIC_KEY)!;
  const stack: ComplianceTemplate[] = [];

  while (current) {
    if (seen.has(current.key)) {
      throw new Error(`compliance template inheritance cycle at "${current.key}"`);
    }
    seen.add(current.key);
    stack.push(current);
    chain.push(current.key);
    if (!current.basedOn) break;
    const next = compliance.get(current.basedOn);
    if (!next) break;
    current = next;
  }

  // Apply from the base upward so derived templates win on id collision.
  const byId = new Map<string, ComplianceRule>();
  for (const template of stack.reverse()) {
    for (const rule of template.rules) byId.set(rule.id, rule);
  }

  return { rules: [...byId.values()], chain: chain.reverse() };
}

export function complianceTemplateFor(industryKey: string | null | undefined): string {
  return resolveIndustry(industryKey).complianceTemplate ?? GENERIC_KEY;
}

export function listComplianceTemplates(): { key: string; label: string; ruleCount: number }[] {
  const { compliance } = loadRegistry();
  return [...compliance.values()].map((t) => ({
    key: t.key,
    label: t.label,
    ruleCount: resolveComplianceRules(t.key).rules.length,
  }));
}
