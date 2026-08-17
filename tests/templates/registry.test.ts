import { describe, expect, it } from 'vitest';
import {
  CORE_KEY,
  GENERIC_KEY,
  complianceTemplateFor,
  findQuestion,
  listComplianceTemplates,
  listIndustries,
  loadRegistry,
  questionsFor,
  resolveComplianceRules,
  resolveIndustry,
} from '../../src/templates/registry.js';

describe('template loading', () => {
  it('loads every shipped template without error', () => {
    expect(() => loadRegistry(true)).not.toThrow();
  });

  it('requires the core, generic industry, and generic compliance templates', () => {
    const registry = loadRegistry();
    expect(registry.industries.has(CORE_KEY)).toBe(true);
    expect(registry.industries.has(GENERIC_KEY)).toBe(true);
    expect(registry.compliance.has(GENERIC_KEY)).toBe(true);
  });

  it('lists industries with generic sorted last', () => {
    const industries = listIndustries();
    expect(industries.length).toBeGreaterThan(1);
    expect(industries.some((i) => i.key === CORE_KEY)).toBe(false);
    expect(industries[industries.length - 1]!.key).toBe(GENERIC_KEY);
  });

  it('every industry points at a compliance template that exists', () => {
    const templates = new Set(listComplianceTemplates().map((t) => t.key));
    for (const industry of listIndustries()) {
      expect(templates.has(industry.complianceTemplate)).toBe(true);
    }
  });
});

describe('industry resolution — never dead-ends', () => {
  it('falls back to generic for an unknown industry', () => {
    expect(resolveIndustry('underwater-basket-weaving').key).toBe(GENERIC_KEY);
  });

  it('falls back to generic for null and empty input', () => {
    expect(resolveIndustry(null).key).toBe(GENERIC_KEY);
    expect(resolveIndustry(undefined).key).toBe(GENERIC_KEY);
    expect(resolveIndustry('').key).toBe(GENERIC_KEY);
  });

  it('never resolves to the core template, which is not a choice', () => {
    expect(resolveIndustry(CORE_KEY).key).toBe(GENERIC_KEY);
  });

  it('resolves a known industry exactly', () => {
    expect(resolveIndustry('healthcare').key).toBe('healthcare');
  });
});

describe('question assembly', () => {
  it('always begins with the universal core questions', () => {
    const core = loadRegistry().core.questions.map((q) => q.id);
    for (const key of ['healthcare', 'real-estate', 'finance', 'not-a-real-industry']) {
      const ids = questionsFor(key).map((q) => q.id);
      expect(ids.slice(0, core.length)).toEqual(core);
    }
  });

  it('appends the industry branch after the core', () => {
    const healthcare = questionsFor('healthcare').map((q) => q.id);
    expect(healthcare).toContain('brandName'); // core
    expect(healthcare).toContain('regulatoryBody'); // branch
  });

  it('asks different follow-ups per industry — the whole point of branching', () => {
    const realEstate = new Set(questionsFor('real-estate').map((q) => q.id));
    const healthcare = new Set(questionsFor('healthcare').map((q) => q.id));
    expect(realEstate.has('propertyTypes')).toBe(true);
    expect(healthcare.has('propertyTypes')).toBe(false);
    expect(healthcare.has('patientDemographics')).toBe(true);
    expect(realEstate.has('patientDemographics')).toBe(false);
  });

  it('still asks a full question set for an unlisted industry', () => {
    const questions = questionsFor('taxidermy');
    expect(questions.length).toBeGreaterThan(loadRegistry().core.questions.length);
  });

  it('finds a question by id within the resolved set', () => {
    expect(findQuestion('healthcare', 'regulatoryBody')?.type).toBe('single_select');
    expect(findQuestion('healthcare', 'propertyTypes')).toBeNull();
  });

  it('every question maps to a valid profile path', () => {
    for (const industry of listIndustries()) {
      for (const q of questionsFor(industry.key)) {
        expect(q.mapsTo).toMatch(/^(core|industry)\.[a-zA-Z][a-zA-Z0-9]*$/);
      }
    }
  });

  it('select questions all carry options', () => {
    for (const industry of listIndustries()) {
      for (const q of questionsFor(industry.key)) {
        if (q.type === 'single_select' || q.type === 'multi_select') {
          expect(q.options?.length ?? 0).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('compliance template resolution', () => {
  it('flattens an inheritance chain, base first', () => {
    const { chain } = resolveComplianceRules('healthcare');
    expect(chain[0]).toBe(GENERIC_KEY);
    expect(chain).toContain('healthcare');
  });

  it('includes the base rules as well as the derived ones', () => {
    const generic = resolveComplianceRules(GENERIC_KEY).rules.map((r) => r.id);
    const healthcare = resolveComplianceRules('healthcare').rules.map((r) => r.id);
    for (const id of generic) expect(healthcare).toContain(id);
    expect(healthcare.length).toBeGreaterThan(generic.length);
  });

  it('falls back to generic rules for an unknown template', () => {
    const unknown = resolveComplianceRules('does-not-exist').rules.map((r) => r.id).sort();
    const generic = resolveComplianceRules(GENERIC_KEY).rules.map((r) => r.id).sort();
    expect(unknown).toEqual(generic);
  });

  it('maps an unlisted industry to the generic rule set rather than nothing', () => {
    expect(complianceTemplateFor('nonexistent-vertical')).toBe(GENERIC_KEY);
    expect(resolveComplianceRules(complianceTemplateFor('nonexistent-vertical')).rules.length)
      .toBeGreaterThan(0);
  });

  it('every shipped compliance template yields at least one rule', () => {
    for (const template of listComplianceTemplates()) {
      expect(template.ruleCount).toBeGreaterThan(0);
    }
  });

  it('regulated industries carry mandatory blocking rules', () => {
    for (const key of ['healthcare', 'finance', 'legal']) {
      const rules = resolveComplianceRules(key).rules;
      const hardStops = rules.filter((r) => r.severity === 'BLOCK' && r.mandatory);
      expect(hardStops.length, `${key} should have mandatory blocks`).toBeGreaterThan(0);
    }
  });
});
