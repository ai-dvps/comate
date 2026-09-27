import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { getStorageDir } from '../storage/data-dir.js';
import {
  BROWSER_UPLOAD_MAX_TOTAL_BYTES,
  type BrowserUploadCandidate,
} from './browser-upload-policy.js';

const STAGING_TTL_MS = 30 * 60 * 1000;
const GLOBAL_MAX_BYTES = 1024 * 1024 * 1024;

export interface StagedBrowserUpload {
  operationId: string;
  sessionId: string;
  paths: string[];
  digests: string[];
  totalBytes: number;
  expiresAt: number;
}

interface StagingEntry extends StagedBrowserUpload {
  directory: string;
  timer: NodeJS.Timeout;
}

export class BrowserUploadStagingService {
  private readonly entries = new Map<string, StagingEntry>();
  private readonly reservedSessionBytes = new Map<string, number>();
  private reservedGlobalBytes = 0;
  private initialized: Promise<void> | null = null;

  constructor(
    private readonly root = path.join(getStorageDir(), 'browser-upload-staging'),
    private readonly now: () => number = () => Date.now(),
    private readonly quotas = {
      sessionBytes: BROWSER_UPLOAD_MAX_TOTAL_BYTES,
      globalBytes: GLOBAL_MAX_BYTES,
    },
  ) {}

  private key(sessionId: string, operationId: string): string {
    return `${sessionId}\0${operationId}`;
  }

  private async initialize(): Promise<void> {
    if (!this.initialized) {
      const initialization = (async () => {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const rootStats = await lstat(this.root);
        if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('browser_upload_staging_root_unsafe');
        await chmod(this.root, 0o700);
        const children = await readdir(this.root).catch(() => []);
        await Promise.all(children.map((child) => rm(path.join(this.root, child), { recursive: true, force: true })));
      })();
      const recoverable = initialization.catch((error) => {
        if (this.initialized === recoverable) this.initialized = null;
        throw error;
      });
      this.initialized = recoverable;
    }
    return this.initialized;
  }

  /** Startup hook: remove staging that cannot be tied to a live capability. */
  cleanupOrphans(): Promise<void> {
    return this.initialize();
  }

  async stage(
    sessionId: string,
    operationId: string,
    files: Array<{ candidate: BrowserUploadCandidate; handle: FileHandle }>,
  ): Promise<StagedBrowserUpload> {
    await this.initialize();
    await this.releaseOperation(sessionId, operationId);
    const totalBytes = files.reduce((sum, file) => sum + file.candidate.size, 0);
    const sessionBytes = [...this.entries.values()].filter((entry) => entry.sessionId === sessionId)
      .reduce((sum, entry) => sum + entry.totalBytes, 0);
    const globalBytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.totalBytes, 0);
    const reservedSessionBytes = this.reservedSessionBytes.get(sessionId) ?? 0;
    if (sessionBytes + reservedSessionBytes + totalBytes > this.quotas.sessionBytes ||
        globalBytes + this.reservedGlobalBytes + totalBytes > this.quotas.globalBytes) {
      throw new Error('browser_upload_staging_quota');
    }
    this.reservedSessionBytes.set(sessionId, reservedSessionBytes + totalBytes);
    this.reservedGlobalBytes += totalBytes;
    const directory = path.join(this.root, `${randomBytes(16).toString('hex')}`);
    const paths: string[] = [];
    const digests: string[] = [];
    try {
      await mkdir(directory, { mode: 0o700 });
      for (let index = 0; index < files.length; index += 1) {
        const source = files[index];
        const extension = path.extname(source.candidate.basename).toLowerCase();
        const destinationPath = path.join(directory, `${String(index + 1).padStart(2, '0')}-${randomBytes(8).toString('hex')}${extension}`);
        const destination = await open(destinationPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
        const digest = createHash('sha256');
        try {
          const buffer = Buffer.allocUnsafe(256 * 1024);
          let position = 0;
          let complete = false;
          while (!complete) {
            const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, position);
            if (bytesRead === 0) { complete = true; continue; }
            digest.update(buffer.subarray(0, bytesRead));
            await destination.write(buffer, 0, bytesRead, position);
            position += bytesRead;
          }
          await destination.sync();
        } finally {
          await destination.close().catch(() => undefined);
        }
        paths.push(destinationPath);
        digests.push(digest.digest('hex'));
      }
      const expiresAt = this.now() + STAGING_TTL_MS;
      const timer = setTimeout(() => { void this.releaseOperation(sessionId, operationId); }, STAGING_TTL_MS);
      timer.unref?.();
      const entry: StagingEntry = { operationId, sessionId, directory, paths, digests, totalBytes, expiresAt, timer };
      this.entries.set(this.key(sessionId, operationId), entry);
      return { operationId, sessionId, paths: [...paths], digests: [...digests], totalBytes, expiresAt };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      const remainingSessionBytes = (this.reservedSessionBytes.get(sessionId) ?? totalBytes) - totalBytes;
      if (remainingSessionBytes > 0) this.reservedSessionBytes.set(sessionId, remainingSessionBytes);
      else this.reservedSessionBytes.delete(sessionId);
      this.reservedGlobalBytes -= totalBytes;
    }
  }

  async releaseOperation(sessionId: string, operationId: string): Promise<void> {
    const key = this.key(sessionId, operationId);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    clearTimeout(entry.timer);
    await rm(entry.directory, { recursive: true, force: true }).catch(() => undefined);
  }

  async verify(staged: StagedBrowserUpload): Promise<boolean> {
    const entry = this.entries.get(this.key(staged.sessionId, staged.operationId));
    if (!entry || entry.expiresAt < this.now() || entry.paths.length !== staged.paths.length ||
        entry.totalBytes !== staged.totalBytes || entry.expiresAt !== staged.expiresAt ||
        !entry.paths.every((item, index) => item === staged.paths[index]) ||
        !entry.digests.every((item, index) => item === staged.digests[index])) return false;
    let total = 0;
    for (let index = 0; index < entry.paths.length; index += 1) {
      let handle: FileHandle | undefined;
      try {
        const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
        handle = await open(entry.paths[index], fsConstants.O_RDONLY | noFollow);
        const stats = await handle.stat();
        if (!stats.isFile() || stats.nlink !== 1) return false;
        const digest = createHash('sha256');
        const buffer = Buffer.allocUnsafe(256 * 1024);
        let position = 0;
        while (position < stats.size) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (bytesRead === 0) return false;
          digest.update(buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
        if (digest.digest('hex') !== entry.digests[index]) return false;
        total += stats.size;
      } catch {
        return false;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
    return total === entry.totalBytes;
  }

  async releaseSession(sessionId: string): Promise<void> {
    await Promise.all([...this.entries.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => this.releaseOperation(entry.sessionId, entry.operationId)));
  }
}

export const browserUploadStagingService = new BrowserUploadStagingService();
