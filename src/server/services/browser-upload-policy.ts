import { constants as fsConstants, type Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export const BROWSER_UPLOAD_MAX_FILES = 18;
export const BROWSER_UPLOAD_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const BROWSER_UPLOAD_MAX_TOTAL_BYTES = 500 * 1024 * 1024;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.webp': 'image/webp',
});

export interface BrowserUploadFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface BrowserUploadCandidate {
  relativePath: string;
  basename: string;
  mimeType: string;
  size: number;
  identity: BrowserUploadFileIdentity;
}

export class BrowserUploadPolicyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BrowserUploadPolicyError';
  }
}

function identityOf(stats: Stats): BrowserUploadFileIdentity {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs };
}

function sameIdentity(left: BrowserUploadFileIdentity, right: BrowserUploadFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function containedBy(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validateRelativePath(raw: string): string[] {
  if (!raw || raw.includes('\0') || path.isAbsolute(raw)) {
    throw new BrowserUploadPolicyError('browser_upload_path_invalid', 'Upload paths must be non-empty workspace-relative paths.');
  }
  const segments = raw.split(/[\\/]/u);
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    throw new BrowserUploadPolicyError('browser_upload_path_invalid', 'Upload paths may not contain traversal, empty, or dotfile components.');
  }
  return segments;
}

async function verifyPathComponents(root: string, segments: string[]): Promise<void> {
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stats = await lstat(current).catch(() => null);
    if (!stats || stats.isSymbolicLink()) {
      throw new BrowserUploadPolicyError('browser_upload_path_unsafe', 'Upload source path contains a missing or symbolic-link component.');
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new BrowserUploadPolicyError('browser_upload_path_unsafe', 'Upload source parent is not a directory.');
    }
  }
}

function detectedMime(header: Buffer): string | undefined {
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
  const prefix = header.subarray(0, 6).toString('ascii');
  if (prefix === 'GIF87a' || prefix === 'GIF89a') return 'image/gif';
  if (header.length >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (header.length >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = header.subarray(8, 12).toString('ascii');
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  return undefined;
}

function pageAccepts(mimeType: string, extension: string, rawAccept: string | undefined): boolean {
  const accept = String(rawAccept ?? '').trim();
  if (!accept) return true;
  return accept.split(',').map((part) => part.trim().toLowerCase()).some((part) =>
    part === mimeType || part === extension ||
    (part === 'image/*' && mimeType.startsWith('image/')) ||
    (part === 'video/*' && mimeType.startsWith('video/')) ||
    part === '*/*',
  );
}

async function openVerified(root: string, relativePath: string): Promise<{ handle: FileHandle; stats: Stats; canonicalPath: string }> {
  if (process.platform === 'win32') {
    throw new BrowserUploadPolicyError('browser_upload_platform_unsupported', 'Secure workspace upload is unavailable on Windows because reparse-point no-follow cannot be proven.');
  }
  const segments = validateRelativePath(relativePath);
  await verifyPathComponents(root, segments);
  const candidate = path.join(root, ...segments);
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  if (!noFollow) {
    throw new BrowserUploadPolicyError('browser_upload_platform_unsupported', 'This platform does not expose no-follow file opens.');
  }
  const handle = await open(candidate, fsConstants.O_RDONLY | noFollow).catch(() => null);
  if (!handle) throw new BrowserUploadPolicyError('browser_upload_path_unsafe', 'Upload source could not be safely opened.');
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new BrowserUploadPolicyError('browser_upload_not_regular', 'Upload source must be a single-link regular file.');
    }
    const canonicalPath = await realpath(candidate);
    if (!containedBy(canonicalPath, root)) {
      throw new BrowserUploadPolicyError('browser_upload_outside_workspace', 'Upload source resolves outside the workspace.');
    }
    await verifyPathComponents(root, segments);
    const current = await lstat(candidate);
    if (!current.isFile() || !sameIdentity(identityOf(stats), identityOf(current))) {
      throw new BrowserUploadPolicyError('browser_upload_source_changed', 'Upload source identity changed while opening.');
    }
    return { handle, stats, canonicalPath };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function inspectBrowserUploadCandidates(
  workspaceFolder: string,
  relativePaths: string[],
  pageAccept?: string,
): Promise<BrowserUploadCandidate[]> {
  if (relativePaths.length === 0 || relativePaths.length > BROWSER_UPLOAD_MAX_FILES) {
    throw new BrowserUploadPolicyError('browser_upload_count_invalid', `Upload requires 1-${BROWSER_UPLOAD_MAX_FILES} files.`);
  }
  const root = await realpath(path.resolve(workspaceFolder)).catch(() => null);
  if (!root) throw new BrowserUploadPolicyError('browser_upload_workspace_invalid', 'Workspace root is unavailable.');
  const results: BrowserUploadCandidate[] = [];
  let total = 0;
  for (const relativePath of relativePaths) {
    const extension = path.extname(relativePath).toLowerCase();
    const expectedMime = MIME_BY_EXTENSION[extension];
    if (!expectedMime) throw new BrowserUploadPolicyError('browser_upload_media_unsupported', 'Only approved image and video media types may be uploaded.');
    const opened = await openVerified(root, relativePath);
    try {
      if (opened.stats.size <= 0 || opened.stats.size > BROWSER_UPLOAD_MAX_FILE_BYTES) {
        throw new BrowserUploadPolicyError('browser_upload_size_invalid', 'Upload source is empty or exceeds the per-file size limit.');
      }
      total += opened.stats.size;
      if (total > BROWSER_UPLOAD_MAX_TOTAL_BYTES) {
        throw new BrowserUploadPolicyError('browser_upload_size_invalid', 'Upload sources exceed the total size limit.');
      }
      const header = Buffer.alloc(32);
      const { bytesRead } = await opened.handle.read(header, 0, header.length, 0);
      const actualMime = detectedMime(header.subarray(0, bytesRead));
      if (actualMime !== expectedMime) {
        throw new BrowserUploadPolicyError('browser_upload_media_mismatch', 'Upload source extension and media signature do not match.');
      }
      if (!pageAccepts(actualMime, extension, pageAccept)) {
        throw new BrowserUploadPolicyError('browser_upload_accept_rejected', 'The page file input does not accept this approved media type.');
      }
      results.push({
        relativePath,
        basename: path.basename(relativePath),
        mimeType: actualMime,
        size: opened.stats.size,
        identity: identityOf(opened.stats),
      });
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }
  return results;
}

export async function reopenApprovedBrowserUpload(
  workspaceFolder: string,
  candidate: BrowserUploadCandidate,
): Promise<FileHandle> {
  const root = await realpath(path.resolve(workspaceFolder)).catch(() => null);
  if (!root) throw new BrowserUploadPolicyError('browser_upload_workspace_invalid', 'Workspace root is unavailable.');
  const opened = await openVerified(root, candidate.relativePath);
  if (!sameIdentity(identityOf(opened.stats), candidate.identity)) {
    await opened.handle.close().catch(() => undefined);
    throw new BrowserUploadPolicyError('browser_upload_source_changed', 'Upload source changed after approval.');
  }
  return opened.handle;
}
