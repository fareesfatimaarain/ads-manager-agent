import { useState } from 'react';
import { motion } from 'framer-motion';
import { createWorkspace } from './governanceApi';
import { EASE } from './components';

const COMMON_TIMEZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Asia/Karachi', 'Asia/Dubai',
  'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney',
];

/**
 * The very first screen a fresh deployment shows. Nothing else in the product works before
 * this: there is no client to onboard a brand for, no guardrails to evaluate against, no ad
 * account to launch into. This creates all three with conservative starting limits, then
 * hands off to brand onboarding.
 */
export function SetupView({ onCreated }: { onCreated: () => void | Promise<void> }) {
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [currency, setCurrency] = useState('USD');
  const [objectiveType, setObjectiveType] = useState<'CPA' | 'ROAS'>('CPA');
  const [targetValue, setTargetValue] = useState('50.00');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!name.trim()) return setError('Give the business a name.');
    const target = Number(targetValue);
    if (!Number.isFinite(target) || target <= 0) {
      return setError(
        objectiveType === 'CPA'
          ? 'Target cost per conversion must be a positive amount.'
          : 'Target return on ad spend must be a positive number.',
      );
    }
    setSaving(true);
    try {
      await createWorkspace({ name: name.trim(), timezone, currency, objectiveType, targetValue: target });
      await onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: EASE }}
      style={{ maxWidth: 560, margin: '40px auto' }}
    >
      <div className="section-title">Set up this workspace</div>
      <div className="card">
        <p style={{ marginTop: 0, color: 'var(--ink-3)', fontSize: 13.5 }}>
          This deployment has no client yet. Everything else — brand onboarding, creative
          generation, launching, autonomous decisions — needs a client, a starting set of
          guardrails, and an ad account to exist first. This creates all three. The limits below
          are deliberately conservative; every one of them is editable in Settings once real
          numbers exist.
        </p>

        <div className="field-row">
          <div className="field-label"><label htmlFor="wsName">Business name</label></div>
          <div className="field-input">
            <input
              id="wsName"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Northwind Tools"
            />
          </div>
        </div>

        <div className="field-row">
          <div className="field-label">
            <label htmlFor="wsTz">Timezone</label>
            <div className="field-help">Stat days and the daily decision cycle are anchored to this.</div>
          </div>
          <div className="field-input">
            <select id="wsTz" className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {COMMON_TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="field-row">
          <div className="field-label">
            <label htmlFor="wsCurrency">Currency</label>
            <div className="field-help">3-letter code. Every budget and guardrail is denominated in this.</div>
          </div>
          <div className="field-input">
            <input
              id="wsCurrency"
              className="input"
              value={currency}
              maxLength={3}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </div>
        </div>

        <div className="field-row">
          <div className="field-label">
            <label htmlFor="wsObjective">Success is measured by</label>
            <div className="field-help">Every scale, kill, and mutate decision is judged against this.</div>
          </div>
          <div className="field-input">
            <select
              id="wsObjective"
              className="input"
              value={objectiveType}
              onChange={(e) => setObjectiveType(e.target.value as 'CPA' | 'ROAS')}
            >
              <option value="CPA">Cost per conversion (CPA)</option>
              <option value="ROAS">Return on ad spend (ROAS)</option>
            </select>
          </div>
        </div>

        <div className="field-row">
          <div className="field-label">
            <label htmlFor="wsTarget">
              {objectiveType === 'CPA' ? 'Target cost per conversion' : 'Target return on ad spend'}
            </label>
          </div>
          <div className="field-input">
            {objectiveType === 'CPA' ? <span className="field-prefix">$</span> : null}
            <input
              id="wsTarget"
              className="input"
              type="number"
              step="0.01"
              min="0.01"
              value={targetValue}
              onChange={(e) => setTargetValue(e.target.value)}
            />
            {objectiveType === 'ROAS' ? <span className="field-suffix">×</span> : null}
          </div>
        </div>

        {error ? <div className="notice notice--bad">{error}</div> : null}

        <div className="actions">
          <button className="btn btn--primary" disabled={saving} onClick={() => void submit()}>
            {saving ? 'Creating workspace…' : 'Create workspace'}
          </button>
        </div>
      </div>
    </motion.div>
  );
}
