import { describe, expect, it } from 'vitest';
import {
  assembleRules,
  brandConstraintsOf,
  checkContent,
  ComplianceConfigurationError,
  evaluate,
  sortFindings,
  type CustomRuleInput,
  type EffectiveRule,
  type ReviewableContent,
} from '../../src/compliance/engine.js';
import { resolveComplianceRules } from '../../src/templates/registry.js';

const content = (over: Partial<ReviewableContent> = {}): ReviewableContent => ({
  headline: 'A perfectly ordinary headline',
  primaryText: 'Some perfectly ordinary body copy that says what the thing does.',
  cta: 'Learn more',
  imageConcept: 'A product on a plain background.',
  ...over,
});

describe('the gate cannot fail open', () => {
  it('applies the generic rule set to an unlisted industry', () => {
    const verdict = checkContent(content(), { industryKey: 'artisanal-yak-shaving' });
    expect(verdict.rulesApplied).toBeGreaterThan(0);
    expect(verdict.templateChain).toContain('generic');
  });

  it('applies rules when the industry is null', () => {
    expect(checkContent(content(), { industryKey: null }).rulesApplied).toBeGreaterThan(0);
  });

  it('refuses to evaluate against an empty rule set rather than passing', () => {
    expect(() => evaluate(content(), [])).toThrow(ComplianceConfigurationError);
  });

  it('refuses to assemble a rule set that would be empty', () => {
    const generic = resolveComplianceRules('generic').rules;
    const nonMandatory = generic.filter((r) => !r.mandatory).map((r) => r.id);
    const mandatory = generic.filter((r) => r.mandatory).map((r) => r.id);
    // Disabling everything: mandatory rules survive, so this should NOT be empty.
    const assembled = assembleRules({
      industryKey: 'generic',
      disabledRuleIds: [...nonMandatory, ...mandatory],
    });
    expect(assembled.rules.length).toBe(mandatory.length);
    expect(assembled.rules.length).toBeGreaterThan(0);
  });
});

describe('mandatory rules cannot be switched off', () => {
  it('ignores an attempt to disable a mandatory rule and reports it', () => {
    const rules = resolveComplianceRules('finance').rules;
    const mandatory = rules.find((r) => r.mandatory)!;
    const result = assembleRules({
      industryKey: 'finance',
      disabledRuleIds: [mandatory.id],
    });
    expect(result.rules.some((r) => r.id === mandatory.id)).toBe(true);
    expect(result.refusedDisables).toContain(mandatory.id);
  });

  it('honours disabling a non-mandatory rule', () => {
    const rules = resolveComplianceRules('generic').rules;
    const optional = rules.find((r) => !r.mandatory);
    if (!optional) return; // template may have none; nothing to assert
    const result = assembleRules({ industryKey: 'generic', disabledRuleIds: [optional.id] });
    expect(result.rules.some((r) => r.id === optional.id)).toBe(false);
    expect(result.refusedDisables).not.toContain(optional.id);
  });

  it('a client cannot weaken a mandatory rule by redefining its id', () => {
    const mandatory = resolveComplianceRules('healthcare').rules.find((r) => r.mandatory)!;
    const custom: CustomRuleInput = {
      id: mandatory.id,
      title: 'Watered down',
      severity: 'FLAG',
      reason: 'nope',
      appliesTo: ['headline'],
      match: { kind: 'FORBID_TERMS', terms: ['nothing'] },
      enabled: true,
    };
    expect(() =>
      assembleRules({ industryKey: 'healthcare', customRules: [custom] }),
    ).toThrow(ComplianceConfigurationError);
  });
});

