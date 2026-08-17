/**
 * Chat-based brand intake.
 *
 * A state machine over a question set, not a form. It asks the universal core first, then
 * branches into whatever the stated industry's template defines — and because both come from
 * templates, this file contains no knowledge of any particular industry. Adding dentistry
 * means adding `templates/industries/dentistry.json`; this file does not change.
 *
 * Two behaviours matter for a client-facing product:
 *
 *  - **Resumable.** Answers accumulate in the session, so a half-finished intake survives a
 *    closed tab. Changing the industry mid-flow discards only the branch answers, never the
 *    core ones.
 *  - **Pre-fillable.** An uploaded brand document can seed answers, which are then presented
 *    for confirmation rather than silently accepted. A document that says the wrong thing
 *    should be correctable before it becomes the brand's permanent memory.
 */
import {
  findQuestion,
  listIndustries,
  questionsFor,
  resolveIndustry,
  complianceTemplateFor,
} from '../templates/registry.js';
import type { Question } from '../templates/schema.js';

export type AnswerValue = string | number | string[] | { name: string; hex: string }[] | { display: string; body: string } | null;

export interface IntakeState {
  readonly industryKey: string | null;
  readonly answers: Readonly<Record<string, AnswerValue>>;
  readonly prefilled: Readonly<Record<string, AnswerValue>>;
}

export interface IntakeStep {
  /** The question to ask now, or null when intake is complete. */
  readonly question: Question | null;
  /** How far through, for a progress indicator. */
  readonly answered: number;
  readonly total: number;
  readonly complete: boolean;
  /** Present when this question was pre-filled from a document and needs confirming. */
  readonly suggestedAnswer: AnswerValue | null;
  /** Set before the industry is chosen, so the UI can offer the list. */
  readonly industryChoices: { key: string; label: string; description: string | null }[] | null;
}

export class IntakeError extends Error {
  constructor(
    message: string,
    readonly questionId: string | null,
  ) {
    super(message);
    this.name = 'IntakeError';
  }
}

/** The industry question is asked by the engine itself; it is not part of any template. */
export const INDUSTRY_QUESTION_ID = '__industry';

export const INDUSTRY_QUESTION: Question = {
  id: INDUSTRY_QUESTION_ID,
  prompt: 'What industry is the brand in?',
  help: 'This decides which follow-up questions you get and which compliance rules apply. Pick the closest — you can change it later.',
  type: 'single_select',
  required: true,
  options: [],
  mapsTo: 'core.industryKey',
};

function industryQuestion(): Question {
  return {
    ...INDUSTRY_QUESTION,
    options: listIndustries().map((i) => ({
      value: i.key,
      label: i.label,
      ...(i.description ? { hint: i.description } : {}),
    })),
  };
}

/** Every question in order, including the engine's own industry question. */
export function fullQuestionSet(industryKey: string | null): Question[] {
  return [industryQuestion(), ...questionsFor(industryKey)];
}

function isAnswered(value: AnswerValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

/**
 * Works out what to ask next.
 *
 * Optional questions are asked once but never block completion — the flow is finished when
 * every *required* question has an answer, so a client is not held hostage by a field they
 * genuinely have nothing to say about.
 */
export function nextStep(state: IntakeState): IntakeStep {
  const questions = fullQuestionSet(state.industryKey);
  const answered = questions.filter((q) => isAnswered(state.answers[q.id])).length;

  // The industry gate comes first: without it we do not know which branch to ask.
  if (!isAnswered(state.answers[INDUSTRY_QUESTION_ID])) {
    return {
      question: industryQuestion(),
      answered,
      total: questions.length,
      complete: false,
      suggestedAnswer: state.prefilled[INDUSTRY_QUESTION_ID] ?? null,
      industryChoices: listIndustries().map((i) => ({
        key: i.key,
        label: i.label,
        description: i.description,
      })),
    };
  }

  const unanswered = questions.filter((q) => !isAnswered(state.answers[q.id]));
  const nextRequired = unanswered.find((q) => q.required) ?? unanswered[0] ?? null;

  const requiredOutstanding = questions.some((q) => q.required && !isAnswered(state.answers[q.id]));

  return {
    question: nextRequired,
    answered,
    total: questions.length,
    complete: !requiredOutstanding,
    suggestedAnswer: nextRequired ? (state.prefilled[nextRequired.id] ?? null) : null,
    industryChoices: null,
  };
}

// ---------------------------------------------------------------------------
// Answer validation
// ---------------------------------------------------------------------------

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Validates and normalises an answer against its question definition.
 *
 * Validation is driven entirely by the template's declared type and bounds. Adding a question
 * type would touch this function; adding an industry never does.
 */
export function validateAnswer(question: Question, raw: unknown): AnswerValue {
  const fail = (message: string): never => {
    throw new IntakeError(message, question.id);
  };

  if (raw === null || raw === undefined || raw === '') {
    if (question.required) fail(`"${question.prompt}" is required`);
    return null;
  }

  switch (question.type) {
    case 'text':
    case 'long_text': {
      if (typeof raw !== 'string') return fail('expected text');
      const trimmed = raw.trim();
      if (question.required && trimmed.length === 0) fail('this answer cannot be empty');
      if (trimmed.length > 4000) fail('answer is too long (4000 characters maximum)');
      return trimmed;
    }

    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) return fail('expected a number');
      return n;
    }

    case 'single_select': {
      if (typeof raw !== 'string') return fail('expected one option');
      const allowed = (question.options ?? []).map((o) => o.value);
      if (!allowed.includes(raw)) fail(`"${raw}" is not one of the available options`);
      return raw;
    }

    case 'multi_select': {
      if (!Array.isArray(raw)) return fail('expected a list of options');
      const allowed = new Set((question.options ?? []).map((o) => o.value));
      const values = raw.map(String);
      for (const v of values) if (!allowed.has(v)) fail(`"${v}" is not one of the available options`);
      if (question.minItems && values.length < question.minItems) {
        fail(`choose at least ${question.minItems}`);
      }
      if (question.maxItems && values.length > question.maxItems) {
        fail(`choose at most ${question.maxItems}`);
      }
      return values;
    }

    case 'multi_text': {
      if (!Array.isArray(raw)) return fail('expected a list');
      const values = raw.map((v) => String(v).trim()).filter((v) => v.length > 0);
      if (question.minItems && values.length < question.minItems) {
        fail(`add at least ${question.minItems}`);
      }
      if (question.maxItems && values.length > question.maxItems) {
        fail(`add at most ${question.maxItems}`);
      }
      if (question.required && values.length === 0) fail('add at least one');
      return values;
    }

    case 'color_list': {
      if (!Array.isArray(raw)) return fail('expected a list of colours');
      const colors = raw.map((entry) => {
        const e = entry as { name?: unknown; hex?: unknown };
        const name = String(e.name ?? '').trim();
        const hex = String(e.hex ?? '').trim();
        if (!HEX.test(hex)) fail(`"${hex}" is not a 6-digit hex colour like #1A1915`);
        if (name.length === 0) fail('every colour needs a name');
        return { name, hex: hex.toUpperCase() };
      });
      if (question.minItems && colors.length < question.minItems) {
        fail(`add at least ${question.minItems} colour(s)`);
      }
      if (question.maxItems && colors.length > question.maxItems) {
        fail(`add at most ${question.maxItems} colours`);
      }
      return colors;
    }

    case 'font_pair': {
      const e = raw as { display?: unknown; body?: unknown };
      const display = String(e.display ?? '').trim();
      const body = String(e.body ?? '').trim();
      if (display.length === 0 || body.length === 0) {
        fail('provide both a display and a body typeface');
      }
      return { display, body };
    }
  }
}

