import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'framer-motion';
import {
  count,
  money,
  percent,
  relativeTime,
  timeUntil,
  type Approval,
  type Decision,
  type GuardrailEvaluation,
  type Variant,
} from './api';

/* -------------------------------------------------------------------------
 * Motion is used to communicate a state change, never for decoration. Each
 * variant set below has a still fallback selected when the OS asks for
 * reduced motion.
 * ---------------------------------------------------------------------- */

/** Shared easing curve. Typed as a 4-tuple so Framer accepts it as a cubic bezier. */
export const EASE: [number, number, number, number] = [0.22, 0.61, 0.36, 1];

export function useMotionVariants() {
  const reduce = Boolean(useReducedMotion());
  const list: Variants = {
    hidden: {},
    show: { transition: { staggerChildren: reduce ? 0 : 0.045 } },
  };
  const item: Variants = reduce
    ? { hidden: { opacity: 0 }, show: { opacity: 1 } }
    : {
        hidden: { opacity: 0, y: 8 },
        show: { opacity: 1, y: 0, transition: { duration: 0.32, ease: EASE } },
      };
  const view = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, y: 6 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -6 },
      };
  return { reduce, list, item, view };
}

/* --- primitives ---------------------------------------------------------- */

const BADGE_CLASS: Record<string, string> = {
  TESTING: 'badge--testing',
  SCALING: 'badge--scaling',
  KILLED: 'badge--killed',
  PAUSED: 'badge--paused',
  EXECUTED: 'badge--executed',
  PENDING_APPROVAL: 'badge--pending',
  PENDING_EXECUTION: 'badge--pending',
  APPROVED: 'badge--executed',
  REJECTED: 'badge--killed',
  BLOCKED: 'badge--blocked',
  FAILED: 'badge--blocked',
  EXPIRED: 'badge--paused',
  NO_ACTION: 'badge--noaction',
  // Angle verdicts have their own vocabulary — reusing decision statuses here would label a
  // losing argument "refused", which means something entirely different.
  WINNER: 'badge--scaling',
  MIXED: 'badge--pending',
  LOSER: 'badge--killed',
  UNTESTED: 'badge--noaction',
};

const LABEL: Record<string, string> = {
  TESTING: 'Testing',
  SCALING: 'Scaling',
  KILLED: 'Stopped',
  PAUSED: 'Paused',
  EXECUTED: 'Done',
  PENDING_APPROVAL: 'Awaiting you',
  PENDING_EXECUTION: 'Queued',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  BLOCKED: 'Refused',
  FAILED: 'Failed',
  EXPIRED: 'Expired',
  NO_ACTION: 'No change',
  KILL: 'Stop',
  SCALE: 'Increase budget',
  MUTATE: 'Test a variation',
  WINNER: 'Working',
  MIXED: 'Mixed',
  LOSER: 'Not working',
  UNTESTED: 'No data yet',
};

export function Badge({ status }: { status: string }) {
  return (
    <span className={`badge ${BADGE_CLASS[status] ?? 'badge--noaction'}`}>
      {LABEL[status] ?? status.replace(/_/g, ' ').toLowerCase()}
    </span>
  );
}

