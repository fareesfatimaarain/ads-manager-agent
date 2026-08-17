import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  activeKeyVersion,
  decryptToken,
  encryptToken,
  isTokenEncryptionConfigured,
  resetTokenCryptoCacheForTests,
  TokenCryptoError,
} from '../../src/security/tokenCrypto.js';

const KEY_V1 = randomBytes(32).toString('base64');
const KEY_V2 = randomBytes(32).toString('base64');

const ENV_VARS = [
  'TOKEN_ENCRYPTION_KEY',
  'TOKEN_ENCRYPTION_KEY_V1',
  'TOKEN_ENCRYPTION_KEY_V2',
] as const;
let saved: Record<string, string | undefined> = {};

function clearEnv(): void {
  for (const k of ENV_VARS) delete process.env[k];
  resetTokenCryptoCacheForTests();
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  clearEnv();
});

afterEach(() => {
  for (const k of ENV_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetTokenCryptoCacheForTests();
});

describe('tokenCrypto', () => {
  it('reports unconfigured when no key is set', () => {
    expect(isTokenEncryptionConfigured()).toBe(false);
  });

  it('throws a clear error rather than silently accepting plaintext when unconfigured', () => {
    expect(() => encryptToken('a-real-access-token')).toThrow(TokenCryptoError);
  });

  it('round-trips a token under a single configured key', () => {
    process.env.TOKEN_ENCRYPTION_KEY_V1 = KEY_V1;
    const { ciphertext, keyVersion } = encryptToken('a-real-access-token');
    expect(keyVersion).toBe(1);
    expect(ciphertext).not.toContain('a-real-access-token');
    expect(decryptToken(ciphertext, keyVersion)).toBe('a-real-access-token');
  });

  it('accepts the unversioned TOKEN_ENCRYPTION_KEY as an alias for v1', () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_V1;
    const { keyVersion } = encryptToken('token');
    expect(keyVersion).toBe(1);
  });

  it('produces a different ciphertext each time (random IV) for the same plaintext', () => {
    process.env.TOKEN_ENCRYPTION_KEY_V1 = KEY_V1;
    const a = encryptToken('same token');
    const b = encryptToken('same token');
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('rejects a key that is not exactly 32 bytes', () => {
    process.env.TOKEN_ENCRYPTION_KEY_V1 = Buffer.from('too short').toString('base64');
    expect(() => encryptToken('token')).toThrow(TokenCryptoError);
  });

  it('encrypts new tokens under the highest configured version', () => {
    process.env.TOKEN_ENCRYPTION_KEY_V1 = KEY_V1;
    process.env.TOKEN_ENCRYPTION_KEY_V2 = KEY_V2;
    expect(activeKeyVersion()).toBe(2);
    expect(encryptToken('token').keyVersion).toBe(2);
  });

  it('still decrypts a token encrypted under an older key after a newer one is added', () => {
    process.env.TOKEN_ENCRYPTION_KEY_V1 = KEY_V1;
    const { ciphertext, keyVersion } = encryptToken('old token');

    process.env.TOKEN_ENCRYPTION_KEY_V2 = KEY_V2;
    resetTokenCryptoCacheForTests();

    expect(decryptToken(ciphertext, keyVersion)).toBe('old token');
    expect(encryptToken('new token').keyVersion).toBe(2);
  });

  it('refuses to decrypt with the wrong key', () => {
    process.env.TOKEN_ENCRYPTION_KEY_V1 = KEY_V1;
    const { ciphertext } = encryptToken('token');

    process.env.TOKEN_ENCRYPTION_KEY_V1 = KEY_V2;
    resetTokenCryptoCacheForTests();

    expect(() => decryptToken(ciphertext, 1)).toThrow(TokenCryptoError);
  });

  it('refuses to decrypt a tampered ciphertext rather than returning garbage plaintext', () => {
    process.env.TOKEN_ENCRYPTION_KEY_V1 = KEY_V1;
    const { ciphertext, keyVersion } = encryptToken('token');
    const bytes = Buffer.from(ciphertext, 'base64');
    const lastIndex = bytes.length - 1;
    bytes[lastIndex] = (bytes[lastIndex] ?? 0) ^ 0xff; // flip a bit in the ciphertext
    const tampered = bytes.toString('base64');

    expect(() => decryptToken(tampered, keyVersion)).toThrow(TokenCryptoError);
  });

  it('refuses to decrypt when no key is configured for that version', () => {
    process.env.TOKEN_ENCRYPTION_KEY_V1 = KEY_V1;
    const { ciphertext } = encryptToken('token');
    expect(() => decryptToken(ciphertext, 7)).toThrow(TokenCryptoError);
  });
});
