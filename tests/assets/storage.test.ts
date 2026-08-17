import { describe, expect, it } from 'vitest';
import {
  extractText,
  isTextExtractable,
  resolveMimeType,
  safeFilename,
} from '../../src/assets/storage.js';

describe('uploaded filenames are never trusted', () => {
  it('strips directory components', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('C:\\Windows\\System32\\evil.png')).toBe('evil.png');
    expect(safeFilename('nested/path/logo.png')).toBe('logo.png');
  });

  it('leaves an ordinary filename alone', () => {
    expect(safeFilename('style-guide.md')).toBe('style-guide.md');
  });
});

describe('mime resolution', () => {
  it('trusts a declared type over the extension', () => {
    // A .txt declared as a PNG stays a PNG: the extension never overrides a real declaration,
    // so renaming a file cannot change how it is treated.
    expect(resolveMimeType('image/png', 'notes.txt')).toBe('image/png');
  });

  it('falls back to the extension when the browser says nothing useful', () => {
    // Windows Chrome sends octet-stream for .md — the common real case this exists for.
    expect(resolveMimeType('application/octet-stream', 'guide.md')).toBe('text/markdown');
    expect(resolveMimeType('', 'guide.pdf')).toBe('application/pdf');
    expect(resolveMimeType(undefined, 'logo.PNG')).toBe('image/png');
  });

  it('cannot be used to widen the allowlist', () => {
    // An extension with no mapping resolves to the generic type, which the store then refuses.
    expect(resolveMimeType('application/octet-stream', 'payload.exe')).toBe('application/octet-stream');
    expect(resolveMimeType('application/octet-stream', 'script.sh')).toBe('application/octet-stream');
    expect(resolveMimeType('application/octet-stream', 'noextension')).toBe('application/octet-stream');
  });

  it('resolves through a hostile filename rather than around it', () => {
    expect(resolveMimeType('application/octet-stream', '../../evil.md')).toBe('text/markdown');
  });

  it('normalises a declared type that differs only in case or spacing', () => {
    expect(resolveMimeType(' IMAGE/PNG ', 'x.bin')).toBe('image/png');
  });
});

describe('text extraction is honest about what it read', () => {
  it('reads plain text and markdown', () => {
    expect(extractText('text/markdown', Buffer.from('# Brand'))).toBe('# Brand');
    expect(extractText('text/plain', Buffer.from('hello'))).toBe('hello');
  });

  it('returns null for formats it cannot parse rather than gibberish', () => {
    // A PDF read as utf8 would produce noise that then poisons the brand profile.
    expect(extractText('application/pdf', Buffer.from([0x25, 0x50, 0x44, 0x46]))).toBeNull();
    expect(extractText('image/png', Buffer.from([0x89, 0x50]))).toBeNull();
  });

  it('agrees with isTextExtractable', () => {
    for (const type of ['text/plain', 'text/markdown', 'application/pdf', 'image/png']) {
      const extracted = extractText(type, Buffer.from('x'));
      expect(isTextExtractable(type)).toBe(extracted !== null);
    }
  });

  it('caps how much of a very large document it keeps', () => {
    const huge = Buffer.from('a'.repeat(300_000));
    expect(extractText('text/plain', huge)!.length).toBe(200_000);
  });
});
