import { describe, expect, it } from 'vitest';
import {
  applyAnswer,
  assembleProfile,
  fullQuestionSet,
  INDUSTRY_QUESTION_ID,
  IntakeError,
  nextStep,
  summarise,
  validateAnswer,
  type IntakeState,
} from '../../src/intake/engine.js';
import { findQuestion, questionsFor } from '../../src/templates/registry.js';

const empty: IntakeState = { industryKey: null, answers: {}, prefilled: {} };

/** Answers every required question for an industry, so completion can be tested. */
function completeIntake(industryKey: string): IntakeState {
  let state = applyAnswer(empty, INDUSTRY_QUESTION_ID, industryKey);

  for (const q of questionsFor(industryKey)) {
    if (!q.required) continue;
    let answer: unknown;
    switch (q.type) {
      case 'text':
      case 'long_text':
        answer = `Answer for ${q.id}`;
        break;
      case 'number':
        answer = 42;
        break;
      case 'single_select':
        answer = q.options![0]!.value;
        break;
      case 'multi_select':
        answer = [q.options![0]!.value];
        break;
      case 'multi_text':
        answer = ['one', 'two'];
        break;
      case 'color_list':
        answer = [{ name: 'Ink', hex: '#1A1915' }];
        break;
      case 'font_pair':
        answer = { display: 'Georgia', body: 'Segoe UI' };
        break;
    }
    state = applyAnswer(state, q.id, answer);
  }
  return state;
}

describe('flow', () => {
  it('asks for the industry first', () => {
    const step = nextStep(empty);
    expect(step.question?.id).toBe(INDUSTRY_QUESTION_ID);
    expect(step.industryChoices?.length).toBeGreaterThan(1);
    expect(step.complete).toBe(false);
  });

  it('offers every listed industry as a choice', () => {
    const choices = nextStep(empty).industryChoices!;
    expect(choices.some((c) => c.key === 'healthcare')).toBe(true);
    expect(choices.some((c) => c.key === 'generic')).toBe(true);
  });

  it('asks the universal core before the industry branch', () => {
    const state = applyAnswer(empty, INDUSTRY_QUESTION_ID, 'healthcare');
    const step = nextStep(state);
    expect(step.question?.id).toBe('brandName');
  });

  it('branches differently by industry', () => {
    const healthcare = fullQuestionSet('healthcare').map((q) => q.id);
    const realEstate = fullQuestionSet('real-estate').map((q) => q.id);
    expect(healthcare).toContain('patientDemographics');
    expect(realEstate).toContain('propertyTypes');
    expect(healthcare).not.toContain('propertyTypes');
  });

  it('branches to the generic set for an unlisted industry rather than stalling', () => {
    const state = applyAnswer(empty, INDUSTRY_QUESTION_ID, 'generic');
    const ids = fullQuestionSet(state.industryKey).map((q) => q.id);
    expect(ids).toContain('categories');
    expect(nextStep(state).complete).toBe(false);
  });

  it('reports progress as answers accumulate', () => {
    const a = nextStep(empty);
    const state = applyAnswer(empty, INDUSTRY_QUESTION_ID, 'ecommerce');
    const b = nextStep(state);
    expect(b.answered).toBeGreaterThan(a.answered);
    expect(b.total).toBeGreaterThan(0);
  });

  it('completes once every required question is answered', () => {
    const state = completeIntake('healthcare');
    expect(nextStep(state).complete).toBe(true);
  });

  it('does not require optional questions to complete', () => {
    const state = completeIntake('real-estate');
    const optional = questionsFor('real-estate').filter((q) => !q.required);
    expect(optional.length).toBeGreaterThan(0);
    for (const q of optional) expect(state.answers[q.id]).toBeUndefined();
    expect(nextStep(state).complete).toBe(true);
  });
});

describe('changing industry mid-flow', () => {
  it('keeps core answers but drops the previous branch', () => {
    let state = applyAnswer(empty, INDUSTRY_QUESTION_ID, 'real-estate');
    state = applyAnswer(state, 'brandName', 'Northwind');
    state = applyAnswer(state, 'propertyTypes', ['residential-sale']);
    expect(state.answers.propertyTypes).toBeDefined();

    state = applyAnswer(state, INDUSTRY_QUESTION_ID, 'healthcare');
    expect(state.answers.brandName).toBe('Northwind');
    expect(state.answers.propertyTypes).toBeUndefined();
    expect(state.industryKey).toBe('healthcare');
  });

  it('is a no-op when the industry is re-selected unchanged', () => {
    let state = applyAnswer(empty, INDUSTRY_QUESTION_ID, 'finance');
    state = applyAnswer(state, 'registrationNumber', 'FCA-123');
    state = applyAnswer(state, INDUSTRY_QUESTION_ID, 'finance');
    expect(state.answers.registrationNumber).toBe('FCA-123');
  });

  it('rejects an answer to a question from a branch no longer in play', () => {
    const state = applyAnswer(empty, INDUSTRY_QUESTION_ID, 'healthcare');
    expect(() => applyAnswer(state, 'propertyTypes', ['residential-sale'])).toThrow(IntakeError);
  });
});

