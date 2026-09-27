/**
 * Skill installer.
 *
 * Reimplemented from `src/server/vendor/vercel-skills/src/installer.ts` with
 * two Comate-specific changes:
 *   1. Hardcoded Claude Code paths (`.claude/skills/`, `~/.claude/skills/`)
 *      — drops the 70+-agent `agents.ts` machinery.
 *   2. Copy-only install mode (no symlink option). Per the plan's scope
 *      boundary, Comate never creates symlinks — copy avoids broken-link
 *      surprises if the cache moves, prevents git pollution in the workspace,
 *      and sidesteps Windows symlink-permission issues.
 *
 * doc-review Adversarial #1: `lstat` the install target BEFORE writing to
 * detect an existing symlink (legacy CLI install). We refuse to overwrite
 * a symlink silently — the caller surfaces the conflict as
 * `status: 'already-installed'` so the user can choose Reinstall explicitly.
 *
 * doc-review Security #6: `sanitizeName` is applied to every skill name
 * before composing a filesystem path, blocking `../../etc/passwd` style
 * attacks from malicious SKILL.md frontmatter.
 */

import { cp, mkdir, lstat, rm, readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, normalize, resolve, sep, relative } from 'path';
import { createHash } from 'crypto';
import { getSkillsDirForScope } from './claude-code-paths.js';

/**
 * Sanitize a filename/directory name to prevent path traversal attacks
 * and enforce kebab-case convention.
 *
 * Ported verbatim from upstream `installer.ts:sanitizeName`.
 */
export function sanitizeName(name: string): string {
  const sanitized = name
    .toLowerCase()
    // Replace any sequence of characters that are NOT lowercase letters (a-z),
    // digits (0-9), dots (.), or underscores (_) with a single hyphen.
    .replace(/[^a-z0-9._]+/g, '-')
    // Remove leading/trailing dots and hyphens to prevent hidden files (.)
    // and ensure clean directory names.
    .replace(/^[.-]+|[.-]+$/g, '');

  // Limit to 255 chars (common filesystem limit), fallback to 'unnamed-skill' if empty
  return sanitized.substring(0, 255) || 'unnamed-skill';
}

/**
 * Validates that `targetPath` is `basePath` itself or a descendant of it.
 * Used to ensure sanitized install paths never escape the skills directory.
 */
function isPathSafe(basePath: string, targetPath: string): boolean {
  const normalizedBase = normalize(resolve(basePath));
  const normalizedTarget = normalize(resolve(targetPath));
  return (
    normalizedTarget === normalizedBase ||
    normalizedTarget.startsWith(normalizedBase + sep)
  );
}

export interface CopySkillOptions {
  /** Set to true to overwrite a pre-existing copy (Reinstall flow). */
  force?: boolean;
}

export interface CopySkillResult {
  /** Absolute path the skill was copied to. */
  destPath: string;
  /** SHA-256 hash computed from all files in the copied skill directory. */
  computedHash: string;
  /**
   * `installed` — fresh copy created.
   * `overwritten` — existing copy replaced (force=true only).
   * `already-installed` — non-forced install hit an existing copy or symlink.
   */
  status: 'installed' | 'overwritten' | 'already-installed';
  /** True if the existing target was a symlink (legacy CLI install). */
  wasSymlink?: boolean;
}

/**
 * Copy a single skill directory from `srcSkillDir` into the appropriate
 * Claude Code skills directory for `scope`.
 *
 * Behavior:
 *   - Sanitizes `skillName` before composing the destination path.
 *   - `lstat`s the destination. If a symlink exists there: refuse unless
 *     `force=true`. The caller surfaces the conflict for R8 handling.
 *   - If a real directory exists there: refuse unless `force=true`.
 *   - On `force=true`: removes the existing entry, copies fresh.
 *   - Computes a SHA-256 hash from all files in the COPIED directory and
 *     returns it for lock-file persistence.
 *
 * @throws if the sanitized path escapes the skills directory (defense in depth)
 */
