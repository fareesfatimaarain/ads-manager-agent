/**
 * Brand governance API: onboarding, brand memory, reference assets, compliance rules, review.
 *
 * Mounted as an Express router so `server.ts` stays a wiring file. Every write path here is
 * validated at the boundary — a request body is untrusted input, and the compliance layer in
 * particular must not be configurable into a state that would approve content unchecked.
 */
import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  adAccounts,
  brandProfiles,
  campaignBriefs,
  clients,
  complianceRuleOverrides,
  complianceRules,
  creativeAssets,
  creativeReviews,
  guardrailConfigs,
  intakeSessions,
  referenceAssets,
} from '../db/schema.js';
import {
  applyAnswer,
  assembleProfile,
  fullQuestionSet,
  IntakeError,
  INDUSTRY_QUESTION_ID,
  nextStep,
  summarise,
  type AnswerValue,
  type IntakeState,
} from '../intake/engine.js';
import { extractFromDocument } from '../intake/extract.js';
import {
  complianceTemplateFor,
  listComplianceTemplates,
  listIndustries,
  resolveComplianceRules,
  resolveIndustry,
} from '../templates/registry.js';
import { ComplianceRuleSchema, type ContentField, type Match } from '../templates/schema.js';
import {
  assembleRules,
  brandConstraintsOf,
  checkContent,
  ComplianceConfigurationError,
} from '../compliance/engine.js';
import { generateGoverned, loadClientComplianceConfig, recheckReview } from '../creative/brandGoverned.js';
import { launchApprovedReviews, LaunchError } from '../campaigns/launch.js';
import { adapterFor } from '../scheduler/index.js';
import type { TargetingSpec } from '../platform/types.js';
import {
  assetStore,
  AssetError,
  extractText,
  resolveMimeType,
  safeFilename,
  MAX_ASSET_BYTES,
} from '../assets/storage.js';

export const governanceRouter = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ASSET_BYTES },
});

const route =
  (handler: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) => {
    handler(req, res).catch((error: unknown) => {
      if (error instanceof IntakeError) {
        res.status(400).json({ error: error.message, questionId: error.questionId });
        return;
      }
      if (error instanceof ComplianceConfigurationError) {
        res.status(409).json({ error: error.message });
        return;
      }
      if (error instanceof AssetError) {
        const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'IO' ? 500 : 400;
        res.status(status).json({ error: error.message, code: error.code });
        return;
      }
      console.error(`${req.method} ${req.path} failed:`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'internal error' });
      }
    });
  };

export async function requireClient(): Promise<typeof clients.$inferSelect> {
  const [client] = await db.select().from(clients).limit(1);
  if (!client) throw new Error('no client is configured in this deployment');
  return client;
}

// ---------------------------------------------------------------------------
// First-run setup
//
// This deployment is single-tenant: everything else in this file assumes a client row
// already exists. Before onboarding, generation, or any of it can run, something has to
// create that row — this is the only place that does, and it refuses once one exists so a
// second workspace can never be created by mistake underneath the first.
// ---------------------------------------------------------------------------

governanceRouter.get('/setup/status', route(async (_req, res) => {
  const [client] = await db.select({ id: clients.id }).from(clients).limit(1);
  res.json({ hasWorkspace: Boolean(client) });
}));

