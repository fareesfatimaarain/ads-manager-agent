import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ApiError,
  compactMoney,
  count,
  fetchApprovals,
  fetchCreative,
  fetchDeadLetters,
  fetchDecisions,
  fetchMe,
  fetchOperations,
  fetchOverview,
  fetchSettings,
  logout,
  money,
  percent,
  respondToApproval,
  type Approval,
  type AuthUser,
  type CreativeLibrary,
  type DeadLetter,
  type Decision,
  type Operations,
  type Overview,
  type Settings,
} from './api';
import { SettingsView } from './settings';
import { CreativeView, OperationsView } from './operations';
import { OnboardingView } from './onboarding';
import { BrandView, ComplianceView, ReviewQueueView } from './brandGovernance';
import { SetupView } from './setup';
import { LoginView } from './login';
import { fetchBrand, type BrandResponse } from './governanceApi';
import {
  ApprovalCard,
  Badge,
  DecisionRow,
  EASE,
  EmptyState,
  ErrorState,
  LoadingCards,
  Stat,
  useMotionVariants,
  VariantCard,
} from './components';

type Tab =
  | 'overview' | 'brand' | 'review' | 'compliance'
  | 'creative' | 'decisions' | 'approvals' | 'operations' | 'settings' | 'onboarding';

interface Data {
  overview: Overview | null;
  decisions: Decision[];
  approvals: Approval[];
  deadLetters: DeadLetter[];
  settings: Settings | null;
  operations: Operations | null;
  creative: CreativeLibrary | null;
}

