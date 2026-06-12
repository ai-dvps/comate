/**
 * Source string parser.
 *
 * Reimplemented from `src/server/vendor/vercel-skills/src/source-parser.ts`.
 * The upstream module is pure (only `path` + type deps) but uses
 * `.ts` extension imports incompatible with our tsc config, so we
 * port the logic into the adapter.
 *
 * Supports:
 *   - Local paths (absolute, ./, ../, Windows drive letters) — SANDBOXED
 *   - GitHub shorthand (owner/repo, owner/repo/subpath, owner/repo@skill)
 *   - GitHub URLs (with optional /tree/<ref>/<subpath>)
 *   - GitLab URLs (with optional /-/tree/<ref>/<subpath>)
 *   - Well-known HTTP(S) URLs (any host other than GitHub/GitLab/raw.githubusercontent)
 *   - Direct git URLs (SSH, HTTPS with .git suffix, git@ github.com:... etc.)
 *
 * SECURITY NOTE (doc-review Security #1): upstream accepts arbitrary local
 * paths. Comate adds sandboxing: local paths must resolve inside the active
 * workspace OR the user's home directory. This blocks `/etc/passwd` style
 * reads when the client passes an attacker-controlled absolute path.
 */

import { isAbsolute, resolve, join, sep } from 'path';
import { homedir } from 'os';
import type { ParsedSource } from './types.js';

/**
 * Reject subpaths containing `..` segments to prevent path traversal inside
 * a cloned repository (e.g., `owner/repo/../../etc/passwd`).
 *
 * Ported verbatim from upstream.
 */
export function sanitizeSubpath(subpath: string): string {
  const normalized = subpath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      throw new Error(
        `Unsafe subpath: "${subpath}" contains path traversal segments. ` +
          `Subpaths must not contain ".." components.`
      );
    }
  }
  return subpath;
}

/**
 * Returns true if `target` is `base` itself or a descendant of `base`.
 * Both paths must be normalized/resolved before comparison.
 */
function isWithin(base: string, target: string): boolean {
  return target === base || target.startsWith(base + sep);
}

/**
 * Validate that a user-supplied local path is safe to read from.
 *
 * A local path is safe iff its resolved absolute form is within:
 *   - The active workspace, OR
 *   - The user's home directory
 *
 * This blocks reads of arbitrary system paths (`/etc/passwd`, `/proc/self/...`)
 * when the client passes an attacker-controlled string. The user's home
 * directory is allowed because legitimate local skills often live in
 * sibling project folders or `~/projects/...`.
 *
 * @param workspacePath The active workspace path (may be undefined)
 * @param localPath     The local path the client wants to resolve
 * @throws if the path resolves outside both allowed roots
 */
export function assertLocalPathSafe(workspacePath: string | undefined, localPath: string): void {
  const resolved = resolve(localPath);
  const home = homedir();

  const allowedRoots: string[] = [home];
  if (workspacePath) {
    allowedRoots.push(resolve(workspacePath));
  }

  const isSafe = allowedRoots.some((root) => isWithin(root, resolved));
  if (!isSafe) {
    throw new Error(
      `Local path "${localPath}" resolves outside the workspace and user home directory. ` +
        `Local skill sources must live inside the active workspace or $HOME.`
    );
  }
}

/**
 * Returns true if the input looks like a local filesystem path
 * (absolute, ./, ../, `.`, `..`, or a Windows drive letter path).
 */
function isLocalPath(input: string): boolean {
  return (
    isAbsolute(input) ||
    input.startsWith('./') ||
    input.startsWith('../') ||
    input === '.' ||
    input === '..' ||
    // Windows absolute paths like C:\ or D:\
    /^[a-zA-Z]:[/\\]/.test(input)
  );
}

// Source aliases: map common shorthand to canonical source.
// Ported from upstream; extend here only if Comate adds new aliases.
const SOURCE_ALIASES: Record<string, string> = {
  'coinbase/agentWallet': 'coinbase/agentic-wallet-skills',
};