governanceRouter.post('/setup/workspace', route(async (req, res) => {
  const [existing] = await db.select({ id: clients.id }).from(clients).limit(1);
  if (existing) {
    res.status(409).json({ error: 'a workspace already exists in this deployment' });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const name = String(body.name ?? '').trim();
  if (!name) {
    res.status(400).json({ error: 'business name is required' });
    return;
  }
  const timezone = String(body.timezone ?? 'UTC').trim() || 'UTC';
  const currency = String(body.currency ?? 'USD').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    res.status(400).json({ error: 'currency must be a 3-letter ISO 4217 code, e.g. USD' });
    return;
  }
  const objectiveType = body.objectiveType === 'ROAS' ? 'ROAS' : 'CPA';
  const targetValue = Number(body.targetValue);
  if (!Number.isFinite(targetValue) || targetValue <= 0) {
    res.status(400).json({
      error: objectiveType === 'CPA'
        ? 'target cost per conversion must be a positive amount'
        : 'target return on ad spend must be a positive number',
    });
    return;
  }

  const slugBase = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'client';
  const slug = `${slugBase}-${randomUUID().slice(0, 8)}`;

  const clientId = await db.transaction(async (tx) => {
    // Serialises against a second setup request racing this one — the pre-check above is not
    // enough on its own, since two requests could both pass it before either inserts.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('workspace-setup'))`);

    const [raced] = await tx.select({ id: clients.id }).from(clients).limit(1);
    if (raced) {
      throw new Error('a workspace already exists in this deployment');
    }

    const [client] = await tx
      .insert(clients)
      .values({
        name,
        slug,
        timezone,
        defaultObjectiveType: objectiveType,
        defaultTargetCpaCents: objectiveType === 'CPA' ? Math.round(targetValue * 100) : null,
        defaultTargetRoas: objectiveType === 'ROAS' ? targetValue.toFixed(4) : null,
        // Tiered autonomy by default, consistent with every other client created in this
        // system: stopping spend is safe to automate immediately, starting or growing it is
        // not, and mutation needs the creative pipeline the client hasn't set up yet.
        autonomousKillEnabled: true,
        autonomousScaleEnabled: false,
        autonomousMutateEnabled: false,
      })
      .returning({ id: clients.id });

    // Conservative starting limits. Every one of these is editable in Settings once the
    // client has seen real numbers — the point here is a workspace that cannot spend
    // dangerously on day one, not a workspace tuned for this business.
    await tx.insert(guardrailConfigs).values({
      clientId: client!.id,
      version: 1,
      maxDailyAutonomousIncreaseCents: 20_000,
      maxTotalDailyBudgetCents: 100_000,
      maxAdSetDailyBudgetCents: 50_000,
      createdBy: 'setup',
    });

    // A MOCK ad account so the workspace is immediately usable end-to-end. Connecting a real
    // platform account is a separate, later step — nothing here handles a real access token.
    await tx.insert(adAccounts).values({
      clientId: client!.id,
      platform: 'MOCK',
      platformAccountId: `act_${randomUUID().slice(0, 12)}`,
      name: `${name} — primary`,
      currency,
      timezone,
      status: 'ACTIVE',
    });

    return client!.id;
  });

  res.json({ ok: true, clientId });
}));

// ---------------------------------------------------------------------------
// Templates — what this deployment knows how to do
// ---------------------------------------------------------------------------

governanceRouter.get('/templates', route(async (_req, res) => {
  res.json({
    industries: listIndustries(),
    compliance: listComplianceTemplates(),
  });
}));

/** The full rule set an industry would apply, so a client can see it before committing. */
governanceRouter.get('/templates/compliance/:industryKey', route(async (req, res) => {
  const industryKey = String(req.params.industryKey);
  const templateKey = complianceTemplateFor(industryKey);
  const { rules, chain } = resolveComplianceRules(templateKey);
  res.json({
    industry: resolveIndustry(industryKey),
    templateKey,
    chain,
    rules: rules.map((r) => ({
      id: r.id,
      title: r.title,
      severity: r.severity,
      mandatory: r.mandatory,
      reason: r.reason,
      appliesTo: r.appliesTo,
      matchKind: r.match.kind,
    })),
  });
}));

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

function stateOf(session: typeof intakeSessions.$inferSelect): IntakeState {
  return {
    industryKey: session.industryKey,
    answers: session.answers as Record<string, AnswerValue>,
    prefilled: session.prefilled as Record<string, AnswerValue>,
  };
}

function stepPayload(state: IntakeState) {
  const step = nextStep(state);
  return {
    question: step.question,
    answered: step.answered,
    total: step.total,
    complete: step.complete,
    suggestedAnswer: step.suggestedAnswer,
    industryChoices: step.industryChoices,
    summary: step.complete ? summarise(state) : null,
  };
}

/** Current onboarding session, creating one if none is open. */
governanceRouter.get('/intake', route(async (_req, res) => {
  const client = await requireClient();

  let [session] = await db
    .select()
    .from(intakeSessions)
    .where(and(eq(intakeSessions.clientId, client.id), eq(intakeSessions.status, 'IN_PROGRESS')))
    .orderBy(desc(intakeSessions.startedAt))
    .limit(1);

  if (!session) {
    const [created] = await db
      .insert(intakeSessions)
      .values({ clientId: client.id, status: 'IN_PROGRESS' })
      .returning();
    session = created!;
  }

  const state = stateOf(session);
  res.json({
    sessionId: session.id,
    industryKey: session.industryKey,
    answers: session.answers,
    prefilled: session.prefilled,
    transcript: session.transcript,
    ...stepPayload(state),
  });
}));

