/**
 * SkillsService — business logic for the Skills page.
 *
 * Orchestrates the adapter layer (`services/skills/*`) and the atomic lock
 * utility (`utils/skills-lock.ts`) to implement search, resolve, install,
 * list, remove, and update flows.
 *
 * Singleton exported as `skillsService`. Mirrors the shape of
 * `plugin-settings-service.ts` (class + singleton export at module bottom).
 *
 * doc-review Coherence #3: install/uninstall/update return arrays of
 * per-skill results (InstallResult[]) so partial-success surfaces cleanly.
 *
 * doc-review Coherence #2: install accepts a `force` flag for the
 * Reinstall path (R8).
 *
 * doc-review Adversarial #1 + Security #6: enforced inside the adapter's
 * `copySkillToScope` (lstat-before-write, sanitizeName). This service
 * does not duplicate those checks.
 */

import { mkdtempSync, rmSync, existsSync, lstatSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { sidecarLog } from '../utils/sidecar-logger.js';
import {
  searchSkillsAPI,
  parseSource,
  cloneRepository,
  discoverSkills,
  toDiscoveredSkill,
  copySkillToScope,
  removeSkillFromScope,
  parseSkillMd,
  getOwnerRepo,
  getSkillsDirForScope,
  buildProjectLockEntry,
  buildGlobalLockEntry,
  type SearchSkill,
  type DiscoveredSkill,
  type Skill,
  type InstallResult,
  type LocalSkillLockEntry,
  type GlobalSkillLockEntry,
} from './skills/index.js';
import {
  readProjectLock,
  readGlobalLock,
  writeProjectLock,
  writeGlobalLock,
} from '../utils/skills-lock.js';

export type SkillScope = 'project' | 'global';

/**
 * Assert that a scope string is valid for the Skills page.
 * Mirrors `assertPluginScope` from plugin-settings-service.ts.
 */
export function assertSkillScope(scope: string): asserts scope is SkillScope {
  if (scope !== 'project' && scope !== 'global') {
    throw new Error(
      `Invalid skill scope: "${scope}". Must be "project" or "global" (Skills page does not support "local").`
    );
  }
}

export interface InstalledSkill {
  name: string;
  /** 'project' or 'global' */
  scope: SkillScope;
  /** Original source identifier (e.g., "owner/repo") */
  source: string;
  /** Where the skill is installed on disk */
  installPath: string;
  /** True if installPath is a symlink (legacy CLI install) */
  isLegacySymlink: boolean;
  /** Hash from the lock file (computed at install time) */
  computedHash?: string;
  /** ISO timestamp of last update (global lock only) */
  updatedAt?: string;
  /** ISO timestamp of initial install (global lock only) */
  installedAt?: string;
}

export interface ResolveSourceArgs {
  source: string;
  /** Active workspace path — required for local-path sandboxing */
  workspacePath?: string;
}

export interface InstallArgs {
  source: string;
  /** Skill names to install (must match discovered skill names) */
  skills: string[];
  scope: SkillScope;
  workspacePath?: string;
  /**
   * When true, overwrite any existing copy at the install path
   * (Reinstall flow per R8).
   */
  force?: boolean;
}

export interface UninstallArgs {
  skillName: string;
  scope: SkillScope;
  workspacePath?: string;
}

export interface UninstallResult {
  skillName: string;
  status: 'removed' | 'not-found' | 'error';
  error?: string;
}

export interface UpdateArgs {
  skillName: string;
  scope: SkillScope;
  workspacePath?: string;
  /** When true, overwrite even if the existing copy is a symlink. */
  force?: string;
}

export interface UpdateAllArgs {
  workspacePath?: string;
}

export interface UpdateAllResult {
  skillName: string;
  scope: SkillScope;
  status: 'updated' | 'already-current' | 'error';
  error?: string;
}

class SkillsService {
  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------

  async search(query: string): Promise<SearchSkill[]> {
    return searchSkillsAPI(query);
  }

  // -----------------------------------------------------------------------
  // Resolve (discover skills in a source)
  // -----------------------------------------------------------------------

  /**
   * Parse the source string and discover all skills it contains.
   * For git/github/gitlab sources: clone to a temp dir, walk for SKILL.md
   * files, clean up. For local sources: walk in place (no copy).
   *
   * Returns DiscoveredSkill[] (paths relative to source root) so the client
   * can render a multi-select picker.
   */
  async resolveSource(args: ResolveSourceArgs): Promise<DiscoveredSkill[]> {
    const parsed = parseSource(args.source, args.workspacePath);

    if (parsed.type === 'local') {
      const localPath = parsed.localPath!;
      if (!existsSync(localPath)) {
        throw new Error(`Local source path does not exist: ${localPath}`);
      }
      const skills = await discoverSkills(localPath, parsed.subpath);
      return skills.map((s) => toDiscoveredSkill(s, localPath));
    }

    // Remote source: clone to temp, discover, clean up
    const tempDir = mkdtempSync(join(tmpdir(), 'comate-skills-resolve-'));
    try {
      const cloneResult = await cloneRepository(parsed.url, tempDir, { ref: parsed.ref });
      if (!cloneResult.success) {
        throw new Error(cloneResult.error ?? 'Failed to clone repository');
      }

      const skills = await discoverSkills(tempDir, parsed.subpath, {
        skillFilter: parsed.skillFilter,
      });
      return skills.map((s) => toDiscoveredSkill(s, tempDir));
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch (err) {
        sidecarLog(`[SkillsService] failed to clean up temp clone ${tempDir}: ${(err as Error).message}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Install (Coherence #3: returns InstallResult[] for partial-success)
  // -----------------------------------------------------------------------

  async install(args: InstallArgs): Promise<InstallResult[]> {
    const { source, skills: requestedSkills, scope, workspacePath, force } = args;
    if (requestedSkills.length === 0) {
      return [];
    }

    const parsed = parseSource(source, workspacePath);
    const results: InstallResult[] = [];

    // For local source, walk in place; for remote, clone to temp first.
    let sourceRoot: string;
    let tempDir: string | null = null;

    if (parsed.type === 'local') {
      sourceRoot = parsed.localPath!;
      if (!existsSync(sourceRoot)) {
        throw new Error(`Local source path does not exist: ${sourceRoot}`);
      }
    } else {
      tempDir = mkdtempSync(join(tmpdir(), 'comate-skills-install-'));
      const cloneResult = await cloneRepository(parsed.url, tempDir, { ref: parsed.ref });
      if (!cloneResult.success) {
        try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
        throw new Error(cloneResult.error ?? 'Failed to clone repository');
      }
      sourceRoot = tempDir;
    }

    try {
      // Discover available skills so we can match by name.
      const allSkills = await discoverSkills(sourceRoot, parsed.subpath);
      const skillByName = new Map<string, Skill>();
      for (const s of allSkills) {
        skillByName.set(s.name, s);
      }

      for (const requestedName of requestedSkills) {
        const skill = skillByName.get(requestedName);
        if (!skill) {
          results.push({
            skillName: requestedName,
            status: 'error',
            error: `Skill "${requestedName}" not found in source. Available: ${[...skillByName.keys()].slice(0, 10).join(', ')}${skillByName.size > 10 ? '…' : ''}`,
          });
          continue;
        }

        try {
          const copyResult = await copySkillToScope(
            skill.path,
            { skillName: skill.name, scope, workspacePath },
            { force }
          );

          if (copyResult.status === 'already-installed') {
            results.push({
              skillName: skill.name,
              status: 'already-installed',
              path: copyResult.destPath,
            });
            continue;
          }

          // Write lock entry.
          await this.writeLockEntry({
            scope,
            workspacePath,
            skillName: skill.name,
            source,
            sourceUrl: parsed.url,
            sourceType: parsed.type,
            ref: parsed.ref,
            skillPath: this.computeSkillPathForLock(sourceRoot, skill.path),
            computedHash: copyResult.computedHash,
          });

          results.push({
            skillName: skill.name,
            status: 'installed',
            path: copyResult.destPath,
          });
        } catch (err) {
          results.push({
            skillName: skill.name,
            status: 'error',
            error: (err as Error).message,
          });
        }
      }
    } finally {
      if (tempDir) {
        try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // List installed
  // -----------------------------------------------------------------------

  /**
   * List installed skills across both scopes. Merges project + global lock
   * entries, attaches `isLegacySymlink` flag based on filesystem state.
   */
  async listInstalled(workspacePath?: string): Promise<InstalledSkill[]> {
    const installed: InstalledSkill[] = [];

    if (workspacePath) {
      const projectLock = await readProjectLock(workspacePath);
      for (const [name, entry] of Object.entries(projectLock.skills)) {
        installed.push(await this.toInstalledSkill(name, entry, 'project', workspacePath));
      }
    }

    const globalLock = await readGlobalLock();
    for (const [name, entry] of Object.entries(globalLock.skills)) {
      installed.push(await this.toInstalledSkill(name, entry, 'global'));
    }

    return installed;
  }

  private async toInstalledSkill(
    name: string,
    entry: LocalSkillLockEntry | GlobalSkillLockEntry,
    scope: SkillScope,
    workspacePath?: string
  ): Promise<InstalledSkill> {
    const dir = getSkillsDirForScope(scope, workspacePath);
    const installPath = join(dir, name);

    let isLegacySymlink = false;
    if (existsSync(installPath)) {
      try {
        const lst = lstatSync(installPath);
        isLegacySymlink = lst.isSymbolicLink();
      } catch {
        // Path exists check passed but lstat failed (race). Treat as not symlink.
      }
    }

    const base: InstalledSkill = {
      name,
      scope,
      source: entry.source,
      installPath,
      isLegacySymlink,
    };

    if (scope === 'project') {
      const p = entry as LocalSkillLockEntry;
      base.computedHash = p.computedHash;
    } else {
      const g = entry as GlobalSkillLockEntry;
      base.computedHash = g.skillFolderHash;
      base.installedAt = g.installedAt;
      base.updatedAt = g.updatedAt;
    }

    return base;
  }

  // -----------------------------------------------------------------------
  // Remove
  // -----------------------------------------------------------------------

  async remove(args: UninstallArgs): Promise<UninstallResult> {
    const { skillName, scope, workspacePath } = args;
    try {
      let removed = true;
      try {
        removed = await removeSkillFromScope({ skillName, scope, workspacePath });
      } catch (err) {
        // Symlink-refusal error etc. — surface as error result.
        return {
          skillName,
          status: 'error',
          error: (err as Error).message,
        };
      }

      // Always remove the lock entry (lock is source-of-truth for "installed")
      await this.removeLockEntry({ scope, workspacePath, skillName });

      return {
        skillName,
        status: removed ? 'removed' : 'not-found',
      };
    } catch (err) {
      return {
        skillName,
        status: 'error',
        error: (err as Error).message,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Update (re-fetch source, re-copy, refresh lock entry)
  // -----------------------------------------------------------------------

  async update(args: UpdateArgs): Promise<InstallResult> {
    const { skillName, scope, workspacePath, force } = args;

    // Read current lock entry to find the source
    const entry = await this.readLockEntry(scope, workspacePath, skillName);
    if (!entry) {
      return {
        skillName,
        status: 'error',
        error: `Skill "${skillName}" is not in the ${scope} lock file.`,
      };
    }

    // Refuse to update a symlinked legacy skill unless force is set.
    const dir = getSkillsDirForScope(scope, workspacePath);
    const installPath = join(dir, skillName);
    if (existsSync(installPath)) {
      const lst = lstatSync(installPath);
      if (lst.isSymbolicLink() && !force) {
        return {
          skillName,
          status: 'error',
          error: `Cannot update symlinked legacy skill "${skillName}" via Skills page. Use 'npx skills update ${skillName}'.`,
        };
      }
    }

    // Re-install with force=true (overwrites existing copy)
    const installResults = await this.install({
      source: entry.sourceUrl ?? entry.source,
      skills: [skillName],
      scope,
      workspacePath,
      force: true,
    });

    return installResults[0] ?? {
      skillName,
      status: 'error',
      error: 'Update produced no result.',
    };
  }

  async updateAll(args: UpdateAllArgs): Promise<UpdateAllResult[]> {
    const installed = await this.listInstalled(args.workspacePath);
    const results: UpdateAllResult[] = [];

    for (const skill of installed) {
      if (skill.isLegacySymlink) {
        results.push({
          skillName: skill.name,
          scope: skill.scope,
          status: 'error',
          error: 'Cannot update symlinked legacy skill via Skills page.',
        });
        continue;
      }

      try {
        const result = await this.update({
          skillName: skill.name,
          scope: skill.scope,
          workspacePath: args.workspacePath,
        });
        results.push({
          skillName: skill.name,
          scope: skill.scope,
          status: result.status === 'error' ? 'error' : 'updated',
          error: result.error,
        });
      } catch (err) {
        results.push({
          skillName: skill.name,
          scope: skill.scope,
          status: 'error',
          error: (err as Error).message,
        });
      }
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // Lock entry helpers
  // -----------------------------------------------------------------------

  private async writeLockEntry(args: {
    scope: SkillScope;
    workspacePath?: string;
    skillName: string;
    source: string;
    sourceUrl: string;
    sourceType: string;
    ref?: string;
    skillPath?: string;
    computedHash: string;
  }): Promise<void> {
    const {
      scope, workspacePath, skillName,
      source, sourceUrl, sourceType, ref, skillPath, computedHash,
    } = args;

    if (scope === 'project') {
      if (!workspacePath) {
        throw new Error('workspacePath is required for project-scope lock writes');
      }
      const lock = await readProjectLock(workspacePath);
      lock.skills[skillName] = buildProjectLockEntry({
        source, sourceType, computedHash, ref, skillPath,
      });
      await writeProjectLock(workspacePath, lock);
    } else {
      const lock = await readGlobalLock();
      const existing = lock.skills[skillName];
      const now = new Date().toISOString();
      // Use owner/repo as the source identifier when available, falling back to URL.
      const parsed = parseSource(source, workspacePath);
      const sourceIdentifier = getOwnerRepo(parsed) ?? sourceUrl;
      lock.skills[skillName] = buildGlobalLockEntry({
        source: sourceIdentifier,
        sourceType,
        sourceUrl,
        skillFolderHash: computedHash,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
        ref, skillPath,
      });
      await writeGlobalLock(lock);
    }
  }

  private async removeLockEntry(args: {
    scope: SkillScope;
    workspacePath?: string;
    skillName: string;
  }): Promise<void> {
    const { scope, workspacePath, skillName } = args;
    if (scope === 'project') {
      if (!workspacePath) return;
      const lock = await readProjectLock(workspacePath);
      if (skillName in lock.skills) {
        delete lock.skills[skillName];
        await writeProjectLock(workspacePath, lock);
      }
    } else {
      const lock = await readGlobalLock();
      if (skillName in lock.skills) {
        delete lock.skills[skillName];
        await writeGlobalLock(lock);
      }
    }
  }

  private async readLockEntry(
    scope: SkillScope,
    workspacePath: string | undefined,
    skillName: string
  ): Promise<{ source: string; sourceUrl?: string } | null> {
    if (scope === 'project') {
      if (!workspacePath) return null;
      const lock = await readProjectLock(workspacePath);
      const entry = lock.skills[skillName];
      return entry ? { source: entry.source } : null;
    }
    const lock = await readGlobalLock();
    const entry = lock.skills[skillName];
    return entry ? { source: entry.source, sourceUrl: entry.sourceUrl } : null;
  }

  /**
   * Compute the path to a SKILL.md relative to the source root, for the lock
   * entry's `skillPath` field. This lets `update` re-install only this skill
   * instead of refetching every skill in the source repo.
   */
  private computeSkillPathForLock(sourceRoot: string, skillDir: string): string {
    let rel = relative(sourceRoot, skillDir).split('\\').join('/');
    if (rel === '') rel = '.';
    return `${rel}/SKILL.md`;
  }
}

export const skillsService = new SkillsService();

// Re-export installer helpers + path utilities for routes + store convenience
export { sanitizeName, getProjectLockPath, getGlobalLockPath } from './skills/index.js';
export { parseSkillMd };
