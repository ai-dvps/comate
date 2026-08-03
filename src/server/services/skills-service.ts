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

import { mkdtempSync, rmSync, existsSync, lstatSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { sidecarLog } from '../utils/sidecar-logger.js';
import {
  searchFederatedSkills,
  parseSource,
  cloneRepository,
  discoverSkills,
  toDiscoveredSkill,
  copySkillToScope,
  sanitizeName,
  removeSkillFromScope,
  parseSkillMd,
  getOwnerRepo,
  getSkillsDirForScope,
  buildProjectLockEntry,
  buildGlobalLockEntry,
  getProjectLockPath,
  getGlobalLockPath,
  materializeRegistrySource,
  parseRegistrySource,
  registrySourceUrl,
  installCoordinator,
  getExpertPackage,
  getExpertPackageDefinition,
  getExpertSkill,
  listExpertPackages,
  getEnterprise,
  getEnterpriseSkill,
  listEnterprises,
  listEnterpriseIndustries,
  listEnterpriseSkills,
  type SearchSkill,
  type DiscoveredSkill,
  type Skill,
  type InstallResult,
  type LocalSkillLockEntry,
  type GlobalSkillLockEntry,
  type ExpertPackageInstallResult,
  type ExpertSkillDetail,
  type ExpertPackageDetail,
  type ExpertPackageSummary,
  type EnterpriseDetail,
  type EnterpriseIndustry,
  type EnterprisePage,
  type EnterpriseSkillPage,
  type EnterpriseSkillSort,
  type SkillHubSkillDetail,
} from './skills/index.js';
import type { SkillSearchQuery } from './skills/index.js';
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
  kind: 'skill' | 'expert-package-orchestrator';
  /** Description parsed from the installed skill's local SKILL.md, when available. */
  description?: string;
  /** 'project' or 'global' */
  scope: SkillScope;
  /** Original source identifier (e.g., "owner/repo") */
  source: string;
  /** Expert Package that installed this Skill, if it belongs to one. */
  packageSlug?: string;
  /** Catalog summary cached at package installation time for offline display. */
  packageCatalog?: ExpertPackageSummary;
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
  /** Server-owned snapshot used only while expanding an Expert Package install. */
  packageOrchestrationContent?: string;
  /** Expert Package that owns the installed Skill. */
  packageSlug?: string;
  /** Catalog summary saved only for an Expert Package orchestration. */
  packageCatalog?: ExpertPackageSummary;
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

export interface InstallExpertPackageArgs {
  packageSlug: string;
  scope: SkillScope;
  workspacePath?: string;
  /** Stable item ids from a previous failed attempt. Omit to install all items. */
  itemIds?: string[];
  /** Overwrite installed package files when refreshing the package. */
  force?: boolean;
}

export class SkillsService {
  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------

  async search(query: SkillSearchQuery): Promise<SearchSkill[]> {
    return searchFederatedSkills(query);
  }

  async listExpertPackages(input: {
    keyword?: string;
    scene?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ packages: ExpertPackageSummary[]; total: number }> {
    return listExpertPackages(input);
  }

  async getExpertPackage(slug: string): Promise<ExpertPackageDetail> {
    return getExpertPackage(slug);
  }

  async listEnterpriseIndustries(): Promise<EnterpriseIndustry[]> {
    return listEnterpriseIndustries();
  }

  async listEnterprises(input: {
    keyword?: string;
    industry?: string;
    page?: number;
  }): Promise<EnterprisePage> {
    return listEnterprises(input);
  }

  async getEnterprise(orgId: string): Promise<EnterpriseDetail> {
    return getEnterprise(orgId);
  }

  async listEnterpriseSkills(
    orgId: string,
    input: { keyword?: string; sort?: EnterpriseSkillSort; page?: number },
  ): Promise<EnterpriseSkillPage> {
    return listEnterpriseSkills(orgId, input);
  }

  async isExpertSkillInPackage(packageSlug: string, namespace: string, slug: string): Promise<boolean> {
    const definition = await getExpertPackageDefinition(packageSlug);
    return definition.coordinates.some((item) => item.namespace === namespace && item.slug === slug);
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
    const registrySource = parseRegistrySource(args.source);
    if (registrySource) {
      const tempDir = mkdtempSync(join(tmpdir(), 'comate-skills-resolve-'));
      try {
        await materializeRegistrySource(registrySource, tempDir);
        const skills = await discoverSkills(tempDir, undefined, {
          fullDepth: registrySource.skillId !== undefined,
        });
        if (registrySource.skillId !== undefined) {
          const validationError = this.registrySkillValidationError(
            registrySource,
            skills,
            this.countSkillManifests(tempDir),
          );
          if (validationError) throw new Error(validationError);
        }
        return skills.map((s) => toDiscoveredSkill(s, tempDir));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }

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
    const {
      source, skills: requestedSkills, scope, workspacePath, force, packageOrchestrationContent, packageSlug, packageCatalog,
    } = args;
    if (requestedSkills.length === 0) {
      return [];
    }

    const results: InstallResult[] = [];

    // For local source, walk in place; for remote, clone to temp first.
    let sourceRoot: string;
    let tempDir: string | null = null;

    const registrySource = parseRegistrySource(source);
    const parsed = registrySource ? null : parseSource(source, workspacePath);

    if (registrySource) {
      tempDir = mkdtempSync(join(tmpdir(), 'comate-skills-install-'));
      try {
        await materializeRegistrySource(registrySource, tempDir, { packageOrchestrationContent });
      } catch (error) {
        rmSync(tempDir, { recursive: true, force: true });
        throw error;
      }
      sourceRoot = tempDir;
    } else if (parsed!.type === 'local') {
      sourceRoot = parsed!.localPath!;
      if (!existsSync(sourceRoot)) {
        throw new Error(`Local source path does not exist: ${sourceRoot}`);
      }
    } else {
      tempDir = mkdtempSync(join(tmpdir(), 'comate-skills-install-'));
      const cloneResult = await cloneRepository(parsed!.url, tempDir, { ref: parsed!.ref });
      if (!cloneResult.success) {
        try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
        throw new Error(cloneResult.error ?? 'Failed to clone repository');
      }
      sourceRoot = tempDir;
    }

    try {
      // Package orchestration is copied verbatim, even when its frontmatter is incomplete.
      // Other sources still require normal Skill discovery and metadata validation.
      const allSkills: Array<Pick<Skill, 'name' | 'path'>> = registrySource?.kind === 'expert-package-orchestrator'
        ? [{
            name: registrySource.packageSlug!,
            path: join(sourceRoot, registrySource.packageSlug!),
          }]
        : await discoverSkills(sourceRoot, parsed?.subpath, {
            fullDepth: registrySource?.skillId !== undefined,
          });
      const registryValidationError = registrySource
        ? this.registrySkillValidationError(
            registrySource,
            allSkills,
            registrySource.skillId !== undefined ? this.countSkillManifests(sourceRoot) : undefined,
          )
        : null;
      if (registryValidationError) {
        return requestedSkills.map((skillName) => ({
          skillName,
          kind: registrySource?.kind ?? 'skill',
          status: 'error',
          error: registryValidationError,
        }));
      }
      if (
        registrySource?.skillId !== undefined
        && (requestedSkills.length !== 1 || requestedSkills[0] !== allSkills[0]!.name)
      ) {
        return requestedSkills.map((skillName) => ({
          skillName,
          kind: registrySource.kind,
          status: 'error',
          error: `WeSkillHub source contains exactly one Skill named "${allSkills[0]!.name}".`,
        }));
      }
      const skillByName = new Map<string, Pick<Skill, 'name' | 'path'>>();
      for (const s of allSkills) {
        skillByName.set(s.name, s);
      }

      for (const requestedName of requestedSkills) {
        const skill = skillByName.get(requestedName);
        if (!skill) {
          results.push({
            skillName: requestedName,
            kind: registrySource?.kind ?? 'skill',
            status: 'error',
            error: `Skill "${requestedName}" not found in source. Available: ${[...skillByName.keys()].slice(0, 10).join(', ')}${skillByName.size > 10 ? '…' : ''}`,
          });
          continue;
        }

        try {
          const result = await installCoordinator.run(
            this.scopeMutationKey(scope, workspacePath),
            async (): Promise<InstallResult> => {
              const destPath = join(getSkillsDirForScope(scope, workspacePath), skill.name);
              const existedBeforeCopy = existsSync(destPath);
              if (registrySource?.skillId !== undefined) {
                const existingEntry = await this.readLockEntry(scope, workspacePath, skill.name);
                if (
                  (existingEntry && (existingEntry.source !== source || existingEntry.sourceType !== 'registry'))
                  || (existedBeforeCopy && !existingEntry)
                ) {
                  return {
                    skillName: skill.name,
                    kind: registrySource.kind,
                    status: 'error',
                    error: `Skill name "${skill.name}" is already used by another source in this scope.`,
                  };
                }
              }
              const copyResult = await copySkillToScope(
                skill.path,
                { skillName: skill.name, scope, workspacePath },
                { force }
              );

              if (copyResult.status === 'already-installed') {
                const existingEntry = await this.readLockEntry(scope, workspacePath, skill.name);
                if (registrySource && existingEntry?.source !== source) {
                  return {
                    skillName: skill.name,
                    kind: registrySource.kind,
                    status: 'error',
                    error: `Skill name "${skill.name}" is already used by another source in this scope.`,
                  };
                }
                return {
                  skillName: skill.name,
                  kind: registrySource?.kind ?? 'skill',
                  status: 'already-installed',
                  path: copyResult.destPath,
                };
              }

              try {
                await this.writeLockEntry({
                  scope,
                  workspacePath,
                  skillName: skill.name,
                  source,
                  sourceUrl: registrySource
                    ? (registrySource.skillId !== undefined ? registrySource.source : registrySourceUrl(registrySource))
                    : parsed!.url,
                  sourceType: registrySource ? 'registry' : parsed!.type,
                  ref: parsed?.ref,
                  skillPath: this.computeSkillPathForLock(sourceRoot, skill.path),
                  computedHash: copyResult.computedHash,
                  packageSlug,
                  packageCatalog,
                });
              } catch (error) {
                // A fresh directory without a lock entry is not a valid install.
                // Forced overwrites are intentionally not deleted because doing so
                // would destroy the user's previous installation.
                if (!existedBeforeCopy) {
                  rmSync(copyResult.destPath, { recursive: true, force: true });
                }
                throw error;
              }

              return {
                skillName: skill.name,
                kind: registrySource?.kind ?? 'skill',
                status: 'installed',
                path: copyResult.destPath,
              };
            },
          );
          results.push(result);
        } catch (err) {
          results.push({
            skillName: skill.name,
            kind: registrySource?.kind ?? 'skill',
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

  async getExpertSkillDetail(namespace: string, slug: string): Promise<ExpertSkillDetail> {
    const detail = await getExpertSkill(namespace, slug);
    return this.hydrateSkillDocumentation(detail);
  }

  async getEnterpriseSkillDetail(
    orgId: string,
    namespace: string,
    slug: string,
  ): Promise<SkillHubSkillDetail> {
    const detail = await getEnterpriseSkill(orgId, namespace, slug);
    return this.hydrateSkillDocumentation(detail);
  }

  private async hydrateSkillDocumentation(detail: SkillHubSkillDetail): Promise<SkillHubSkillDetail> {
    const tempDir = mkdtempSync(join(tmpdir(), 'comate-skill-doc-'));
    try {
      const source = parseRegistrySource(detail.source)!;
      await materializeRegistrySource(source, tempDir);
      const skills = await discoverSkills(tempDir);
      if (skills.length !== 1 || skills[0]?.name !== detail.slug || !skills[0].rawContent) {
        throw new Error(`Registry source must contain exactly one Skill named "${detail.slug}".`);
      }
      return { ...detail, documentation: skills[0].rawContent };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async installExpertPackage(args: InstallExpertPackageArgs): Promise<ExpertPackageInstallResult[]> {
    const definition = await getExpertPackageDefinition(args.packageSlug);

    const items: Array<{
      id: string;
      kind: 'orchestrator' | 'skill';
      source: string;
      name: string;
      packageOrchestrationContent?: string;
      packageCatalog?: ExpertPackageSummary;
    }> = [
      {
        id: `orchestrator:${definition.summary.slug}`,
        kind: 'orchestrator',
        source: `skillhub-package:${definition.summary.slug}`,
        name: definition.summary.slug,
        packageOrchestrationContent: definition.content,
        packageCatalog: definition.summary,
      },
      ...definition.coordinates.map((coordinate) => ({
        id: `skill:${coordinate.namespace}/${coordinate.slug}`,
        kind: 'skill' as const,
        source: `skillhub-cn:${coordinate.namespace}/${coordinate.slug}`,
        name: coordinate.slug,
      })),
    ];
    const byId = new Map(items.map((item) => [item.id, item]));
    const requestedIds = args.itemIds ?? [...byId.keys()];
    if (requestedIds.length === 0 || new Set(requestedIds).size !== requestedIds.length) {
      throw new Error('Package install itemIds must be a non-empty unique list');
    }
    for (const id of requestedIds) {
      if (!byId.has(id)) throw new Error(`Install item "${id}" does not belong to this Expert Package`);
    }

    const results: ExpertPackageInstallResult[] = [];
    for (const id of requestedIds) {
      const item = byId.get(id)!;
      try {
        const [result] = await this.install({
          source: item.source,
          skills: [item.name],
          scope: args.scope,
          workspacePath: args.workspacePath,
          force: args.force,
          packageOrchestrationContent: item.packageOrchestrationContent,
          packageSlug: definition.summary.slug,
          packageCatalog: item.packageCatalog,
        });
        results.push({
          id: item.id,
          kind: item.kind,
          source: item.source,
          name: item.name,
          status: result?.status ?? 'error',
          ...(result?.path ? { path: result.path } : {}),
          ...(result?.error ? { error: result.error } : {}),
        });
      } catch (error) {
        results.push({
          id: item.id,
          kind: item.kind,
          source: item.source,
          name: item.name,
          status: 'error',
          error: (error as Error).message,
        });
      }
    }
    return results;
  }

  async removeExpertPackage(args: {
    packageSlug: string;
    scope: SkillScope;
    workspacePath?: string;
  }): Promise<UninstallResult[]> {
    const definition = await getExpertPackageDefinition(args.packageSlug);
    const names = [definition.summary.slug, ...definition.coordinates.map((coordinate) => coordinate.slug)];
    const uniqueNames = [...new Set(names)];
    const results: UninstallResult[] = [];

    for (const skillName of uniqueNames) {
      results.push(await this.remove({
        skillName,
        scope: args.scope,
        workspacePath: args.workspacePath,
      }));
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

    await this.associateLegacyExpertPackageSkills(installed);
    return installed;
  }

  private async associateLegacyExpertPackageSkills(installed: InstalledSkill[]): Promise<void> {
    const packages = installed.filter((skill) => skill.kind === 'expert-package-orchestrator');
    await Promise.all(packages.map(async (packageSkill) => {
      const hasUnlinkedSkills = installed.some((skill) => (
        skill.scope === packageSkill.scope && skill.kind === 'skill' && !skill.packageSlug
      ));
      if (!hasUnlinkedSkills) return;
      const packageSlug = packageSkill.source.slice('skillhub-package:'.length);
      try {
        const definition = await getExpertPackageDefinition(packageSlug);
        const childSources = new Set(definition.coordinates.map(
          (coordinate) => `skillhub-cn:${coordinate.namespace}/${coordinate.slug}`,
        ));
        for (const skill of installed) {
          if (skill.scope === packageSkill.scope && skill.kind === 'skill' && childSources.has(skill.source)) {
            skill.packageSlug ??= packageSlug;
          }
        }
      } catch {
        // Keep legacy package children as standalone entries when SkillHub is unavailable.
      }
    }));
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
      kind: entry.source.startsWith('skillhub-package:') ? 'expert-package-orchestrator' : 'skill',
      scope,
      source: entry.source,
      ...(entry.packageSlug ? { packageSlug: entry.packageSlug } : {}),
      ...(entry.packageCatalog ? { packageCatalog: entry.packageCatalog } : {}),
      installPath,
      isLegacySymlink,
    };

    const skillMetadata = await parseSkillMd(join(installPath, 'SKILL.md'), { includeInternal: true });
    if (skillMetadata?.description) {
      base.description = skillMetadata.description;
    }

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
      const removed = await installCoordinator.run(
        this.scopeMutationKey(scope, workspacePath),
        async () => {
          const didRemove = await removeSkillFromScope({ skillName, scope, workspacePath });
          // Always remove the lock entry (lock is source-of-truth for "installed")
          await this.removeLockEntry({ scope, workspacePath, skillName });
          return didRemove;
        },
      );

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
      source: entry.sourceType === 'registry' ? entry.source : entry.sourceUrl ?? entry.source,
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
      if (skill.kind === 'expert-package-orchestrator') {
        try {
          const packageSlug = skill.source.slice('skillhub-package:'.length);
          const packageResults = await this.installExpertPackage({
            packageSlug,
            scope: skill.scope,
            workspacePath: args.workspacePath,
            force: true,
          });
          const failures = packageResults.filter((result) => result.status === 'error');
          results.push({
            skillName: skill.name,
            scope: skill.scope,
            status: failures.length === 0 ? 'updated' : 'error',
            ...(failures.length > 0 ? { error: failures.map((result) => result.error).filter(Boolean).join('; ') } : {}),
          });
        } catch (err) {
          results.push({
            skillName: skill.name,
            scope: skill.scope,
            status: 'error',
            error: (err as Error).message,
          });
        }
        continue;
      }

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
    packageSlug?: string;
    packageCatalog?: ExpertPackageSummary;
  }): Promise<void> {
    const {
      scope, workspacePath, skillName,
      source, sourceUrl, sourceType, ref, skillPath, computedHash, packageSlug, packageCatalog,
    } = args;

    if (scope === 'project') {
      if (!workspacePath) {
        throw new Error('workspacePath is required for project-scope lock writes');
      }
      const lock = await readProjectLock(workspacePath);
      lock.skills[skillName] = buildProjectLockEntry({
        source, sourceType, computedHash, ref, skillPath, packageSlug, packageCatalog,
      });
      await writeProjectLock(workspacePath, lock);
    } else {
      const lock = await readGlobalLock();
      const existing = lock.skills[skillName];
      const now = new Date().toISOString();
      // Registry coordinates must stay intact so update can re-download them.
      // Git sources retain the existing owner/repo-friendly lock representation.
      const sourceIdentifier = sourceType === 'registry'
        ? source
        : getOwnerRepo(parseSource(source, workspacePath)) ?? sourceUrl;
      lock.skills[skillName] = buildGlobalLockEntry({
        source: sourceIdentifier,
        sourceType,
        sourceUrl,
        skillFolderHash: computedHash,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
        ref, skillPath, packageSlug, packageCatalog,
      });
      await writeGlobalLock(lock);
    }
  }

  private registrySkillValidationError(
    source: NonNullable<ReturnType<typeof parseRegistrySource>>,
    skills: Array<Pick<Skill, 'name'>>,
    skillManifestCount?: number,
  ): string | null {
    if (source.skillId !== undefined) {
      if (skills.length !== 1 || skillManifestCount !== 1) {
        return 'WeSkillHub source must contain exactly one discoverable Skill.';
      }
      const name = skills[0]!.name;
      if (name !== sanitizeName(name)) {
        return `WeSkillHub Skill name "${name}" must already be in its filesystem-safe canonical form.`;
      }
      return null;
    }

    const expectedName = source.packageSlug ?? source.slug;
    if (expectedName && (skills.length !== 1 || skills[0]?.name !== expectedName)) {
      return `Registry source must contain exactly one Skill named "${expectedName}".`;
    }
    return null;
  }

  private countSkillManifests(dir: string, depth = 0): number {
    if (depth > 5) return 0;

    let count = 0;
    try {
      const skillMdPath = join(dir, 'SKILL.md');
      if (existsSync(skillMdPath) && lstatSync(skillMdPath).isFile()) count += 1;

      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (
          entry.isDirectory()
          && !['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(entry.name)
        ) {
          count += this.countSkillManifests(join(dir, entry.name), depth + 1);
        }
      }
    } catch {
      return count;
    }
    return count;
  }

  private scopeMutationKey(scope: SkillScope, workspacePath?: string): string {
    if (scope === 'project') {
      if (!workspacePath) throw new Error('workspacePath is required for project-scope mutations');
      return getProjectLockPath(workspacePath);
    }
    return getGlobalLockPath();
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
  ): Promise<{ source: string; sourceUrl?: string; sourceType?: string } | null> {
    if (scope === 'project') {
      if (!workspacePath) return null;
      const lock = await readProjectLock(workspacePath);
      const entry = lock.skills[skillName];
      return entry ? { source: entry.source, sourceType: entry.sourceType } : null;
    }
    const lock = await readGlobalLock();
    const entry = lock.skills[skillName];
    return entry ? { source: entry.source, sourceUrl: entry.sourceUrl, sourceType: entry.sourceType } : null;
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
