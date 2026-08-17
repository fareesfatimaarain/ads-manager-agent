/**
 * Server-side sessions. Deliberately not a JWT: revoking access has to be immediate — an
 * offboarded admin's session must stop working the moment someone revokes it, and a
 * self-verifying token can't do that without a denylist, which is this table by another name.
 * So the token is opaque and the database is the source of truth on every request.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { adminSessions, adminUsers } from '../db/schema.js';

export const SESSION_COOKIE = 'ads_session';

/** Idle-expiry window. Sliding: a session that keeps getting used keeps getting extended. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface AuthedUser {
  readonly id: string;
  readonly email: string;
  readonly role: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  db: Database,
  userId: string,
  userAgent: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(adminSessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    userAgent,
  });
  return { token, expiresAt };
}

/**
 * Verifies a session token and, if valid, slides its expiry forward. Returns null for
 * anything that isn't a live, unrevoked session belonging to an enabled user — the caller
 * never needs to know which of those was false.
 */
export async function resolveSession(db: Database, token: string | undefined): Promise<AuthedUser | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const now = new Date();

  const [row] = await db
    .select({
      sessionId: adminSessions.id,
      userId: adminUsers.id,
      email: adminUsers.email,
      role: adminUsers.role,
      disabledAt: adminUsers.disabledAt,
    })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminSessions.userId, adminUsers.id))
    .where(
      and(
        eq(adminSessions.tokenHash, tokenHash),
        isNull(adminSessions.revokedAt),
        gt(adminSessions.expiresAt, now),
      ),
    );

  if (!row || row.disabledAt) return null;

  await db
    .update(adminSessions)
    .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
    .where(eq(adminSessions.id, row.sessionId));

  return { id: row.userId, email: row.email, role: row.role };
}

export async function revokeSession(db: Database, token: string): Promise<void> {
  await db
    .update(adminSessions)
    .set({ revokedAt: new Date() })
    .where(eq(adminSessions.tokenHash, hashToken(token)));
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

export function sessionCookieHeader(token: string, expiresAt: Date, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearSessionCookieHeader(secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}
