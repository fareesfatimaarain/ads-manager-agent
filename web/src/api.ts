export interface Overview {
  client: {
    id: string;
    name: string;
    objectiveType: 'CPA' | 'ROAS';
    targetCpaCents: number | null;
    targetRoas: string | null;
    autonomousKillEnabled: boolean;
    autonomousScaleEnabled: boolean;
    autonomousMutateEnabled: boolean;
  } | null;
  config: Record<string, unknown> | null;
  variants: Variant[];
  totals: {
    spendCents: number;
    conversions: number;
    impressions: number;
    clicks: number;
    activeDailyBudgetCents: number;
    cpaCents: number | null;
  } | null;
}

export interface Variant {
  id: string;
  headline: string;
  primaryText: string;
  cta: string;
  angleTag: string;
  status: 'DRAFT' | 'PENDING_LAUNCH' | 'TESTING' | 'SCALING' | 'PAUSED' | 'KILLED' | 'FAILED';
  campaignName: string;
  dailyBudgetCents: number;
  adSetStatus: string;
  testStartedAt: string | null;
  evaluationsOutcome: number;
  impressions: number;
  clicks: number;
  spendCents: number;
  conversions: number;
  ctr: number | null;
  cvr: number | null;
  cpaCents: number | null;
}

export interface Decision {
  id: string;
  decisionType: 'KILL' | 'SCALE' | 'MUTATE' | 'NO_ACTION' | 'ESCALATE';
  status: string;
  reasoning: string | null;
  blockedByRule: string | null;
  blockedReason: string | null;
  decidedAt: string;
  executedAt: string | null;
  expiresAt: string | null;
  failureReason: string | null;
  proposedAction: Record<string, unknown> | null;
  statisticalEvidence: Record<string, unknown> | null;
  guardrailEvaluations: GuardrailEvaluation[] | null;
  engineVersion: string;
  rulesetVersion: string;
  variantId: string | null;
  headline: string | null;
  angleTag: string | null;
}

export interface GuardrailEvaluation {
  rule: string;
  passed: boolean;
  applicable: boolean;
  detail: string;
  observed: number | string | null;
  limit: number | string | null;
}

export interface Approval {
  id: string;
  decisionType: string;
  reasoning: string | null;
  decidedAt: string;
  expiresAt: string | null;
  proposedAction: Record<string, unknown> | null;
  statisticalEvidence: Record<string, unknown> | null;
  headline: string | null;
  angleTag: string | null;
}

export interface DeadLetter {
  id: string;
  method: string;
  lastError: string | null;
  attempts: number;
  createdAt: string;
}

export interface GuardrailConfig {
  id: string;
  version: number;
  maxBudgetIncreasePct: number;
  maxBudgetDecreasePct: number;
  maxDailyAutonomousIncreaseCents: number;
  maxTotalDailyBudgetCents: number;
  minAdSetDailyBudgetCents: number;
  maxAdSetDailyBudgetCents: number;
  minRuntimeHours: number;
  minSpendMultipleOfTargetCpa: number;
  minConversionsPerArm: number;
  minTestSpendCents: number;
  zeroConversionKillSpendCents: number;
  killPThreshold: number;
  scalePThreshold: number;
  proxyKillMinImpressions: number;
  proxyKillCtrDropPct: number;
  zeroConversionKillSpendMultiple: number;
  roasScaleSafetyMargin: number;
  roasBootstrapMinDays: number;
  roasBootstrapIterations: number;
  mSprtTauRelative: number;
  mutateCpaBandMultiple: number;
  maxMutationDepth: number;
  mutateTestBudgetCents: number;
  allowScaleWithoutComparativeBaseline: boolean;
  actionCooldownHours: number;
  maxActionsPerCyclePerClient: number;
  minActiveCampaigns: number;
  allowTargetingChanges: boolean;
  allowAudienceExpansion: boolean;
  allowCampaignCreation: boolean;
  attributionSettlingHours: number;
  maxPerformanceStalenessHours: number;
  approvalExpiryHours: number;
  [key: string]: string | number | boolean;
}

export interface Settings {
  client: {
    id: string;
    name: string;
    objectiveType: 'CPA' | 'ROAS';
    targetCpaCents: number | null;
    targetRoas: string | null;
    timezone: string;
    autonomousKillEnabled: boolean;
    autonomousScaleEnabled: boolean;
    autonomousMutateEnabled: boolean;
    automationPausedAt: string | null;
    automationPausedBy: string | null;
  } | null;
  guardrails: GuardrailConfig | null;
  history: { id: string; version: number; effectiveFrom: string; effectiveTo: string | null; createdBy: string }[];
  editableFields: string[];
  executionEnabled: boolean;
}