/** Records an answer and returns the next question. */
governanceRouter.post('/intake/answer', route(async (req, res) => {
  const client = await requireClient();
  const { sessionId, questionId, answer } = req.body as {
    sessionId?: string;
    questionId?: string;
    answer?: unknown;
  };

  if (!sessionId || !questionId) {
    res.status(400).json({ error: 'sessionId and questionId are required' });
    return;
  }

  const [session] = await db
    .select()
    .from(intakeSessions)
    .where(and(eq(intakeSessions.id, sessionId), eq(intakeSessions.clientId, client.id)));
  if (!session) {
    res.status(404).json({ error: 'onboarding session not found' });
    return;
  }
  if (session.status !== 'IN_PROGRESS') {
    res.status(409).json({ error: `this session is ${session.status.toLowerCase()}` });
    return;
  }

  const updated = applyAnswer(stateOf(session), questionId, answer);

  const transcript = [
    ...(session.transcript as unknown[]),
    { at: new Date().toISOString(), questionId, answer },
  ];

  await db
    .update(intakeSessions)
    .set({
      industryKey: updated.industryKey,
      answers: updated.answers as object,
      transcript: transcript as object,
      updatedAt: new Date(),
    })
    .where(eq(intakeSessions.id, sessionId));

  res.json({ sessionId, industryKey: updated.industryKey, answers: updated.answers, ...stepPayload(updated) });
}));

/** Go back and change a previously given answer. */
governanceRouter.post('/intake/revise', route(async (req, res) => {
  const client = await requireClient();
  const { sessionId, questionId } = req.body as { sessionId?: string; questionId?: string };
  if (!sessionId || !questionId) {
    res.status(400).json({ error: 'sessionId and questionId are required' });
    return;
  }

  const [session] = await db
    .select()
    .from(intakeSessions)
    .where(and(eq(intakeSessions.id, sessionId), eq(intakeSessions.clientId, client.id)));
  if (!session) {
    res.status(404).json({ error: 'onboarding session not found' });
    return;
  }

  const answers = { ...(session.answers as Record<string, AnswerValue>) };
  delete answers[questionId];

  await db
    .update(intakeSessions)
    .set({ answers: answers as object, updatedAt: new Date() })
    .where(eq(intakeSessions.id, sessionId));

  const state: IntakeState = {
    industryKey: session.industryKey,
    answers,
    prefilled: session.prefilled as Record<string, AnswerValue>,
  };
  res.json({ sessionId, ...stepPayload(state) });
}));

/** Upload a brand document to pre-fill the intake. Suggestions are never auto-accepted. */
governanceRouter.post(
  '/intake/document',
  upload.single('file'),
  route(async (req, res) => {
    const client = await requireClient();
    const sessionId = String((req.body as { sessionId?: string }).sessionId ?? '');
    const file = req.file;

    if (!file) {
      res.status(400).json({ error: 'no file was uploaded' });
      return;
    }

    const [session] = await db
      .select()
      .from(intakeSessions)
      .where(and(eq(intakeSessions.id, sessionId), eq(intakeSessions.clientId, client.id)));
    if (!session) {
      res.status(404).json({ error: 'onboarding session not found' });
      return;
    }

    const mimeType = resolveMimeType(file.mimetype, file.originalname);
    const stored = await assetStore.put(file.originalname, mimeType, file.buffer);
    const text = extractText(mimeType, file.buffer);

    await db.insert(referenceAssets).values({
      clientId: client.id,
      kind: 'BRAND_DOCUMENT',
      filename: safeFilename(file.originalname),
      mimeType,
      sizeBytes: stored.sizeBytes,
      storageKey: stored.storageKey,
      extractedText: text,
      usageNote: 'Uploaded during onboarding',
      uploadedBy: 'dashboard',
    });

    if (!text) {
      res.json({
        stored: true,
        readable: false,
        prefilled: {},
        message:
          'The file was saved as reference material, but its text could not be read, so nothing was pre-filled. Plain text and Markdown can be read; PDF and Word are stored but not parsed.',
      });
      return;
    }

    const extraction = await extractFromDocument(text, { industryHint: session.industryKey });
    const merged = { ...(session.prefilled as Record<string, AnswerValue>), ...extraction.prefilled };

    await db
      .update(intakeSessions)
      .set({ prefilled: merged as object, updatedAt: new Date() })
      .where(eq(intakeSessions.id, sessionId));

    const state: IntakeState = {
      industryKey: session.industryKey,
      answers: session.answers as Record<string, AnswerValue>,
      prefilled: merged,
    };

    res.json({
      stored: true,
      readable: true,
      extractor: extraction.extractor,
      suggestedIndustry: extraction.suggestedIndustry,
      prefilled: merged,
      rejected: extraction.rejected,
      ...stepPayload(state),
    });
  }),
);