export default function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [data, setData] = useState<Data>({
    overview: null,
    decisions: [],
    approvals: [],
    deadLetters: [],
    settings: null,
    operations: null,
    creative: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyApproval, setBusyApproval] = useState<string | null>(null);
  const [brand, setBrand] = useState<BrandResponse | null>(null);
  // undefined = still checking; null = signed out; a user object once confirmed.
  const [authUser, setAuthUser] = useState<AuthUser | null | undefined>(undefined);
  const motionVariants = useMotionVariants();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [overview, decisions, approvals, deadLetters, settings, operations, creative] =
        await Promise.all([
          fetchOverview(),
          fetchDecisions(),
          fetchApprovals(),
          fetchDeadLetters(),
          fetchSettings(),
          fetchOperations(),
          fetchCreative(),
        ]);
      setData({
        overview,
        decisions: decisions.decisions,
        approvals: approvals.approvals,
        deadLetters: deadLetters.deadLetters,
        settings,
        operations,
        creative,
      });
      // Brand is fetched separately: a deployment with no brand yet must still render, and
      // the answer decides whether onboarding is the first thing the user sees.
      setBrand(await fetchBrand().catch(() => null));
    } catch (e) {
      // A session that expired mid-use (idle past the sliding window) looks like any other
      // fetch failure to the caller — surface it as "signed out" rather than a generic error.
      if (e instanceof ApiError && e.status === 401) {
        setAuthUser(null);
        return;
      }
      setError(e instanceof Error ? e.message : 'unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMe()
      .then(setAuthUser)
      .catch(() => setAuthUser(null));
  }, []);

  useEffect(() => {
    if (authUser) void load();
  }, [authUser, load]);

  const respond = useCallback(
    async (id: string, action: 'approve' | 'reject') => {
      setBusyApproval(id);
      try {
        await respondToApproval(id, action);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'could not record your decision');
      } finally {
        setBusyApproval(null);
      }
    },
    [load],
  );

  const { overview, decisions, approvals, deadLetters } = data;
  const totals = overview?.totals ?? null;
  const target = overview?.client?.targetCpaCents ?? null;
  const beatingTarget = totals?.cpaCents !== null && target !== null && (totals?.cpaCents ?? 0) <= target;

  const active = overview?.variants.filter((v) => v.status === 'TESTING' || v.status === 'SCALING') ?? [];
  const stopped = overview?.variants.filter((v) => v.status === 'KILLED' || v.status === 'PAUSED') ?? [];

  if (authUser === undefined) {
    // Still checking for a live session. A blank frame for one round trip beats a flash of
    // the login screen for every already-signed-in visit.
    return <div className="shell" />;
  }

  if (authUser === null) {
    return <LoginView onSignedIn={setAuthUser} />;
  }

  // A fresh deployment has no client row at all. Nothing else in the product is reachable
  // before one exists, so this replaces the whole shell rather than being one more tab.
  if (!loading && overview && !overview.client) {
    return (
      <div className="shell">
        <header className="masthead">
          <div>
            <div className="brand-eyebrow">Autonomous Ad Management</div>
            <h1 className="brand-title">Let's get set up</h1>
            <div className="brand-sub">
              <span className="live-dot" aria-hidden="true" />
              This deployment has no client yet
            </div>
          </div>
          <button
            className="btn"
            onClick={() => {
              void logout().then(() => setAuthUser(null));
            }}
          >
            Sign out ({authUser.email})
          </button>
        </header>
        {error ? (
          <div style={{ marginBottom: 24 }}>
            <ErrorState error={error} onRetry={() => void load()} />
          </div>
        ) : null}
        <SetupView onCreated={load} />
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="masthead">
        <div>
          <div className="brand-eyebrow">Autonomous Ad Management</div>
          <h1 className="brand-title">{overview?.client?.name ?? 'Control'}</h1>
          <div className="brand-sub">
            <span className="live-dot" aria-hidden="true" />
            {overview?.client
              ? `Target ${money(target)} per conversion · stops are automatic, spend increases need you`
              : 'Not connected to a client yet'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => void load()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            className="btn"
            title={authUser.email}
            onClick={() => {
              void logout().then(() => setAuthUser(null));
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <nav className="tabs" role="tablist" aria-label="Sections">
        {(
          [
            ['overview', 'Live position', 0],
            ['review', 'Creative review', 0],
            ['brand', 'Brand', 0],
            ['compliance', 'Compliance', 0],
            ['creative', 'Library', 0],
            ['decisions', 'Decisions', 0],
            ['approvals', 'Awaiting you', approvals.length],
            ['operations', 'Operations', deadLetters.length],
            ['settings', 'Settings', 0],
          ] as const
        ).map(([key, label, badge]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className="tab"
            onClick={() => setTab(key)}
          >
            {label}
            {badge > 0 ? <span className="tab-count">{badge}</span> : null}
            {tab === key ? (
              <motion.span layoutId="tab-underline" className="tab-underline" />
            ) : null}
          </button>
        ))}
      </nav>

      {error ? (
        <div style={{ marginBottom: 24 }}>
          <ErrorState error={error} onRetry={() => void load()} />
        </div>
      ) : null}

      {brand && !brand.profile && tab !== 'onboarding' ? (
        <div className="notice notice--bad" style={{ marginBottom: 24 }}>
          <strong>This deployment has no brand profile yet.</strong> Creative generation is
          disabled until one exists — the system will not invent a brand for you.{' '}
          <button className="linkish" onClick={() => setTab('onboarding')}>
            Start brand onboarding
          </button>
        </div>
      ) : null}

      {deadLetters.length > 0 ? (
        <div className="error" style={{ marginBottom: 24 }}>
          <div className="error-title">{deadLetters.length} action(s) need a person</div>
          <p style={{ margin: 0, fontSize: 13 }}>
            These could not be completed after retrying and were set aside rather than dropped.
            Most recent: {deadLetters[0]?.lastError ?? 'unknown error'}
          </p>
        </div>
      ) : null}

      <AnimatePresence mode="wait">
        <motion.main
          key={tab}
          initial={motionVariants.view.initial}
          animate={motionVariants.view.animate}
          exit={motionVariants.view.exit}
          transition={{ duration: motionVariants.reduce ? 0.001 : 0.22, ease: EASE }}
        >
          {tab === 'overview' ? (
            <>
              {loading && !overview ? (
                <div className="stat-row">
                  {[0, 1, 2, 3].map((i) => (
                    <div className="stat" key={i}>
                      <div className="stat-label">Loading</div>
                      <div style={{ marginTop: 8 }}>
                        <div className="skeleton" style={{ height: 26, width: '70%' }} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : totals ? (
                <div className="stat-row">
                  <Stat
                    label="Cost per conversion"
                    value={money(totals.cpaCents)}
                    note={target ? `Target ${money(target)}` : undefined}
                    tone={beatingTarget ? 'good' : 'bad'}
                  />
                  <Stat label="Total spend" value={compactMoney(totals.spendCents)} note="Test to date" />
                  <Stat label="Conversions" value={count(totals.conversions)} />
                  <Stat
                    label="Daily budget live"
                    value={money(totals.activeDailyBudgetCents)}
                    note={`${active.length} ad(s) running`}
                  />
                  <Stat label="Click rate" value={percent(totals.clicks / Math.max(1, totals.impressions))} />
                </div>
              ) : null}

              <div className="section-title">Running now</div>
              {loading && active.length === 0 ? (
                <LoadingCards label="Loading live ads" />
              ) : active.length === 0 ? (
                <EmptyState
                  title="Nothing is running"
                  body="No ads are currently live for this client. Once creative is launched into a test it will appear here with its performance against target."
                />
              ) : (
                <motion.div
                  className="card-grid"
                  variants={motionVariants.list}
                  initial="hidden"
                  animate="show"
                >
                  {active.map((v) => (
                    <motion.div key={v.id} variants={motionVariants.item}>
                      <VariantCard variant={v} targetCpaCents={target} />
                    </motion.div>
                  ))}
                </motion.div>
              )}

              {stopped.length > 0 ? (
                <>
                  <div className="section-title">Stopped</div>
                  <motion.div
                    className="card-grid"
                    variants={motionVariants.list}
                    initial="hidden"
                    animate="show"
                  >
                    {stopped.map((v) => (
                      <motion.div key={v.id} variants={motionVariants.item}>
                        <VariantCard variant={v} targetCpaCents={target} />
                      </motion.div>
                    ))}
                  </motion.div>
                </>
              ) : null}
            </>
          ) : null}

          {tab === 'decisions' ? (
            loading && decisions.length === 0 ? (
              <LoadingCards label="Loading decision history" />
            ) : decisions.length === 0 ? (
              <EmptyState
                title="No decisions yet"
                body="The engine records every autonomous action here before it happens, along with the numbers behind it. Nothing has met the evidence threshold so far."
              />
            ) : (
              <motion.div
                className="card-grid"
                variants={motionVariants.list}
                initial="hidden"
                animate="show"
              >
                {decisions.map((d) => (
                  <motion.div key={d.id} variants={motionVariants.item}>
                    <DecisionRow decision={d} />
                  </motion.div>
                ))}
              </motion.div>
            )
          ) : null}

          {tab === 'approvals' ? (
            loading && approvals.length === 0 ? (
              <LoadingCards label="Loading approvals" />
            ) : approvals.length === 0 ? (
              <EmptyState
                title="Nothing needs you right now"
                body="Budget increases wait here for your approval. Stopping an ad happens automatically, since the worst case is a little lost opportunity rather than lost money."
              />
            ) : (
              <motion.div
                className="card-grid"
                variants={motionVariants.list}
                initial="hidden"
                animate="show"
              >
                {approvals.map((a) => (
                  <motion.div key={a.id} variants={motionVariants.item}>
                    <ApprovalCard approval={a} onRespond={(id, act) => void respond(id, act)} busy={busyApproval === a.id} />
                  </motion.div>
                ))}
              </motion.div>
            )
          ) : null}

          {tab === 'creative' ? (
            loading && !data.creative ? (
              <LoadingCards label="Loading creative library" />
            ) : data.creative ? (
              <CreativeView library={data.creative} />
            ) : null
          ) : null}

          {tab === 'operations' ? (
            loading && !data.operations ? (
              <LoadingCards label="Loading operations" />
            ) : data.operations ? (
              <OperationsView operations={data.operations} onChanged={load} />
            ) : null
          ) : null}

          {tab === 'settings' ? (
            loading && !data.settings ? (
              <LoadingCards label="Loading settings" />
            ) : data.settings ? (
              <SettingsView settings={data.settings} onSaved={load} />
            ) : null
          ) : null}

          {tab === 'onboarding' ? (
            <OnboardingView
              onCompleted={async () => {
                await load();
                setTab('brand');
              }}
            />
          ) : null}

          {tab === 'brand' ? <BrandView onChanged={load} /> : null}
          {tab === 'compliance' ? <ComplianceView /> : null}
          {tab === 'review' ? <ReviewQueueView /> : null}
        </motion.main>
      </AnimatePresence>

      <footer className="footnote">
        Every figure here comes from the decision engine running against recorded performance
        data — nothing on this page is illustrative. Decisions are written down before they are
        carried out, so anything shown as done genuinely happened.
        {overview?.client ? (
          <>
            {' '}
            Autonomy: stops{' '}
            <Badge status={overview.client.autonomousKillEnabled ? 'EXECUTED' : 'PAUSED'} /> · increases{' '}
            <Badge status={overview.client.autonomousScaleEnabled ? 'EXECUTED' : 'PENDING_APPROVAL'} />
          </>
        ) : null}
      </footer>
    </div>
  );
}
