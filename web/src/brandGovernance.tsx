import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  addComplianceRule,
  decideReview,
  deleteAsset,
  deleteComplianceRule,
  editReview,
  fetchBrand,
  fetchCompliance,
  fetchReviews,
  overrideTemplateRule,
  patchAsset,
  saveBrand,
  testCompliance,
  toggleComplianceRule,
  uploadAsset,
  type BrandResponse,
  type ComplianceResponse,
  type ComplianceVerdict,
  type ReviewItem,
  type ReviewsResponse,
} from './governanceApi';
import { AnswerEditor, renderAnswer } from './onboarding';
import { Badge, EmptyState, useMotionVariants } from './components';
import { CampaignsPanel } from './campaigns';

// ===========================================================================
// Brand memory
// ===========================================================================

export function BrandView({ onChanged }: { onChanged: () => void | Promise<void> }) {
  const { list, item } = useMotionVariants();
  const [data, setData] = useState<BrandResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [direction, setDirection] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await fetchBrand();
      setData(next);
      setDraft({});
      setDirection(next.profile?.creativeDirection ?? '');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return <EmptyState title="Loading brand" body="One moment." />;
  if (!data.profile) {
    return (
      <EmptyState
        title="No brand profile yet"
        body="Run brand onboarding first. Until a brand exists, generation has nothing to constrain itself with — and the system will refuse to generate rather than invent a brand for you."
      />
    );
  }

  const profile = data.profile;
  const dirty = Object.keys(draft).length > 0 || direction !== (profile.creativeDirection ?? '');

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const core: Record<string, unknown> = {};
      const industry: Record<string, unknown> = { ...profile.industry };
      for (const [id, value] of Object.entries(draft)) {
        const q = data.questions.find((x) => x.id === id);
        if (!q) continue;
        const [scope, field] = q.mapsTo.split('.');
        if (scope === 'core') core[field!] = value;
        else industry[field!] = value;
      }
      const result = await saveBrand({ core, industry, creativeDirection: direction });
      setSaved(profile.version + 1);
      await load();
      await onChanged();
      return result;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const toggleLock = async (element: string) => {
    setBusy(true);
    try {
      await saveBrand({ locks: { ...profile.locks, [element]: !profile.locks[element] } });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const currentValue = (questionId: string, mapsTo: string): unknown => {
    if (questionId in draft) return draft[questionId];
    const [scope, field] = mapsTo.split('.');
    return scope === 'core' ? profile.core[field!] : profile.industry[field!];
  };

  const coreQuestions = data.questions.filter((q) => q.mapsTo.startsWith('core.'));
  const industryQuestions = data.questions.filter((q) => q.mapsTo.startsWith('industry.'));

  return (
    <motion.div variants={list} initial="hidden" animate="show">
      <motion.div variants={item}>
        <div className="section-title">Brand memory — v{profile.version}</div>
        <div className="card">
          <p style={{ marginTop: 0, fontSize: 13, color: 'var(--ink-2)' }}>
            Every ad is generated against this. Editing creates a new version rather than
            overwriting, so creative made last month stays interpretable against the brand as it
            stood then. Industry: <strong>{data.industry?.label}</strong>.
          </p>

          <div className="field-row">
            <div className="field-label">
              <label htmlFor="direction">Standing creative direction</label>
              <div className="field-help">
                Applies to every campaign until you change it. Per-campaign direction goes on the
                campaign instead.
              </div>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <textarea
                id="direction"
                className="input"
                rows={3}
                value={direction ?? ''}
                onChange={(e) => setDirection(e.target.value)}
              />
            </div>
          </div>
        </div>
      </motion.div>

      <motion.div variants={item}>
        <div className="section-title">Locked elements</div>
        <div className="card">
          <p style={{ marginTop: 0, fontSize: 13, color: 'var(--ink-2)' }}>
            A locked element is used exactly as stored and never reinterpreted by generation. This
            is the override that outranks autonomy.
          </p>
          <div className="lock-grid">
            {['logo', 'palette', 'fonts', 'brandName', 'requiredDisclaimers'].map((element) => (
              <button
                key={element}
                className={`lock${profile.locks[element] ? ' lock--on' : ''}`}
                disabled={busy}
                aria-pressed={Boolean(profile.locks[element])}
                onClick={() => void toggleLock(element)}
              >
                <span className="lock-icon" aria-hidden="true">
                  {profile.locks[element] ? '🔒' : '🔓'}
                </span>
                <span>{element}</span>
              </button>
            ))}
          </div>
        </div>
      </motion.div>

      {[
        { title: 'Brand identity', questions: coreQuestions },
        { title: `${data.industry?.label ?? 'Industry'} details`, questions: industryQuestions },
      ].map((group) =>
        group.questions.length === 0 ? null : (
          <motion.div variants={item} key={group.title}>
            <div className="section-title">{group.title}</div>
            <div className="card">
              {group.questions.map((q) => (
                <div className="field-row field-row--stack" key={q.id}>
                  <div className="field-label">
                    <label>{q.prompt}</label>
                    {q.help ? <div className="field-help">{q.help}</div> : null}
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <AnswerEditor
                      question={q}
                      value={currentValue(q.id, q.mapsTo)}
                      onChange={(v) => setDraft((d) => ({ ...d, [q.id]: v }))}
                      disabled={busy}
                    />
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        ),
      )}

      <motion.div variants={item}>
        <ReferenceAssets assets={data.referenceAssets} onChanged={load} />
      </motion.div>

      <motion.div variants={item}>
        <div className="section-title">Version history</div>
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Industry</th>
                <th>From</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {data.history.map((h) => (
                <tr key={h.id}>
                  <td>
                    v{h.version} {h.effectiveTo === null ? <Badge status="EXECUTED" /> : null}
                  </td>
                  <td>{h.industryKey}</td>
                  <td>{new Date(h.effectiveFrom).toLocaleString()}</td>
                  <td className="mono">{h.sourceKind}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </motion.div>

      {error ? <div className="notice notice--bad">{error}</div> : null}
      {saved ? (
        <div className="notice notice--good">Saved as version {saved}.</div>
      ) : null}

      {dirty ? (
        <motion.div className="savebar" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <span>Unsaved changes. Saving creates version {profile.version + 1}.</span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => void load()} disabled={busy}>
              Discard
            </button>
            <button className="btn btn--primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save brand'}
            </button>
          </span>
        </motion.div>
      ) : null}
    </motion.div>
  );
}

const ASSET_KINDS = ['LOGO', 'PAST_AD', 'POSTER', 'BRAND_VIDEO', 'STYLE_GUIDE', 'BRAND_DOCUMENT', 'OTHER'];

function ReferenceAssets({
  assets,
  onChanged,
}: {
  assets: BrandResponse['referenceAssets'];
  onChanged: () => void | Promise<void>;
}) {
  const [kind, setKind] = useState('PAST_AD');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      await uploadAsset(file, kind, note);
      setNote('');
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="section-title">Reference material</div>
      <div className="card">
        <p style={{ marginTop: 0, fontSize: 13, color: 'var(--ink-2)' }}>
          Logos, past ads, posters, style guides, brand videos. Active items ground generation so
          new work resembles your existing work rather than a generic house style.
        </p>

        <div className="upload-row">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            {ASSET_KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace(/_/g, ' ').toLowerCase()}
              </option>
            ))}
          </select>
          <input
            className="input"
            placeholder="How should this influence generation? (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <input
            type="file"
            className="file-input"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = '';
            }}
          />
        </div>

        {error ? <div className="notice notice--bad">{error}</div> : null}

        {assets.length === 0 ? (
          <p style={{ color: 'var(--ink-3)', fontSize: 13 }}>Nothing uploaded yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Kind</th>
                <th>Text read</th>
                <th>Active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => (
                <tr key={a.id}>
                  <td>
                    <a href={`/api/assets/${a.id}/content`} target="_blank" rel="noreferrer">
                      {a.filename}
                    </a>
                    {a.usageNote ? (
                      <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>{a.usageNote}</div>
                    ) : null}
                  </td>
                  <td className="mono">{a.kind}</td>
                  <td>{a.hasText ? 'yes' : 'no'}</td>
                  <td>
                    <button
                      className="linkish"
                      onClick={() => void patchAsset(a.id, { active: !a.active }).then(onChanged)}
                    >
                      {a.active ? 'active' : 'inactive'}
                    </button>
                  </td>
                  <td>
                    <button
                      className="linkish linkish--danger"
                      onClick={() => void deleteAsset(a.id).then(onChanged)}
                    >
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ===========================================================================
// Compliance
// ===========================================================================

export function ComplianceView() {
  const { list, item } = useMotionVariants();
  const [data, setData] = useState<ComplianceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await fetchCompliance());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return <EmptyState title="Loading compliance" body="One moment." />;

  const disabled = new Set(data.overrides.filter((o) => o.disabled).map((o) => o.templateRuleId));
  const templateRules = data.effectiveRules.filter((r) => r.origin === 'TEMPLATE');
  const customRules = data.effectiveRules.filter((r) => r.origin === 'CUSTOM');
  // Brand rules are compiled from the brand profile rather than written here, so they get their
  // own section — showing them alongside editable rules would imply they can be edited here.
  const brandDerived = data.effectiveRules.filter((r) => r.origin === 'BRAND');

  const attemptDisable = async (ruleId: string, next: boolean) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await overrideTemplateRule(ruleId, next);
      await load();
      setNotice(next ? 'Rule switched off.' : 'Rule switched back on.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div variants={list} initial="hidden" animate="show">
      <motion.div variants={item}>
        <div className="section-title">Rules in force</div>
        <div className="card">
          <p style={{ marginTop: 0, fontSize: 13, color: 'var(--ink-2)' }}>
            {data.industry?.label ?? 'Generic'} rules, layered{' '}
            <span className="mono">{data.templateChain.join(' → ')}</span>. Every generated ad is
            checked against these before anyone sees it. A <strong>block</strong> cannot be
            approved; a <strong>flag</strong> reaches you with the reason attached.
          </p>
          {data.refusedDisables.length > 0 ? (
            <div className="notice notice--bad">
              {data.refusedDisables.length} switch-off request(s) were refused because those rules
              are mandatory for this industry.
            </div>
          ) : null}
        </div>
      </motion.div>

      {notice ? <div className="notice notice--good">{notice}</div> : null}
      {error ? <div className="notice notice--bad">{error}</div> : null}

      <motion.div variants={item}>
        <div className="section-title">From your industry template</div>
        <div className="card-grid">
          {templateRules.map((rule) => (
            <div className="card rule-card" key={rule.id}>
              <div className="variant">
                <div>
                  <div className="variant-headline">{rule.title}</div>
                  <div className="variant-body">{rule.reason}</div>
                  <div className="rule-meta">
                    <span className="mono">{rule.id}</span> · applies to{' '}
                    {rule.appliesTo.join(', ')} · {rule.match.kind.replace(/_/g, ' ').toLowerCase()}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                  <Badge status={rule.severity === 'BLOCK' ? 'BLOCKED' : 'PENDING_APPROVAL'} />
                  {rule.mandatory ? <span className="pill pill--locked">mandatory</span> : null}
                </div>
              </div>
              <div className="actions">
                {rule.mandatory ? (
                  <span className="rule-locked-note">
                    Mandatory for {data.industry?.label ?? 'this industry'} — cannot be switched
                    off. You can add stricter rules on top.
                  </span>
                ) : (
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => void attemptDisable(rule.id, !disabled.has(rule.id))}
                  >
                    {disabled.has(rule.id) ? 'Switch back on' : 'Switch off'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </motion.div>

      {brandDerived.length > 0 ? (
        <motion.div variants={item}>
          <div className="section-title">From your brand guidelines</div>
          <div className="card">
            <p style={{ marginTop: 0, fontSize: 13, color: 'var(--ink-2)' }}>
              These are compiled automatically from the banned words and required disclaimers on
              your brand profile — they are enforced on every generated ad, not merely requested
              of the writer. Change them on the <strong>Brand</strong> tab.
            </p>
            {brandDerived.map((rule) => (
              <div className="answered-row" key={rule.id}>
                <span className="answered-id">{rule.id}</span>
                <span className="answered-value">{rule.reason}</span>
                <Badge status="BLOCKED" />
              </div>
            ))}
          </div>
        </motion.div>
      ) : null}

      <motion.div variants={item}>
        <div className="section-title">Your own rules</div>
        {customRules.length === 0 ? (
          <EmptyState
            title="No custom rules"
            body="Add restricted terms, required disclosures, or claim restrictions specific to your brand. They sit on top of the industry template."
          />
        ) : (
          <div className="card-grid">
            {customRules.map((rule) => (
              <div className="card rule-card" key={rule.id}>
                <div className="variant">
                  <div>
                    <div className="variant-headline">{rule.title}</div>
                    <div className="variant-body">{rule.reason}</div>
                    <div className="rule-meta">
                      <span className="mono">{rule.id}</span> · {rule.appliesTo.join(', ')}
                    </div>
                  </div>
                  <Badge status={rule.severity === 'BLOCK' ? 'BLOCKED' : 'PENDING_APPROVAL'} />
                </div>
                <div className="actions">
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => void toggleComplianceRule(rule.id, false).then(load)}
                  >
                    Disable
                  </button>
                  <button
                    className="btn btn--danger"
                    disabled={busy}
                    onClick={() => void deleteComplianceRule(rule.id).then(load)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </motion.div>

      <motion.div variants={item}>
        <AddRuleForm onAdded={load} />
      </motion.div>

      <motion.div variants={item}>
        <RuleTester />
      </motion.div>
    </motion.div>
  );
}

/**
 * A rule id is a stable key the compliance engine matches on, but it is not something a
 * marketer should have to invent. It is derived from the title instead, so the only way to
 * get a malformed or colliding key is to write two rules with the same name — which the
 * server refuses with an explanation.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function AddRuleForm({ onAdded }: { onAdded: () => void | Promise<void> }) {
  const [title, setTitle] = useState('');
  const [reason, setReason] = useState('');
  const [severity, setSeverity] = useState<'BLOCK' | 'FLAG'>('FLAG');
  const [kind, setKind] = useState<'FORBID_TERMS' | 'REQUIRE_ONE_OF'>('FORBID_TERMS');
  const [terms, setTerms] = useState('');
  const [fields, setFields] = useState<string[]>(['headline', 'primaryText']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const id = slugify(title);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await addComplianceRule({
        id,
        title: title.trim(),
        severity,
        reason: reason.trim(),
        appliesTo: fields,
        match: { kind, terms: terms.split(',').map((t) => t.trim()).filter(Boolean) },
      });
      setTitle(''); setReason(''); setTerms('');
      await onAdded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="section-title">Add a rule</div>
      <div className="card">
        <div className="rule-form">
          <label style={{ gridColumn: '1 / -1' }}>
            <span className="metric-label">Rule name</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="No slang" />
            {id ? <div className="rule-meta">Saved as <code>{id}</code></div> : null}
          </label>
          <label>
            <span className="metric-label">Kind</span>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as 'FORBID_TERMS')}>
              <option value="FORBID_TERMS">Forbid these terms</option>
              <option value="REQUIRE_ONE_OF">Require one of these</option>
            </select>
          </label>
          <label>
            <span className="metric-label">Severity</span>
            <select className="input" value={severity} onChange={(e) => setSeverity(e.target.value as 'BLOCK')}>
              <option value="FLAG">Flag for review</option>
              <option value="BLOCK">Block outright</option>
            </select>
          </label>
          <label style={{ gridColumn: '1 / -1' }}>
            <span className="metric-label">Terms, comma separated</span>
            <input className="input" value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="gonna, wanna" />
          </label>
          <label style={{ gridColumn: '1 / -1' }}>
            <span className="metric-label">Why — shown to whoever reviews the ad</span>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div style={{ gridColumn: '1 / -1' }}>
            <span className="metric-label">Applies to</span>
            <div className="chip-row" style={{ marginTop: 6 }}>
              {['headline', 'primaryText', 'cta', 'imageConcept'].map((f) => (
                <button
                  key={f}
                  className={`chip chip--toggle${fields.includes(f) ? ' chip--on' : ''}`}
                  onClick={() =>
                    setFields((prev) => (prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]))
                  }
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
        </div>
        {error ? <div className="notice notice--bad">{error}</div> : null}
        <div className="actions">
          <button
            className="btn btn--primary"
            disabled={busy || !id || !reason.trim() || !terms.trim() || fields.length === 0}
            onClick={() => void submit()}
          >
            {busy ? 'Adding…' : 'Add rule'}
          </button>
        </div>
      </div>
    </>
  );
}

function RuleTester() {
  const [headline, setHeadline] = useState('');
  const [primaryText, setPrimaryText] = useState('');
  const [verdict, setVerdict] = useState<ComplianceVerdict | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <>
      <div className="section-title">Try it</div>
      <div className="card">
        <p style={{ marginTop: 0, fontSize: 13, color: 'var(--ink-2)' }}>
          Paste ad copy to see exactly what the rules would say about it. Nothing is saved.
        </p>
        <input className="input" placeholder="Headline" value={headline} onChange={(e) => setHeadline(e.target.value)} />
        <textarea
          className="input"
          rows={3}
          placeholder="Body copy"
          style={{ marginTop: 8 }}
          value={primaryText}
          onChange={(e) => setPrimaryText(e.target.value)}
        />
        <div className="actions">
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void testCompliance({ headline, primaryText, cta: 'Learn more' })
                .then(setVerdict)
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Checking…' : 'Check it'}
          </button>
        </div>
        {verdict ? (
          <div style={{ marginTop: 12 }}>
            <div className={`notice ${verdict.blocked ? 'notice--bad' : verdict.findings.length ? '' : 'notice--good'}`}>
              {verdict.blocked
                ? 'This would be blocked and could not be approved.'
                : verdict.findings.length > 0
                  ? 'This would reach review with warnings attached.'
                  : `Clean against all ${verdict.rulesApplied} rules.`}
            </div>
            <FindingList findings={verdict.findings} />
          </div>
        ) : null}
      </div>
    </>
  );
}

export function FindingList({ findings }: { findings: ComplianceVerdict['findings'] }) {
  if (findings.length === 0) return null;
  return (
    <div className="finding-list">
      {findings.map((f, i) => (
        <div className={`finding finding--${f.severity.toLowerCase()}`} key={`${f.ruleId}-${f.field}-${i}`}>
          <div className="finding-head">
            <Badge status={f.severity === 'BLOCK' ? 'BLOCKED' : 'PENDING_APPROVAL'} />
            <strong>{f.title}</strong>
            <span className="finding-field">{f.field}</span>
          </div>
          <div className="finding-reason">{f.reason}</div>
          {f.matched ? (
            <div className="finding-matched">
              triggered by <span className="mono">“{f.matched}”</span>
            </div>
          ) : null}
          <div className="finding-origin">
            {f.origin === 'TEMPLATE'
              ? `${f.sourceTemplate} template`
              : f.origin === 'BRAND'
                ? 'your brand guidelines'
                : 'your rule'}{' '}
            ·{' '}
            <span className="mono">{f.ruleId}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ===========================================================================
// Review queue
// ===========================================================================

export function ReviewQueueView() {
  const { list, item } = useMotionVariants();
  const [data, setData] = useState<ReviewsResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('PENDING_REVIEW');

  const load = useCallback(async () => {
    try {
      setData(await fetchReviews(filter === 'ALL' ? undefined : filter));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return <EmptyState title="Loading review queue" body="One moment." />;

  const counts = data.counts;

  return (
    <motion.div variants={list} initial="hidden" animate="show">
      <motion.div variants={item}>
        {error ? <div className="notice notice--bad" style={{ marginBottom: 16 }}>{error}</div> : null}
        <CampaignsPanel reviews={data.reviews} onChanged={load} busy={busy} setBusy={setBusy} />
      </motion.div>

      <motion.div variants={item}>
        <div className="filter-row">
          {['PENDING_REVIEW', 'BLOCKED', 'EDITED', 'APPROVED', 'REJECTED', 'ALL'].map((s) => (
            <button
              key={s}
              className={`chip chip--toggle${filter === s ? ' chip--on' : ''}`}
              onClick={() => setFilter(s)}
            >
              {s.replace(/_/g, ' ').toLowerCase()}
              {counts[s] !== undefined ? <span className="chip-count">{counts[s]}</span> : null}
            </button>
          ))}
        </div>
      </motion.div>

      {data.reviews.length === 0 ? (
        <EmptyState
          title="Nothing here"
          body="No creative in this state. Generate a batch to see the compliance layer at work."
        />
      ) : (
        <div className="card-grid">
          {data.reviews.map((review) => (
            <motion.div variants={item} key={review.id}>
              <ReviewCard review={review} onChanged={load} busy={busy} setBusy={setBusy} />
            </motion.div>
          ))}
        </div>
      )}
    </motion.div>
  );
}

function ReviewCard({
  review,
  onChanged,
  busy,
  setBusy,
}: {
  review: ReviewItem;
  onChanged: () => void | Promise<void>;
  busy: string | null;
  setBusy: (v: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [headline, setHeadline] = useState(review.headline);
  const [primaryText, setPrimaryText] = useState(review.primaryText);
  const [cta, setCta] = useState(review.cta);
  const [error, setError] = useState<string | null>(null);

  const verdict = review.complianceVerdict;
  const isBusy = busy === review.id;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(review.id);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={`card review-card${review.complianceBlocked ? ' review-card--blocked' : ''}`}>
      <div className="variant">
        <div style={{ flex: 1 }}>
          {editing ? (
            <>
              <input className="input" value={headline} onChange={(e) => setHeadline(e.target.value)} />
              <textarea
                className="input"
                rows={3}
                style={{ marginTop: 8 }}
                value={primaryText}
                onChange={(e) => setPrimaryText(e.target.value)}
              />
              <input className="input" style={{ marginTop: 8 }} value={cta} onChange={(e) => setCta(e.target.value)} />
            </>
          ) : (
            <>
              <div className="variant-headline">{review.headline}</div>
              <div className="variant-body">{review.primaryText}</div>
              <span className="variant-angle">{review.cta}</span>{' '}
              <span className="variant-angle">{review.angleTag.replace(/-/g, ' ')}</span>
            </>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
          <Badge status={review.status} />
          {review.imageUrl ? (
            <img className="review-thumb" src={review.imageUrl} alt="" loading="lazy" />
          ) : null}
        </div>
      </div>

      {review.generationReasoning && !editing ? (
        <p className="reasoning">{review.generationReasoning}</p>
      ) : null}

      {verdict?.findings?.length ? (
        <FindingList findings={verdict.findings} />
      ) : (
        <div className="notice notice--good" style={{ marginTop: 10 }}>
          Clean against all {verdict?.rulesApplied ?? 0} rules in force.
        </div>
      )}

      {error ? <div className="notice notice--bad">{error}</div> : null}

      <div className="actions">
        {editing ? (
          <>
            <button
              className="btn btn--primary"
              disabled={isBusy}
              onClick={() =>
                void act(async () => {
                  const r = await editReview(review.id, { headline, primaryText, cta });
                  setEditing(false);
                  if (r.blocked) setError('Still blocked after your edit — see the reasons above.');
                })
              }
            >
              {isBusy ? 'Re-checking…' : 'Save and re-check'}
            </button>
            <button className="btn" disabled={isBusy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            {review.status !== 'APPROVED' && review.status !== 'REJECTED' ? (
              <>
                <button
                  className="btn btn--primary"
                  disabled={isBusy || review.complianceBlocked}
                  title={
                    review.complianceBlocked
                      ? 'Blocked by a compliance rule — edit the copy to resolve it'
                      : undefined
                  }
                  onClick={() => void act(() => decideReview(review.id, 'approve'))}
                >
                  Approve
                </button>
                <button className="btn" disabled={isBusy} onClick={() => setEditing(true)}>
                  Edit
                </button>
                <button
                  className="btn btn--danger"
                  disabled={isBusy}
                  onClick={() => void act(() => decideReview(review.id, 'reject'))}
                >
                  Reject
                </button>
              </>
            ) : (
              <span className="rule-locked-note">
                {review.status === 'APPROVED' ? 'Approved and ready to launch.' : 'Rejected.'}
                {review.rejectionReason ? ` ${review.rejectionReason}` : ''}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export { renderAnswer };
