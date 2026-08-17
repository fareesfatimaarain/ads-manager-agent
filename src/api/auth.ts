/**
 * Login, logout, session check, and the middleware that gates everything else under /api.
 *
 * There is deliberately no "create the first admin" endpoint here. An unauthenticated route
 * that can mint an account with real access is a standing invitation; the first admin is
 * created from the deployment via `npm run admin:create`, the same trust boundary that
 * already governs EXECUTION_ENABLED and the database itself.
 */
import express from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { adminUsers } from '../db/schema.js';
import { DUMMY_HASH_PROMISE, verifyPassword } from '../auth/password.js';
import {
  clearSessionCookieHeader,
  createSession,
  parseCookies,
  resolveSession,
  revokeSession,
  sessionCookieHeader,
  SESSION_COOKIE,
  type AuthedUser,
} from '../auth/session.js';
import { env } from '../config/env.js';

export interface AuthedRequest extends express.Request {
  user?: AuthedUser;
}

const secureCookies = env.nodeEnv === 'production';

export const authRouter = express.Router();

authRouter.post('/auth/login', async (req, res) => {
  const { email, password } = req.body as { email?: unknown; password?: unknown };
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  const [user] = await db.select().from(adminUsers).where(eq(adminUsers.email, email.toLowerCase().trim()));

  // Always do the same async work on the same code path, whether or not the email exists —
  // see password.ts for why.
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await DUMMY_HASH_PROMISE));

  if (!user || user.disabledAt || !passwordOk) {
    res.status(401).json({ error: 'invalid email or password' });
    return;
  }

  const userAgent = req.headers['user-agent'];
  const { token, expiresAt } = await createSession(
    db,
    user.id,
    typeof userAgent === 'string' ? userAgent.slice(0, 300) : null,
  );
  await db.update(adminUsers).set({ lastLoginAt: new Date() }).where(eq(adminUsers.id, user.id));

  res.setHeader('Set-Cookie', sessionCookieHeader(token, expiresAt, secureCookies));
  res.json({ ok: true, user: { id: user.id, email: user.email, role: user.role } });
});

authRouter.post('/auth/logout', async (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) await revokeSession(db, token);
  res.setHeader('Set-Cookie', clearSessionCookieHeader(secureCookies));
  res.json({ ok: true });
});

authRouter.get('/auth/me', async (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const user = await resolveSession(db, token);
  if (!user) {
    res.status(401).json({ error: 'not signed in' });
    return;
  }
  res.json({ user });
});

/**
 * Gates every route registered after it. Mount order in server.ts matters: `/api/health` and
 * this router's own routes must be registered before this middleware, everything else after.
 */
export function requireAuth(req: AuthedRequest, res: express.Response, next: express.NextFunction): void {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  resolveSession(db, token)
    .then((user) => {
      if (!user) {
        res.status(401).json({ error: 'not signed in' });
        return;
      }
      req.user = user;
      next();
    })
    .catch(next);
}
