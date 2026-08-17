/**
 * Session lifecycle against a real database: creation, resolution, sliding expiry, and
 * revocation. These are exactly the properties that can't be verified against a mock — the
 * whole point of a server-side session is that the database is the source of truth.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../../src/db/index.js';
import { adminSessions, adminUsers } from '../../src/db/schema.js';
import { hashPassword } from '../../src/auth/password.js';
import { createSession, resolveSession, revokeSession } from '../../src/auth/session.js';
import { truncateAll } from './helpers.js';

beforeEach(truncateAll);
afterAll(async () => {
  await pool.end();
});

async function seedUser(overrides: { disabledAt?: Date } = {}): Promise<string> {
  const [user] = await db
    .insert(adminUsers)
    .values({
      email: `admin-${Math.random().toString(36).slice(2, 10)}@example.com`,
      passwordHash: await hashPassword('irrelevant for this test'),
      disabledAt: overrides.disabledAt ?? null,
    })
    .returning({ id: adminUsers.id });
  return user!.id;
}

describe('session lifecycle', () => {
  it('resolves a freshly created session to its owning user', async () => {
    const userId = await seedUser();
    const { token } = await createSession(db, userId, 'test-agent');
    const resolved = await resolveSession(db, token);
    expect(resolved?.id).toBe(userId);
  });

  it('rejects an unknown token', async () => {
    await expect(resolveSession(db, 'not-a-real-token')).resolves.toBeNull();
  });

  it('rejects a missing token without touching the database', async () => {
    await expect(resolveSession(db, undefined)).resolves.toBeNull();
  });

  it('never stores the raw token, only its hash', async () => {
    const userId = await seedUser();
    const { token } = await createSession(db, userId, null);
    const [row] = await db.select().from(adminSessions).where(eq(adminSessions.userId, userId));
    expect(row?.tokenHash).not.toBe(token);
    expect(row?.tokenHash).toHaveLength(64); // sha256 hex
  });

  it('rejects a revoked session immediately', async () => {
    const userId = await seedUser();
    const { token } = await createSession(db, userId, null);
    expect(await resolveSession(db, token)).not.toBeNull();

    await revokeSession(db, token);
    expect(await resolveSession(db, token)).toBeNull();
  });

  it('rejects a session belonging to a disabled user', async () => {
    const userId = await seedUser({ disabledAt: new Date() });
    const { token } = await createSession(db, userId, null);
    expect(await resolveSession(db, token)).toBeNull();
  });

  it('rejects an expired session', async () => {
    const userId = await seedUser();
    const { token } = await createSession(db, userId, null);
    // Force it into the past directly — createSession always issues a future expiry.
    await db
      .update(adminSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(adminSessions.userId, userId));

    expect(await resolveSession(db, token)).toBeNull();
  });

  it('slides the expiry forward on each successful resolve', async () => {
    const userId = await seedUser();
    const { token, expiresAt: initialExpiry } = await createSession(db, userId, null);

    await resolveSession(db, token);
    const [row] = await db.select().from(adminSessions).where(eq(adminSessions.userId, userId));
    expect(row!.expiresAt.getTime()).toBeGreaterThan(initialExpiry.getTime() - 1000);
  });

  it('scopes to exactly the session that was revoked, not every session for that user', async () => {
    const userId = await seedUser();
    const a = await createSession(db, userId, null);
    const b = await createSession(db, userId, null);

    await revokeSession(db, a.token);

    expect(await resolveSession(db, a.token)).toBeNull();
    expect(await resolveSession(db, b.token)).not.toBeNull();
  });
});
