/**
 * Reference asset storage.
 *
 * Local disk by default, because this product ships as a single isolated deployment per client
 * — there is no cross-tenant object store to reason about, and a directory on the instance is
 * both simpler and easier to back up. `AssetStore` is an interface so a deployment that wants
 * S3 or Azure Blob can swap it without touching a caller.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const ASSET_ROOT =
  process.env.ASSET_ROOT ?? resolve(here, '../../storage/assets');

/** Anything larger is refused before it reaches disk. */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
  'image/gif',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'video/mp4',
  'video/quicktime',
]);

/**
 * Extension → type, used only when the browser declines to say.
 *
 * Windows has no registry MIME mapping for `.md`, so Chrome uploads a markdown style guide as
 * `application/octet-stream` and a strict allowlist rejects a file it would otherwise accept.
 * Every target here is already on the allowlist — this resolves an unknown declaration, it does
 * not widen what is permitted. A declared type is always trusted over the extension, so this
 * cannot be used to smuggle a file past the check by renaming it.
 */
const EXTENSION_MIME: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

const GENERIC_MIME = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/** The type to store the file under, given what the client claimed and what it is called. */
export function resolveMimeType(declared: string | undefined, filename: string): string {
  const claimed = (declared ?? '').trim().toLowerCase();
  if (!GENERIC_MIME.has(claimed)) return claimed;
  return EXTENSION_MIME[extname(safeFilename(filename)).toLowerCase()] ?? claimed;
}

export class AssetError extends Error {
  constructor(
    message: string,
    readonly code: 'TOO_LARGE' | 'UNSUPPORTED_TYPE' | 'NOT_FOUND' | 'IO',
  ) {
    super(message);
    this.name = 'AssetError';
  }
}

export interface StoredAsset {
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface AssetStore {
  put(filename: string, mimeType: string, bytes: Buffer): Promise<StoredAsset>;
  get(storageKey: string): Promise<Buffer>;
  remove(storageKey: string): Promise<void>;
}

/** Strips any path component a client may have supplied. Never trust an uploaded filename. */
export function safeFilename(filename: string): string {
  const base = filename.replace(/^.*[\\/]/, '').replace(/[^\w.\-]/g, '_');
  return base.length > 0 ? base.slice(0, 120) : 'upload';
}

export class LocalAssetStore implements AssetStore {
  constructor(private readonly root: string = ASSET_ROOT) {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
  }

  async put(filename: string, mimeType: string, bytes: Buffer): Promise<StoredAsset> {
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      throw new AssetError(
        `file is ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB; the limit is ${MAX_ASSET_BYTES / 1024 / 1024}MB`,
        'TOO_LARGE',
      );
    }
    if (!ALLOWED_MIME.has(mimeType)) {
      throw new AssetError(`${mimeType} files are not accepted as reference material`, 'UNSUPPORTED_TYPE');
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = `${randomUUID()}${extname(safeFilename(filename))}`;
    const target = join(this.root, key);

    // Resolve and confirm the target is still inside the root — belt and braces against a
    // filename that survived sanitisation with something exotic in it.
    if (!resolve(target).startsWith(resolve(this.root))) {
      throw new AssetError('resolved path escapes the asset directory', 'IO');
    }

    await writeFile(target, bytes);
    return { storageKey: key, sizeBytes: bytes.byteLength, sha256 };
  }

  async get(storageKey: string): Promise<Buffer> {
    const target = join(this.root, safeFilename(storageKey));
    if (!resolve(target).startsWith(resolve(this.root)) || !existsSync(target)) {
      throw new AssetError(`asset ${storageKey} not found`, 'NOT_FOUND');
    }
    return readFile(target);
  }

  async remove(storageKey: string): Promise<void> {
    const target = join(this.root, safeFilename(storageKey));
    if (!existsSync(target)) return;
    await unlink(target);
  }
}

export const assetStore: AssetStore = new LocalAssetStore();

/**
 * Pulls readable text out of an upload so it can ground generation.
 *
 * Plain text and markdown are read directly. PDFs and Word documents are stored but not parsed
 * — extracting them properly needs a parser dependency, and a half-working extractor that
 * silently returns gibberish would poison the brand profile. Returning null is honest: the
 * file is kept as a reference, and the UI says its text was not read.
 */
export function extractText(mimeType: string, bytes: Buffer): string | null {
  if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
    return bytes.toString('utf8').slice(0, 200_000);
  }
  return null;
}

export function isTextExtractable(mimeType: string): boolean {
  return mimeType === 'text/plain' || mimeType === 'text/markdown';
}