/** Finish onboarding: assemble the profile and make it the live brand memory. */
governanceRouter.post('/intake/complete', route(async (req, res) => {
  const client = await requireClient();
  const { sessionId } = req.body as { sessionId?: string };

  const [session] = await db
    .select()
    .from(intakeSessions)
    .where(and(eq(intakeSessions.id, String(sessionId)), eq(intakeSessions.clientId, client.id)));
  if (!session) {
    res.status(404).json({ error: 'onboarding session not found' });
    return;
  }

  const assembled = assembleProfile(stateOf(session));

  const profileId = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${client.id}))`);

    const [current] = await tx
      .select({ version: brandProfiles.version })
      .from(brandProfiles)
      .where(and(eq(brandProfiles.clientId, client.id), isNull(brandProfiles.effectiveTo)));

    if (current) {
      await tx
        .update(brandProfiles)
        .set({ effectiveTo: new Date() })
        .where(and(eq(brandProfiles.clientId, client.id), isNull(brandProfiles.effectiveTo)));
    }

    const [inserted] = await tx
      .insert(brandProfiles)
      .values({
        clientId: client.id,
        version: (current?.version ?? 0) + 1,
        industryKey: assembled.industryKey,
        complianceTemplateKey: assembled.complianceTemplateKey,
        core: assembled.core as object,
        industry: assembled.industry as object,
        locks: {},
        createdBy: 'dashboard',
        sourceKind: 'INTAKE',
      })
      .returning({ id: brandProfiles.id });

    return inserted!.id;
  });

  await db
    .update(intakeSessions)
    .set({ status: 'COMPLETED', completedAt: new Date(), resultingProfileId: profileId })
    .where(eq(intakeSessions.id, session.id));

  res.json({ ok: true, brandProfileId: profileId, industryKey: assembled.industryKey });
}));

/** Abandon an in-progress session and start over. */
governanceRouter.post('/intake/restart', route(async (_req, res) => {
  const client = await requireClient();
  await db
    .update(intakeSessions)
    .set({ status: 'ABANDONED' })
    .where(and(eq(intakeSessions.clientId, client.id), eq(intakeSessions.status, 'IN_PROGRESS')));
  const [created] = await db
    .insert(intakeSessions)
    .values({ clientId: client.id, status: 'IN_PROGRESS' })
    .returning();
  res.json({ sessionId: created!.id, ...stepPayload({ industryKey: null, answers: {}, prefilled: {} }) });
}));

// ---------------------------------------------------------------------------
// Brand memory
// ---------------------------------------------------------------------------

governanceRouter.get('/brand', route(async (_req, res) => {
  const client = await requireClient();

  const [live] = await db
    .select()
    .from(brandProfiles)
    .where(and(eq(brandProfiles.clientId, client.id), isNull(brandProfiles.effectiveTo)));

  const history = await db
    .select({
      id: brandProfiles.id,
      version: brandProfiles.version,
      industryKey: brandProfiles.industryKey,
      effectiveFrom: brandProfiles.effectiveFrom,
      effectiveTo: brandProfiles.effectiveTo,
      createdBy: brandProfiles.createdBy,
      sourceKind: brandProfiles.sourceKind,
    })
    .from(brandProfiles)
    .where(eq(brandProfiles.clientId, client.id))
    .orderBy(desc(brandProfiles.version));

  const assets = await db
    .select()
    .from(referenceAssets)
    .where(eq(referenceAssets.clientId, client.id))
    .orderBy(desc(referenceAssets.createdAt));

  res.json({
    profile: live ?? null,
    questions: live ? fullQuestionSet(live.industryKey) : [],
    industry: live ? resolveIndustry(live.industryKey) : null,
    history,
    referenceAssets: assets.map((a) => ({ ...a, hasText: a.extractedText !== null })),
  });
}));

/**
 * Edits the live brand profile.
 *
 * Every edit creates a new version rather than mutating — brand memory is an audit trail, and
 * creative generated last month must remain interpretable against the brand as it stood then.
 */
governanceRouter.put('/brand', route(async (req, res) => {
  const client = await requireClient();
  const body = req.body as {
    core?: Record<string, unknown>;
    industry?: Record<string, unknown>;
    locks?: Record<string, boolean>;
    creativeDirection?: string | null;
    industryKey?: string;
  };

  const profileId = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${client.id}))`);

    const [current] = await tx
      .select()
      .from(brandProfiles)
      .where(and(eq(brandProfiles.clientId, client.id), isNull(brandProfiles.effectiveTo)));

    if (!current) throw new Error('there is no live brand profile to edit — complete onboarding first');

    const industryKey = body.industryKey ?? current.industryKey;

    await tx
      .update(brandProfiles)
      .set({ effectiveTo: new Date() })
      .where(eq(brandProfiles.id, current.id));

    const [inserted] = await tx
      .insert(brandProfiles)
      .values({
        clientId: client.id,
        version: current.version + 1,
        industryKey,
        complianceTemplateKey: complianceTemplateFor(industryKey),
        core: { ...(current.core as object), ...(body.core ?? {}) },
        industry: body.industry ?? (current.industry as object),
        locks: body.locks ?? (current.locks as object),
        creativeDirection:
          body.creativeDirection !== undefined ? body.creativeDirection : current.creativeDirection,
        createdBy: 'dashboard',
        sourceKind: 'MANUAL_EDIT',
      })
      .returning({ id: brandProfiles.id });

    return inserted!.id;
  });

  res.json({ ok: true, brandProfileId: profileId });
}));

