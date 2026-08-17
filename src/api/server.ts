/**
 * Read-mostly reporting API, plus the approval endpoints.
 *
 * Deliberately thin: it exposes what the engine already decided and recorded. No decision
 * logic lives here, and no endpoint can cause a platform mutation except the approval route,
 * which only flips a decision's status — execution remains the executor's job.
 */
import 'dotenv/config';
import express from 'express';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, pool } from '../db/index.js';
import {
  adAccounts,
  adSets,
  adVariants,
  brandKits,
  campaigns,
  clients,
  creativeAssets,
  dailyPerformance,
  decisionsLog,
  guardrailConfigs,
  platformActions,
  spendLedger,
  testCohorts,
} from '../db/schema.js';
import { parseGuardrailConfig } from '../guardrails/config.js';
import {
  EDITABLE_FIELDS,
  guardrailHistory,
  SettingsValidationError,
  updateGuardrails,
} from './settings.js';
import { env } from '../config/env.js';
import { loadAnglePerformance } from '../creative/generate.js';
import { ingestPerformance, runCycleNow } from '../scheduler/index.js';
import { governanceRouter } from './governance.js';
import { accountsRouter } from './accounts.js';
import { authRouter, requireAuth } from './auth.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, '../../web/dist');

const app = express();
// Brand documents and reference assets arrive as multipart, but pasted brand text can be
// large, so the JSON limit is raised well above the default 100kb.
app.use(express.json({ limit: '10mb' }));

/** Wraps an async handler so a rejected promise becomes a 500 rather than an unhandled rejection. */
const route =
  (handler: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) => {
    handler(req, res).catch((error: unknown) => {
      console.error(`${req.method} ${req.path} failed:`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'internal error' });
      }
    });
  };

// Public: unauthenticated infra probes, and the routes that establish a session in the
// first place. Everything registered after requireAuth below needs a live session.
app.get('/api/health', route(async (_req, res) => {
  await db.execute(sql`SELECT 1`);
  res.json({ ok: true, time: new Date().toISOString() });
}));
app.use('/api', authRouter);

app.use('/api', requireAuth);

// Brand governance: onboarding, brand memory, reference assets, compliance, review queue.
// Mounted after the auth gate, so every route in it requires a session.
app.use('/api', governanceRouter);
app.use('/api', accountsRouter);

/** Everything the overview needs, in one round trip. */
app.get('/api/overview', route(async (_req, res) => {
  const [client] = await db.select().from(clients).limit(1);
  if (!client) {
    res.json({ client: null, variants: [], totals: null });
    return;
  }

  const [config] = await db
    .select()
    .from(guardrailConfigs)
    .where(and(eq(guardrailConfigs.clientId, client.id), isNull(guardrailConfigs.effectiveTo)));

  const variants = await db
    .select({
      id: adVariants.id,
      headline: adVariants.headline,
      primaryText: adVariants.primaryText,
      cta: adVariants.cta,
      angleTag: adVariants.angleTag,
      status: adVariants.status,
      testStartedAt: adVariants.testStartedAt,
      evaluationsOutcome: adVariants.evaluationsOutcome,
      adSetId: adVariants.adSetId,
      dailyBudgetCents: adSets.dailyBudgetCents,
      adSetStatus: adSets.status,
      campaignName: campaigns.name,
    })
    .from(adVariants)
    .innerJoin(adSets, eq(adVariants.adSetId, adSets.id))
    .innerJoin(campaigns, eq(adVariants.campaignId, campaigns.id))
    .orderBy(adVariants.createdAt);

  // Latest snapshot per (variant, date), then aggregate. Mirrors the reader's "latest wins".
  const perf = await db.execute(sql`
    SELECT ad_variant_id,
           SUM(impressions)::bigint            AS impressions,
           SUM(clicks)::bigint                 AS clicks,
           SUM(spend_cents)::bigint            AS spend_cents,
           SUM(conversions)::bigint            AS conversions,
           SUM(conversion_value_cents)::bigint AS conversion_value_cents,
           MAX(stat_date)                      AS latest_date
    FROM (
      SELECT DISTINCT ON (ad_variant_id, stat_date) *
      FROM daily_performance
      ORDER BY ad_variant_id, stat_date, fetched_at DESC
    ) latest
    GROUP BY ad_variant_id
  `);

  const perfByVariant = new Map<string, Record<string, unknown>>();
  for (const row of perf.rows as Record<string, unknown>[]) {
    perfByVariant.set(String(row.ad_variant_id), row);
  }

  const enriched = variants.map((v) => {
    const p = perfByVariant.get(v.id);
    const spendCents = Number(p?.spend_cents ?? 0);
    const conversions = Number(p?.conversions ?? 0);
    const clicks = Number(p?.clicks ?? 0);
    const impressions = Number(p?.impressions ?? 0);
    return {
      ...v,
      impressions,
      clicks,
      spendCents,
      conversions,
      conversionValueCents: Number(p?.conversion_value_cents ?? 0),
      ctr: impressions > 0 ? clicks / impressions : null,
      cvr: clicks > 0 ? conversions / clicks : null,
      cpaCents: conversions > 0 ? Math.round(spendCents / conversions) : null,
    };
  });

  const totals = enriched.reduce(
    (acc, v) => ({
      spendCents: acc.spendCents + v.spendCents,
      conversions: acc.conversions + v.conversions,
      impressions: acc.impressions + v.impressions,
      clicks: acc.clicks + v.clicks,
      activeDailyBudgetCents:
        acc.activeDailyBudgetCents + (v.adSetStatus === 'ACTIVE' ? v.dailyBudgetCents : 0),
    }),
    { spendCents: 0, conversions: 0, impressions: 0, clicks: 0, activeDailyBudgetCents: 0 },
  );

  res.json({
    client: {
      id: client.id,
      name: client.name,
      objectiveType: client.defaultObjectiveType,
      targetCpaCents: client.defaultTargetCpaCents,
      targetRoas: client.defaultTargetRoas,
      autonomousKillEnabled: client.autonomousKillEnabled,
      autonomousScaleEnabled: client.autonomousScaleEnabled,
      autonomousMutateEnabled: client.autonomousMutateEnabled,
    },
    config: config ?? null,
    variants: enriched,
    totals: {
      ...totals,
      cpaCents: totals.conversions > 0 ? Math.round(totals.spendCents / totals.conversions) : null,
    },
  });
}));

