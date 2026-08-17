import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  money,
  saveClientSettings,
  saveGuardrails,
  type GuardrailConfig,
  type Settings,
} from './api';
import { Badge, EmptyState, useMotionVariants } from './components';

/**
 * Every editable limit, grouped the way an operator thinks about them rather than the way the
 * table is laid out. Each field carries the consequence of changing it — a number with no
 * explanation is a number nobody dares touch.
 */
type FieldKind = 'money' | 'percent' | 'integer' | 'decimal' | 'probability' | 'boolean';

interface FieldSpec {
  key: keyof GuardrailConfig & string;
  label: string;
  kind: FieldKind;
  help: string;
}

interface FieldGroup {
  title: string;
  intent: string;
  fields: FieldSpec[];
}

const GROUPS: FieldGroup[] = [
  {
    title: 'Spend limits',
    intent: 'The hard ceilings. Nothing the system does can exceed these.',
    fields: [
      { key: 'maxBudgetIncreasePct', label: 'Max increase per change', kind: 'percent', help: 'How much a single budget rise may add. Prevents lump jumps that disturb delivery.' },
      { key: 'maxBudgetDecreasePct', label: 'Max decrease per change', kind: 'percent', help: 'How far a single change may cut a budget.' },
      { key: 'maxDailyAutonomousIncreaseCents', label: 'Max new spend per day', kind: 'money', help: 'Total additional daily budget the system may commit across the account in one day.' },
      { key: 'maxTotalDailyBudgetCents', label: 'Absolute daily ceiling', kind: 'money', help: 'Hard cap on combined daily budget, regardless of performance.' },
      { key: 'minAdSetDailyBudgetCents', label: 'Per-ad floor', kind: 'money', help: 'No ad may run below this daily budget.' },
      { key: 'maxAdSetDailyBudgetCents', label: 'Per-ad ceiling', kind: 'money', help: 'Stops any single ad absorbing the whole budget.' },
    ],
  },
  {
    title: 'Evidence required',
    intent: 'How much has to be known before any decision is allowed at all.',
    fields: [
      { key: 'minRuntimeHours', label: 'Minimum runtime (hours)', kind: 'integer', help: 'An ad must run this long before it can be judged.' },
      { key: 'minTestSpendCents', label: 'Minimum test spend', kind: 'money', help: 'Absolute spend floor per ad before any decision.' },
      { key: 'minSpendMultipleOfTargetCpa', label: 'Spend as multiple of target', kind: 'decimal', help: 'Additional floor for cost-per-sale clients: spend at least this many times the target.' },
      { key: 'minConversionsPerArm', label: 'Minimum conversions to scale', kind: 'integer', help: 'Conversions needed before an ad can have its budget raised.' },
      { key: 'attributionSettlingHours', label: 'Attribution settling (hours)', kind: 'integer', help: 'How long to wait before treating a day’s sales figures as final. Lowering this makes the system act on undercounted data.' },
      { key: 'maxPerformanceStalenessHours', label: 'Max data age (hours)', kind: 'integer', help: 'If performance data is older than this, the system refuses to act.' },
    ],
  },
  {
    title: 'Confidence thresholds',
    intent: 'How certain the system must be. Lower numbers mean stricter.',
    fields: [
      { key: 'scalePThreshold', label: 'Threshold to scale', kind: 'probability', help: 'Must be at least as strict as the stop threshold — a wrong scale costs money, a wrong stop costs opportunity.' },
      { key: 'killPThreshold', label: 'Threshold to stop', kind: 'probability', help: 'Deliberately looser than the scale threshold.' },
      { key: 'proxyKillMinImpressions', label: 'Impressions before click-rate stop', kind: 'integer', help: 'How much delivery an ad needs before its click rate can trigger a stop.' },
      { key: 'proxyKillCtrDropPct', label: 'Click-rate drop to stop', kind: 'percent', help: 'How far below the rest of the test an ad’s click rate must fall. Guards against statistically real but commercially trivial gaps.' },
      { key: 'zeroConversionKillSpendMultiple', label: 'Zero-sale stop multiple', kind: 'decimal', help: 'Spend this many times the target with no sales and the ad is stopped.' },
      { key: 'mSprtTauRelative', label: 'Test sensitivity (tau)', kind: 'decimal', help: 'Effect size the significance test is tuned for, relative to the base rate. Affects sensitivity only, never correctness.' },
    ],
  },
  {
    title: 'Pace and variation',
    intent: 'How often the system may act, and how it explores.',
    fields: [
      { key: 'actionCooldownHours', label: 'Cooling-off period (hours)', kind: 'integer', help: 'Minimum time between two changes to the same ad.' },
      { key: 'maxActionsPerCyclePerClient', label: 'Max actions per cycle', kind: 'integer', help: 'Caps how much can change in a single run.' },
      { key: 'minActiveCampaigns', label: 'Minimum active campaigns', kind: 'integer', help: 'The system will never leave you with fewer than this.' },
      { key: 'mutateCpaBandMultiple', label: 'Near-winner band', kind: 'decimal', help: 'An ad within this multiple of target is treated as worth varying rather than stopping.' },
      { key: 'maxMutationDepth', label: 'Max variation depth', kind: 'integer', help: 'How many generations of variation one ad may spawn.' },
      { key: 'mutateTestBudgetCents', label: 'Variation test budget', kind: 'money', help: 'Daily budget a new variation launches at.' },
      { key: 'approvalExpiryHours', label: 'Approval expiry (hours)', kind: 'integer', help: 'Recommendations lapse after this, so nobody approves stale evidence.' },
    ],
  },
];

