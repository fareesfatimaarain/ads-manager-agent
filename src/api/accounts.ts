/**
 * Connecting a real ad account.
 *
 * Deliberately a token paste, not a browser OAuth redirect. Meta's standard OAuth flow issues
 * a ~60-day user token that needs re-consent before it expires — fine for a person clicking
 * through a dashboard, wrong for a scheduler that has to keep running unattended for months.
 * The standard fix or unattended automation is a Business Manager **System User token**,
 * which doesn't expire on that clock and is generated once, outside this app, in Meta's
 * Business Settings. This endpoint accepts that token directly rather than building a
 * redirect flow this system can't act on once the token it produces goes stale.
 *
 * A token is never stored unless it has first been proven to work: this calls
 * `getAccountStatus` against the real adapter before writing anything, and refuses if the
 * account isn't active. Nothing here ever returns a token in a response.
 */
import express from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { adAccounts } from '../db/schema.js';
import { encryptToken, isTokenEncryptionConfigured, TokenCryptoError } from '../security/tokenCrypto.js';
import { MetaPlatformAdapter } from '../platform/meta/metaAdapter.js';
import type { AdapterContext, PlatformAdapter } from '../platform/types.js';
import { requireClient } from './governance.js';

export const accountsRouter = express.Router();

const route =
  (handler: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) => {
    handler(req, res).catch((error: unknown) => {
      console.error(`${req.method} ${req.path} failed:`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'internal error' });
      }
    });
  };

function adapterFor(platform: string): PlatformAdapter | null {
  if (platform === 'META') return new MetaPlatformAdapter(db);
  return null;
}

accountsRouter.get('/accounts', route(async (_req, res) => {
  const client = await requireClient();
  const rows = await db
    .select({
      id: adAccounts.id,
      platform: adAccounts.platform,
      platformAccountId: adAccounts.platformAccountId,
      name: adAccounts.name,
      currency: adAccounts.currency,
      timezone: adAccounts.timezone,
      status: adAccounts.status,
      platformConfig: adAccounts.platformConfig,
      tokenExpiresAt: adAccounts.tokenExpiresAt,
      lastSyncedAt: adAccounts.lastSyncedAt,
      lastErrorAt: adAccounts.lastErrorAt,
      lastError: adAccounts.lastError,
    })
    .from(adAccounts)
    .where(eq(adAccounts.clientId, client.id));
  // accessTokenCiphertext/refreshTokenCiphertext are deliberately excluded from the select —
  // not just unread, structurally impossible for this endpoint to leak.
  res.json({ accounts: rows });
}));

accountsRouter.post('/accounts/connect', route(async (req, res) => {
  const client = await requireClient();
  const body = req.body as Record<string, unknown>;

  const platform = String(body.platform ?? '');
  const adapter = adapterFor(platform);
  if (!adapter) {
    res.status(400).json({ error: 'platform must be one of: META (the only real adapter implemented so far)' });
    return;
  }

  const platformAccountId = String(body.platformAccountId ?? '').trim();
  const accessToken = String(body.accessToken ?? '').trim();
  const name = String(body.name ?? '').trim();
  const currency = String(body.currency ?? '').trim().toUpperCase();
  const timezone = String(body.timezone ?? '').trim();
  const platformConfig =
    body.platformConfig && typeof body.platformConfig === 'object'
      ? (body.platformConfig as Record<string, unknown>)
      : null;

  if (!platformAccountId || !accessToken || !name || !currency || !timezone) {
    res.status(400).json({
      error: 'platformAccountId, accessToken, name, currency and timezone are all required',
    });
    return;
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    res.status(400).json({ error: 'currency must be a 3-letter ISO 4217 code, e.g. USD' });
    return;
  }
  if (!isTokenEncryptionConfigured()) {
    res.status(503).json({
      error: 'TOKEN_ENCRYPTION_KEY is not configured on this deployment — refusing to store a token it cannot encrypt',
    });
    return;
  }

  // Prove the token works before it's ever written anywhere.
  const probeCtx: AdapterContext = {
    adAccountId: 'pending-connection',
    platformAccountId,
    accessToken,
    currency,
    timezone,
    ...(platformConfig ? { platformConfig } : {}),
  };
  let status;
  try {
    status = await adapter.getAccountStatus(probeCtx);
  } catch (error) {
    res.status(400).json({
      error: `could not verify this token against ${platform}: ${error instanceof Error ? error.message : 'unknown error'}`,
    });
    return;
  }
  if (!status.isActive) {
    res.status(400).json({
      error: `${platform} reports this account is not active (${status.disabledReason ?? 'reason not given'}) — connect an active account`,
    });
    return;
  }

  let encrypted;
  try {
    encrypted = encryptToken(accessToken);
  } catch (error) {
    if (error instanceof TokenCryptoError) {
      res.status(503).json({ error: error.message });
      return;
    }
    throw error;
  }

  const refreshTokenRaw = body.refreshToken ? String(body.refreshToken).trim() : '';
  const refreshEncrypted = refreshTokenRaw ? encryptToken(refreshTokenRaw) : null;
  const tokenExpiresAt = body.tokenExpiresAt ? new Date(String(body.tokenExpiresAt)) : null;
  if (tokenExpiresAt && Number.isNaN(tokenExpiresAt.getTime())) {
    res.status(400).json({ error: 'tokenExpiresAt must be a valid date if provided' });
    return;
  }

  const [existing] = await db
    .select({ id: adAccounts.id })
    .from(adAccounts)
    .where(
      and(
        eq(adAccounts.clientId, client.id),
        eq(adAccounts.platform, platform as 'META'),
        eq(adAccounts.platformAccountId, platformAccountId),
      ),
    );

  const commonFields = {
    name,
    currency,
    timezone,
    accessTokenCiphertext: encrypted.ciphertext,
    refreshTokenCiphertext: refreshEncrypted?.ciphertext ?? null,
    tokenKeyVersion: encrypted.keyVersion,
    tokenExpiresAt,
    platformConfig: platformConfig as object | null,
    status: 'ACTIVE' as const,
    lastError: null,
    lastErrorAt: null,
    updatedAt: new Date(),
  };

  if (existing) {
    await db.update(adAccounts).set(commonFields).where(eq(adAccounts.id, existing.id));
    res.json({ ok: true, adAccountId: existing.id, reconnected: true });
    return;
  }

  const [created] = await db
    .insert(adAccounts)
    .values({
      clientId: client.id,
      platform: platform as 'META',
      platformAccountId,
      ...commonFields,
    })
    .returning({ id: adAccounts.id });

  res.json({ ok: true, adAccountId: created!.id, reconnected: false });
}));

accountsRouter.post('/accounts/:id/disconnect', route(async (req, res) => {
  const client = await requireClient();
  const id = String(req.params.id);

  const [existing] = await db
    .select({ id: adAccounts.id })
    .from(adAccounts)
    .where(and(eq(adAccounts.id, id), eq(adAccounts.clientId, client.id)));
  if (!existing) {
    res.status(404).json({ error: 'ad account not found' });
    return;
  }

  await db
    .update(adAccounts)
    .set({
      status: 'TOKEN_EXPIRED',
      accessTokenCiphertext: null,
      refreshTokenCiphertext: null,
      tokenKeyVersion: null,
      tokenExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(adAccounts.id, id));

  res.json({ ok: true });
}));
