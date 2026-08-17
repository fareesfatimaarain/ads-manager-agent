import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  acknowledgeDeadLetter,
  count,
  money,
  relativeTime,
  runCycle,
  runIngest,
  type CreativeLibrary,
  type CycleResult,
  type Operations,
} from './api';
import { Badge, EmptyState, Stat, useMotionVariants } from './components';

export function OperationsView({
  operations,
  onChanged,
}: {
  operations: Operations;
  onChanged: () => void | Promise<void>;
}) {
  const { list, item } = useMotionVariants();
  const [busy, setBusy] = useState<string | null>(null);
  const [lastCycle, setLastCycle] = useState<CycleResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const spend = operations.spendToday;
  const usedPct =
    spend && spend.capCents && spend.capCents > 0
      ? Math.min(100, (spend.committedCents / spend.capCents) * 100)
      : 0;

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    setMessage(null);
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
    <motion.div variants={list} initial="hidden" animate="show">
      <motion.div variants={item}>
        <div className="stat-row">
          <Stat
            label="Autonomous spend today"
            value={money(spend?.committedCents ?? 0)}
            note={spend?.capCents ? `of ${money(spend.capCents)} allowed` : undefined}
            tone={usedPct > 85 ? 'bad' : undefined}
          />
          <Stat
            label="Ad accounts"
            value={String(operations.accounts.length)}
            note={`${operations.accounts.filter((a) => a.status === 'ACTIVE').length} healthy`}
            tone={operations.accounts.some((a) => a.status !== 'ACTIVE') ? 'bad' : 'good'}
          />
          <Stat
            label="Needs a person"
            value={String(operations.deadLetters.length)}
            note="Actions that could not complete"
            tone={operations.deadLetters.length > 0 ? 'bad' : 'good'}
          />
          <Stat
            label="Execution"
            value={
              !operations.executionEnabled ? 'Halted' : operations.automationPaused ? 'Paused' : 'Live'
            }
            note={
              !operations.executionEnabled
                ? 'Deployment switch is off'
                : operations.automationPaused
                  ? 'Paused for this client'
                  : 'Acting within limits'
            }
            tone={operations.executionEnabled && !operations.automationPaused ? 'good' : 'bad'}
          />
        </div>
      </motion.div>

      {spend?.capCents ? (
        <motion.div variants={item}>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="metric-label">Daily spend headroom</div>
            <div
              className="meter"
              role="meter"
              aria-valuenow={Math.round(usedPct)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Autonomous spend committed today"
            >
              <motion.div
                className={`meter-fill${usedPct > 85 ? ' meter-fill--hot' : ''}`}
                initial={{ width: 0 }}
                animate={{ width: `${usedPct}%` }}
                transition={{ duration: 0.5, ease: [0.22, 0.61, 0.36, 1] }}
              />
            </div>
            <div className="meter-caption">
              {money(spend.committedCents)} committed of {money(spend.capCents)} — resets at
              midnight in the account timezone.
            </div>
          </div>
        </motion.div>
      ) : null}

      <motion.div variants={item}>
        <div className="section-title">Run now</div>
        <div className="card">
          <p style={{ marginTop: 0, fontSize: 13, color: 'var(--ink-2)' }}>
            The scheduler pulls performance every three hours and decides once a day. Running
            manually uses the same code path and the same limits — it only changes the timing.
          </p>
          <div className="actions">
            <button
              className="btn"
              disabled={busy !== null}
              onClick={() =>
                void act('ingest', async () => {
                  const r = await runIngest();
                  setMessage(
                    `Pulled ${r.rowsWritten} performance snapshot(s)${r.errors.length ? `, ${r.errors.length} error(s)` : ''}.`,
                  );
                })
              }
            >
              {busy === 'ingest' ? 'Pulling…' : 'Pull performance'}
            </button>
            <button
              className="btn btn--primary"
              disabled={busy !== null || !operations.executionEnabled}
              onClick={() =>
                void act('cycle', async () => {
                  const r = await runCycle();
                  setLastCycle(r);
                  setMessage(
                    `Cycle complete: ${r.cohortsEvaluated} test group(s) evaluated, ${r.decisions.length} decision(s).`,
                  );
                })
              }
            >
              {busy === 'cycle' ? 'Running…' : 'Run decision cycle'}
            </button>
          </div>

          {message ? <div className="notice notice--good">{message}</div> : null}
          {error ? <div className="notice notice--bad">{error}</div> : null}

          {lastCycle && lastCycle.errors.length > 0 ? (
            <div className="notice notice--bad">
              <strong>{lastCycle.errors.length} error(s) during the cycle.</strong> Other clients
              and test groups were unaffected — failures are isolated.
              <ul className="tight">
                {lastCycle.errors.slice(0, 5).map((e, i) => (
                  <li key={i}>
                    {e.scope} {e.id.slice(0, 8)}: {e.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </motion.div>

      <motion.div variants={item}>
        <div className="section-title">Ad accounts</div>
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Platform</th>
                <th>Status</th>
                <th>Last synced</th>
              </tr>
            </thead>
            <tbody>
              {operations.accounts.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.name}
                    <div style={{ color: 'var(--ink-3)', fontSize: 11.5 }}>
                      {a.currency} · {a.timezone}
                    </div>
                  </td>
                  <td>{a.platform}</td>
                  <td>
                    <Badge status={a.status === 'ACTIVE' ? 'EXECUTED' : 'BLOCKED'} />
                    {a.lastError ? (
                      <div style={{ color: 'var(--rust)', fontSize: 11.5, marginTop: 3 }}>
                        {a.lastError.slice(0, 80)}
                      </div>
                    ) : null}
                  </td>
                  <td>{relativeTime(a.lastSyncedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </motion.div>

      <motion.div variants={item}>
        <div className="section-title">Needs a person</div>
        {operations.deadLetters.length === 0 ? (
          <EmptyState
            title="Nothing is stuck"
            body="Actions that cannot be completed after retrying are set aside here rather than dropped. There are none."
          />
        ) : (
          <div className="card-grid">
            {operations.deadLetters.map((d) => (
              <div className="card" key={d.id}>
                <div className="variant">
                  <div>
                    <div className="variant-headline">{d.method}</div>
                    <div className="variant-body">{d.lastError ?? 'no error recorded'}</div>
                    <span className="variant-angle">
                      {d.attempts} attempt(s) · {relativeTime(d.createdAt)}
                    </span>
                  </div>
                  <Badge status="FAILED" />
                </div>
                <div className="actions">
                  <button
                    className="btn"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(`ack-${d.id}`, async () => {
                        await acknowledgeDeadLetter(d.id);
                        setMessage('Acknowledged. It will no longer appear here.');
                      })
                    }
                  >
                    Acknowledge
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </motion.div>

      <motion.div variants={item}>
        <div className="section-title">Recent cycles</div>
        <div className="card">
          {operations.recentCycles.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--ink-3)', fontSize: 13 }}>
              No cycles have run yet.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Cycle</th>
                  <th>When</th>
                  <th>Decisions</th>
                </tr>
              </thead>
              <tbody>
                {operations.recentCycles.map((c) => (
                  <tr key={c.cycleId}>
                    <td className="mono">{c.cycleId.slice(0, 8)}</td>
                    <td>{relativeTime(c.at)}</td>
                    <td>{count(c.decisions)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------

export function CreativeView({ library }: { library: CreativeLibrary }) {
  const { list, item } = useMotionVariants();

  if (library.variants.length === 0) {
    return (
      <EmptyState
        title="No creative yet"
        body="Ads appear here as they are generated, grouped by the argument they test — so you can see which arguments persuade your audience, not just which individual ads did well."
      />
    );
  }

  const byAngle = new Map<string, typeof library.variants>();
  for (const v of library.variants) {
    const existing = byAngle.get(v.angleTag) ?? [];
    existing.push(v);
    byAngle.set(v.angleTag, existing);
  }

  return (
    <motion.div variants={list} initial="hidden" animate="show">
      {library.brandKit ? (
        <motion.div variants={item}>
          <div className="section-title">Brand kit — v{library.brandKit.version}</div>
          <div className="card">
            <div className="swatches">
              {library.brandKit.palette.map((p) => (
                <div className="swatch" key={p.hex}>
                  <span className="swatch-chip" style={{ background: p.hex }} aria-hidden="true" />
                  <span className="swatch-label">
                    {p.name}
                    <span className="mono"> {p.hex}</span>
                  </span>
                </div>
              ))}
            </div>
            <div className="metrics">
              <div>
                <div className="metric-label">Tone</div>
                <div style={{ fontSize: 13 }}>{library.brandKit.tone}</div>
              </div>
              <div>
                <div className="metric-label">Banned words</div>
                <div style={{ fontSize: 13 }}>
                  {library.brandKit.bannedWords.length > 0
                    ? library.brandKit.bannedWords.join(', ')
                    : 'none'}
                </div>
              </div>
              <div>
                <div className="metric-label">Banned claims</div>
                <div style={{ fontSize: 13 }}>
                  {library.brandKit.bannedClaims.length > 0
                    ? `${library.brandKit.bannedClaims.length} defined`
                    : 'none'}
                </div>
              </div>
            </div>
            <p className="footnote" style={{ marginTop: 12 }}>
              These constraints are applied while the copy is written, not filtered afterwards —
              a banned claim that never gets written cannot slip past a filter that didn&rsquo;t
              anticipate its phrasing.
            </p>
          </div>
        </motion.div>
      ) : null}

      <motion.div variants={item}>
        <div className="section-title">What works — by argument</div>
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Angle</th>
                <th>Verdict</th>
                <th>Ads</th>
                <th>Spend</th>
                <th>Conversions</th>
                <th>Cost / conv.</th>
              </tr>
            </thead>
            <tbody>
              {library.angles.map((a) => (
                <tr key={a.angleTag}>
                  <td>{a.angleTag.replace(/-/g, ' ')}</td>
                  <td>
                    <Badge status={a.verdict} />
                  </td>
                  <td>{a.variantsTested}</td>
                  <td>{money(a.totalSpendCents)}</td>
                  <td>{count(a.totalConversions)}</td>
                  <td>{a.cpaCents === null ? '—' : money(a.cpaCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </motion.div>

      {[...byAngle.entries()].map(([angle, variants]) => (
        <motion.div variants={item} key={angle}>
          <div className="section-title">{angle.replace(/-/g, ' ')}</div>
          <div className="card-grid">
            {variants.map((v) => (
              <div className="card" key={v.id}>
                <div className="variant">
                  <div>
                    <div className="variant-headline">{v.headline}</div>
                    <div className="variant-body">{v.primaryText}</div>
                    <span className="variant-angle">{v.cta}</span>
                  </div>
                  <Badge status={v.status} />
                </div>
                {v.generationReasoning ? (
                  <p className="reasoning">{v.generationReasoning}</p>
                ) : null}
              </div>
            ))}
          </div>
        </motion.div>
      ))}
    </motion.div>
  );
}