// ---------------------------------------------------------------------------
// Reference assets
// ---------------------------------------------------------------------------

governanceRouter.post(
  '/assets',
  upload.single('file'),
  route(async (req, res) => {
    const client = await requireClient();
    const file = req.file;
    const { kind, usageNote } = req.body as { kind?: string; usageNote?: string };

    if (!file) {
      res.status(400).json({ error: 'no file was uploaded' });
      return;
    }

    const allowedKinds = ['LOGO', 'PAST_AD', 'POSTER', 'BRAND_VIDEO', 'STYLE_GUIDE', 'BRAND_DOCUMENT', 'OTHER'];
    const assetKind = allowedKinds.includes(String(kind)) ? String(kind) : 'OTHER';

    // Resolved once and used everywhere, so the stored type, the allowlist check, and the text
    // extractor all agree about what the file is.
    const mimeType = resolveMimeType(file.mimetype, file.originalname);
    const stored = await assetStore.put(file.originalname, mimeType, file.buffer);

    const [row] = await db
      .insert(referenceAssets)
      .values({
        clientId: client.id,
        kind: assetKind as 'LOGO',
        filename: safeFilename(file.originalname),
        mimeType,
        sizeBytes: stored.sizeBytes,
        storageKey: stored.storageKey,
        extractedText: extractText(mimeType, file.buffer),
        usageNote: usageNote ?? null,
        uploadedBy: 'dashboard',
      })
      .returning();

    res.json({ ok: true, asset: { ...row, hasText: row!.extractedText !== null } });
  }),
);

governanceRouter.get('/assets/:id/content', route(async (req, res) => {
  const client = await requireClient();
  const [asset] = await db
    .select()
    .from(referenceAssets)
    .where(and(eq(referenceAssets.id, String(req.params.id)), eq(referenceAssets.clientId, client.id)));
  if (!asset) {
    res.status(404).json({ error: 'asset not found' });
    return;
  }
  const bytes = await assetStore.get(asset.storageKey);
  res.setHeader('content-type', asset.mimeType);
  res.setHeader('content-disposition', `inline; filename="${asset.filename}"`);
  res.send(bytes);
}));

governanceRouter.patch('/assets/:id', route(async (req, res) => {
  const client = await requireClient();
  const { active, usageNote } = req.body as { active?: boolean; usageNote?: string };
  const updates: Record<string, unknown> = {};
  if (typeof active === 'boolean') updates.active = active;
  if (typeof usageNote === 'string') updates.usageNote = usageNote;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'nothing to update' });
    return;
  }
  await db
    .update(referenceAssets)
    .set(updates)
    .where(and(eq(referenceAssets.id, String(req.params.id)), eq(referenceAssets.clientId, client.id)));
  res.json({ ok: true });
}));

