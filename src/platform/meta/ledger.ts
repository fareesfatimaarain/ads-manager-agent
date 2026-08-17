/**
 * The durable idempotency record a real adapter needs and Meta doesn't provide. See the doc
 * comment on the `platformMutationLedger` table for why this exists.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { platformMutationLedger } from '../../db/schema.js';
import type { Platform, PriorAttempt } from '../types.js';

export async function recordApplied(
  db: Database,
  platform: Platform,
  idempotencyKey: string,
  method: string,
  platformEntityId: string | null,
  result: unknown,
  appliedAt: Date,
): Promise<void> {
  await db
    .insert(platformMutationLedger)
    .values({
      idempotencyKey,
      platform,
      method,
      platformEntityId,
      resultJson: result as object,
      appliedAt,
    })
    // A retry that reaches this point after the platform call already succeeded once (e.g.
    // the response was lost) must not fail on the ledger write itself — the row is already
    // exactly what we're about to insert.
    .onConflictDoNothing();
}

export async function findApplied(db: Database, idempotencyKey: string): Promise<PriorAttempt> {
  const [row] = await db
    .select()
    .from(platformMutationLedger)
    .where(eq(platformMutationLedger.idempotencyKey, idempotencyKey));
  if (!row) return { found: false, platformEntityId: null, appliedAt: null };
  return {
    found: true,
    platformEntityId: row.platformEntityId,
    appliedAt: row.appliedAt.toISOString(),
  };
}
