import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

/**
 * `pg` returns bigint (int8) and numeric as strings by default to avoid silent precision
 * loss. That default is correct and we keep it — but it means every money column arrives as
 * a string. Drizzle's `mode: 'number'` handles the bigint columns; `numeric` columns are
 * parsed explicitly at the config boundary (see parseGuardrailConfig). Nothing in this
 * codebase may do arithmetic on a raw numeric column value.
 */
export const pool = new pg.Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export const db = drizzle(pool, { schema });
export type Database = typeof db;
export { schema };