/**
 * Records an answer, returning the new state.
 *
 * Changing the industry clears the previous branch's answers, because they belong to questions
 * that are no longer being asked. Core answers are preserved — a brand's name and tone do not
 * change because its industry was mis-selected on the first pass.
 */
export function applyAnswer(
  state: IntakeState,
  questionId: string,
  raw: unknown,
): IntakeState {
  if (questionId === INDUSTRY_QUESTION_ID) {
    const value = validateAnswer(industryQuestion(), raw) as string;
    if (state.industryKey === value) {
      return { ...state, answers: { ...state.answers, [questionId]: value } };
    }

    const coreIds = new Set(questionsFor(null).map((q) => q.id));
    const preserved: Record<string, AnswerValue> = {};
    for (const [id, answer] of Object.entries(state.answers)) {
      // Keep core answers and the industry answer itself; drop the old branch.
      const isCore = coreIds.has(id);
      const fromOldBranch = !isCore && id !== INDUSTRY_QUESTION_ID;
      if (!fromOldBranch) preserved[id] = answer;
    }
    preserved[questionId] = value;

    return { industryKey: value, answers: preserved, prefilled: state.prefilled };
  }

  const question = findQuestion(state.industryKey, questionId);
  if (!question) {
    throw new IntakeError(
      `"${questionId}" is not a question in this intake — the industry may have changed`,
      questionId,
    );
  }

  const value = validateAnswer(question, raw);
  return { ...state, answers: { ...state.answers, [questionId]: value } };
}

// ---------------------------------------------------------------------------
// Profile assembly
// ---------------------------------------------------------------------------

export interface AssembledProfile {
  readonly industryKey: string;
  readonly complianceTemplateKey: string;
  readonly core: Record<string, AnswerValue>;
  readonly industry: Record<string, AnswerValue>;
}

/**
 * Turns a completed intake into a brand profile.
 *
 * Answers are routed by each question's declared `mapsTo`, so where a value lands is a
 * template decision rather than a hardcoded mapping.
 */
export function assembleProfile(state: IntakeState): AssembledProfile {
  const step = nextStep(state);
  if (!step.complete) {
    throw new IntakeError(
      `intake is not finished — "${step.question?.prompt ?? 'a required question'}" still needs an answer`,
      step.question?.id ?? null,
    );
  }

  const industryKey = resolveIndustry(state.industryKey).key;
  const core: Record<string, AnswerValue> = {};
  const industry: Record<string, AnswerValue> = {};

  for (const question of questionsFor(state.industryKey)) {
    const value = state.answers[question.id];
    if (!isAnswered(value)) continue;

    const [scope, field] = question.mapsTo.split('.') as ['core' | 'industry', string];
    if (scope === 'core') core[field] = value!;
    else industry[field] = value!;
  }

  core.industryKey = industryKey;

  return {
    industryKey,
    complianceTemplateKey: complianceTemplateFor(industryKey),
    core,
    industry,
  };
}

/** A concise summary for the confirmation screen at the end of intake. */
export function summarise(state: IntakeState): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const industry = resolveIndustry(state.industryKey);
  rows.push({ label: 'Industry', value: industry.label });

  for (const question of questionsFor(state.industryKey)) {
    const value = state.answers[question.id];
    if (!isAnswered(value)) continue;
    rows.push({ label: question.prompt, value: renderAnswer(value!) });
  }
  return rows;
}

export function renderAnswer(value: AnswerValue): string {
  if (value === null) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v : 'name' in v ? `${v.name} ${v.hex}` : String(v)))
      .join(', ');
  }
  if ('display' in value) return `${value.display} / ${value.body}`;
  return JSON.stringify(value);
}
