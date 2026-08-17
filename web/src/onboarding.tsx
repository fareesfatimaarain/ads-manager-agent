import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  answerIntake,
  completeIntake,
  fetchIntake,
  restartIntake,
  reviseIntake,
  uploadBrandDocument,
  type AnswerValue,
  type IntakeStep,
  type Question,
} from './governanceApi';
import { EASE, EmptyState, useMotionVariants } from './components';

/**
 * Chat-style brand onboarding.
 *
 * The question set comes entirely from the server, which builds it from templates — this
 * component renders whatever it is given and knows nothing about any particular industry.
 * Adding a vertical changes no code here.
 */
export function OnboardingView({ onCompleted }: { onCompleted: () => void | Promise<void> }) {
  const { reduce } = useMotionVariants();
  const [step, setStep] = useState<IntakeStep | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<unknown>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setStep(await fetchIntake());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Seed the editor with the pre-filled suggestion whenever the question changes.
  useEffect(() => {
    setDraft(step?.suggestedAnswer ?? null);
  }, [step?.question?.id, step?.suggestedAnswer]);

  const submit = async (value: unknown) => {
    if (!step?.question) return;
    setBusy(true);
    setError(null);
    try {
      setStep(await answerIntake(step.sessionId, step.question.id, value));
      setNotice(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revise = async (questionId: string) => {
    if (!step) return;
    setBusy(true);
    try {
      setStep(await reviseIntake(step.sessionId, questionId));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (!step) return;
    setBusy(true);
    setError(null);
    try {
      await completeIntake(step.sessionId);
      await onCompleted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const uploadDocument = async (file: File) => {
    if (!step) return;
    setBusy(true);
    setError(null);
    try {
      const result = await uploadBrandDocument(step.sessionId, file);
      setStep(result);
      const count = Object.keys(result.prefilled ?? {}).length;
      setNotice(
        result.readable
          ? count > 0
            ? `Read ${file.name} and suggested ${count} answer(s). Each one is shown for you to confirm or change — nothing was accepted automatically.`
            : `Read ${file.name}, but it did not clearly state anything we ask about.`
          : (result.message ?? 'Saved as reference material.'),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  if (error && !step) return <div className="error">{error}</div>;
  if (!step) return <EmptyState title="Loading onboarding" body="One moment." />;

  const progress = step.total > 0 ? Math.round((step.answered / step.total) * 100) : 0;

  return (
    <div className="onboarding">
      <div className="onboarding-head">
        <div>
          <h2 className="onboarding-title">Brand onboarding</h2>
          <p className="onboarding-sub">
            The system asks a universal set first, then follows up on whatever is specific to your
            industry. Answers become the brand memory every future ad is generated against.
          </p>
        </div>
        <button className="btn" onClick={() => void restartIntake().then(setStep)} disabled={busy}>
          Start over
        </button>
      </div>

      <div className="progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
        <motion.div
          className="progress-fill"
          initial={{ width: 0 }}
          animate={{ width: `${progress}%` }}
          transition={{ duration: reduce ? 0.001 : 0.4, ease: EASE }}
        />
      </div>
      <div className="progress-caption">
        {step.answered} of {step.total} answered
      </div>

      {notice ? <div className="notice notice--good">{notice}</div> : null}
      {error ? <div className="notice notice--bad">{error}</div> : null}

      <AnimatePresence mode="wait">
        {step.complete ? (
          <motion.div
            key="summary"
            initial={{ opacity: 0, y: reduce ? 0 : 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Ready to save</h3>
              <p style={{ color: 'var(--ink-2)', fontSize: 13 }}>
                Check this over. Saving creates the brand profile that every generated ad will be
                constrained by — you can edit it any time afterwards, and each edit is versioned.
              </p>
              <dl className="kv" style={{ marginTop: 16 }}>
                {(step.summary ?? []).map((row) => (
                  <div className="kv-row" key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
              <div className="actions">
                <button className="btn btn--primary" onClick={() => void finish()} disabled={busy}>
                  {busy ? 'Saving…' : 'Save brand profile'}
                </button>
              </div>
            </div>
          </motion.div>
        ) : step.question ? (
          <motion.div
            key={step.question.id}
            initial={{ opacity: 0, y: reduce ? 0 : 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduce ? 0 : -10 }}
            transition={{ duration: reduce ? 0.001 : 0.24, ease: EASE }}
          >
            <div className="card question-card">
              <h3 className="question-prompt">{step.question.prompt}</h3>
              {step.question.help ? <p className="question-help">{step.question.help}</p> : null}
              {step.suggestedAnswer !== null ? (
                <div className="notice">
                  Suggested from your uploaded document. Confirm it or change it — it has not been
                  saved.
                </div>
              ) : null}

              <AnswerEditor
                question={step.question}
                value={draft}
                onChange={setDraft}
                onSubmit={(v) => void submit(v)}
                disabled={busy}
              />

              <div className="actions">
                <button
                  className="btn btn--primary"
                  disabled={busy}
                  onClick={() => void submit(draft)}
                >
                  {busy ? 'Saving…' : 'Continue'}
                </button>
                {!step.question.required ? (
                  <button className="btn" disabled={busy} onClick={() => void submit(null)}>
                    Skip
                  </button>
                ) : null}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="metric-label">Have a brand guide?</div>
        <p style={{ fontSize: 13, color: 'var(--ink-2)', margin: '4px 0 12px' }}>
          Upload it and we will suggest answers from it. Plain text and Markdown can be read; other
          formats are kept as reference material for generation but not parsed.
        </p>
        <input
          ref={fileRef}
          type="file"
          className="file-input"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void uploadDocument(file);
          }}
        />
      </div>

      {Object.keys(step.answers).length > 0 ? (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="metric-label">Answered so far</div>
          <div className="answered-list">
            {Object.entries(step.answers).map(([id, value]) => (
              <div className="answered-row" key={id}>
                <span className="answered-id">{id}</span>
                <span className="answered-value">{renderAnswer(value)}</span>
                <button className="linkish" disabled={busy} onClick={() => void revise(id)}>
                  change
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function renderAnswer(value: AnswerValue): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v : 'name' in v ? `${v.name} ${v.hex}` : String(v)))
      .join(', ');
  }
  if ('display' in value) return `${value.display} / ${value.body}`;
  return JSON.stringify(value);
}

/** Renders whichever editor the question's declared type calls for. */
export function AnswerEditor({
  question,
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  question: Question;
  value: unknown;
  onChange: (v: unknown) => void;
  onSubmit?: (v: unknown) => void;
  disabled?: boolean;
}) {
  switch (question.type) {
    case 'text':
      return (
        <input
          className="input"
          type="text"
          value={(value as string) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onSubmit) onSubmit((value as string) ?? '');
          }}
          autoFocus
        />
      );

    case 'long_text':
      return (
        <textarea
          className="input"
          rows={4}
          value={(value as string) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          autoFocus
        />
      );

    case 'number':
      return (
        <input
          className="input"
          type="number"
          value={(value as number | null) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );

    case 'single_select':
      return (
        <div className="choice-grid">
          {(question.options ?? []).map((opt) => (
            <button
              key={opt.value}
              className={`choice${value === opt.value ? ' choice--on' : ''}`}
              disabled={disabled}
              onClick={() => {
                onChange(opt.value);
                if (onSubmit) onSubmit(opt.value);
              }}
            >
              <span className="choice-label">{opt.label}</span>
              {opt.hint ? <span className="choice-hint">{opt.hint}</span> : null}
            </button>
          ))}
        </div>
      );

    case 'multi_select': {
      const selected = new Set((value as string[]) ?? []);
      return (
        <div className="choice-grid">
          {(question.options ?? []).map((opt) => (
            <button
              key={opt.value}
              className={`choice${selected.has(opt.value) ? ' choice--on' : ''}`}
              disabled={disabled}
              onClick={() => {
                const next = new Set(selected);
                if (next.has(opt.value)) next.delete(opt.value);
                else next.add(opt.value);
                onChange([...next]);
              }}
            >
              <span className="choice-label">{opt.label}</span>
              {opt.hint ? <span className="choice-hint">{opt.hint}</span> : null}
            </button>
          ))}
        </div>
      );
    }

    case 'multi_text':
      return <ListEditor value={(value as string[]) ?? []} onChange={onChange} disabled={disabled} />;

    case 'color_list':
      return (
        <ColorEditor
          value={(value as { name: string; hex: string }[]) ?? []}
          onChange={onChange}
          disabled={disabled}
        />
      );

    case 'font_pair': {
      const v = (value as { display?: string; body?: string }) ?? {};
      return (
        <div className="pair-grid">
          <label>
            <span className="metric-label">Display</span>
            <input
              className="input"
              value={v.display ?? ''}
              disabled={disabled}
              onChange={(e) => onChange({ ...v, display: e.target.value })}
            />
          </label>
          <label>
            <span className="metric-label">Body</span>
            <input
              className="input"
              value={v.body ?? ''}
              disabled={disabled}
              onChange={(e) => onChange({ ...v, body: e.target.value })}
            />
          </label>
        </div>
      );
    }
  }
}

function ListEditor({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
}) {
  const [entry, setEntry] = useState('');
  const add = () => {
    const trimmed = entry.trim();
    if (!trimmed) return;
    onChange([...value, trimmed]);
    setEntry('');
  };
  return (
    <div>
      <div className="chip-row">
        {value.map((item, i) => (
          <span className="chip" key={`${item}-${i}`}>
            {item}
            <button
              className="chip-x"
              disabled={disabled}
              aria-label={`Remove ${item}`}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="inline-add">
        <input
          className="input"
          value={entry}
          disabled={disabled}
          placeholder="Type and press Enter"
          onChange={(e) => setEntry(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button className="btn" onClick={add} disabled={disabled}>
          Add
        </button>
      </div>
    </div>
  );
}

function ColorEditor({
  value,
  onChange,
  disabled,
}: {
  value: { name: string; hex: string }[];
  onChange: (v: { name: string; hex: string }[]) => void;
  disabled?: boolean;
}) {
  const [name, setName] = useState('');
  const [hex, setHex] = useState('#1A1915');
  return (
    <div>
      <div className="swatches" style={{ marginBottom: 10 }}>
        {value.map((c, i) => (
          <div className="swatch" key={`${c.hex}-${i}`}>
            <span className="swatch-chip" style={{ background: c.hex }} aria-hidden="true" />
            <span className="swatch-label">
              {c.name} <span className="mono">{c.hex}</span>
            </span>
            <button
              className="chip-x"
              disabled={disabled}
              aria-label={`Remove ${c.name}`}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="inline-add">
        <input
          className="input"
          placeholder="Colour name"
          value={name}
          disabled={disabled}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="color"
          className="color-input"
          value={hex}
          disabled={disabled}
          onChange={(e) => setHex(e.target.value.toUpperCase())}
        />
        <button
          className="btn"
          disabled={disabled}
          onClick={() => {
            if (!name.trim()) return;
            onChange([...value, { name: name.trim(), hex: hex.toUpperCase() }]);
            setName('');
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}