interface FragmentRefResult {
  inputWithoutFragment: string;
  ref?: string;
  skillFilter?: string;
}

function decodeFragmentValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function looksLikeGitSource(input: string): boolean {
  if (input.startsWith('github:') || input.startsWith('gitlab:') || input.startsWith('git@')) {
    return true;
  }

  if (/^ssh:\/\/.+\.git(?:$|[/?])/i.test(input)) {
    return true;
  }

  if (input.startsWith('http://') || input.startsWith('https://')) {
    try {
      const parsed = new URL(input);
      const pathname = parsed.pathname;

      // Only treat GitHub fragments as refs for repo/tree URLs.
      if (parsed.hostname === 'github.com') {
        return /^\/[^/]+\/[^/]+(?:\.git)?(?:\/tree\/[^/]+(?:\/.*)?)?\/?$/.test(pathname);
      }

      // Only treat gitlab.com fragments as refs for repo/tree URLs.
      if (parsed.hostname === 'gitlab.com') {
        return /^\/.+?\/[^/]+(?:\.git)?(?:\/-\/tree\/[^/]+(?:\/.*)?)?\/?$/.test(pathname);
      }
    } catch {
      // Fall through to generic checks below.
    }
  }

  if (/^https?:\/\/.+\.git(?:$|[/?])/i.test(input)) {
    return true;
  }

  return (
    !input.includes(':') &&
    !input.startsWith('.') &&
    !input.startsWith('/') &&
    /^([^/]+)\/([^/]+)(?:\/(.+)|@(.+))?$/.test(input)
  );
}

function parseFragmentRef(input: string): FragmentRefResult {
  const hashIndex = input.indexOf('#');
  if (hashIndex < 0) {
    return { inputWithoutFragment: input };
  }

  const inputWithoutFragment = input.slice(0, hashIndex);
  const fragment = input.slice(hashIndex + 1);

  // Treat URL fragments as git refs only for git-like sources.
  if (!fragment || !looksLikeGitSource(inputWithoutFragment)) {
    return { inputWithoutFragment: input };
  }

  const atIndex = fragment.indexOf('@');
  if (atIndex === -1) {
    return {
      inputWithoutFragment,
      ref: decodeFragmentValue(fragment),
    };
  }

  const ref = fragment.slice(0, atIndex);
  const skillFilter = fragment.slice(atIndex + 1);
  return {
    inputWithoutFragment,
    ref: ref ? decodeFragmentValue(ref) : undefined,
    skillFilter: skillFilter ? decodeFragmentValue(skillFilter) : undefined,
  };
}

function appendFragmentRef(input: string, ref?: string, skillFilter?: string): string {
  if (!ref) {
    return input;
  }
  return `${input}#${ref}${skillFilter ? `@${skillFilter}` : ''}`;
}

/**
 * Parse a source string into a structured `ParsedSource`.
 *
 * Mirrors upstream `parseSource(input): ParsedSource` exactly, plus the
 * `workspacePath` parameter for local-path sandboxing (Comate addition).
 *
 * @throws if `input` is a local path that fails `assertLocalPathSafe`
 */