describe('industry rule sets catch the thing they exist for', () => {
  it('healthcare blocks a cure claim', () => {
    const v = checkContent(content({ headline: 'We cure back pain for good' }), {
      industryKey: 'healthcare',
    });
    expect(v.blocked).toBe(true);
    expect(v.findings.some((f) => f.ruleId === 'hc-cure-claims')).toBe(true);
  });

  it('healthcare blocks a guaranteed clinical outcome', () => {
    const v = checkContent(
      content({ primaryText: 'Guaranteed results after a single session.' }),
      { industryKey: 'healthcare' },
    );
    expect(v.blocked).toBe(true);
  });

  it('finance blocks guaranteed returns', () => {
    const v = checkContent(content({ headline: 'Guaranteed returns on every portfolio' }), {
      industryKey: 'finance',
    });
    expect(v.blocked).toBe(true);
    expect(v.findings.some((f) => f.ruleId === 'fin-guaranteed-returns')).toBe(true);
  });

  it('finance blocks investment copy that omits the capital-at-risk warning', () => {
    const v = checkContent(
      content({ primaryText: 'Invest with us and watch your portfolio grow.' }),
      { industryKey: 'finance' },
    );
    expect(v.blocked).toBe(true);
    expect(v.findings.some((f) => f.ruleId === 'fin-risk-warning')).toBe(true);
  });

  it('finance passes the same copy once the warning is present', () => {
    const v = checkContent(
      content({
        primaryText: 'Invest with us and watch your portfolio grow. Your capital is at risk.',
      }),
      { industryKey: 'finance' },
    );
    expect(v.findings.some((f) => f.ruleId === 'fin-risk-warning')).toBe(false);
  });

  it('legal blocks an outcome promise', () => {
    const v = checkContent(content({ headline: 'We will win your case' }), {
      industryKey: 'legal',
    });
    expect(v.blocked).toBe(true);
  });

  it('real estate blocks fair-housing preference language', () => {
    const v = checkContent(content({ headline: 'Perfect for families only' }), {
      industryKey: 'real-estate',
    });
    expect(v.blocked).toBe(true);
    expect(v.findings.some((f) => f.ruleId === 're-fair-housing')).toBe(true);
  });

  it('the same copy is judged differently by industry — the point of the layer', () => {
    const copy = content({ primaryText: 'Invest today for guaranteed returns on your money.' });
    expect(checkContent(copy, { industryKey: 'finance' }).blocked).toBe(true);
    // Generic still flags the guarantee, but does not carry the finance-specific block.
    const generic = checkContent(copy, { industryKey: 'ecommerce' });
    expect(generic.findings.some((f) => f.ruleId === 'fin-guaranteed-returns')).toBe(false);
  });
});

describe('matching behaviour', () => {
  const rule = (over: Partial<EffectiveRule> = {}): EffectiveRule => ({
    id: 'test-rule',
    title: 'Test',
    severity: 'BLOCK',
    mandatory: false,
    reason: 'because',
    appliesTo: ['headline'],
    match: { kind: 'FORBID_TERMS', terms: ['cure'] },
    origin: 'CUSTOM',
    sourceTemplate: null,
    ...over,
  });

  it('respects word boundaries', () => {
    // "secure" and "accurate" both contain "cure" as a substring.
    const v = evaluate(content({ headline: 'A secure and accurate service' }), [rule()]);
    expect(v.findings).toHaveLength(0);
  });

  it('still catches the word itself, in any casing', () => {
    expect(evaluate(content({ headline: 'We CURE things' }), [rule()]).findings).toHaveLength(1);
  });

  it('matches multi-word terms across flexible whitespace', () => {
    const r = rule({ match: { kind: 'FORBID_TERMS', terms: ['no risk'] } });
    expect(evaluate(content({ headline: 'There is no    risk here' }), [r]).findings).toHaveLength(1);
  });

  it('reports the exact matched text so a reviewer knows what to change', () => {
    const v = evaluate(content({ headline: 'We CURE things' }), [rule()]);
    expect(v.findings[0]!.matched).toBe('CURE');
  });

  it('only inspects the fields a rule declares', () => {
    const v = evaluate(content({ primaryText: 'we cure everything' }), [rule()]);
    expect(v.findings).toHaveLength(0);
  });

  it('flags a missing required disclosure', () => {
    const r = rule({ match: { kind: 'REQUIRE_ONE_OF', terms: ['terms apply'] } });
    expect(evaluate(content(), [r]).findings).toHaveLength(1);
  });

  it('does not fire a conditional requirement when the trigger is absent', () => {
    const r = rule({
      match: { kind: 'REQUIRE_WHEN', whenPattern: 'invest', whenFlags: 'i', requireOneOf: ['capital at risk'] },
    });
    expect(evaluate(content({ headline: 'Buy a kettle' }), [r]).findings).toHaveLength(0);
  });

  it('fires a conditional requirement when the trigger is present', () => {
    const r = rule({
      match: { kind: 'REQUIRE_WHEN', whenPattern: 'invest', whenFlags: 'i', requireOneOf: ['capital at risk'] },
    });
    expect(evaluate(content({ headline: 'Invest now' }), [r]).findings).toHaveLength(1);
  });

  it('treats a missing optional field as empty for REQUIRE rules rather than skipping', () => {
    const r = rule({
      appliesTo: ['imageConcept'],
      match: { kind: 'REQUIRE_TEXT', text: 'must appear' },
    });
    const withoutConcept: ReviewableContent = {
      headline: 'h',
      primaryText: 'p',
      cta: 'c',
    };
    expect(evaluate(withoutConcept, [r]).findings).toHaveLength(1);
  });

  it('skips a missing optional field for FORBID rules', () => {
    const r = rule({ appliesTo: ['imageConcept'] });
    const withoutConcept: ReviewableContent = { headline: 'h', primaryText: 'p', cta: 'c' };
    expect(evaluate(withoutConcept, [r]).findings).toHaveLength(0);
  });
});

