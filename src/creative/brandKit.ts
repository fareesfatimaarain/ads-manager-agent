/**
 * Brand kit enforcement.
 *
 * The spec requires the brand kit to be enforced **at generation time, not filtered after**,
 * and that is what `renderBrandConstraints` is for — it becomes part of the instruction that
 * produces the copy, so the generator is not writing something it then has to be talked out of.
 *
 * `checkCompliance` is the second line of defence, not the first. Filtering alone fails in a
 * predictable way: it only catches what the filter happens to recognise, and it produces no
 * replacement, so a rejected batch is simply a batch you don't have. Generating under the
 * constraint means most output is compliant to begin with, and this check catches the residue.
 */
import type { BrandKit, GeneratedCopy } from './types.js';

export interface ComplianceViolation {
  readonly field: 'headline' | 'primaryText' | 'cta';
  readonly kind: 'BANNED_WORD' | 'BANNED_CLAIM' | 'MISSING_DISCLAIMER' | 'LENGTH';
  readonly detail: string;
  readonly matched: string | null;
}

export interface ComplianceResult {
  readonly compliant: boolean;
  readonly violations: readonly ComplianceViolation[];
}

/** Platform limits. Exceeding them means the ad is silently truncated in the feed. */
export const COPY_LIMITS = {
  headlineMaxChars: 40,
  primaryTextMaxChars: 125,
  ctaMaxChars: 20,
} as const;

/** The constraint block injected into the generation prompt. */
export function renderBrandConstraints(kit: BrandKit): string {
  const lines: string[] = [
    `Tone of voice: ${kit.tone}`,
    `Brand palette: ${kit.palette.map((p) => `${p.name} (${p.hex})`).join(', ')}`,
    `Typography: ${kit.fonts.display} for display, ${kit.fonts.body} for body`,
  ];

  if (kit.bannedWords.length > 0) {
    lines.push(
      `These words must not appear anywhere in the copy, in any form or casing: ${kit.bannedWords.join(', ')}`,
    );
  }
  if (kit.bannedClaims.length > 0) {
    lines.push(
      'These claims must not be made, including paraphrases and implications:\n' +
        kit.bannedClaims.map((c) => `  - ${c}`).join('\n'),
    );
  }
  if (kit.requiredDisclaimers.length > 0) {
    lines.push(
      'Every ad must carry this disclaimer verbatim in the primary text:\n' +
        kit.requiredDisclaimers.map((d) => `  - ${d}`).join('\n'),
    );
  }

  lines.push(
    `Length limits, enforced by the ad platform: headline at most ${COPY_LIMITS.headlineMaxChars} characters, ` +
      `primary text at most ${COPY_LIMITS.primaryTextMaxChars}, call to action at most ${COPY_LIMITS.ctaMaxChars}.`,
  );

  return lines.join('\n');
}

/** Word-boundary match so "cure" does not fire on "accurate" or "secure". */
function containsWord(haystack: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
}

export function checkCompliance(copy: GeneratedCopy, kit: BrandKit): ComplianceResult {
  const violations: ComplianceViolation[] = [];

  const fields = [
    { field: 'headline' as const, text: copy.headline, limit: COPY_LIMITS.headlineMaxChars },
    { field: 'primaryText' as const, text: copy.primaryText, limit: COPY_LIMITS.primaryTextMaxChars },
    { field: 'cta' as const, text: copy.cta, limit: COPY_LIMITS.ctaMaxChars },
  ];

  for (const { field, text, limit } of fields) {
    for (const word of kit.bannedWords) {
      if (containsWord(text, word)) {
        violations.push({
          field,
          kind: 'BANNED_WORD',
          detail: `contains the banned word "${word}"`,
          matched: word,
        });
      }
    }

    if (text.length > limit) {
      violations.push({
        field,
        kind: 'LENGTH',
        detail: `is ${text.length} characters, over the ${limit} limit`,
        matched: null,
      });
    }
  }

  // Disclaimers are checked on the primary text, which is where they must appear.
  for (const disclaimer of kit.requiredDisclaimers) {
    if (!copy.primaryText.includes(disclaimer)) {
      violations.push({
        field: 'primaryText',
        kind: 'MISSING_DISCLAIMER',
        detail: `is missing the required disclaimer "${disclaimer}"`,
        matched: disclaimer,
      });
    }
  }

  return { compliant: violations.length === 0, violations };
}

/**
 * Filters a batch to the compliant members, reporting what was dropped.
 *
 * Note this returns fewer variants rather than substituting replacements — the caller decides
 * whether a short batch is acceptable or whether to regenerate. Silently topping up with
 * near-duplicates would undermine the test design, since cohort members are supposed to be
 * genuinely distinct angles.
 */
export function partitionByCompliance(
  batch: readonly GeneratedCopy[],
  kit: BrandKit,
): { compliant: GeneratedCopy[]; rejected: { copy: GeneratedCopy; result: ComplianceResult }[] } {
  const compliant: GeneratedCopy[] = [];
  const rejected: { copy: GeneratedCopy; result: ComplianceResult }[] = [];

  for (const copy of batch) {
    const result = checkCompliance(copy, kit);
    if (result.compliant) compliant.push(copy);
    else rejected.push({ copy, result });
  }

  return { compliant, rejected };
}