export async function copySkillToScope(
  srcSkillDir: string,
  args: { skillName: string; scope: 'project' | 'global'; workspacePath?: string },
  options: CopySkillOptions = {}
): Promise<CopySkillResult> {
  const { skillName, scope, workspacePath } = args;
  const skillsDir = getSkillsDirForScope(scope, workspacePath);
  const sanitized = sanitizeName(skillName);
  const destPath = join(skillsDir, sanitized);

  if (!isPathSafe(skillsDir, destPath)) {
    // Defense in depth — sanitizeName should make this impossible.
    throw new Error(
      `Refusing to install skill "${skillName}": sanitized path escapes the skills directory.`
    );
  }

  // Adversarial #1: lstat BEFORE writing. Detects symlinks (legacy CLI install).
  let wasSymlink = false;
  if (existsSync(destPath)) {
    const lst = await lstat(destPath);
    if (lst.isSymbolicLink()) {
      wasSymlink = true;
    }
    if (!options.force) {
      return {
        destPath,
        computedHash: '',
        status: 'already-installed',
        wasSymlink,
      };
    }
    // force=true: remove existing entry. Use `rm` with `force` so symlinks
    // and directories both go away cleanly.
    await rm(destPath, { recursive: true, force: true });
  }

  // Copy source → dest. `dereference: true` ensures we copy real file
  // contents even if the source is a symlink into a cache directory.
  await mkdir(skillsDir, { recursive: true });
  await cp(srcSkillDir, destPath, { recursive: true, dereference: true });

  const computedHash = await computeSkillFolderHash(destPath);

  return {
    destPath,
    computedHash,
    status: wasSymlink ? 'overwritten' : 'installed',
    wasSymlink,
  };
}

/**
 * Remove a skill directory from the given scope. Returns false if the
 * skill wasn't installed (no filesystem mutation).
 *
 * Refuses to remove a symlink silently — that's a legacy CLI install,
 * and silently replacing it would be destructive. The caller surfaces
 * a "use npx skills update" message instead (per scope boundary in plan).
 *
 * @throws if the target is a symlink (legacy) — caller catches and surfaces
 */
export async function removeSkillFromScope(args: {
  skillName: string;
  scope: 'project' | 'global';
  workspacePath?: string;
}): Promise<boolean> {
  const { skillName, scope, workspacePath } = args;
  const skillsDir = getSkillsDirForScope(scope, workspacePath);
  const sanitized = sanitizeName(skillName);
  const targetPath = join(skillsDir, sanitized);

  if (!isPathSafe(skillsDir, targetPath)) {
    throw new Error(
      `Refusing to remove skill "${skillName}": sanitized path escapes the skills directory.`
    );
  }

  if (!existsSync(targetPath)) {
    return false;
  }

  const lst = await lstat(targetPath);
  if (lst.isSymbolicLink()) {
    throw new Error(
      `Cannot remove symlinked legacy skill "${skillName}" via Skills page. ` +
        `Use 'npx skills remove ${skillName}' to manage CLI-installed skills.`
    );
  }

  await rm(targetPath, { recursive: true, force: true });
  return true;
}

/**
 * Compute a SHA-256 hash from all files in a skill directory.
 *
 * Reads all files recursively (skipping `.git`, `node_modules`), sorts them
 * by relative path for determinism, and produces a single hash from their
 * concatenated contents. Includes the path in each update so renames are
 * detected as a hash change.
 *
 * Ported verbatim from upstream `local-lock.ts:computeSkillFolderHash`.
 */
export async function computeSkillFolderHash(skillDir: string): Promise<string> {
  const files: Array<{ relativePath: string; content: Buffer }> = [];
  await collectFiles(skillDir, skillDir, files);

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update(file.content);
  }

  return hash.digest('hex');
}

async function collectFiles(
  baseDir: string,
  currentDir: string,
  results: Array<{ relativePath: string; content: Buffer }>
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        // Skip .git and node_modules within skill dirs
        if (entry.name === '.git' || entry.name === 'node_modules') return;
        await collectFiles(baseDir, fullPath, results);
      } else if (entry.isFile()) {
        const content = await readFile(fullPath);
        const relativePath = relative(baseDir, fullPath).split('\\').join('/');
        results.push({ relativePath, content });
      }
    })
  );
}