describe('verdicts', () => {
  const blockRule: EffectiveRule = {
    id: 'b', title: 'B', severity: 'BLOCK', mandatory: true, reason: 'r',
    appliesTo: ['headline'], match: { kind: 'FORBID_TERMS', terms: ['bad'] },
    origin: 'TEMPLATE', sourceTemplate: 'generic',
  };
  const flagRule: EffectiveRule = {
    ...blockRule, id: 'f', severity: 'FLAG', match: { kind: 'FORBID_TERMS', terms: ['meh'] },
  };

  it('a flag does not block', () => {
    const v = evaluate(content({ headline: 'this is meh' }), [blockRule, flagRule]);
    expect(v.findings).toHaveLength(1);
    expect(v.blocked).toBe(false);
    expect(v.passed).toBe(true);
  });

  it('a block blocks', () => {
    const v = evaluate(content({ headline: 'this is bad' }), [blockRule, flagRule]);
    expect(v.blocked).toBe(true);
    expect(v.passed).toBe(false);
  });

  it('reports every violation rather than stopping at the first', () => {
    const v = evaluate(content({ headline: 'this is bad and meh' }), [blockRule, flagRule]);
    expect(v.findings).toHaveLength(2);
  });

  it('every finding carries a reason and an origin', () => {
    const v = checkContent(content({ headline: 'We cure everything, guaranteed' }), {
      industryKey: 'healthcare',
    });
    expect(v.findings.length).toBeGreaterThan(0);
    for (const f of v.findings) {
      expect(f.reason.length).toBeGreaterThan(10);
      expect(['TEMPLATE', 'CUSTOM', 'BRAND']).toContain(f.origin);
      expect(f.title.length).toBeGreaterThan(0);
    }
  });

  it('sorts blocks before flags for display', () => {
    const sorted = sortFindings(
      evaluate(content({ headline: 'this is bad and meh' }), [flagRule, blockRule]).findings,
    );
    expect(sorted[0]!.severity).toBe('BLOCK');
  });
});

describe('client-defined rules', () => {
  it('adds custom rules on top of the template set', () => {
    const custom: CustomRuleInput = {
      id: 'client-no-slang',
      title: 'No slang',
      severity: 'FLAG',
      reason: 'The brand does not use slang.',
      appliesTo: ['headline', 'primaryText'],
      match: { kind: 'FORBID_TERMS', terms: ['gonna', 'wanna'] },
      enabled: true,
    };
    const v = checkContent(content({ headline: 'You gonna love this' }), {
      industryKey: 'ecommerce',
      customRules: [custom],
    });
    expect(v.findings.some((f) => f.ruleId === 'client-no-slang')).toBe(true);
    expect(v.findings.find((f) => f.ruleId === 'client-no-slang')?.origin).toBe('CUSTOM');
  });

  it('ignores a disabled custom rule', () => {
    const custom: CustomRuleInput = {
      id: 'off', title: 'Off', severity: 'BLOCK', reason: 'r',
      appliesTo: ['headline'], match: { kind: 'FORBID_TERMS', terms: ['love'] }, enabled: false,
    };
    const v = checkContent(content({ headline: 'You will love this' }), {
      industryKey: 'ecommerce',
      customRules: [custom],
    });
    expect(v.findings.some((f) => f.ruleId === 'off')).toBe(false);
  });

  it('lets a client be stricter than their industry requires', () => {
    const custom: CustomRuleInput = {
      id: 'client-no-discount-language',
      title: 'Never mention discounts',
      severity: 'BLOCK',
      reason: 'This brand never discounts and will not imply otherwise.',
      appliesTo: ['headline', 'primaryText'],
      match: { kind: 'FORBID_TERMS', terms: ['sale', 'discount', 'off'] },
      enabled: true,
    };
    const v = checkContent(content({ headline: 'Big sale this weekend' }), {
      industryKey: 'ecommerce',
      customRules: [custom],
    });
    expect(v.blocked).toBe(true);
  });
});

