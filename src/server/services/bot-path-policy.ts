import path from 'node:path';
import fs from 'node:fs';
import picomatch from 'picomatch';
import type { Workspace } from '../models/workspace.js';

export interface PathPolicyContext {
  workspaceFolder: string;
  userDirName: string;
  userDir: string;
  knownUserDirNames: string[];
  denyMatchers: ReturnType<typeof picomatch>[];
}

export interface PathValidationResult {
  allowed: boolean;
  reason?: string;
}

const DEFAULT_DENY_GLOBS = [
  '.claude/**',
  '.env*',
  '*id_rsa*',
  '*.pem',
  '*.key',
  '*.db',
  '*.sqlite*',
  '*.log',
];

const SENSITIVE_RELATIVE_SEGMENTS = new Set([
  '.claude',
  'node_modules',
  '.git',
]);

/**
 * Build a path policy context for a bot session.
 *
 * @param workspace - the workspace being accessed
 * @param userDirName - directory name for the current user (plaintext id or encrypted id fallback)
 * @param knownUserDirNames - directory names of other WeCom users in this workspace, used to block cross-user access
 */
export function createPathPolicyContext(
  workspace: Workspace,
  userDirName: string,
  knownUserDirNames: string[] = [],
): PathPolicyContext {
  const workspaceFolder = path.resolve(workspace.folderPath);
  const userDir = path.join(workspaceFolder, userDirName);
  // Future: merge a configurable workspace denylist here.
  const denyMatchers = DEFAULT_DENY_GLOBS.map((g) => picomatch(g));
  return {
    workspaceFolder,
    userDirName,
    userDir,
    knownUserDirNames: knownUserDirNames.filter((n) => n !== userDirName),
    denyMatchers,
  };
}

function normalizePath(raw: string): string {
  // Collapse redundant separators and normalize separators (no-op on posix).
  return path.normalize(raw);
}

function resolvePath(ctx: PathPolicyContext, rawPath: string): string {
  // The SDK passes absolute paths for Read/Edit/Write/NotebookEdit, but we also
  // accept relative paths defensively.
  const normalized = normalizePath(rawPath);
  if (path.isAbsolute(normalized)) {
    return normalized;
  }
  return path.resolve(ctx.workspaceFolder, normalized);
}

/**
 * Resolve a path, following symlinks where possible. For paths that do not exist,
 * resolve the parent directory's realpath and append the basename to avoid
 * escaping via symlinks.
 */
function resolveRealPath(ctx: PathPolicyContext, rawPath: string): string {
  const resolved = resolvePath(ctx, rawPath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    // Path does not exist; resolve the parent to follow symlinks.
    const parent = path.dirname(resolved);
    const base = path.basename(resolved);
    try {
      const realParent = fs.realpathSync(parent);
      return path.join(realParent, base);
    } catch {
      return resolved;
    }
  }
}

function startsWithDir(resolved: string, dir: string): boolean {
  const d = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return resolved === dir || resolved.startsWith(d);
}

function isWithinWorkspace(ctx: PathPolicyContext, resolved: string): boolean {
  return startsWithDir(resolved, ctx.workspaceFolder);
}

function isWithinUserDir(ctx: PathPolicyContext, resolved: string): boolean {
  return startsWithDir(resolved, ctx.userDir);
}

function isInOtherUserDir(ctx: PathPolicyContext, resolved: string): boolean {
  for (const other of ctx.knownUserDirNames) {
    const otherDir = path.join(ctx.workspaceFolder, other);
    if (startsWithDir(resolved, otherDir)) return true;
  }
  return false;
}

function matchesDenylist(ctx: PathPolicyContext, resolved: string): boolean {
  const relative = path.relative(ctx.workspaceFolder, resolved);
  if (relative === '') return false;
  for (const match of ctx.denyMatchers) {
    if (match(relative)) return true;
  }
  return false;
}

function checkWorkspaceEscape(ctx: PathPolicyContext, resolved: string): PathValidationResult {
  if (!isWithinWorkspace(ctx, resolved)) {
    return { allowed: false, reason: 'outside-workspace' };
  }
  return { allowed: true };
}

function checkReadPath(ctx: PathPolicyContext, resolved: string): PathValidationResult {
  const escape = checkWorkspaceEscape(ctx, resolved);
  if (!escape.allowed) return escape;

  if (isWithinUserDir(ctx, resolved)) {
    return { allowed: true };
  }

  if (isInOtherUserDir(ctx, resolved)) {
    return { allowed: false, reason: 'other-user-dir' };
  }

  if (matchesDenylist(ctx, resolved)) {
    return { allowed: false, reason: 'denylist' };
  }

  return { allowed: true };
}

function checkWritePath(ctx: PathPolicyContext, resolved: string): PathValidationResult {
  const escape = checkWorkspaceEscape(ctx, resolved);
  if (!escape.allowed) return escape;

  if (isWithinUserDir(ctx, resolved)) {
    return { allowed: true };
  }

  return { allowed: false, reason: 'outside-user-dir-write' };
}

