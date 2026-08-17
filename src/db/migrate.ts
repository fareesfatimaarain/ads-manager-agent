import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './index.js';

async function main(): Promise<void> {
  console.log('running migrations...');
  await migrate(db, { migrationsFolder: 'src/db/migrations' });
  console.log('migrations complete');
  await pool.end();
}

main().catch((err: unknown) => {
  console.error('migration failed:', err);
  process.exitCode = 1;
  void pool.end();
});
