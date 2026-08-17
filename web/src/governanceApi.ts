export interface QuestionOption { value: string; label: string; hint?: string }

export interface Question {
  id: string;
  prompt: string;
  help?: string;
  type:
    | 'text' | 'long_text' | 'multi_text' | 'single_select'
    | 'multi_select' | 'color_list' | 'font_pair' | 'number';
  required: boolean;
  options?: QuestionOption[];
  minItems?: number;
  maxItems?: number;
  mapsTo: string;
}

export type AnswerValue =
  | string | number | string[]
  | { name: string; hex: string }[]
  | { display: string; body: string }
  | null;

export interface IntakeStep {
  sessionId: string;
  industryKey: string | null;
  answers: Record<string, AnswerValue>;
  prefilled: Record<string, AnswerValue>;
  question: Question | null;
  answered: number;
  total: number;
  complete: boolean;
  suggestedAnswer: AnswerValue | null;
  industryChoices: { key: string; label: string; description: string | null }[] | null;
  summary: { label: string; value: string }[] | null;
}

export interface BrandProfile {
  id: string;
  version: number;
  industryKey: string;
  complianceTemplateKey: string;
  core: Record<string, AnswerValue>;
  industry: Record<string, AnswerValue>;
  locks: Record<string, boolean>;
  creativeDirection: string | null;
  effectiveFrom: string;
  sourceKind: string;
}

export interface ReferenceAsset {
  id: string;
  kind: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  usageNote: string | null;
  active: boolean;
  hasText: boolean;
  createdAt: string;
}

export interface BrandResponse {
  profile: BrandProfile | null;
  questions: Question[];
  industry: { key: string; label: string } | null;
  history: {
    id: string; version: number; industryKey: string;
    effectiveFrom: string; effectiveTo: string | null;
    createdBy: string; sourceKind: string;
  }[];
  referenceAssets: ReferenceAsset[];
}

export interface EffectiveRule {
  id: string;
  title: string;
  severity: 'BLOCK' | 'FLAG';
  mandatory: boolean;
  reason: string;
  appliesTo: string[];
  origin: 'TEMPLATE' | 'CUSTOM' | 'BRAND';
  sourceTemplate: string | null;
  match: { kind: string; [k: string]: unknown };
}

export interface ComplianceResponse {
  industryKey: string | null;
  industry: { key: string; label: string } | null;
  templateChain: string[];
  effectiveRules: EffectiveRule[];
  customRules: {
    id: string; ruleKey: string; title: string; severity: string;
    reason: string; enabled: boolean;
  }[];
  overrides: { templateRuleId: string; disabled: boolean; justification: string | null }[];
  refusedDisables: string[];
}

export interface Finding {
  ruleId: string;
  title: string;
  severity: 'BLOCK' | 'FLAG';
  field: string;
  reason: string;
  matched: string | null;
  origin: 'TEMPLATE' | 'CUSTOM' | 'BRAND';
  sourceTemplate: string | null;
}

export interface ComplianceVerdict {
  passed: boolean;
  blocked: boolean;
  findings: Finding[];
  rulesApplied: number;
  templateChain: string[];
}

export interface ReviewItem {
  id: string;
  status: 'PENDING_REVIEW' | 'BLOCKED' | 'APPROVED' | 'REJECTED' | 'EDITED';
  campaignBriefId: string | null;
  angleTag: string;
  hookType: string | null;
  headline: string;
  primaryText: string;
  cta: string;
  imageConcept: string | null;
  imageUrl: string | null;
  generationReasoning: string | null;
  complianceVerdict: ComplianceVerdict;
  complianceBlocked: boolean;
  rejectionReason: string | null;
  launchedAt: string | null;
  launchedVariantId: string | null;
  createdAt: string;
}

export interface CampaignBrief {
  id: string;
  clientId: string;
  brandProfileId: string;
  name: string;
  campaignType: 'awareness' | 'conversion' | 'retargeting' | 'launch' | 'seasonal';
  placements: { platform: string; formats: string[] }[];
  toneOverride: string | null;
  briefNotes: string | null;
  landingPageUrl: string;
  variantCount: number;
  dailyBudgetPerVariantCents: number;
  createdBy: string;
  createdAt: string;
  launchedCampaignId: string | null;
  launchedCohortId: string | null;
}

export interface LaunchResult {
  ok: true;
  campaignId: string;
  cohortId: string;
  variants: { id: string; reviewId: string; angleTag: string; headline: string; adSetId: string }[];
  totalDailyBudgetCents: number;
}

export interface ReviewsResponse {
  reviews: ReviewItem[];
  counts: Record<string, number>;
}

export interface TemplatesResponse {
  industries: { key: string; label: string; description: string | null; complianceTemplate: string }[];
  compliance: { key: string; label: string; ruleCount: number }[];
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; questionId?: string };
  if (!response.ok) {
    const err = new Error(body.error ?? `request failed (${response.status})`) as Error & {
      questionId?: string;
      status?: number;
    };
    if (body.questionId) err.questionId = body.questionId;
    err.status = response.status;
    throw err;
  }
  return body;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// --- workspace setup ----------------------------------------------------------