function checkFilePath(
  ctx: PathPolicyContext,
  rawPath: unknown,
  opts: { write: boolean },
): PathValidationResult {
  if (typeof rawPath !== 'string' || rawPath === '') {
    return { allowed: false, reason: 'invalid-path' };
  }
  const resolved = resolveRealPath(ctx, rawPath);
  return opts.write ? checkWritePath(ctx, resolved) : checkReadPath(ctx, resolved);
}

function hasDotDotSegment(pattern: string): boolean {
  return pattern.split(/[\\/]/).some((s) => s === '..');
}

function segmentAppears(pattern: string, segment: string): boolean {
  return pattern.split(/[\\/]/).includes(segment);
}

/**
 * Validate a Glob pattern. We can only inspect the input; the actual file list is
 * produced by the SDK after we return allow. We therefore reject any pattern that
 * could reach outside the workspace, target .claude/, or target another user's
 * directory.
 */
function checkGlobPattern(
  ctx: PathPolicyContext,
  pattern: string,
  basePath?: string,
): PathValidationResult {
  const normalized = normalizePath(pattern);

  if (hasDotDotSegment(normalized)) {
    return { allowed: false, reason: 'invalid-pattern' };
  }

  if (path.isAbsolute(normalized)) {
    const resolved = resolveRealPath(ctx, normalized);
    return checkReadPath(ctx, resolved);
  }

  // Reject explicit traversal into protected segments.
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  if (segments[0] === '.claude' || segments[0] === 'node_modules' || segments[0] === '.git') {
    return { allowed: false, reason: 'denylist' };
  }
  if (ctx.knownUserDirNames.includes(segments[0] || '')) {
    return { allowed: false, reason: 'other-user-dir' };
  }

  if (basePath) {
    const resolved = resolveRealPath(ctx, basePath);
    const readResult = checkReadPath(ctx, resolved);
    if (!readResult.allowed) return readResult;
  }

  return { allowed: true };
}

function checkGrepPath(
  ctx: PathPolicyContext,
  rawPath: unknown,
  globFilter?: unknown,
): PathValidationResult {
  if (rawPath === undefined || rawPath === null || rawPath === '') {
    // Grep defaults to cwd (workspace root). Reading the workspace root is allowed
    // for non-denylisted files; the tool itself will scan files and return results.
    // We cannot filter output, but the path policy has verified the starting point.
    return { allowed: true };
  }
  if (typeof rawPath !== 'string') {
    return { allowed: false, reason: 'invalid-path' };
  }
  const resolved = resolveRealPath(ctx, rawPath);
  const readResult = checkReadPath(ctx, resolved);
  if (!readResult.allowed) return readResult;

  if (typeof globFilter === 'string' && globFilter !== '') {
    return checkGlobPattern(ctx, globFilter);
  }

  return { allowed: true };
}

export function validateToolInput(
  ctx: PathPolicyContext,
  toolName: string,
  input: Record<string, unknown>,
): PathValidationResult {
  switch (toolName) {
    case 'Read':
      return checkFilePath(ctx, input.file_path, { write: false });
    case 'Edit':
      return checkFilePath(ctx, input.file_path, { write: true });
    case 'Write':
      return checkFilePath(ctx, input.file_path, { write: true });
    case 'NotebookEdit':
      return checkFilePath(ctx, input.notebook_path, { write: true });
    case 'Glob': {
      const pattern = input.pattern;
      if (typeof pattern !== 'string' || pattern === '') {
        return { allowed: false, reason: 'invalid-pattern' };
      }
      const basePath = typeof input.path === 'string' ? input.path : undefined;
      return checkGlobPattern(ctx, pattern, basePath);
    }
    case 'Grep': {
      return checkGrepPath(ctx, input.path, input.glob);
    }
    default:
      return { allowed: true };
  }
}

/**
 * Low-level helper to resolve and check a single raw path. Used by the Bash
 * whitelist engine to re-validate path arguments.
 */
export function resolveAndCheckPath(
  ctx: PathPolicyContext,
  rawPath: string,
  opts: { write: boolean },
): PathValidationResult {
  return checkFilePath(ctx, rawPath, opts);
}

/**
 * Low-level helper to validate that a path argument is inside the caller's user
 * directory (used by Bash whitelist for {{user_path}} placeholders).
 */
export function checkUserPath(
  ctx: PathPolicyContext,
  rawPath: string,
): PathValidationResult {
  if (typeof rawPath !== 'string' || rawPath === '') {
    return { allowed: false, reason: 'invalid-path' };
  }
  const resolved = resolveRealPath(ctx, rawPath);
  const escape = checkWorkspaceEscape(ctx, resolved);
  if (!escape.allowed) return escape;
  if (isWithinUserDir(ctx, resolved)) return { allowed: true };
  return { allowed: false, reason: 'outside-user-dir-write' };
}