export function parseSource(input: string, workspacePath?: string): ParsedSource {
  // Local path: absolute, relative, or current directory
  if (isLocalPath(input)) {
    if (workspacePath !== undefined) {
      // Sandbox check skipped when no workspace context (legacy/test callers)
      assertLocalPathSafe(workspacePath, input);
    }
    const resolvedPath = resolve(input);
    return {
      type: 'local',
      url: resolvedPath,
      localPath: resolvedPath,
    };
  }

  const {
    inputWithoutFragment,
    ref: fragmentRef,
    skillFilter: fragmentSkillFilter,
  } = parseFragmentRef(input);
  input = inputWithoutFragment;

  // Resolve source aliases before parsing
  const alias = SOURCE_ALIASES[input];
  if (alias) {
    input = alias;
  }

  // Prefix shorthand: github:owner/repo -> owner/repo
  const githubPrefixMatch = input.match(/^github:(.+)$/);
  if (githubPrefixMatch) {
    return parseSource(
      appendFragmentRef(githubPrefixMatch[1]!, fragmentRef, fragmentSkillFilter),
      workspacePath
    );
  }

  // Prefix shorthand: gitlab:owner/repo -> https://gitlab.com/owner/repo
  const gitlabPrefixMatch = input.match(/^gitlab:(.+)$/);
  if (gitlabPrefixMatch) {
    return parseSource(
      appendFragmentRef(
        `https://gitlab.com/${gitlabPrefixMatch[1]!}`,
        fragmentRef,
        fragmentSkillFilter
      ),
      workspacePath
    );
  }

  // GitHub URL with path: https://github.com/owner/repo/tree/branch/path/to/skill
  const githubTreeWithPathMatch = input.match(
    /github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)/
  );
  if (githubTreeWithPathMatch) {
    const [, owner, repo, ref, subpath] = githubTreeWithPathMatch;
    return {
      type: 'github',
      url: `https://github.com/${owner}/${repo}.git`,
      ref: ref || fragmentRef,
      subpath: subpath ? sanitizeSubpath(subpath) : subpath,
    };
  }

  // GitHub URL with branch only: https://github.com/owner/repo/tree/branch
  const githubTreeMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)$/);
  if (githubTreeMatch) {
    const [, owner, repo, ref] = githubTreeMatch;
    return {
      type: 'github',
      url: `https://github.com/${owner}/${repo}.git`,
      ref: ref || fragmentRef,
    };
  }

  // GitHub URL: https://github.com/owner/repo
  const githubRepoMatch = input.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (githubRepoMatch) {
    const [, owner, repo] = githubRepoMatch;
    const cleanRepo = repo!.replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${owner}/${cleanRepo}.git`,
      ...(fragmentRef ? { ref: fragmentRef } : {}),
    };
  }

  // GitLab URL with path (any GitLab instance)
  const gitlabTreeWithPathMatch = input.match(
    /^(https?):\/\/([^/]+)\/(.+?)\/-\/tree\/([^/]+)\/(.+)/
  );
  if (gitlabTreeWithPathMatch) {
    const [, protocol, hostname, repoPath, ref, subpath] = gitlabTreeWithPathMatch;
    if (hostname !== 'github.com' && repoPath) {
      return {
        type: 'gitlab',
        url: `${protocol}://${hostname}/${repoPath.replace(/\.git$/, '')}.git`,
        ref: ref || fragmentRef,
        subpath: subpath ? sanitizeSubpath(subpath) : subpath,
      };
    }
  }

  // GitLab URL with branch only (any GitLab instance)
  const gitlabTreeMatch = input.match(/^(https?):\/\/([^/]+)\/(.+?)\/-\/tree\/([^/]+)$/);
  if (gitlabTreeMatch) {
    const [, protocol, hostname, repoPath, ref] = gitlabTreeMatch;
    if (hostname !== 'github.com' && repoPath) {
      return {
        type: 'gitlab',
        url: `${protocol}://${hostname}/${repoPath.replace(/\.git$/, '')}.git`,
        ref: ref || fragmentRef,
      };
    }
  }

  // GitLab.com URL: https://gitlab.com/owner/repo (supports subgroups)
  const gitlabRepoMatch = input.match(/gitlab\.com\/(.+?)(?:\.git)?\/?$/);
  if (gitlabRepoMatch) {
    const repoPath = gitlabRepoMatch[1]!;
    if (repoPath.includes('/')) {
      return {
        type: 'gitlab',
        url: `https://gitlab.com/${repoPath}.git`,
        ...(fragmentRef ? { ref: fragmentRef } : {}),
      };
    }
  }

  // GitHub shorthand: owner/repo, owner/repo/path/to/skill, or owner/repo@skill-name
  // First check for @skill syntax: owner/repo@skill-name
  const atSkillMatch = input.match(/^([^/]+)\/([^/@]+)@(.+)$/);
  if (atSkillMatch && !input.includes(':') && !input.startsWith('.') && !input.startsWith('/')) {
    const [, owner, repo, skillFilter] = atSkillMatch;
    return {
      type: 'github',
      url: `https://github.com/${owner}/${repo}.git`,
      ...(fragmentRef ? { ref: fragmentRef } : {}),
      skillFilter: fragmentSkillFilter || skillFilter,
    };
  }

  const shorthandMatch = input.match(/^([^/]+)\/([^/]+)(?:\/(.+?))?\/?$/);
  if (shorthandMatch && !input.includes(':') && !input.startsWith('.') && !input.startsWith('/')) {
    const [, owner, repo, subpath] = shorthandMatch;
    return {
      type: 'github',
      url: `https://github.com/${owner}/${repo}.git`,
      ...(fragmentRef ? { ref: fragmentRef } : {}),
      subpath: subpath ? sanitizeSubpath(subpath) : subpath,
      ...(fragmentSkillFilter ? { skillFilter: fragmentSkillFilter } : {}),
    };
  }

  // Well-known skills: arbitrary HTTP(S) URLs that aren't GitHub/GitLab
  if (isWellKnownUrl(input)) {
    return {
      type: 'well-known',
      url: input,
    };
  }

  // Fallback: treat as direct git URL
  return {
    type: 'git',
    url: input,
    ...(fragmentRef ? { ref: fragmentRef } : {}),
  };
}

