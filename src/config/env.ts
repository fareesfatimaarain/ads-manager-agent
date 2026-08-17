import 'dotenv/config';

/**
 * Environment configuration, validated once at startup.
 *
 * Everything that can fail at boot should fail at boot. A missing encryption key discovered
 * during a decision cycle is a far worse outcome than a process that refuses to start.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}

export const env = {
  databaseUrl: required('DATABASE_URL'),
  redisUrl: optional('REDIS_URL', 'redis://localhost:6380'),
  port: Number(optional('PORT', '3000')),
  nodeEnv: optional('NODE_ENV', 'development'),

  /**
   * Deployment-level master switch. Deliberately not reachable from the dashboard — a global
   * halt should require access to the deployment, not a misplaced click in a browser.
   * Per-client pausing is available in the UI instead.
   */
  executionEnabled: bool('EXECUTION_ENABLED', true),

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
  /** Copy generation model. Opus-tier because ad copy quality compounds across every test. */
  copyModel: optional('COPY_MODEL', 'claude-opus-5'),

  ideogramApiKey: process.env.IDEOGRAM_API_KEY ?? null,
  /** Falls back to the deterministic mock when no image provider is configured. */
  imageProvider: optional('IMAGE_PROVIDER', 'mock') as 'mock' | 'ideogram',

  /**
   * AES-256-GCM key for ad account tokens, base64, 32 bytes. Versioned keys
   * (TOKEN_ENCRYPTION_KEY_V2, _V3, ...) are read directly by src/security/tokenCrypto.ts;
   * this is kept here only so a missing key is visible in one place at a glance.
   */
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY ?? null,

  metaAppId: process.env.META_APP_ID ?? null,
  metaAppSecret: process.env.META_APP_SECRET ?? null,
  metaApiVersion: optional('META_API_VERSION', 'v21.0'),
} as const;

export function assertCreativeConfigured(): void {
  if (!env.anthropicApiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set — copy generation is unavailable. ' +
        'Set it in .env, or use the mock generator for local work.',
    );
  }
}
