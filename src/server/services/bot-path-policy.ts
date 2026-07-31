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
  isAdminOrOwner: boolean;
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

/**
 * Build a path policy context for a bot session.
 *
 * @param workspace - the workspace being accessed
 * @param userDirName - directory name for the current user (plaintext id or encrypted id fallback)
 * @param knownUserDirNames - directory names of other bot users in this workspace, used to block cross-user access
 * @param isAdminOrOwner - whether the user bypasses the denylist and cross-user restrictions
 * @param workspaceDenyGlobs - additional workspace-specific globs that Normal users cannot read
 */
export function createPathPolicyContext(
  workspace: Workspace,
  userDirName: string,
  knownUserDirNames: string[] = [],
  isAdminOrOwner = false,
  workspaceDenyGlobs: string[] = [],
): PathPolicyContext {
  const workspaceFolder = path.resolve(workspace.folderPath);
  const userDir = path.join(workspaceFolder, 'data', userDirName);
  const globs = [...DEFAULT_DENY_GLOBS, ...(workspaceDenyGlobs ?? [])];
  const denyMatchers = globs.map((g) => picomatch(g));
  return {
    workspaceFolder,
    userDirName,
    userDir,
    knownUserDirNames: knownUserDirNames.filter((n) => n !== userDirName),
    denyMatchers,
    isAdminOrOwner,
  };
}

function normalizePath(raw: string): string {
  // Collapse redundant separators and normalize separators (no-op on posix).
  return path.normalize(raw);
}

/**
 * Resolve a path, following symlinks where possible. For paths that do not exist,
 * resolve the parent directory's realpath and append the basename to avoid
 * escaping via symlinks.
 */
function resolveRealPath(ctx: PathPolicyContext, rawPath: string): string {
  return canonicalizeBotPath(ctx.workspaceFolder, rawPath);
}

/**
 * Realpath canonicalization retained as the bot gate's verification layer
 * (U3, KTD-5): resolves a tool-input path against the workspace and follows
 * symlinks (parent-dir fallback for non-existent targets) so the gate checks
 * the canonical destination, never the spelled path. The sandbox/permission
 * rules are the enforcement layer; this is the in-gate double-check.
 */
export function canonicalizeBotPath(workspaceFolder: string, rawPath: string): string {
  const normalized = normalizePath(rawPath);
  const resolved = path.isAbsolute(normalized)
    ? normalized
    : path.resolve(workspaceFolder, normalized);
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
    const otherDir = path.join(ctx.workspaceFolder, 'data', other);
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

  if (ctx.isAdminOrOwner) {
    return { allowed: true };
  }

  if (isInOtherUserDir(ctx, resolved)) {
    return { allowed: false, reason: 'other-user-dir' };
  }

  if (matchesDenylist(ctx, resolved)) {
    return { allowed: false, reason: 'denylist' };
  }

  if (isWithinUserDir(ctx, resolved)) {
    return { allowed: true };
  }

  return { allowed: true };
}

