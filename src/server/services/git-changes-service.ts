import { watch, type FSWatcher } from 'chokidar';
import path from 'path';
import { realpath } from 'fs/promises';
import { readFile } from 'fs/promises';
import { WebSocket } from 'ws';
import ignore from 'ignore';
import type { Ignore } from 'ignore';
import { fdir } from 'fdir';
import { store as workspaceStore, SqliteStore } from '../storage/sqlite-store.js';
import { diagLog, diagWarn } from '../utils/diag-logger.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { GitStatusItem } from '../models/git-changes.js';
import { runGitStatus, isNotAGitRepoError } from './git-porcelain.js';

const execFileAsync = promisify(execFile);

const REFRESH_DEBOUNCE_MS = 150;
const MAX_WATCHED_FILES = 10000;

// Hard excludes match the ripgrep flags used elsewhere: .git and node_modules
// are always skipped regardless of whether a .gitignore exists.
const HARD_EXCLUDES = new Set(['.git', 'node_modules']);

interface IgnoreLayer {
  dir: string;
  ig: Ignore;
}

export interface GitChangesEvent {
  type: 'git_changes';
  workspaceId: string;
  items: GitStatusItem[];
}

export interface WatcherUnavailableEvent {
  type: 'watcher_unavailable';
  workspaceId: string;
  reason: string;
}

async function buildIgnoreLayers(workspaceRoot: string): Promise<IgnoreLayer[]> {
  const finder = new fdir()
    .withRelativePaths()
    .filter((p) => path.basename(p) === '.gitignore')
    .exclude((name) => HARD_EXCLUDES.has(name))
    .crawl(workspaceRoot);
  const paths = (await finder.withPromise()) as string[];

  const layers: IgnoreLayer[] = [];
  for (const rel of paths) {
    const normalized = rel.split(path.sep).join('/');
    const dirPosix = path.posix.dirname(normalized);
    let content: string;
    try {
      content = await readFile(path.join(workspaceRoot, normalized), 'utf8');
    } catch {
      continue;
    }
    layers.push({
      dir: dirPosix === '.' ? '' : dirPosix,
      ig: ignore().add(content),
    });
  }

  layers.sort((a, b) => a.dir.length - b.dir.length);
  return layers;
}

function isIgnored(relPath: string, layers: IgnoreLayer[]): boolean {
  for (const { dir, ig } of layers) {
    if (dir === '') {
      if (ig.ignores(relPath)) return true;
      continue;
    }
    if (relPath === dir || relPath.startsWith(`${dir}/`)) {
      const relativeToLayer = relPath.slice(dir.length + 1);
      if (relativeToLayer && ig.ignores(relativeToLayer)) return true;
    }
  }
  return false;
}

/**
 * Resolve the git directory and index paths for a workspace root. In a linked
 * worktree (or submodule) `.git` is a *file* pointing at metadata elsewhere,
 * so `<root>/.git/index` does not exist and watching it misses index-only
 * (staged) changes. `git rev-parse` resolves the real locations; we fall back
 * to the standard `<root>/.git` layout if git is unavailable.
 */
async function resolveGitPaths(root: string): Promise<{ gitDir: string; indexPath: string }> {
  try {
    const { stdout: indexOut } = await execFileAsync(
      'git',
      ['-C', root, 'rev-parse', '--git-path', 'index'],
      { encoding: 'utf-8', timeout: 5000 },
    );
    const { stdout: gitDirOut } = await execFileAsync(
      'git',
      ['-C', root, 'rev-parse', '--git-dir'],
      { encoding: 'utf-8', timeout: 5000 },
    );
    return {
      indexPath: path.resolve(root, indexOut.trim()),
      gitDir: path.resolve(root, gitDirOut.trim()),
    };
  } catch {
    return {
      indexPath: path.join(root, '.git/index'),
      gitDir: path.join(root, '.git'),
    };
  }
}

interface WsEventEnvelope {
  type: 'event';
  eventType: string;
  workspaceId: string;
  data: GitChangesEvent | WatcherUnavailableEvent;
}

export class GitChangesService {
  private workspaceStore: SqliteStore;
  private runGitStatusFn: (folderPath: string) => Promise<GitStatusItem[]>;
  private watchers = new Map<string, FSWatcher>();
  private watcherPromises = new Map<string, Promise<void>>();
  private subscriptions = new Map<string, Set<WebSocket>>();
  private socketSubscriptions = new Map<WebSocket, Set<string>>();
  private refreshPromises = new Map<string, Promise<void>>();
  private pending = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private watchedCounts = new Map<string, number>();

