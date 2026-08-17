/**
 * Encrypts and decrypts ad-account access/refresh tokens before they touch the database.
 * AES-256-GCM, standard library only.
 *
 * Keys are versioned so rotation never requires a flag day: `TOKEN_ENCRYPTION_KEY_V2` can be
 * added alongside `TOKEN_ENCRYPTION_KEY_V1` and new tokens start encrypting under v2 while
 * every token still on disk under v1 keeps decrypting correctly, because `keyVersion` travels
 * with the ciphertext (see `adAccounts.tokenKeyVersion` in the schema). Retiring v1 is then
 * just deleting the env var once nothing references it any more.
 *
 * `TOKEN_ENCRYPTION_KEY` (unversioned) is accepted as an alias for `TOKEN_ENCRYPTION_KEY_V1`,
 * matching the variable name the README and .env.example already document.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const MAX_KEY_VERSION = 20;

export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenCryptoError';
  }
}

function decodeKey(raw: string, varName: string): Buffer {
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    throw new TokenCryptoError(`${varName} is not valid base64`);
  }
  if (buf.length !== KEY_LENGTH) {
    throw new TokenCryptoError(
      `${varName} must decode to exactly ${KEY_LENGTH} bytes (got ${buf.length}). Generate one with: ` +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return buf;
}

function loadKeys(): Map<number, Buffer> {
  const keys = new Map<number, Buffer>();
  const v1 = process.env.TOKEN_ENCRYPTION_KEY_V1 ?? process.env.TOKEN_ENCRYPTION_KEY;
  if (v1) keys.set(1, decodeKey(v1, 'TOKEN_ENCRYPTION_KEY_V1 (or TOKEN_ENCRYPTION_KEY)'));
  for (let v = 2; v <= MAX_KEY_VERSION; v += 1) {
    const raw = process.env[`TOKEN_ENCRYPTION_KEY_V${v}`];
    if (raw) keys.set(v, decodeKey(raw, `TOKEN_ENCRYPTION_KEY_V${v}`));
  }
  return keys;
}

let cachedKeys: Map<number, Buffer> | null = null;
function keys(): Map<number, Buffer> {
  if (!cachedKeys) cachedKeys = loadKeys();
  return cachedKeys;
}

export function isTokenEncryptionConfigured(): boolean {
  return keys().size > 0;
}

/** The version new encryptions are written under — the highest key currently configured. */
export function activeKeyVersion(): number {
  const all = keys();
  if (all.size === 0) {
    throw new TokenCryptoError(
      'no TOKEN_ENCRYPTION_KEY is configured — connecting a real ad account requires one. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  return Math.max(...all.keys());
}

export function encryptToken(plaintext: string): { ciphertext: string; keyVersion: number } {
  const version = activeKeyVersion();
  const key = keys().get(version)!;
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([iv, tag, encrypted]).toString('base64'), keyVersion: version };
}

export function decryptToken(ciphertext: string, keyVersion: number): string {
  const key = keys().get(keyVersion);
  if (!key) {
    throw new TokenCryptoError(
      `no key is configured for version ${keyVersion} — set TOKEN_ENCRYPTION_KEY_V${keyVersion} ` +
        'to decrypt tokens that were encrypted under it',
    );
  }

  const payload = Buffer.from(ciphertext, 'base64');
  if (payload.length < IV_LENGTH + TAG_LENGTH) {
    throw new TokenCryptoError('ciphertext is too short to be a valid encrypted token');
  }
  const iv = payload.subarray(0, IV_LENGTH);
  const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = payload.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    // GCM's auth tag check failed: wrong key, corrupted ciphertext, or someone tampered with
    // it. All three deserve the same treatment — refuse, never return partial plaintext.
    throw new TokenCryptoError('token failed to decrypt — wrong key, or the ciphertext has been altered');
  }
}

/** Test-only: forces the next call to re-read process.env instead of using the cache. */
export function resetTokenCryptoCacheForTests(): void {
  cachedKeys = null;
}