function checkWritePath(ctx: PathPolicyContext, resolved: string): PathValidationResult {
  const escape = checkWorkspaceEscape(ctx, resolved);
  if (!escape.allowed) return escape;

  if (ctx.isAdminOrOwner) {
    return { allowed: true };
  }

  if (matchesDenylist(ctx, resolved)) {
    return { allowed: false, reason: 'denylist' };
  }

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

  if (!ctx.isAdminOrOwner) {
    // Reject explicit traversal into protected segments.
    const segments = normalized.split(/[\\/]/).filter(Boolean);
    if (segments[0] === '.claude' || segments[0] === 'node_modules' || segments[0] === '.git') {
      return { allowed: false, reason: 'denylist' };
    }
    if (
      segments[0] === 'data' &&
      segments[1] !== undefined &&
      ctx.knownUserDirNames.includes(segments[1])
    ) {
      return { allowed: false, reason: 'other-user-dir' };
    }
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

/**
 * Legacy per-call path validator (string-based, pre-realpath-canonicalization
 * era semantics). Retained ONLY for the legacy permission-model branches in
 * chat-service (the workspace kill switch and the pre-migration fallback);
 * the sandbox permission model uses `verifyBotFileToolAccess` instead. U4
 * pruned the dead `resolveAndCheckPath`/`checkUserPath` exports.
 */
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

// ---------------------------------------------------------------------------
// Sandbox-model in-gate verification (U3, KTD-1/KTD-5)
// ---------------------------------------------------------------------------

/**
 * Canonical read check for the sandbox permission model. Every role stays
 * workspace-scoped for file tools; privileged (owner/admin) roles pass the
 * interior checks; normal members are denied other members' data dirs —
 * expressed as "deny the data/ parent, allow own dir", NOT the legacy
 * knownUserDirNames enumeration (KTD-6) — and denylisted files.
 */
function checkVerifiedRead(ctx: PathPolicyContext, canonical: string, privileged: boolean): PathValidationResult {
  if (!startsWithDir(canonical, ctx.workspaceFolder)) {
    return { allowed: false, reason: 'outside-workspace' };
  }
  if (privileged) {
    return { allowed: true };
  }
  const dataRoot = path.join(ctx.workspaceFolder, 'data');
  if (startsWithDir(canonical, dataRoot) && !startsWithDir(canonical, ctx.userDir)) {
    return { allowed: false, reason: 'other-user-dir' };
  }
  if (matchesDenylist(ctx, canonical)) {
    return { allowed: false, reason: 'denylist' };
  }
  return { allowed: true };
}

/**
 * Canonical write check for the sandbox permission model. The derived SDK
 * allow rules cover the role's writable surface upstream (the gate never sees
 * those calls); writes reaching the gate are allowed only for privileged
 * roles or inside the member's own data dir. Everything else denies — the
 * gate is fail-closed (KTD-1).
 */
function checkVerifiedWrite(ctx: PathPolicyContext, canonical: string, privileged: boolean): PathValidationResult {
  if (!startsWithDir(canonical, ctx.workspaceFolder)) {
    return { allowed: false, reason: 'outside-workspace' };
  }
  if (privileged) {
    return { allowed: true };
  }
  if (matchesDenylist(ctx, canonical)) {
    return { allowed: false, reason: 'denylist' };
  }
  if (startsWithDir(canonical, ctx.userDir)) {
    return { allowed: true };
  }
  return { allowed: false, reason: 'outside-user-dir-write' };
}

function checkVerifiedFilePath(
  ctx: PathPolicyContext,
  rawPath: unknown,
  opts: { write: boolean },
  privileged: boolean,
): PathValidationResult {
  if (typeof rawPath !== 'string' || rawPath === '') {
    return { allowed: false, reason: 'invalid-path' };
  }
  const canonical = canonicalizeBotPath(ctx.workspaceFolder, rawPath);
  return opts.write
    ? checkVerifiedWrite(ctx, canonical, privileged)
    : checkVerifiedRead(ctx, canonical, privileged);
}

function checkVerifiedGlobPattern(
  ctx: PathPolicyContext,
  pattern: string,
  basePath: string | undefined,
  privileged: boolean,
): PathValidationResult {
  const normalized = normalizePath(pattern);

  if (hasDotDotSegment(normalized)) {
    return { allowed: false, reason: 'invalid-pattern' };
  }

  if (path.isAbsolute(normalized)) {
    return checkVerifiedRead(ctx, canonicalizeBotPath(ctx.workspaceFolder, normalized), privileged);
  }

  if (!privileged) {
    // Reject explicit traversal into protected segments. Wildcard scans of
    // data/ (`data/*`) cannot be result-filtered at the gate — same accepted
    // posture as a root-level Grep scan; literal other-user targeting denies.
    const segments = normalized.split(/[\\/]/).filter(Boolean);
    if (segments[0] === '.claude' || segments[0] === 'node_modules' || segments[0] === '.git') {
      return { allowed: false, reason: 'denylist' };
    }
    if (
      segments[0] === 'data' &&
      segments[1] !== undefined &&
      segments[1] !== ctx.userDirName &&
      segments[1] !== '*' &&
      segments[1] !== '**'
    ) {
      return { allowed: false, reason: 'other-user-dir' };
    }
  }

  if (basePath) {
    return checkVerifiedRead(ctx, canonicalizeBotPath(ctx.workspaceFolder, basePath), privileged);
  }

  return { allowed: true };
}

/**
 * The realpath verification layer the sandbox-model bot gate retains (U3,
 * KTD-5): replaces `validateToolInput` in the botId branch. The SDK's derived
 * allow rules cover the role's allowed surface upstream; calls reaching the
 * gate are verified against the canonical destination (symlink-resolved) so
 * no allow falls through unchecked (KTD-1 fail-closed).
 *
 * `privileged` must be computed from the freshly resolved role at call time
 * (never the spawn snapshot) so role promotions take effect immediately.
 */
export function verifyBotFileToolAccess(
  ctx: PathPolicyContext,
  toolName: string,
  input: Record<string, unknown>,
  privileged: boolean,
): PathValidationResult {
  switch (toolName) {
    case 'Read':
      return checkVerifiedFilePath(ctx, input.file_path, { write: false }, privileged);
    case 'Edit':
      return checkVerifiedFilePath(ctx, input.file_path, { write: true }, privileged);
    case 'Write':
      return checkVerifiedFilePath(ctx, input.file_path, { write: true }, privileged);
    case 'NotebookEdit':
      return checkVerifiedFilePath(ctx, input.notebook_path, { write: true }, privileged);
    case 'Glob': {
      const pattern = input.pattern;
      if (typeof pattern !== 'string' || pattern === '') {
        return { allowed: false, reason: 'invalid-pattern' };
      }
      const basePath = typeof input.path === 'string' ? input.path : undefined;
      return checkVerifiedGlobPattern(ctx, pattern, basePath, privileged);
    }
    case 'Grep': {
      const rawPath = input.path;
      if (rawPath !== undefined && rawPath !== null && rawPath !== '') {
        if (typeof rawPath !== 'string') {
          return { allowed: false, reason: 'invalid-path' };
        }
        const readResult = checkVerifiedRead(
          ctx,
          canonicalizeBotPath(ctx.workspaceFolder, rawPath),
          privileged,
        );
        if (!readResult.allowed) return readResult;
      }
      if (typeof input.glob === 'string' && input.glob !== '') {
        return checkVerifiedGlobPattern(ctx, input.glob, undefined, privileged);
      }
      return { allowed: true };
    }
    default:
      return { allowed: true };
  }
}
