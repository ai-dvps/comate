import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { Dir } from 'node:fs';
import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitRepository, GitRepositoryCatalog } from '../models/git-graph.js';
import { GitGraphUnavailableError } from './git-graph-service.js';

const exec = promisify(execFile);
const excluded = new Set(['.git', 'node_modules']);
interface RepositoryBinding extends GitRepository { folderPath: string }
interface Scan {
  root: string;
  generation: string;
  queue: string[];
  queueIndex: number;
  seen: Set<string>;
  current?: { folder: string; dir: Dir };
  repositories: Map<string, RepositoryBinding>;
  previousBindings: Map<string, RepositoryBinding>;
  errors: GitRepositoryCatalog['errors'];
  done: boolean;
  updatedAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function relativeTo(root: string, folder: string): string {
  return path.relative(root, folder).split(path.sep).join('/') || '.';
}
function sortRepositories(a: GitRepository, b: GitRepository): number {
  const depth = (item: GitRepository) => item.relativePath === '.' ? 0 : item.relativePath.split('/').length;
  return depth(a) - depth(b) || (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
}

/** Read-only discovery. Only server-owned bindings can select a Git cwd. */
export class GitRepositoryService {
  private scans = new Map<string, Scan>();
  private pending = new Map<string, Promise<GitRepositoryCatalog>>();
  constructor(private readonly options: { batchSize?: number; idleMs?: number } = {}) {}

  private async identify(workspaceId: string, root: string, folder: string): Promise<RepositoryBinding> {
    const canonical = await realpath(folder);
    if (!inside(root, canonical)) throw new GitGraphUnavailableError();
    if (canonical !== root) await lstat(path.join(canonical, '.git'));
    const { stdout } = await exec('git', ['rev-parse', '--is-inside-work-tree', '--absolute-git-dir'], {
      cwd: canonical, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
    });
    if (!stdout.startsWith('true\n')) throw new GitGraphUnavailableError();
    const gitDir = await realpath(stdout.slice(5).trimEnd());
    const [folderStat, gitStat] = await Promise.all([stat(canonical), stat(gitDir)]);
    const identity = [workspaceId, root, canonical, gitDir,
      folderStat.dev, folderStat.ino, folderStat.birthtimeMs,
      gitStat.dev, gitStat.ino, gitStat.birthtimeMs];
    return {
      id: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
      name: path.basename(canonical), relativePath: relativeTo(root, canonical), folderPath: canonical,
    };
  }

  discover(workspaceId: string, folderPath: string, force = false): Promise<GitRepositoryCatalog> {
    const pending = this.pending.get(workspaceId);
    if (pending) return pending;
    const request = this.batch(workspaceId, folderPath, force).finally(() => {
      if (this.pending.get(workspaceId) === request) this.pending.delete(workspaceId);
    });
    this.pending.set(workspaceId, request);
    return request;
  }

  private async batch(workspaceId: string, folderPath: string, force: boolean): Promise<GitRepositoryCatalog> {
    const root = await realpath(folderPath);
    let scan = this.scans.get(workspaceId);
    if (!scan || scan.root !== root || (scan.done && (force || Date.now() - scan.updatedAt > 30_000))) {
      if (scan) await this.close(scan);
      const previousBindings = scan?.root === root
        ? new Map([...scan.previousBindings, ...scan.repositories]) : new Map<string, RepositoryBinding>();
      scan = { root, generation: randomUUID(), queue: [root], queueIndex: 0, seen: new Set(), previousBindings,
        repositories: new Map(), errors: [], done: false, updatedAt: Date.now() };
      this.scans.set(workspaceId, scan);
    }
    if (scan.timer) clearTimeout(scan.timer);
    const cached = scan.done;
    // Budget entries too, so a huge flat directory cannot monopolize one request.
    const deadline = Date.now() + 150;
    for (let count = 0; count < (this.options.batchSize ?? 250) && !scan.done && Date.now() < deadline; count++) {
      if (!scan.current) {
        const next = scan.queue[scan.queueIndex++];
        if (scan.queueIndex >= 1024) {
          scan.queue.splice(0, scan.queueIndex);
          scan.queueIndex = 0;
        }
        if (!next) { scan.done = true; break; }
        try {
          const folder = await realpath(next);
          if (!inside(root, folder) || scan.seen.has(folder)
            || (folder !== root && path.relative(root, folder).split(path.sep).some((part) => excluded.has(part)))) continue;
          scan.seen.add(folder);
          let candidate = folder === root;
          try { await lstat(path.join(folder, '.git')); candidate = true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (candidate) {
            try {
              const repository = await this.identify(workspaceId, root, folder);
              scan.repositories.set(repository.id, repository);
            } catch (error) {
              // A container root legitimately has no Git metadata. Other probe failures are visible.
              const notGit = /not a git repository/i.test(String((error as { stderr?: string }).stderr));
              if (!(folder === root && notGit)) scan.errors.push({ relativePath: relativeTo(root, folder), message: 'Repository is unreadable' });
            }
          }
          scan.current = { folder, dir: await opendir(folder) };
        } catch {
          scan.errors.push({ relativePath: relativeTo(root, next), message: 'Directory is unreadable' });
          continue;
        }
      }
      try {
        const entry = await scan.current.dir.read();
        if (!entry) {
          await scan.current.dir.close();
          scan.current = undefined;
        } else if (!excluded.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) {
          const child = path.join(scan.current.folder, entry.name);
          // A symlink to a file is not a directory candidate.
          try {
            if (!entry.isSymbolicLink() || (await stat(child)).isDirectory()) scan.queue.push(child);
          } catch (error) {
            // Broken or looping links must not abandon the parent's remaining entries.
            if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
              scan.errors.push({ relativePath: relativeTo(root, child), message: 'Directory is unreadable' });
            }
          }
        }
      } catch {
        scan.errors.push({ relativePath: relativeTo(root, scan.current?.folder ?? root), message: 'Directory is unreadable' });
        await this.close(scan);
      }
    }
    if (!cached) scan.updatedAt = Date.now();
    {
      const active = scan;
      scan.timer = setTimeout(() => {
        if (this.scans.get(workspaceId) === active && !this.pending.has(workspaceId)) {
          this.scans.delete(workspaceId);
          void this.close(active);
        }
      }, scan.done ? 5 * 60_000 : this.options.idleMs ?? 60_000);
      scan.timer.unref();
    }
    return {
      repositories: [...scan.repositories.values()].sort(sortRepositories).map(({ id, name, relativePath }) => ({ id, name, relativePath })),
      generation: scan.generation, done: scan.done, errors: [...scan.errors],
    };
  }

  async resolve(workspaceId: string, folderPath: string, id?: string): Promise<RepositoryBinding> {
    try {
      const root = await realpath(folderPath);
      if (!id) return await this.identify(workspaceId, root, root);
      let scan = this.scans.get(workspaceId);
      // Reconstruct deterministic IDs after an idle scan was retired or the server restarted.
      if (!scan || scan.root !== root) {
        let catalog = await this.discover(workspaceId, folderPath);
        while (!catalog.done && !catalog.repositories.some((repo) => repo.id === id)) {
          catalog = await this.discover(workspaceId, folderPath);
        }
        scan = this.scans.get(workspaceId);
      }
      const binding = scan?.repositories.get(id) ?? scan?.previousBindings.get(id);
      if (!binding) throw new GitGraphUnavailableError();
      const current = await this.identify(workspaceId, root, binding.folderPath);
      if (current.id !== id) throw new GitGraphUnavailableError();
      return current;
    } catch { throw new GitGraphUnavailableError(); }
  }

  private async close(scan: Scan): Promise<void> {
    if (scan.timer) clearTimeout(scan.timer);
    const current = scan.current;
    scan.current = undefined;
    if (current) await current.dir.close().catch(() => undefined);
  }

  async dispose(): Promise<void> {
    await Promise.all(this.pending.values());
    await Promise.all([...this.scans.values()].map((scan) => this.close(scan)));
    this.scans.clear();
  }
}

export const gitRepositoryService = new GitRepositoryService();
