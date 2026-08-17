/**
 * Cron wiring: performance ingestion, the decision cycle, and interrupted-action recovery.
 *
 * Two rules shape the schedule:
 *
 *  1. **Ingestion is frequent, decisions are not.** Performance is pulled every three hours so
 *     the dashboard stays current, but decisions run once a day. With a 72-hour attribution
 *     settling window, evaluating more often adds no information — the settled data has not
 *     changed since the last pass.
 *
 *  2. **Reconciliation runs at startup, before anything else.** A process that died mid-action
 *     left rows in EXECUTING; those must be resolved against the platform before a new cycle
 *     can reason about the account's state.
 */
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { adAccounts, adVariants, campaigns, dailyPerformance } from '../db/schema.js';
import { MockPlatformAdapter } from '../platform/mock/mockAdapter.js';
import { MetaPlatformAdapter } from '../platform/meta/metaAdapter.js';
import { decryptToken } from '../security/tokenCrypto.js';
import { CircuitBreaker } from '../platform/resilience.js';
import { reconcileInterrupted } from '../decisions/executor.js';
import { runDecisionCycle, type CycleResult } from './cycle.js';
import { addDays, currentDateInZone } from '../time/zonedDate.js';
import { env } from '../config/env.js';
import type { PlatformAdapter } from '../platform/types.js';

/**
 * Adapter resolution.
 *
 * Only the mock is wired today — the Meta adapter is deliberately the last thing built, so
 * that debugging it means debugging one adapter rather than the adapter and the core at once.
 * Ad account tokens are decrypted here and never leave this boundary.
 */
export interface ResolvedAdapter {
  readonly adapter: PlatformAdapter;
  readonly accessToken: string;
  readonly platformConfig: Record<string, unknown> | null;
}

export async function adapterFor(adAccountId: string): Promise<ResolvedAdapter> {
  const [account] = await db.select().from(adAccounts).where(eq(adAccounts.id, adAccountId));
  if (!account) throw new Error(`unknown ad account ${adAccountId}`);

  const platformConfig = (account.platformConfig as Record<string, unknown> | null) ?? null;

  if (account.platform === 'META') {
    if (!account.accessTokenCiphertext || account.tokenKeyVersion === null) {
      throw new Error(
        `ad account ${adAccountId} has no stored access token — connect it via POST /api/accounts/connect first`,
      );
    }
    const accessToken = decryptToken(account.accessTokenCiphertext, account.tokenKeyVersion);
    return { adapter: new MetaPlatformAdapter(db), accessToken, platformConfig };
  }

  if (account.platform !== 'MOCK') {
    throw new Error(
      `no adapter is implemented for ${account.platform} yet; only MOCK and META accounts can run a cycle`,
    );
  }

  const variants = await db
    .select({ platformAdId: adVariants.platformAdId })
    .from(adVariants)
    .innerJoin(campaigns, eq(adVariants.campaignId, campaigns.id))
    .where(eq(campaigns.adAccountId, adAccountId));

  const adapter = new MockPlatformAdapter({
    seed: 20260805,
    variants: variants
      .filter((v) => v.platformAdId !== null)
      .map((v) => ({
        platformAdId: v.platformAdId!,
        trueCtr: 0.02,
        trueCvr: 0.005,
        avgOrderValueCents: 12_000,
        impressionsPerDollar: 200,
      })),
  });

  return { adapter, accessToken: 'mock-token', platformConfig };
}