/**
 * Check if a URL could be a well-known skills endpoint.
 * Must be HTTP(S) and not a known git host (GitHub, GitLab).
 * Also excludes URLs that look like git repos (.git suffix).
 */
function isWellKnownUrl(input: string): boolean {
  if (!input.startsWith('http://') && !input.startsWith('https://')) {
    return false;
  }

  try {
    const parsed = new URL(input);
    const excludedHosts = ['github.com', 'gitlab.com', 'raw.githubusercontent.com'];
    if (excludedHosts.includes(parsed.hostname)) {
      return false;
    }

    if (input.endsWith('.git')) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Extract owner/repo (or group/subgroup/repo for GitLab) from a parsed source.
 * Returns null for local paths or unparseable sources.
 * Ported verbatim from upstream.
 */
export function getOwnerRepo(parsed: ParsedSource): string | null {
  if (parsed.type === 'local') {
    return null;
  }

  // Handle Git SSH URLs (e.g., git@gitlab.com:owner/repo.git)
  const sshMatch = parsed.url.match(/^git@[^:]+:(.+)$/);
  if (sshMatch) {
    let path = sshMatch[1]!;
    path = path.replace(/\.git$/, '');
    if (path.includes('/')) {
      return path;
    }
    return null;
  }

  if (parsed.url.startsWith('ssh://')) {
    try {
      const url = new URL(parsed.url);
      let path = url.pathname.slice(1);
      path = path.replace(/\.git$/, '');
      if (path.includes('/')) {
        return path;
      }
      return null;
    } catch {
      return null;
    }
  }

  if (!parsed.url.startsWith('http://') && !parsed.url.startsWith('https://')) {
    return null;
  }

  try {
    const url = new URL(parsed.url);
    let path = url.pathname.slice(1);
    path = path.replace(/\.git$/, '');
    if (path.includes('/')) {
      return path;
    }
  } catch {
    // Invalid URL
  }

  return null;
}

/**
 * Validates that a resolved subpath stays within the base directory.
 * Prevents path traversal attacks where subpath contains ".." segments
 * that would escape the cloned repository directory.
 *
 * Ported verbatim from upstream `skills.ts:isSubpathSafe`.
 */
export function isSubpathSafe(basePath: string, subpath: string): boolean {
  const normalizedBase = resolve(basePath);
  const normalizedTarget = resolve(join(basePath, subpath));
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(normalizedBase + sep);
}