/**
 * The brand's own guidelines are stated in the generation prompt, but a prompt is a request.
 * These tests are the reason the same words are also compiled into rules: they assert that a
 * banned word is caught after generation, by the engine, regardless of what the model did.
 */
describe('brand constraints are enforced, not merely requested', () => {
  const brand = {
    bannedWords: ['revolutionary', 'game-changing'],
    requiredDisclaimers: ['Prices exclude VAT.'],
  };

  it('blocks a banned word the copy generator let through', () => {
    const v = checkContent(content({ headline: 'A revolutionary new drill' }), {
      industryKey: 'ecommerce',
      brand,
    });
    expect(v.blocked).toBe(true);
    const finding = v.findings.find((f) => f.ruleId === 'brand-banned-words');
    expect(finding?.origin).toBe('BRAND');
    expect(finding?.matched?.toLowerCase()).toBe('revolutionary');
  });

  it('matches a banned word on word boundaries only', () => {
    // "revolutionary" must not fire inside an unrelated longer word.
    const v = checkContent(content({ headline: 'Counterrevolutionaryism aside' }), {
      industryKey: 'ecommerce',
      brand,
    });
    expect(v.findings.some((f) => f.ruleId === 'brand-banned-words')).toBe(false);
  });

  it('checks banned words in every content field, including the image concept', () => {
    const v = checkContent(content({ imageConcept: 'A game-changing workshop scene' }), {
      industryKey: 'ecommerce',
      brand,
    });
    const finding = v.findings.find((f) => f.ruleId === 'brand-banned-words');
    expect(finding?.field).toBe('imageConcept');
  });

  it('blocks copy that omits a required disclaimer', () => {
    const v = checkContent(content(), { industryKey: 'ecommerce', brand });
    expect(v.findings.some((f) => f.ruleId === 'brand-disclaimer-1')).toBe(true);
    expect(v.blocked).toBe(true);
  });

  it('passes once the disclaimer is present', () => {
    const v = checkContent(
      content({ primaryText: 'Solid tools that last. Prices exclude VAT.' }),
      { industryKey: 'ecommerce', brand },
    );
    expect(v.findings.some((f) => f.ruleId.startsWith('brand-disclaimer'))).toBe(false);
  });

  it('names each missing disclaimer separately', () => {
    const v = checkContent(content(), {
      industryKey: 'ecommerce',
      brand: { requiredDisclaimers: ['Terms apply.', 'Over 18s only.'] },
    });
    const ids = v.findings.map((f) => f.ruleId);
    expect(ids).toContain('brand-disclaimer-1');
    expect(ids).toContain('brand-disclaimer-2');
  });

  it('contributes nothing when the brand declares no constraints', () => {
    const withBrand = assembleRules({ industryKey: 'ecommerce', brand: {} });
    const without = assembleRules({ industryKey: 'ecommerce' });
    expect(withBrand.rules.length).toBe(without.rules.length);
  });

  it('ignores blank entries rather than compiling an empty term', () => {
    const { rules } = assembleRules({
      industryKey: 'ecommerce',
      brand: { bannedWords: ['   ', ''], requiredDisclaimers: ['  '] },
    });
    expect(rules.some((r) => r.origin === 'BRAND')).toBe(false);
  });

  it('does not let a custom rule shadow a brand constraint', () => {
    // A client rule reusing the reserved id must be refused, not silently replace enforcement.
    expect(() =>
      assembleRules({
        industryKey: 'ecommerce',
        brand,
        customRules: [
          {
            id: 'brand-banned-words',
            title: 'Actually these are fine',
            severity: 'FLAG',
            reason: 'r',
            appliesTo: ['headline'],
            match: { kind: 'FORBID_TERMS', terms: ['nothing'] },
            enabled: true,
          },
        ],
      }),
    ).toThrow(ComplianceConfigurationError);
  });

  it('reads constraints out of an untyped brand profile blob', () => {
    expect(brandConstraintsOf({ core: { bannedWords: ['x'] } }).bannedWords).toEqual(['x']);
    expect(brandConstraintsOf(null).bannedWords).toBeUndefined();
    // A malformed blob must not crash the gate — it contributes nothing and templates still apply.
    expect(brandConstraintsOf({ core: { bannedWords: 'oops' } }).bannedWords).toBeUndefined();
  });
});