  constructor(
    workspaceStoreInstance: SqliteStore = workspaceStore,
    runGitStatusFn: (folderPath: string) => Promise<GitStatusItem[]> = runGitStatus,
  ) {
    this.workspaceStore = workspaceStoreInstance;
    this.runGitStatusFn = runGitStatusFn;
  }

  async subscribe(workspaceId: string, socket: WebSocket): Promise<void> {
    const workspace = await this.workspaceStore.get(workspaceId);
    if (!workspace) {
      this.sendToSocket(socket, {
        type: 'watcher_unavailable',
        workspaceId,
        reason: 'Workspace not found',
      });
      return;
    }

    let sockets = this.subscriptions.get(workspaceId);
    if (!sockets) {
      sockets = new Set();
      this.subscriptions.set(workspaceId, sockets);
    }
    sockets.add(socket);

    let workspaces = this.socketSubscriptions.get(socket);
    if (!workspaces) {
      workspaces = new Set();
      this.socketSubscriptions.set(socket, workspaces);
    }
    workspaces.add(workspaceId);

    diagLog(`[git-changes] socket subscribed to workspace ${workspaceId}`);

    await this.ensureWatcher(workspaceId);

    // Push the current status to the new subscriber. If another refresh is
    // already in flight for this workspace, the in-flight refresh will
    // broadcast to this socket once it completes.
    void this.refreshAndBroadcast(workspaceId);
  }