/** Pulls fresh performance for every active variant and appends it as new snapshots. */
export async function ingestPerformance(): Promise<{ rowsWritten: number; errors: string[] }> {
  const errors: string[] = [];
  let rowsWritten = 0;

  const accounts = await db.select().from(adAccounts).where(eq(adAccounts.status, 'ACTIVE'));

  for (const account of accounts) {
    try {
      const variants = await db
        .select({ id: adVariants.id, platformAdId: adVariants.platformAdId })
        .from(adVariants)
        .innerJoin(campaigns, eq(adVariants.campaignId, campaigns.id))
        .where(eq(campaigns.adAccountId, account.id));

      const live = variants.filter((v) => v.platformAdId !== null);
      if (live.length === 0) continue;

      const { adapter, accessToken } = await adapterFor(account.id);
      const today = currentDateInZone(new Date(), account.timezone);

      const rows = await adapter.getPerformanceData(
        {
          platformAdIds: live.map((v) => v.platformAdId!),
          // Re-pull a week so restatements inside the attribution window are captured.
          since: addDays(today, -7),
          until: today,
        },
        {
          adAccountId: account.id,
          platformAccountId: account.platformAccountId,
          accessToken,
          currency: account.currency,
          timezone: account.timezone,
        },
      );

      const byPlatformId = new Map(live.map((v) => [v.platformAdId!, v.id]));
      const fetchedAt = new Date();

      for (const row of rows) {
        const variantId = byPlatformId.get(row.platformAdId);
        if (!variantId) continue;
        await db.insert(dailyPerformance).values({
          adVariantId: variantId,
          statDate: row.statDate,
          fetchedAt,
          impressions: row.impressions,
          clicks: row.clicks,
          spendCents: row.spendCents,
          conversions: row.conversions,
          conversionValueCents: row.conversionValueCents,
          currency: row.currency,
          source: account.platform === 'MOCK' ? 'MOCK' : 'PLATFORM',
          rawPayload: row.raw as object,
        });
        rowsWritten += 1;
      }

      await db
        .update(adAccounts)
        .set({ lastSyncedAt: fetchedAt })
        .where(eq(adAccounts.id, account.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${account.id}: ${message}`);
      await db
        .update(adAccounts)
        .set({ lastErrorAt: new Date(), lastError: message })
        .where(eq(adAccounts.id, account.id));
    }
  }

  return { rowsWritten, errors };
}

export async function runCycleNow(): Promise<CycleResult> {
  return runDecisionCycle({ db, adapterFor });
}

/** Resolves any action that was in flight when the process last stopped. */
export async function recoverInterrupted(): Promise<number> {
  const accounts = await db.select().from(adAccounts).where(eq(adAccounts.status, 'ACTIVE'));
  let total = 0;
  for (const account of accounts) {
    try {
      const { adapter, accessToken } = await adapterFor(account.id);
      total += await reconcileInterrupted({
        db,
        adapter,
        adapterContext: {
          adAccountId: account.id,
          platformAccountId: account.platformAccountId,
          accessToken,
          currency: account.currency,
          timezone: account.timezone,
        },
        breaker: new CircuitBreaker(),
        now: () => new Date(),
      });
    } catch {
      // An account we cannot reach cannot be reconciled now; the rows stay IN_FLIGHT and are
      // retried on the next startup rather than being wrongly marked dead.
    }
  }
  return total;
}

export interface SchedulerHandle {
  stop(): Promise<void>;
}

/**
 * Registers the recurring jobs (ingest every 3h, decide daily at 06:00) and starts the
 * workers that process them. Idempotent to call on every boot — see queue.ts.
 */
export async function startScheduler(): Promise<SchedulerHandle> {
  const { scheduleRecurringJobs, closeQueues } = await import('./queue.js');
  const { startWorkers } = await import('./worker.js');

  await scheduleRecurringJobs();
  const workers = startWorkers();

  console.log('[scheduler] ingestion every 3h, decision cycle daily at 06:00 (BullMQ + Redis)');
  if (!env.executionEnabled) {
    console.warn('[scheduler] EXECUTION_ENABLED is false — decisions will be recorded but never executed');
  }

  return {
    async stop() {
      await Promise.all(workers.map((w) => w.close()));
      await closeQueues();
    },
  };
}

// Run standalone: `tsx src/scheduler/index.ts`
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  void (async () => {
    const recovered = await recoverInterrupted();
    if (recovered > 0) console.log(`[startup] reconciled ${recovered} interrupted action(s)`);
    const handle = await startScheduler();
    const shutdown = () => {
      void handle.stop().then(() => pool.end()).then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })();
}
