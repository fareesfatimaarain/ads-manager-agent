import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/password.js';

describe('hashPassword / verifyPassword', () => {
  it('round-trips a correct password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('correct horse battery staple', stored)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('wrong password entirely', stored)).resolves.toBe(false);
  });

  it('never stores the plaintext password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored).not.toContain('correct horse battery staple');
  });

  it('produces a different hash each time due to a random salt', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
  });

  it('rejects malformed stored values rather than throwing', async () => {
    await expect(verifyPassword('anything', 'not-a-valid-hash')).resolves.toBe(false);
    await expect(verifyPassword('anything', '')).resolves.toBe(false);
    await expect(verifyPassword('anything', ':')).resolves.toBe(false);
  });

  it('is case- and whitespace-sensitive', async () => {
    const stored = await hashPassword('Password123');
    await expect(verifyPassword('password123', stored)).resolves.toBe(false);
    await expect(verifyPassword('Password123 ', stored)).resolves.toBe(false);
  });
});