describe('answer validation', () => {
  const q = (industry: string, id: string) => findQuestion(industry, id)!;

  it('rejects an empty required answer', () => {
    expect(() => validateAnswer(q('healthcare', 'brandName'), '')).toThrow(IntakeError);
  });

  it('accepts an empty optional answer as null', () => {
    expect(validateAnswer(q('healthcare', 'toneNotes'), '')).toBeNull();
  });

  it('trims text', () => {
    expect(validateAnswer(q('healthcare', 'brandName'), '  Northwind  ')).toBe('Northwind');
  });

  it('rejects an option that is not offered', () => {
    expect(() => validateAnswer(q('healthcare', 'regulatoryBody'), 'made-up')).toThrow(IntakeError);
  });

  it('accepts a valid option', () => {
    expect(validateAnswer(q('healthcare', 'regulatoryBody'), 'fda-us')).toBe('fda-us');
  });

  it('enforces minimum item counts', () => {
    expect(() => validateAnswer(q('healthcare', 'services'), [])).toThrow(IntakeError);
  });

  it('drops blank entries from a list', () => {
    expect(validateAnswer(q('healthcare', 'services'), ['a', '  ', 'b'])).toEqual(['a', 'b']);
  });

  it('validates hex colours and normalises casing', () => {
    expect(validateAnswer(q('healthcare', 'palette'), [{ name: 'Ink', hex: '#1a1915' }])).toEqual([
      { name: 'Ink', hex: '#1A1915' },
    ]);
    expect(() => validateAnswer(q('healthcare', 'palette'), [{ name: 'Ink', hex: 'black' }])).toThrow(
      IntakeError,
    );
  });

  it('requires a colour name', () => {
    expect(() => validateAnswer(q('healthcare', 'palette'), [{ name: '', hex: '#1A1915' }])).toThrow(
      IntakeError,
    );
  });

  it('requires both faces of a font pair', () => {
    expect(() => validateAnswer(q('healthcare', 'fonts'), { display: 'Georgia' })).toThrow(IntakeError);
  });

  it('names the offending question in the error', () => {
    try {
      validateAnswer(q('healthcare', 'brandName'), '');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as IntakeError).questionId).toBe('brandName');
    }
  });
});

describe('profile assembly', () => {
  it('refuses to assemble an unfinished intake', () => {
    const state = applyAnswer(empty, INDUSTRY_QUESTION_ID, 'healthcare');
    expect(() => assembleProfile(state)).toThrow(IntakeError);
  });

  it('routes answers by their declared mapsTo', () => {
    const profile = assembleProfile(completeIntake('healthcare'));
    expect(profile.core.brandName).toBe('Answer for brandName');
    expect(profile.industry.patientDemographics).toBe('Answer for patientDemographics');
    expect(profile.core.patientDemographics).toBeUndefined();
  });

  it('records the industry and its compliance template', () => {
    const profile = assembleProfile(completeIntake('finance'));
    expect(profile.industryKey).toBe('finance');
    expect(profile.complianceTemplateKey).toBe('finance');
  });

  it('resolves an unlisted industry to generic in the stored profile', () => {
    let state = applyAnswer(empty, INDUSTRY_QUESTION_ID, 'generic');
    state = completeIntake('generic');
    const profile = assembleProfile(state);
    expect(profile.industryKey).toBe('generic');
    expect(profile.complianceTemplateKey).toBe('generic');
  });

  it('produces a readable summary for confirmation', () => {
    const rows = summarise(completeIntake('real-estate'));
    expect(rows[0]!.label).toBe('Industry');
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) expect(row.value.length).toBeGreaterThan(0);
  });
});

describe('pre-fill from an uploaded document', () => {
  it('surfaces a suggested answer without accepting it', () => {
    const state: IntakeState = {
      industryKey: 'healthcare',
      answers: { [INDUSTRY_QUESTION_ID]: 'healthcare' },
      prefilled: { brandName: 'Extracted Name' },
    };
    const step = nextStep(state);
    expect(step.question?.id).toBe('brandName');
    expect(step.suggestedAnswer).toBe('Extracted Name');
    // Still unanswered — a suggestion is not a commitment.
    expect(state.answers.brandName).toBeUndefined();
    expect(step.complete).toBe(false);
  });
});
