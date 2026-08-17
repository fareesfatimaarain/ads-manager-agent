/**
 * Creates or resets the password of a dashboard admin. Deliberately a script run with
 * deployment access, not an HTTP endpoint — see the note at the top of api/auth.ts.
 *
 *   npm run admin:create -- --email=you@example.com --password="at least 12 characters"
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { adminUsers } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function main(): Promise<void> {
  const email = arg('email')?.toLowerCase().trim();
  const password = arg('password');

  if (!email || !email.includes('@')) {
    throw new Error(
      'usage: npm run admin:create -- --email=you@example.com --password="at least 12 characters"',
    );
  }
  if (!password || password.length < 12) {
    throw new Error('password must be at least 12 characters');
  }

  const passwordHash = await hashPassword(password);
  const [existing] = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.email, email));

  if (existing) {
    await db
      .update(adminUsers)
      .set({ passwordHash, disabledAt: null })
      .where(eq(adminUsers.id, existing.id));
    console.log(`Password updated (and account re-enabled if it was disabled) for ${email}.`);
  } else {
    await db.insert(adminUsers).values({ email, passwordHash });
    console.log(`Admin account created for ${email}.`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