/** Full decision history, newest first, with the variant it applied to. */
app.get('/api/decisions', route(async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const rows = await db
    .select({
      id: decisionsLog.id,
      decisionType: decisionsLog.decisionType,
      status: decisionsLog.status,
      reasoning: decisionsLog.reasoning,
      blockedByRule: decisionsLog.blockedByRule,
      blockedReason: decisionsLog.blockedReason,
      decidedAt: decisionsLog.decidedAt,
      executedAt: decisionsLog.executedAt,
      expiresAt: decisionsLog.expiresAt,
      failureReason: decisionsLog.failureReason,
      proposedAction: decisionsLog.proposedAction,
      statisticalEvidence: decisionsLog.statisticalEvidence,
      guardrailEvaluations: decisionsLog.guardrailEvaluations,
      triggeringData: decisionsLog.triggeringData,
      engineVersion: decisionsLog.engineVersion,
      rulesetVersion: decisionsLog.rulesetVersion,
      variantId: decisionsLog.adVariantId,
      headline: adVariants.headline,
      angleTag: adVariants.angleTag,
    })
    .from(decisionsLog)
    .leftJoin(adVariants, eq(decisionsLog.adVariantId, adVariants.id))
    .orderBy(desc(decisionsLog.decidedAt))
    .limit(limit);
  res.json({ decisions: rows });
}));

/** Anything waiting on a human. */
app.get('/api/approvals', route(async (_req, res) => {
  const rows = await db
    .select({
      id: decisionsLog.id,
      decisionType: decisionsLog.decisionType,
      reasoning: decisionsLog.reasoning,
      decidedAt: decisionsLog.decidedAt,
      expiresAt: decisionsLog.expiresAt,
      proposedAction: decisionsLog.proposedAction,
      statisticalEvidence: decisionsLog.statisticalEvidence,
      headline: adVariants.headline,
      angleTag: adVariants.angleTag,
    })
    .from(decisionsLog)
    .leftJoin(adVariants, eq(decisionsLog.adVariantId, adVariants.id))
    .where(eq(decisionsLog.status, 'PENDING_APPROVAL'))
    .orderBy(desc(decisionsLog.decidedAt));
  res.json({ approvals: rows });
}));

/**
 * Approve or reject. This only records the human's answer — it does not execute. Execution
 * remains the executor's responsibility, so the guardrails are re-evaluated against fresh
 * state at that point rather than trusting a decision that may since have gone stale.
 */
