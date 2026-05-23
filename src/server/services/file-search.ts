import { spawn } from 'child_process';
import { createRequire } from 'module';
import { existsSync, statSync } from 'fs';
import path from 'path';
import readline from 'readline';
import fuzzysort from 'fuzzysort';
import { sidecarLog } from '../utils/sidecar-logger.js';

export interface FileSearchResult {
  path: string;
}

export interface FileSearchResponse {
  query: string;
  results: FileSearchResult[];
  source: 'rg' | 'fallback';
  truncated: boolean;
}

export interface SearchOptions {
  workspaceRoot: string;
  query: string;
  limit: number;
  signal?: AbortSignal;
}

const DEFAULT_LIMIT = 200;
const CANDIDATE_MULTIPLIER = 5;

const PLATFORM_ARCH = `${process.platform}-${process.arch}`;

let cachedRgPath: string | null | undefined;

function tryFile(p: string | undefined): p is string {
  if (!p) return false;
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the path to the ripgrep binary. Mirrors resolveSdkBinary's
 * strategy ladder so the same call works in dev (require from source),
 * pkg-bundled sidecar (next to the executable), and Tauri production
 * (resources dir).
 */
export function resolveRgPath(): string | null {
  if (cachedRgPath !== undefined) return cachedRgPath;

  const rgBinaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';

  // Strategy 1: @vscode/ripgrep package (dev mode)
  try {
    const req = createRequire(import.meta.url);
    // The package exports rgPath, but we resolve manually to avoid loading the
    // module unnecessarily in production where it may not be present.
    const pkgPath = req.resolve('@vscode/ripgrep/package.json');
    const candidate = path.join(path.dirname(pkgPath), 'bin', rgBinaryName);
    if (tryFile(candidate)) {
      sidecarLog(`[file-search] resolved rg via @vscode/ripgrep: ${candidate}`);
      cachedRgPath = candidate;
      return candidate;
    }
    // Fallback to the per-platform binary package's bin dir.
    const platformPkg = `@vscode/ripgrep-${PLATFORM_ARCH}/package.json`;
    try {
      const platformPkgPath = req.resolve(platformPkg);
      const platCandidate = path.join(path.dirname(platformPkgPath), 'bin', rgBinaryName);
      if (tryFile(platCandidate)) {
        sidecarLog(`[file-search] resolved rg via platform package: ${platCandidate}`);
        cachedRgPath = platCandidate;
        return platCandidate;
      }
    } catch {
      // platform package not installed; fall through
    }
  } catch {
    // @vscode/ripgrep not resolvable; fall through
  }

  // Strategy 2: Tauri resource directory (production builds)
  const resourceDir = process.env.TAURI_RESOURCE_DIR;
  if (resourceDir) {
    const fromResources = path.join(resourceDir, rgBinaryName);
    if (tryFile(fromResources)) {
      sidecarLog(`[file-search] resolved rg via TAURI_RESOURCE_DIR: ${fromResources}`);
      cachedRgPath = fromResources;
      return fromResources;
    }
  }

  // Strategy 3: next to the executable (pkg-bundled sidecar)
  const nextToExec = path.join(path.dirname(process.execPath), rgBinaryName);
  if (tryFile(nextToExec)) {
    sidecarLog(`[file-search] resolved rg next to exec: ${nextToExec}`);
    cachedRgPath = nextToExec;
    return nextToExec;
  }

  sidecarLog('[file-search] no rg binary found; will use fallback walker');
  cachedRgPath = null;
  return null;
}

/**
 * Escape a user-supplied substring so ripgrep's --iglob treats it as
 * literal text. Ripgrep glob syntax mirrors gitignore: *, ?, [, ], {, }, \
 * are metacharacters. We backslash-escape them so the user's query is
 * matched as text rather than as a pattern.
 */
function escapeGlob(input: string): string {
  return input.replace(/[\\*?[\]{}]/g, (ch) => `\\${ch}`);
}

function rankAndCap(
  query: string,
  candidates: string[],
  limit: number,
): FileSearchResult[] {
  if (query === '') {
    return candidates.slice(0, limit).map((p) => ({ path: p }));
  }
  const ranked = fuzzysort.go(query, candidates, {
    limit,
    threshold: -10000,
  });
  return ranked.map((r) => ({ path: r.target }));
}

interface RawWalkResult {
  paths: string[];
  truncated: boolean;
}

async function ripgrepWalk(options: SearchOptions, candidateBudget: number): Promise<RawWalkResult> {
  const { workspaceRoot, query, signal } = options;
  const rgPath = resolveRgPath();
  if (!rgPath) throw new Error('rg binary unavailable');

  // Flag rationale:
  //   --files                   list every non-ignored file
  //   --hidden                  include dotfiles (per R7); .git is still
  //                             excluded via the explicit --glob below
  //   --glob '!.git'            exclude .git regardless of .gitignore
  //   --glob '!node_modules'    exclude node_modules regardless of .gitignore
  //   --iglob '*<query>*'       case-insensitive substring filter (when query is non-empty)
  //   --no-messages             suppress non-fatal warnings on stderr
  const args = [
    '--files',
    '--hidden',
    '--glob',
    '!.git',
    '--glob',
    '!node_modules',
    '--no-messages',
  ];

  if (query !== '') {
    args.push('--iglob', `*${escapeGlob(query)}*`);
  }

  const child = spawn(rgPath, args, { cwd: workspaceRoot });

  let killedByAbort = false;
  const onAbort = () => {
    killedByAbort = true;
    if (!child.killed) child.kill('SIGTERM');
  };
  if (signal) {
    if (signal.aborted) {
      child.kill('SIGTERM');
      throw new DOMException('Aborted', 'AbortError');
    }
    signal.addEventListener('abort', onAbort);
  }

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const paths: string[] = [];
  let truncated = false;

  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      paths.push(line);
      if (paths.length >= candidateBudget) {
        truncated = true;
        if (!child.killed) child.kill('SIGTERM');
        break;
      }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve();
      return;
    }
    child.once('close', () => resolve());
  });

  if (killedByAbort) {
    throw new DOMException('Aborted', 'AbortError');
  }

  return { paths, truncated };
}

/**
 * On-demand file search. Spawns ripgrep when available; falls back to a
 * pure-Node walker (U4) when the rg binary cannot be found.
 */
export async function searchFiles(options: SearchOptions): Promise<FileSearchResponse> {
  const limit = Math.max(1, Math.min(options.limit || DEFAULT_LIMIT, 1000));
  const candidateBudget = limit * CANDIDATE_MULTIPLIER;
  const query = options.query ?? '';

  if (query.includes('\0')) {
    throw new Error('query contains NUL byte');
  }

  const rgPath = resolveRgPath();
  if (rgPath) {
    try {
      const { paths, truncated } = await ripgrepWalk({ ...options, query }, candidateBudget);
      return {
        query,
        results: rankAndCap(query, paths, limit),
        source: 'rg',
        truncated,
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      sidecarLog(`[file-search] rg path failed, falling back to walker: ${err}`);
      // fall through to fallback
    }
  }

  // U4 fills this in.
  const { fallbackWalk } = await import('./file-search-fallback.js');
  const { paths, truncated } = await fallbackWalk({ ...options, query }, candidateBudget);
  return {
    query,
    results: rankAndCap(query, paths, limit),
    source: 'fallback',
    truncated,
  };
}