export function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'good' | 'bad';
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${tone ? ` ${tone}` : ''}`}>{value}</div>
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}

export function Skeleton({ height = 16, width = '100%' }: { height?: number; width?: string }) {
  return <div className="skeleton" style={{ height, width }} aria-hidden="true" />;
}

export function LoadingCards({ label }: { label: string }) {
  return (
    <div className="card-grid" role="status" aria-live="polite">
      <span className="sr-only" style={{ position: 'absolute', left: -9999 }}>
        {label}
      </span>
      {[0, 1, 2].map((i) => (
        <div className="card" key={i}>
          <Skeleton height={18} width="46%" />
          <div style={{ height: 8 }} />
          <Skeleton height={13} width="72%" />
          <div style={{ height: 20 }} />
          <div style={{ display: 'flex', gap: 12 }}>
            {[0, 1, 2, 3].map((j) => (
              <Skeleton key={j} height={30} width="80px" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      <p className="empty-body">{body}</p>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="error">
      <div className="error-title">Couldn&rsquo;t load this</div>
      <p style={{ margin: '0 0 12px', fontSize: 13 }}>
        {error}. The engine keeps running regardless — this only affects what you can see here.
      </p>
      <button className="btn" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/* --- variants ------------------------------------------------------------ */

export function VariantCard({ variant, targetCpaCents }: { variant: Variant; targetCpaCents: number | null }) {
  const beatsTarget =
    variant.cpaCents !== null && targetCpaCents !== null ? variant.cpaCents <= targetCpaCents : null;

  return (
    <motion.div className="card" layout>
      <div className="variant">
        <div>
          <div className="variant-headline">{variant.headline}</div>
          <div className="variant-body">{variant.primaryText}</div>
          <span className="variant-angle">{variant.angleTag.replace(/-/g, ' ')}</span>
        </div>
        <motion.div layout>
          <Badge status={variant.status} />
        </motion.div>
      </div>

      <div className="metrics">
        <Metric label="Spend" value={money(variant.spendCents)} />
        <Metric label="Conversions" value={count(variant.conversions)} />
        <Metric
          label="Cost / conv."
          value={money(variant.cpaCents)}
          tone={beatsTarget === null ? undefined : beatsTarget ? 'good' : 'bad'}
        />
        <Metric label="Click rate" value={percent(variant.ctr)} />
        <Metric label="Conv. rate" value={percent(variant.cvr)} />
        <Metric
          label="Daily budget"
          value={variant.adSetStatus === 'ACTIVE' ? money(variant.dailyBudgetCents) : '—'}
        />
      </div>
    </motion.div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div>
      <div className="metric-label">{label}</div>
      <div className={`metric-value${tone ? ` ${tone}` : ''}`}>{value}</div>
    </div>
  );
}

/* --- decisions ----------------------------------------------------------- */

export function DecisionRow({ decision }: { decision: Decision }) {
  const [open, setOpen] = useState(false);
  const { reduce } = useMotionVariants();

  return (
    <motion.div className="decision" layout>
      <button
        className="decision-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`detail-${decision.id}`}
      >
        <Badge status={decision.status} />
        <div>
          <div className="decision-reason">
            {decision.reasoning ?? `${LABEL[decision.decisionType] ?? decision.decisionType}`}
          </div>
          <div className="decision-meta">
            {decision.headline ? `${decision.headline} · ` : ''}
            {LABEL[decision.decisionType] ?? decision.decisionType} · {relativeTime(decision.decidedAt)}
            {decision.blockedByRule ? ` · refused by ${decision.blockedByRule}` : ''}
          </div>
        </div>
        <span className="chevron" aria-hidden="true">
          {open ? '▲' : '▼'}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id={`detail-${decision.id}`}
            className="decision-detail"
            initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduce ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduce ? 0.001 : 0.26, ease: EASE }}
          >
            <DecisionDetail decision={decision} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

function DecisionDetail({ decision }: { decision: Decision }) {
  const evidence = decision.statisticalEvidence ?? {};
  const action = decision.proposedAction ?? {};
  const rules = decision.guardrailEvaluations ?? [];
  const applicable = rules.filter((r) => r.applicable);
  const failed = applicable.filter((r) => !r.passed);

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div>
        <div className="metric-label">What it proposed</div>
        <dl className="kv" style={{ marginTop: 6 }}>
          {Object.entries(action).map(([key, value]) => (
            <Row key={key} label={humanise(key)} value={formatValue(key, value)} />
          ))}
        </dl>
      </div>

      <div>
        <div className="metric-label">Evidence it relied on</div>
        <dl className="kv" style={{ marginTop: 6 }}>
          <Row label="Reason" value={String(evidence.reasonCode ?? '—')} />
          <Row
            label="Confidence true CPA beats target"
            value={
              typeof evidence.probabilityMeetsCpaTarget === 'number'
                ? `${(evidence.probabilityMeetsCpaTarget * 100).toFixed(1)}%`
                : 'n/a (ROAS objective)'
            }
          />
          <Row label="Times assessed" value={String(evidence.evaluationsOutcome ?? 0)} />
          <Row label="Engine / ruleset" value={`${decision.engineVersion} / ${decision.rulesetVersion}`} />
        </dl>
      </div>

      <div>
        <div className="metric-label">
          Safety limits checked ({applicable.length} applied, {failed.length} failed)
        </div>
        <div className="rule-list">
          {applicable.map((rule) => (
            <RuleItem key={rule.rule} rule={rule} />
          ))}
          {applicable.length === 0 ? (
            <div className="rule-detail">No limits recorded for this entry.</div>
          ) : null}
        </div>
      </div>

      {decision.failureReason ? (
        <div>
          <div className="metric-label">Why it did not complete</div>
          <div style={{ fontSize: 12.5, color: 'var(--rust)', marginTop: 4 }}>
            {decision.failureReason}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RuleItem({ rule }: { rule: GuardrailEvaluation }) {
  return (
    <div className="rule-item">
      <span className={rule.passed ? 'rule-pass' : 'rule-fail'} aria-hidden="true">
        {rule.passed ? '✓' : '✕'}
      </span>
      <span className="rule-name">{rule.rule}</span>
      <span className="rule-detail">
        {rule.observed !== null && rule.limit !== null
          ? `${rule.observed} / ${rule.limit}`
          : rule.detail.length > 60
            ? `${rule.detail.slice(0, 60)}…`
            : rule.detail}
      </span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function humanise(key: string): string {
  return key
    .replace(/Cents$/, '')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function formatValue(key: string, value: unknown): string {
  if (typeof value === 'number' && /Cents$/.test(key)) return money(value);
  if (value === null || value === undefined) return '—';
  return String(value);
}

/* --- approvals ----------------------------------------------------------- */

export function ApprovalCard({
  approval,
  onRespond,
  busy,
}: {
  approval: Approval;
  onRespond: (id: string, action: 'approve' | 'reject') => void;
  busy: boolean;
}) {
  const action = approval.proposedAction ?? {};
  const from = typeof action.currentBudgetCents === 'number' ? action.currentBudgetCents : null;
  const to = typeof action.targetBudgetCents === 'number' ? action.targetBudgetCents : null;

  return (
    <motion.div className="card approval" layout>
      <div className="variant">
        <div>
          <div className="variant-headline">{approval.headline ?? 'Ad'}</div>
          <div className="variant-body">{approval.reasoning}</div>
        </div>
        <Badge status="PENDING_APPROVAL" />
      </div>

      {from !== null && to !== null ? (
        <div className="metrics">
          <Metric label="Budget now" value={money(from)} />
          <Metric label="Proposed" value={money(to)} tone="good" />
          <Metric
            label="Change"
            value={`+${(((to - from) / from) * 100).toFixed(1)}%`}
          />
          <Metric label="Expires" value={timeUntil(approval.expiresAt)} />
        </div>
      ) : null}

      <div className="actions">
        <button
          className="btn btn--primary"
          disabled={busy}
          onClick={() => onRespond(approval.id, 'approve')}
        >
          Approve
        </button>
        <button
          className="btn btn--danger"
          disabled={busy}
          onClick={() => onRespond(approval.id, 'reject')}
        >
          Reject
        </button>
      </div>
    </motion.div>
  );
}