app.post('/api/approvals/:id', route(async (req, res) => {
  const { id } = req.params;
  const { action, actor } = req.body as { action?: string; actor?: string };

  if (action !== 'approve' && action !== 'reject') {
    res.status(400).json({ error: "action must be 'approve' or 'reject'" });
    return;
  }

  const [existing] = await db.select().from(decisionsLog).where(eq(decisionsLog.id, id!));
  if (!existing) {
    res.status(404).json({ error: 'decision not found' });
    return;
  }
  if (existing.status !== 'PENDING_APPROVAL') {
    res.status(409).json({ error: `decision is ${existing.status}, not awaiting approval` });
    return;
  }
  if (existing.expiresAt && existing.expiresAt.getTime() < Date.now()) {
    await db.update(decisionsLog).set({ status: 'EXPIRED' }).where(eq(decisionsLog.id, id!));
    res.status(409).json({
      error: 'this recommendation has expired and must be re-evaluated against current data',
    });
    return;
  }

  const now = new Date();
  await db
    .update(decisionsLog)
    .set(
      action === 'approve'
        ? { status: 'APPROVED', approvedBy: actor ?? 'dashboard', approvedAt: now }
        : { status: 'REJECTED', rejectedBy: actor ?? 'dashboard', rejectedAt: now },
    )
    .where(eq(decisionsLog.id, id!));

  res.json({ ok: true, status: action === 'approve' ? 'APPROVED' : 'REJECTED' });
}));

/** Actions that could not complete and are waiting for a person. */
app.get('/api/dead-letters', route(async (_req, res) => {
  const rows = await db
    .select()
    .from(platformActions)
    .where(and(eq(platformActions.status, 'DEAD'), isNull(platformActions.acknowledgedAt)));
  res.json({ deadLetters: rows });
}));

/** One variant in detail: its daily series and every decision made about it. */
app.get('/api/variants/:id', route(async (req, res) => {
  const id = String(req.params.id);

  const [variant] = await db
    .select({
      id: adVariants.id,
      headline: adVariants.headline,
      primaryText: adVariants.primaryText,
      cta: adVariants.cta,
      angleTag: adVariants.angleTag,
      generationReasoning: adVariants.generationReasoning,
      status: adVariants.status,
      testStartedAt: adVariants.testStartedAt,
      evaluationsProxy: adVariants.evaluationsProxy,
      evaluationsOutcome: adVariants.evaluationsOutcome,
      dailyBudgetCents: adSets.dailyBudgetCents,
      adSetStatus: adSets.status,
    })
    .from(adVariants)
    .innerJoin(adSets, eq(adVariants.adSetId, adSets.id))
    .where(eq(adVariants.id, id));

  if (!variant) {
    res.status(404).json({ error: 'variant not found' });
    return;
  }

  const daily = await db.execute(sql`
    SELECT DISTINCT ON (stat_date)
           stat_date, impressions, clicks, spend_cents, conversions, conversion_value_cents
    FROM daily_performance
    WHERE ad_variant_id = ${id}
    ORDER BY stat_date, fetched_at DESC
  `);

  const decisions = await db
    .select({
      id: decisionsLog.id,
      decisionType: decisionsLog.decisionType,
      status: decisionsLog.status,
      reasoning: decisionsLog.reasoning,
      decidedAt: decisionsLog.decidedAt,
    })
    .from(decisionsLog)
    .where(eq(decisionsLog.adVariantId, id))
    .orderBy(desc(decisionsLog.decidedAt));

  res.json({
    variant,
    daily: (daily.rows as Record<string, unknown>[]).map((r) => ({
      statDate: String(r.stat_date),
      impressions: Number(r.impressions),
      clicks: Number(r.clicks),
      spendCents: Number(r.spend_cents),
      conversions: Number(r.conversions),
      conversionValueCents: Number(r.conversion_value_cents),
    })),
    decisions,
  });
}));

/** Autonomous spend committed today, against the cap. */
app.get('/api/spend', route(async (_req, res) => {
  const rows = await db
    .select({
      ledgerDate: spendLedger.ledgerDate,
      total: sql<string>`SUM(${spendLedger.deltaCents})`,
    })
    .from(spendLedger)
    .groupBy(spendLedger.ledgerDate)
    .orderBy(desc(spendLedger.ledgerDate));
  res.json({ ledger: rows.map((r) => ({ ...r, total: Number(r.total) })) });
}));