export interface Operations {
  accounts: {
    id: string;
    name: string;
    platform: string;
    status: string;
    currency: string;
    timezone: string;
    lastSyncedAt: string | null;
    lastErrorAt: string | null;
    lastError: string | null;
    tokenExpiresAt: string | null;
  }[];
  spendToday: { committedCents: number; capCents: number | null } | null;
  deadLetters: DeadLetter[];
  recentCycles: { cycleId: string; at: string; decisions: number }[];
  executionEnabled: boolean;
  automationPaused: boolean;
}

export interface AngleSummary {
  angleTag: string;
  variantsTested: number;
  totalSpendCents: number;
  totalConversions: number;
  cpaCents: number | null;
  verdict: 'WINNER' | 'MIXED' | 'LOSER' | 'UNTESTED';
}

export interface CreativeLibrary {
  angles: AngleSummary[];
  variants: {
    id: string;
    angleTag: string;
    hookType: string | null;
    headline: string;
    primaryText: string;
    cta: string;
    status: string;
    generationReasoning: string | null;
    createdAt: string;
  }[];
  brandKit: {
    version: number;
    tone: string;
    palette: { name: string; hex: string }[];
    bannedWords: string[];
    bannedClaims: string[];
  } | null;
}

export interface CycleResult {
  cycleId: string;
  clientsProcessed: number;
  cohortsEvaluated: number;
  cohortsSkipped: number;
  decisions: { kind: string; outcome: string; variantId: string }[];
  errors: { scope: string; id: string; message: string }[];
}

export interface AuthUser {
  id: string;
  email: string;
  role: string;
}

/** Returns null for "not signed in" rather than throwing — that's an expected, common state. */
export async function fetchMe(): Promise<AuthUser | null> {
  const response = await fetch('/api/auth/me', { headers: { accept: 'application/json' } });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const body = (await response.json()) as { user: AuthUser };
  return body.user;
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = (await response.json().catch(() => ({}))) as { user?: AuthUser; error?: string };
  if (!response.ok || !body.user) throw new Error(body.error ?? 'sign-in failed');
  return body.user;
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* response had no JSON body; the status line is all we have */
    }
    throw new ApiError(detail, response.status);
  }
  return (await response.json()) as T;
}

export const fetchOverview = () => get<Overview>('/api/overview');
export const fetchDecisions = () => get<{ decisions: Decision[] }>('/api/decisions');
export const fetchApprovals = () => get<{ approvals: Approval[] }>('/api/approvals');
export const fetchDeadLetters = () => get<{ deadLetters: DeadLetter[] }>('/api/dead-letters');
export const fetchSettings = () => get<Settings>('/api/settings');
export const fetchOperations = () => get<Operations>('/api/operations');
export const fetchCreative = () => get<CreativeLibrary>('/api/creative');

async function send<T>(path: string, method: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => ({}))) as T & { error?: string; field?: string };
  if (!response.ok) {
    const err = new ApiError(parsed.error ?? `request failed (${response.status})`, response.status) as ApiError & {
      field?: string;
    };
    if (parsed.field) err.field = parsed.field;
    throw err;
  }
  return parsed;
}

export const saveGuardrails = (patch: Record<string, unknown>) =>
  send<{ ok: true; version: number; changed: { field: string; from: unknown; to: unknown }[] }>(
    '/api/settings/guardrails',
    'PUT',
    { patch },
  );

export const saveClientSettings = (body: Record<string, unknown>) =>
  send<{ ok: true; updated: string[] }>('/api/settings/client', 'PATCH', body);

export const acknowledgeDeadLetter = (id: string) =>
  send<{ ok: true }>(`/api/dead-letters/${id}/acknowledge`, 'POST', {});

export const runCycle = () => send<CycleResult>('/api/cycle/run', 'POST', {});
export const runIngest = () =>
  send<{ rowsWritten: number; errors: string[] }>('/api/cycle/ingest', 'POST', {});

export async function respondToApproval(
  id: string,
  action: 'approve' | 'reject',
): Promise<void> {
  const response = await fetch(`/api/approvals/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, actor: 'dashboard' }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `request failed (${response.status})`);
  }
}

// --- formatting ------------------------------------------------------------

export const money = (cents: number | null | undefined): string =>
  cents === null || cents === undefined
    ? '—'
    : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const compactMoney = (cents: number | null | undefined): string =>
  cents === null || cents === undefined
    ? '—'
    : `$${Math.round(cents / 100).toLocaleString('en-US')}`;

export const percent = (value: number | null | undefined, digits = 2): string =>
  value === null || value === undefined ? '—' : `${(value * 100).toFixed(digits)}%`;

export const count = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : value.toLocaleString('en-US');

export function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const minutes = Math.round(diff / 60_000);
  if (Math.abs(minutes) < 1) return 'just now';
  if (Math.abs(minutes) < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function timeUntil(iso: string | null): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'expired';
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.round(diff / 60_000))}m left`;
  if (hours < 48) return `${hours}h left`;
  return `${Math.round(hours / 24)}d left`;
}