export const fetchSetupStatus = () => req<{ hasWorkspace: boolean }>('/api/setup/status');
export const createWorkspace = (body: {
  name: string;
  timezone: string;
  currency: string;
  objectiveType: 'CPA' | 'ROAS';
  targetValue: number;
}) => req<{ ok: true; clientId: string }>('/api/setup/workspace', json('POST', body));

// --- onboarding -------------------------------------------------------------
export const fetchIntake = () => req<IntakeStep>('/api/intake');
export const answerIntake = (sessionId: string, questionId: string, answer: unknown) =>
  req<IntakeStep>('/api/intake/answer', json('POST', { sessionId, questionId, answer }));
export const reviseIntake = (sessionId: string, questionId: string) =>
  req<IntakeStep>('/api/intake/revise', json('POST', { sessionId, questionId }));
export const completeIntake = (sessionId: string) =>
  req<{ ok: true; brandProfileId: string; industryKey: string }>(
    '/api/intake/complete', json('POST', { sessionId }));
export const restartIntake = () => req<IntakeStep>('/api/intake/restart', json('POST', {}));

export async function uploadBrandDocument(sessionId: string, file: File) {
  const form = new FormData();
  form.append('sessionId', sessionId);
  form.append('file', file);
  return req<IntakeStep & {
    stored: boolean; readable: boolean; extractor?: string;
    message?: string; rejected?: { questionId: string; reason: string }[];
  }>('/api/intake/document', { method: 'POST', body: form });
}

// --- brand ------------------------------------------------------------------
export const fetchBrand = () => req<BrandResponse>('/api/brand');
export const saveBrand = (body: Record<string, unknown>) =>
  req<{ ok: true; brandProfileId: string }>('/api/brand', json('PUT', body));

export async function uploadAsset(file: File, kind: string, usageNote: string) {
  const form = new FormData();
  form.append('file', file);
  form.append('kind', kind);
  form.append('usageNote', usageNote);
  return req<{ ok: true; asset: ReferenceAsset }>('/api/assets', { method: 'POST', body: form });
}
export const patchAsset = (id: string, body: Record<string, unknown>) =>
  req<{ ok: true }>(`/api/assets/${id}`, json('PATCH', body));
export const deleteAsset = (id: string) =>
  req<{ ok: true }>(`/api/assets/${id}`, { method: 'DELETE' });

// --- compliance -------------------------------------------------------------
export const fetchCompliance = () => req<ComplianceResponse>('/api/compliance');
export const addComplianceRule = (rule: unknown) =>
  req<{ ok: true }>('/api/compliance/rules', json('POST', rule));
export const toggleComplianceRule = (ruleKey: string, enabled: boolean) =>
  req<{ ok: true }>(`/api/compliance/rules/${ruleKey}`, json('PATCH', { enabled }));
export const deleteComplianceRule = (ruleKey: string) =>
  req<{ ok: true }>(`/api/compliance/rules/${ruleKey}`, { method: 'DELETE' });
export const overrideTemplateRule = (templateRuleId: string, disabled: boolean, justification?: string) =>
  req<{ ok: true }>('/api/compliance/overrides', json('POST', { templateRuleId, disabled, justification }));
export const testCompliance = (content: Record<string, string>) =>
  req<ComplianceVerdict>('/api/compliance/test', json('POST', content));

// --- reviews ----------------------------------------------------------------
export const fetchReviews = (status?: string) =>
  req<ReviewsResponse>(`/api/reviews${status ? `?status=${status}` : ''}`);
export const generateReviews = (body: { campaignBriefId?: string; variantCount?: number }) =>
  req<{
    reviewIds: string[]; generated: number; blocked: number; flagged: number;
    clean: number; generator: string; imageProvider: string;
  }>('/api/reviews/generate', json('POST', body));
export const editReview = (id: string, body: Record<string, string>) =>
  req<{ ok: true; blocked: boolean; findings: number }>(`/api/reviews/${id}`, json('PUT', body));
export const decideReview = (id: string, action: 'approve' | 'reject', reason?: string) =>
  req<{ ok: true; status: string }>(`/api/reviews/${id}/decision`, json('POST', { action, reason }));

// --- templates / briefs -----------------------------------------------------
export const fetchTemplates = () => req<TemplatesResponse>('/api/templates');
export const fetchBriefs = () => req<{ briefs: CampaignBrief[] }>('/api/briefs');
export const createBrief = (body: Record<string, unknown>) =>
  req<{ ok: true; brief: CampaignBrief }>('/api/briefs', json('POST', body));
export const launchBrief = (id: string, body: Record<string, unknown>) =>
  req<LaunchResult>(`/api/briefs/${id}/launch`, json('POST', body));