/** Daily series for one variant, latest snapshot per day — the chart data. */
app.get('/api/variants/:id/daily', route(async (req, res) => {
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (stat_date)
           stat_date, impressions, clicks, spend_cents, conversions, conversion_value_cents, fetched_at
    FROM ${dailyPerformance}
    WHERE ad_variant_id = ${req.params.id}
    ORDER BY stat_date, fetched_at DESC
  `);
  res.json({ daily: rows.rows });
}));

// --- settings ---------------------------------------------------------------

/** Live guardrail config, the client's autonomy flags, and the version history. */
app.get('/api/settings', route(async (_req, res) => {
  const [client] = await db.select().from(clients).limit(1);
  if (!client) {
    res.json({ client: null, guardrails: null, history: [], editableFields: EDITABLE_FIELDS });
    return;
  }

  const [live] = await db
    .select()
    .from(guardrailConfigs)
    .where(and(eq(guardrailConfigs.clientId, client.id), isNull(guardrailConfigs.effectiveTo)));

  res.json({
    client: {
      id: client.id,
      name: client.name,
      objectiveType: client.defaultObjectiveType,
      targetCpaCents: client.defaultTargetCpaCents,
      targetRoas: client.defaultTargetRoas,
      timezone: client.timezone,
      autonomousKillEnabled: client.autonomousKillEnabled,
      autonomousScaleEnabled: client.autonomousScaleEnabled,
      autonomousMutateEnabled: client.autonomousMutateEnabled,
      automationPausedAt: client.automationPausedAt,
      automationPausedBy: client.automationPausedBy,
    },
    guardrails: live ? parseGuardrailConfig(live as unknown as Record<string, unknown>) : null,
    history: await guardrailHistory(db, client.id),
    editableFields: EDITABLE_FIELDS,
    // The deployment-level switch is reported but deliberately not settable from here.
    executionEnabled: env.executionEnabled,
  });
}));

/** Apply a guardrail change. Creates a new version; never mutates the live row. */
app.put('/api/settings/guardrails', route(async (req, res) => {
  const [client] = await db.select().from(clients).limit(1);
  if (!client) {
    res.status(404).json({ error: 'no client configured' });
    return;
  }

  const patch = (req.body as { patch?: Record<string, unknown> }).patch ?? {};
  try {
    const result = await updateGuardrails(db, client.id, patch, 'dashboard');
    res.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      res.status(400).json({ error: error.message, field: error.field });
      return;
    }
    throw error;
  }
}));

/** Autonomy flags, objective targets, and the per-client automation pause. */
app.patch('/api/settings/client', route(async (req, res) => {
  const [client] = await db.select().from(clients).limit(1);
  if (!client) {
    res.status(404).json({ error: 'no client configured' });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const updates: Record<string, unknown> = {};

  for (const flag of ['autonomousKillEnabled', 'autonomousScaleEnabled', 'autonomousMutateEnabled']) {
    if (typeof body[flag] === 'boolean') updates[flag] = body[flag];
  }

  if (body.targetCpaCents !== undefined) {
    const value = Number(body.targetCpaCents);
    if (!Number.isInteger(value) || value <= 0) {
      res.status(400).json({ error: 'targetCpaCents must be a positive integer', field: 'targetCpaCents' });
      return;
    }
    updates.defaultTargetCpaCents = value;
  }

  if (typeof body.automationPaused === 'boolean') {
    updates.automationPausedAt = body.automationPaused ? new Date() : null;
    updates.automationPausedBy = body.automationPaused ? 'dashboard' : null;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'no recognised fields to update' });
    return;
  }

  updates.updatedAt = new Date();
  await db.update(clients).set(updates).where(eq(clients.id, client.id));
  res.json({ ok: true, updated: Object.keys(updates) });
}));

// --- operations ---------------------------------------------------------------

/** Account health, today's committed autonomous spend, and anything needing a human. */
app.get('/api/operations', route(async (_req, res) => {
  const [client] = await db.select().from(clients).limit(1);
  if (!client) {
    res.json({ accounts: [], spendToday: null, deadLetters: [], recentCycles: [] });
    return;
  }

  const accounts = await db
    .select({
      id: adAccounts.id,
      name: adAccounts.name,
      platform: adAccounts.platform,
      status: adAccounts.status,
      currency: adAccounts.currency,
      timezone: adAccounts.timezone,
      lastSyncedAt: adAccounts.lastSyncedAt,
      lastErrorAt: adAccounts.lastErrorAt,
      lastError: adAccounts.lastError,
      tokenExpiresAt: adAccounts.tokenExpiresAt,
    })
    .from(adAccounts)
    .where(eq(adAccounts.clientId, client.id));

  const [live] = await db
    .select()
    .from(guardrailConfigs)
    .where(and(eq(guardrailConfigs.clientId, client.id), isNull(guardrailConfigs.effectiveTo)));
  const config = live ? parseGuardrailConfig(live as unknown as Record<string, unknown>) : null;

  const today = new Date().toISOString().slice(0, 10);
  const [spend] = await db
    .select({ total: sql<string>`COALESCE(SUM(${spendLedger.deltaCents}), 0)` })
    .from(spendLedger)
    .where(and(eq(spendLedger.clientId, client.id), eq(spendLedger.ledgerDate, today)));

  const dead = await db
    .select()
    .from(platformActions)
    .where(and(eq(platformActions.status, 'DEAD'), isNull(platformActions.acknowledgedAt)));

  const cycles = await db
    .select({
      cycleId: decisionsLog.cycleId,
      at: sql<string>`MAX(${decisionsLog.decidedAt})`,
      decisions: sql<string>`COUNT(*)`,
    })
    .from(decisionsLog)
    .where(eq(decisionsLog.clientId, client.id))
    .groupBy(decisionsLog.cycleId)
    .orderBy(sql`MAX(${decisionsLog.decidedAt}) DESC`)
    .limit(10);

  res.json({
    accounts,
    spendToday: {
      committedCents: Number(spend?.total ?? 0),
      capCents: config?.maxDailyAutonomousIncreaseCents ?? null,
    },
    deadLetters: dead,
    recentCycles: cycles.map((c) => ({ ...c, decisions: Number(c.decisions) })),
    executionEnabled: env.executionEnabled,
    automationPaused: client.automationPausedAt !== null,
  });
}));

/** Acknowledge a dead-lettered action so it leaves the queue. */
app.post('/api/dead-letters/:id/acknowledge', route(async (req, res) => {
  const id = String(req.params.id);
  const updated = await db
    .update(platformActions)
    .set({ acknowledgedBy: 'dashboard', acknowledgedAt: new Date() })
    .where(eq(platformActions.id, id))
    .returning({ id: platformActions.id });

  if (updated.length === 0) {
    res.status(404).json({ error: 'action not found' });
    return;
  }
  res.json({ ok: true });
}));

// --- creative library ---------------------------------------------------------

/** Angles with aggregate performance — what the system has learned about arguments. */
app.get('/api/creative', route(async (_req, res) => {
  const [client] = await db.select().from(clients).limit(1);
  if (!client) {
    res.json({ angles: [], variants: [], brandKit: null });
    return;
  }

  const angles = await loadAnglePerformance(db, client.id, client.defaultTargetCpaCents);

  const variants = await db
    .select({
      id: adVariants.id,
      angleTag: adVariants.angleTag,
      hookType: adVariants.hookType,
      headline: adVariants.headline,
      primaryText: adVariants.primaryText,
      cta: adVariants.cta,
      status: adVariants.status,
      generationReasoning: adVariants.generationReasoning,
      createdAt: adVariants.createdAt,
    })
    .from(adVariants)
    .innerJoin(campaigns, eq(adVariants.campaignId, campaigns.id))
    .where(eq(campaigns.clientId, client.id))
    .orderBy(desc(adVariants.createdAt));

  const [kit] = await db
    .select()
    .from(brandKits)
    .where(eq(brandKits.clientId, client.id))
    .orderBy(desc(brandKits.version))
    .limit(1);

  res.json({ angles, variants, brandKit: kit ?? null });
}));

// --- cycle control ------------------------------------------------------------

/**
 * Runs a decision cycle immediately.
 *
 * The same code path the scheduler uses — this only changes *when* it runs, never what it is
 * allowed to do. Every guardrail still applies.
 */
app.post('/api/cycle/run', route(async (_req, res) => {
  const result = await runCycleNow();
  res.json(result);
}));

/** Pulls fresh performance on demand. */
app.post('/api/cycle/ingest', route(async (_req, res) => {
  const result = await ingestPerformance();
  res.json(result);
}));

// --- static site -----------------------------------------------------------

if (existsSync(webDist)) {
  app.use(express.static(webDist));
  // SPA fallback for client-side routes; API 404s stay JSON.
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(join(webDist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res
      .status(503)
      .type('text/plain')
      .send('Dashboard has not been built yet. Run: npm run web:build');
  });
}

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`\n  Ad manager dashboard → http://localhost:${port}\n`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received, shutting down...`);
  server.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