governanceRouter.delete('/assets/:id', route(async (req, res) => {
  const client = await requireClient();
  const [asset] = await db
    .select()
    .from(referenceAssets)
    .where(and(eq(referenceAssets.id, String(req.params.id)), eq(referenceAssets.clientId, client.id)));
  if (!asset) {
    res.status(404).json({ error: 'asset not found' });
    return;
  }
  await db.delete(referenceAssets).where(eq(referenceAssets.id, asset.id));
  await assetStore.remove(asset.storageKey);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Compliance configuration
// ---------------------------------------------------------------------------

governanceRouter.get('/compliance', route(async (_req, res) => {
  const client = await requireClient();

  const [profile] = await db
    .select()
    .from(brandProfiles)
    .where(and(eq(brandProfiles.clientId, client.id), isNull(brandProfiles.effectiveTo)));

  const industryKey = profile?.industryKey ?? null;
  const clientConfig = await loadClientComplianceConfig(db, client.id);

  const { rules, chain, refusedDisables } = assembleRules({
    industryKey,
    customRules: clientConfig.customRules,
    disabledRuleIds: clientConfig.disabledRuleIds,
    brand: brandConstraintsOf(profile),
  });

  const overrides = await db
    .select()
    .from(complianceRuleOverrides)
    .where(eq(complianceRuleOverrides.clientId, client.id));

  res.json({
    industryKey,
    industry: industryKey ? resolveIndustry(industryKey) : null,
    templateChain: chain,
    effectiveRules: rules,
    customRules: await db.select().from(complianceRules).where(eq(complianceRules.clientId, client.id)),
    overrides,
    refusedDisables,
  });
}));

const CustomRuleBody = ComplianceRuleSchema.omit({ mandatory: true });

governanceRouter.post('/compliance/rules', route(async (req, res) => {
  const client = await requireClient();
  const parsed = CustomRuleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid rule' });
    return;
  }

  const [profile] = await db
    .select()
    .from(brandProfiles)
    .where(and(eq(brandProfiles.clientId, client.id), isNull(brandProfiles.effectiveTo)));

  // Reject a key that collides with a template rule before it can be stored — the collision
  // would otherwise surface as a hard failure on the next generation run.
  const { rules: templateRules } = resolveComplianceRules(
    complianceTemplateFor(profile?.industryKey ?? null),
  );
  if (templateRules.some((r) => r.id === parsed.data.id)) {
    res.status(409).json({
      error: `"${parsed.data.id}" is already a rule in your industry template. Choose a different id.`,
    });
    return;
  }

  await db.insert(complianceRules).values({
    clientId: client.id,
    ruleKey: parsed.data.id,
    title: parsed.data.title,
    severity: parsed.data.severity,
    reason: parsed.data.reason,
    appliesTo: parsed.data.appliesTo as unknown as object,
    match: parsed.data.match as unknown as object,
    createdBy: 'dashboard',
  });

  res.json({ ok: true });
}));

governanceRouter.patch('/compliance/rules/:ruleKey', route(async (req, res) => {
  const client = await requireClient();
  const { enabled } = req.body as { enabled?: boolean };
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return;
  }
  await db
    .update(complianceRules)
    .set({ enabled })
    .where(and(eq(complianceRules.clientId, client.id), eq(complianceRules.ruleKey, String(req.params.ruleKey))));
  res.json({ ok: true });
}));

governanceRouter.delete('/compliance/rules/:ruleKey', route(async (req, res) => {
  const client = await requireClient();
  await db
    .delete(complianceRules)
    .where(and(eq(complianceRules.clientId, client.id), eq(complianceRules.ruleKey, String(req.params.ruleKey))));
  res.json({ ok: true });
}));

/**
 * Switch a template rule off.
 *
 * A mandatory rule cannot be disabled. The request is refused with an explanation rather than
 * silently ignored, so the interface never appears to have done something it did not.
 */
governanceRouter.post('/compliance/overrides', route(async (req, res) => {
  const client = await requireClient();
  const { templateRuleId, disabled, justification } = req.body as {
    templateRuleId?: string;
    disabled?: boolean;
    justification?: string;
  };
  if (!templateRuleId) {
    res.status(400).json({ error: 'templateRuleId is required' });
    return;
  }

  const [profile] = await db
    .select()
    .from(brandProfiles)
    .where(and(eq(brandProfiles.clientId, client.id), isNull(brandProfiles.effectiveTo)));

  const { rules } = resolveComplianceRules(complianceTemplateFor(profile?.industryKey ?? null));
  const rule = rules.find((r) => r.id === templateRuleId);
  if (!rule) {
    res.status(404).json({ error: `"${templateRuleId}" is not a rule in your industry template` });
    return;
  }
  if (rule.mandatory && disabled !== false) {
    res.status(409).json({
      error: `"${rule.title}" is mandatory for your industry and cannot be switched off. You can add stricter rules, but not remove this one.`,
      ruleId: rule.id,
    });
    return;
  }

  await db
    .insert(complianceRuleOverrides)
    .values({
      clientId: client.id,
      templateRuleId,
      disabled: disabled !== false,
      justification: justification ?? null,
      createdBy: 'dashboard',
    })
    .onConflictDoUpdate({
      target: [complianceRuleOverrides.clientId, complianceRuleOverrides.templateRuleId],
      set: { disabled: disabled !== false, justification: justification ?? null },
    });

  res.json({ ok: true });
}));

/** Dry-run the rule set against arbitrary text, so a client can see it work before trusting it. */
governanceRouter.post('/compliance/test', route(async (req, res) => {
  const client = await requireClient();
  const { headline, primaryText, cta, imageConcept } = req.body as Record<string, string>;

  const [profile] = await db
    .select()
    .from(brandProfiles)
    .where(and(eq(brandProfiles.clientId, client.id), isNull(brandProfiles.effectiveTo)));

  const clientConfig = await loadClientComplianceConfig(db, client.id);
  const verdict = checkContent(
    {
      headline: headline ?? '',
      primaryText: primaryText ?? '',
      cta: cta ?? '',
      ...(imageConcept ? { imageConcept } : {}),
    },
    {
      industryKey: profile?.industryKey ?? null,
      customRules: clientConfig.customRules,
      disabledRuleIds: clientConfig.disabledRuleIds,
      brand: brandConstraintsOf(profile),
    },
  );

  res.json(verdict);
}));

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

governanceRouter.get('/reviews', route(async (req, res) => {
  const client = await requireClient();
  const status = req.query.status ? String(req.query.status) : null;

  const rows = await db
    .select({
      review: creativeReviews,
      imageUrl: creativeAssets.url,
    })
    .from(creativeReviews)
    .leftJoin(creativeAssets, eq(creativeReviews.imageAssetId, creativeAssets.id))
    .where(
      status
        ? and(eq(creativeReviews.clientId, client.id), eq(creativeReviews.status, status as 'PENDING_REVIEW'))
        : eq(creativeReviews.clientId, client.id),
    )
    .orderBy(desc(creativeReviews.createdAt))
    .limit(200);

  const counts = await db
    .select({ status: creativeReviews.status, n: sql<string>`COUNT(*)` })
    .from(creativeReviews)
    .where(eq(creativeReviews.clientId, client.id))
    .groupBy(creativeReviews.status);

  res.json({
    reviews: rows.map((r) => ({ ...r.review, imageUrl: r.imageUrl })),
    counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
  });
}));

/** Generate a fresh batch into the review queue. */
governanceRouter.post('/reviews/generate', route(async (req, res) => {
  const client = await requireClient();
  const { campaignBriefId, variantCount } = req.body as {
    campaignBriefId?: string;
    variantCount?: number;
  };

  const result = await generateGoverned(db, {
    clientId: client.id,
    ...(campaignBriefId ? { campaignBriefId } : {}),
    ...(variantCount ? { variantCount: Math.min(Math.max(1, variantCount), 12) } : {}),
  });

  res.json(result);
}));

/** Edit copy. Re-runs compliance, because fixing a block must not be a way around it. */
governanceRouter.put('/reviews/:id', route(async (req, res) => {
  const client = await requireClient();
  const { headline, primaryText, cta, imageConcept } = req.body as Record<string, string>;

  const [existing] = await db
    .select()
    .from(creativeReviews)
    .where(and(eq(creativeReviews.id, String(req.params.id)), eq(creativeReviews.clientId, client.id)));
  if (!existing) {
    res.status(404).json({ error: 'review item not found' });
    return;
  }

  const result = await recheckReview(
    db,
    existing.id,
    {
      headline: headline ?? existing.headline,
      primaryText: primaryText ?? existing.primaryText,
      cta: cta ?? existing.cta,
      ...(imageConcept ?? existing.imageConcept
        ? { imageConcept: imageConcept ?? existing.imageConcept! }
        : {}),
    },
    'dashboard',
  );

  res.json({ ok: true, ...result });
}));

governanceRouter.post('/reviews/:id/decision', route(async (req, res) => {
  const client = await requireClient();
  const { action, reason } = req.body as { action?: string; reason?: string };

  const [existing] = await db
    .select()
    .from(creativeReviews)
    .where(and(eq(creativeReviews.id, String(req.params.id)), eq(creativeReviews.clientId, client.id)));
  if (!existing) {
    res.status(404).json({ error: 'review item not found' });
    return;
  }

  if (action === 'approve') {
    if (existing.complianceBlocked) {
      res.status(409).json({
        error:
          'This item is blocked by a compliance rule and cannot be approved. Edit the copy to resolve the block, or reject it.',
      });
      return;
    }
    await db
      .update(creativeReviews)
      .set({ status: 'APPROVED', reviewedBy: 'dashboard', reviewedAt: new Date() })
      .where(eq(creativeReviews.id, existing.id));
    res.json({ ok: true, status: 'APPROVED' });
    return;
  }

  if (action === 'reject') {
    await db
      .update(creativeReviews)
      .set({
        status: 'REJECTED',
        reviewedBy: 'dashboard',
        reviewedAt: new Date(),
        rejectionReason: reason ?? null,
      })
      .where(eq(creativeReviews.id, existing.id));
    res.json({ ok: true, status: 'REJECTED' });
    return;
  }

  res.status(400).json({ error: "action must be 'approve' or 'reject'" });
}));

// ---------------------------------------------------------------------------
// Campaign briefs
// ---------------------------------------------------------------------------

governanceRouter.get('/briefs', route(async (_req, res) => {
  const client = await requireClient();
  const rows = await db
    .select()
    .from(campaignBriefs)
    .where(eq(campaignBriefs.clientId, client.id))
    .orderBy(desc(campaignBriefs.createdAt));
  res.json({ briefs: rows });
}));

governanceRouter.post('/briefs', route(async (req, res) => {
  const client = await requireClient();
  const body = req.body as Record<string, unknown>;

  const [profile] = await db
    .select()
    .from(brandProfiles)
    .where(and(eq(brandProfiles.clientId, client.id), isNull(brandProfiles.effectiveTo)));
  if (!profile) {
    res.status(409).json({ error: 'complete brand onboarding before creating a campaign' });
    return;
  }

  const types = ['awareness', 'conversion', 'retargeting', 'launch', 'seasonal'];
  const campaignType = String(body.campaignType ?? '');
  if (!types.includes(campaignType)) {
    res.status(400).json({ error: `campaignType must be one of: ${types.join(', ')}` });
    return;
  }

  const variantCount = Number(body.variantCount ?? 4);
  const budget = Number(body.dailyBudgetPerVariantCents ?? 0);
  if (!Number.isInteger(variantCount) || variantCount < 1 || variantCount > 20) {
    res.status(400).json({ error: 'variantCount must be between 1 and 20' });
    return;
  }
  if (!Number.isInteger(budget) || budget <= 0) {
    res.status(400).json({ error: 'dailyBudgetPerVariantCents must be a positive whole number of cents' });
    return;
  }

  const [row] = await db
    .insert(campaignBriefs)
    .values({
      clientId: client.id,
      brandProfileId: profile.id,
      name: String(body.name ?? 'Untitled campaign'),
      campaignType,
      placements: (body.placements ?? []) as object,
      toneOverride: body.toneOverride ? String(body.toneOverride) : null,
      briefNotes: body.briefNotes ? String(body.briefNotes) : null,
      landingPageUrl: String(body.landingPageUrl ?? ''),
      variantCount,
      dailyBudgetPerVariantCents: budget,
      createdBy: 'dashboard',
    })
    .returning();

  res.json({ ok: true, brief: row });
}));

/**
 * Launches every APPROVED, not-yet-launched review under this brief as a live (or
 * paused-for-eyeballing) test. This is the step that actually spends money — everything
 * before it (generation, compliance, human approval) is preparation.
 */
governanceRouter.post('/briefs/:id/launch', route(async (req, res) => {
  const client = await requireClient();
  const briefId = String(req.params.id);
  const body = req.body as Record<string, unknown>;

  const adAccountId = body.adAccountId ? String(body.adAccountId) : '';
  if (!adAccountId) {
    res.status(400).json({ error: 'adAccountId is required' });
    return;
  }

  const targeting = body.targeting as Partial<TargetingSpec> | undefined;
  if (!targeting || !Array.isArray(targeting.countries) || targeting.countries.length === 0) {
    res.status(400).json({ error: 'targeting.countries must be a non-empty array of country codes' });
    return;
  }

  const campaignName = body.campaignName ? String(body.campaignName) : '';
  const cohortName = body.cohortName ? String(body.cohortName) : '';
  if (!campaignName || !cohortName) {
    res.status(400).json({ error: 'campaignName and cohortName are required' });
    return;
  }

  let resolved;
  try {
    resolved = await adapterFor(adAccountId);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'could not resolve that ad account' });
    return;
  }

  try {
    const result = await launchApprovedReviews(db, resolved.adapter, {
      clientId: client.id,
      campaignBriefId: briefId,
      adAccountId,
      campaignName,
      cohortName,
      targeting: targeting as TargetingSpec,
      startPaused: body.startPaused !== false,
      accessToken: resolved.accessToken,
      platformConfig: resolved.platformConfig,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof LaunchError) {
      res.status(409).json({ error: error.message, stage: error.stage });
      return;
    }
    throw error;
  }
}));