function toInput(value: string | number | boolean, kind: FieldKind): string {
  if (typeof value === 'boolean') return String(value);
  if (kind === 'money') return (Number(value) / 100).toFixed(2);
  return String(value);
}

function fromInput(raw: string, kind: FieldKind): number {
  const n = Number(raw);
  if (kind === 'money') return Math.round(n * 100);
  return n;
}

export function SettingsView({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: () => void | Promise<void>;
}) {
  const { list, item } = useMotionVariants();
  const guardrails = settings.guardrails;
  const client = settings.client;

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [saved, setSaved] = useState<string[] | null>(null);

  useEffect(() => {
    setDraft({});
    setSaved(null);
  }, [guardrails?.version]);

  const dirty = useMemo(() => Object.keys(draft).length > 0, [draft]);

  if (!client || !guardrails) {
    return (
      <EmptyState
        title="No client configured"
        body="Settings appear once a client exists. Run the seed to create the worked example, or connect an ad account."
      />
    );
  }

  const setField = (key: string, raw: string) => {
    setDraft((d) => ({ ...d, [key]: raw }));
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const patch: Record<string, number> = {};
      for (const [key, raw] of Object.entries(draft)) {
        const spec = GROUPS.flatMap((g) => g.fields).find((f) => f.key === key);
        if (!spec) continue;
        const value = fromInput(raw, spec.kind);
        if (!Number.isFinite(value)) {
          setError({ message: `${spec.label} is not a number`, field: key });
          setSaving(false);
          return;
        }
        patch[key] = value;
      }
      const result = await saveGuardrails(patch);
      setSaved(result.changed.map((c) => c.field));
      setDraft({});
      await onSaved();
    } catch (e) {
      const err = e as Error & { field?: string };
      setError({ message: err.message, ...(err.field ? { field: err.field } : {}) });
    } finally {
      setSaving(false);
    }
  };

  const toggleClient = async (body: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    try {
      await saveClientSettings(body);
      await onSaved();
    } catch (e) {
      setError({ message: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div variants={list} initial="hidden" animate="show">
      {/* --- autonomy ------------------------------------------------------ */}
      <motion.div variants={item}>
        <div className="section-title">Autonomy</div>
        <div className="card">
          <p style={{ marginTop: 0, color: 'var(--ink-2)', fontSize: 13 }}>
            What the system may do without asking. Stopping an ad forgoes a little opportunity;
            raising a budget spends real money — which is why they are separate switches.
          </p>
          <div className="toggle-grid">
            <Toggle
              label="Stop ads automatically"
              value={client.autonomousKillEnabled}
              disabled={saving}
              onChange={(v) => void toggleClient({ autonomousKillEnabled: v })}
              note="Worst case is a stopped ad that might have recovered."
            />
            <Toggle
              label="Raise budgets automatically"
              value={client.autonomousScaleEnabled}
              disabled={saving}
              onChange={(v) => void toggleClient({ autonomousScaleEnabled: v })}
              note="Worst case is money spent on something that stops working."
            />
            <Toggle
              label="Test variations automatically"
              value={client.autonomousMutateEnabled}
              disabled={saving}
              onChange={(v) => void toggleClient({ autonomousMutateEnabled: v })}
              note="Launches a new ad at the variation test budget."
            />
          </div>

          <div className="pause-row">
            <div>
              <div className="metric-label">Automation</div>
              <div style={{ fontSize: 13, color: 'var(--ink-2)', marginTop: 2 }}>
                {client.automationPausedAt
                  ? 'Paused — the system still gathers data and forms opinions, but changes nothing.'
                  : 'Running — the system acts within the limits below.'}
              </div>
            </div>
            <button
              className={client.automationPausedAt ? 'btn btn--primary' : 'btn btn--danger'}
              disabled={saving}
              onClick={() => void toggleClient({ automationPaused: !client.automationPausedAt })}
            >
              {client.automationPausedAt ? 'Resume automation' : 'Pause automation'}
            </button>
          </div>

          {!settings.executionEnabled ? (
            <div className="notice">
              The deployment-level switch <code>EXECUTION_ENABLED</code> is off, so nothing will
              execute regardless of these settings. That switch is deliberately not changeable
              from here — a global stop should need access to the deployment.
            </div>
          ) : null}
        </div>
      </motion.div>

      {/* --- target -------------------------------------------------------- */}
      <motion.div variants={item}>
        <div className="section-title">Target</div>
        <div className="card">
          <div className="field-row">
            <div className="field-label">
              <label htmlFor="targetCpa">
                {client.objectiveType === 'CPA' ? 'Target cost per conversion' : 'Target return on ad spend'}
              </label>
              <div className="field-help">
                Every decision is measured against this. Changing it re-frames what counts as a
                winner on the next cycle.
              </div>
            </div>
            <div className="field-input">
              <span className="field-prefix">$</span>
              <input
                id="targetCpa"
                type="number"
                step="0.01"
                min="0.01"
                defaultValue={((client.targetCpaCents ?? 0) / 100).toFixed(2)}
                onBlur={(e) => {
                  const cents = Math.round(Number(e.target.value) * 100);
                  if (cents > 0 && cents !== client.targetCpaCents) {
                    void toggleClient({ targetCpaCents: cents });
                  }
                }}
              />
            </div>
          </div>
        </div>
      </motion.div>

      {/* --- guardrails ---------------------------------------------------- */}
      {GROUPS.map((group) => (
        <motion.div variants={item} key={group.title}>
          <div className="section-title">{group.title}</div>
          <div className="card">
            <p style={{ marginTop: 0, color: 'var(--ink-3)', fontSize: 12.5 }}>{group.intent}</p>
            {group.fields.map((f) => {
              const current = guardrails[f.key];
              const value = draft[f.key] ?? toInput(current, f.kind);
              const changed = draft[f.key] !== undefined;
              return (
                <div className={`field-row${changed ? ' field-row--changed' : ''}`} key={f.key}>
                  <div className="field-label">
                    <label htmlFor={f.key}>{f.label}</label>
                    <div className="field-help">{f.help}</div>
                    {error?.field === f.key ? <div className="field-error">{error.message}</div> : null}
                  </div>
                  <div className="field-input">
                    {f.kind === 'money' ? <span className="field-prefix">$</span> : null}
                    <input
                      id={f.key}
                      type="number"
                      step={f.kind === 'probability' ? '0.001' : f.kind === 'decimal' ? '0.01' : f.kind === 'money' ? '0.01' : '1'}
                      value={value}
                      onChange={(e) => setField(f.key, e.target.value)}
                      aria-invalid={error?.field === f.key}
                    />
                    {f.kind === 'percent' ? <span className="field-suffix">%</span> : null}
                  </div>
                </div>
              );
            })}
          </div>
        </motion.div>
      ))}

      {error && !error.field ? <div className="error" style={{ marginTop: 16 }}>{error.message}</div> : null}

      {saved ? (
        <div className="notice notice--good" style={{ marginTop: 16 }}>
          Saved as version {guardrails.version}. {saved.length} limit(s) changed. Past decisions
          remain interpretable against the version that was in force when they were made.
        </div>
      ) : null}

      {/* --- save bar ------------------------------------------------------- */}
      {dirty ? (
        <motion.div
          className="savebar"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          role="status"
        >
          <span>
            {Object.keys(draft).length} unsaved change(s). Saving creates version{' '}
            {guardrails.version + 1}.
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => setDraft({})} disabled={saving}>
              Discard
            </button>
            <button className="btn btn--primary" onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </span>
        </motion.div>
      ) : null}

      {/* --- history -------------------------------------------------------- */}
      <motion.div variants={item}>
        <div className="section-title">Change history</div>
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>In force from</th>
                <th>Until</th>
                <th>Changed by</th>
              </tr>
            </thead>
            <tbody>
              {settings.history.map((h) => (
                <tr key={h.id}>
                  <td>
                    v{h.version} {h.effectiveTo === null ? <Badge status="EXECUTED" /> : null}
                  </td>
                  <td>{new Date(h.effectiveFrom).toLocaleString()}</td>
                  <td>{h.effectiveTo ? new Date(h.effectiveTo).toLocaleString() : '—'}</td>
                  <td>{h.createdBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </motion.div>
    </motion.div>
  );
}

function Toggle({
  label,
  value,
  onChange,
  note,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  note: string;
  disabled: boolean;
}) {
  return (
    <button
      className={`toggle${value ? ' toggle--on' : ''}`}
      role="switch"
      aria-checked={value}
      disabled={disabled}
      onClick={() => onChange(!value)}
    >
      <span className="toggle-track" aria-hidden="true">
        <motion.span className="toggle-thumb" layout transition={{ duration: 0.18 }} />
      </span>
      <span className="toggle-body">
        <span className="toggle-label">{label}</span>
        <span className="toggle-note">{note}</span>
      </span>
    </button>
  );
}

export { money };