  async unsubscribe(workspaceId: string, socket: WebSocket): Promise<void> {
    const sockets = this.subscriptions.get(workspaceId);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.subscriptions.delete(workspaceId);
        await this.closeWatcher(workspaceId);
      }
    }

    const workspaces = this.socketSubscriptions.get(socket);
    if (workspaces) {
      workspaces.delete(workspaceId);
      if (workspaces.size === 0) {
        this.socketSubscriptions.delete(socket);
      }
    }
  }

  async unsubscribeSocket(socket: WebSocket): Promise<void> {
    const workspaces = this.socketSubscriptions.get(socket);
    if (!workspaces) return;
    for (const workspaceId of [...workspaces]) {
      await this.unsubscribe(workspaceId, socket);
    }
  }

  async dispose(): Promise<void> {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.pending.clear();
    this.refreshPromises.clear();
    this.subscriptions.clear();
    this.socketSubscriptions.clear();
    this.watchedCounts.clear();
    this.watcherPromises.clear();

    const closing: Promise<void>[] = [];
    for (const watcher of this.watchers.values()) {
      closing.push(watcher.close());
    }
    this.watchers.clear();
    await Promise.all(closing);
  }

  private async ensureWatcher(workspaceId: string): Promise<void> {
    if (this.watchers.has(workspaceId)) return;

    const existing = this.watcherPromises.get(workspaceId);
    if (existing) {
      return existing;
    }

    const promise = this.createWatcher(workspaceId);
    this.watcherPromises.set(workspaceId, promise);
    try {
      await promise;
    } finally {
      this.watcherPromises.delete(workspaceId);
    }
  }

  private async createWatcher(workspaceId: string): Promise<void> {
    const workspace = await this.workspaceStore.get(workspaceId);
    if (!workspace) {
      this.broadcast(workspaceId, {
        type: 'watcher_unavailable',
        workspaceId,
        reason: 'Workspace not found',
      });
      return;
    }

    let root: string;
    try {
      root = await realpath(workspace.folderPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      diagWarn(`[git-changes] failed to resolve workspace path for ${workspaceId}:`, message);
      this.broadcast(workspaceId, {
        type: 'watcher_unavailable',
        workspaceId,
        reason: 'Workspace path unavailable',
      });
      return;
    }

    const { gitDir: gitDirPath, indexPath: gitIndexPath } = await resolveGitPaths(root);

    let layers: IgnoreLayer[] = [];
    try {
      layers = await buildIgnoreLayers(root);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      diagWarn(`[git-changes] failed to build ignore layers for ${workspaceId}:`, message);
    }

    const ignored = (filePath: string): boolean => {
      if (filePath === gitIndexPath) return false;
      if (filePath === gitDirPath || filePath.startsWith(gitDirPath + path.sep)) {
        return true;
      }
      const rel = path.relative(root, filePath);
      if (!rel) return false;
      const posixRel = rel.split(path.sep).join('/');
      if (isIgnored(posixRel, layers)) return true;
      return false;
    };

    let watcher: FSWatcher;
    try {
      watcher = watch([root, gitIndexPath], {
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        ignored,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      diagWarn(`[git-changes] watcher failed to start for ${workspaceId}:`, message);
      this.broadcast(workspaceId, {
        type: 'watcher_unavailable',
        workspaceId,
        reason: 'Watcher failed to start',
      });
      return;
    }

    this.watchedCounts.set(workspaceId, 0);

    watcher.on('add', () => {
      this.trackWatchedFile(workspaceId);
      this.scheduleRefresh(workspaceId);
    });
    watcher.on('addDir', () => {
      this.trackWatchedFile(workspaceId);
      this.scheduleRefresh(workspaceId);
    });
    watcher.on('change', () => this.scheduleRefresh(workspaceId));
    watcher.on('unlink', () => this.scheduleRefresh(workspaceId));
    watcher.on('unlinkDir', () => this.scheduleRefresh(workspaceId));
    watcher.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      diagWarn(`[git-changes] watcher error for ${workspaceId}:`, message);
      this.broadcast(workspaceId, {
        type: 'watcher_unavailable',
        workspaceId,
        reason: message,
      });
      // Remove the broken watcher so the next subscribe recreates a fresh one
      // instead of ensureWatcher short-circuiting on a dead map entry.
      void this.closeWatcher(workspaceId);
    });

    this.watchers.set(workspaceId, watcher);
  }

  private trackWatchedFile(workspaceId: string): void {
    const count = (this.watchedCounts.get(workspaceId) ?? 0) + 1;
    this.watchedCounts.set(workspaceId, count);
    if (count > MAX_WATCHED_FILES) {
      diagWarn(`[git-changes] watched file count exceeded for ${workspaceId}`);
      this.broadcast(workspaceId, {
        type: 'watcher_unavailable',
        workspaceId,
        reason: 'Too many files to watch',
      });
      void this.closeWatcher(workspaceId);
    }
  }

  private scheduleRefresh(workspaceId: string): void {
    this.pending.add(workspaceId);
    const existing = this.timers.get(workspaceId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(workspaceId);
      void this.refreshAndBroadcast(workspaceId);
    }, REFRESH_DEBOUNCE_MS);
    this.timers.set(workspaceId, timer);
  }

  private async refreshAndBroadcast(workspaceId: string): Promise<void> {
    const existing = this.refreshPromises.get(workspaceId);
    if (existing) {
      await existing;
      if (this.pending.has(workspaceId)) {
        this.pending.delete(workspaceId);
        return this.refreshAndBroadcast(workspaceId);
      }
      return;
    }

    this.pending.delete(workspaceId);
    const promise = (async () => {
      const workspace = await this.workspaceStore.get(workspaceId);
      if (!workspace) return;
      let items: GitStatusItem[] | null = null;
      try {
        items = await this.runGitStatusFn(workspace.folderPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        diagWarn(`[git-changes] refresh failed for ${workspaceId}:`, message);
        // A non-git folder is legitimately "no changes" -> broadcast empty.
        // Any other failure must NOT broadcast an empty list: that would
        // falsely report a clean repo and wipe the client's known changes.
        // Skip the broadcast so subscribers keep their last known state.
        if (isNotAGitRepoError(err)) items = [];
      }
      if (items !== null) {
        this.broadcast(workspaceId, { type: 'git_changes', workspaceId, items });
      }
    })();

    this.refreshPromises.set(workspaceId, promise);
    try {
      await promise;
    } finally {
      this.refreshPromises.delete(workspaceId);
    }

    if (this.pending.has(workspaceId)) {
      this.pending.delete(workspaceId);
      await this.refreshAndBroadcast(workspaceId);
    }
  }

  private broadcast(
    workspaceId: string,
    event: GitChangesEvent | WatcherUnavailableEvent,
  ): void {
    const sockets = this.subscriptions.get(workspaceId);
    if (!sockets) return;

    const envelope: WsEventEnvelope = {
      type: 'event',
      eventType: event.type,
      workspaceId,
      data: event,
    };
    const msg = JSON.stringify(envelope);

    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(msg);
      }
    }
  }

  private sendToSocket(socket: WebSocket, event: GitChangesEvent | WatcherUnavailableEvent): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    const envelope: WsEventEnvelope = {
      type: 'event',
      eventType: event.type,
      workspaceId: event.workspaceId,
      data: event,
    };
    socket.send(JSON.stringify(envelope));
  }

  private async closeWatcher(workspaceId: string): Promise<void> {
    const watcher = this.watchers.get(workspaceId);
    if (!watcher) return;
    this.watchers.delete(workspaceId);
    this.watchedCounts.delete(workspaceId);
    const timer = this.timers.get(workspaceId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(workspaceId);
    }
    this.pending.delete(workspaceId);
    await watcher.close();
  }
}

export const gitChangesService = new GitChangesService();
