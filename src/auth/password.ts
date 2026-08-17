/**
 * Password hashing: scrypt from the standard library, no dependency added for something the
 * runtime already does well. Stored as `${saltHex}:${hashHex}` — the salt travels with the
 * hash, which is the whole point of storing a salt at all.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = (await scrypt(password, salt, expected.length)) as Buffer;
  return timingSafeEqual(derived, expected);
}

/**
 * A hash of a password nobody will ever type, computed once at module load. `login` verifies
 * against this when the email lookup misses, so a login attempt for an unknown address takes
 * the same shape — same async work, same code path — as one for a real address with the wrong
 * password. Without this, response timing would leak which emails have accounts.
 */
export const DUMMY_HASH_PROMISE: Promise<string> = hashPassword(randomBytes(32).toString('hex'));
