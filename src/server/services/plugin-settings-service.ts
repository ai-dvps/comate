import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  readPluginSettings,
  writePluginSettings,
  resolveWorkspaceClaudeSettingsPath,
  resolveLocalClaudeSettingsPath,
  resolveGlobalClaudeSettingsPath,
  readInstalledPluginsJson,
  type PluginSettings,
  type PluginStateEntry,
  type InstalledPluginsFile,
  type InstalledPluginEntry,
} from '../utils/claude-settings.js';
import { sidecarLog } from '../utils/sidecar-logger.js';

export type PluginScope = 'user' | 'project' | 'local';

export function assertPluginScope(scope: string): asserts scope is PluginScope {
  if (scope !== 'user' && scope !== 'project' && scope !== 'local') {
    throw new Error(`Invalid plugin scope: "${scope}". Must be "user", "project", or "local".`);
  }
}

export interface InstalledPlugin {
  id: string;
  version: string;
  source: string;
  enabled: boolean;
  installedAt: string;
  updatedAt?: string;
  /** CLI's qualified key: "plugin@marketplace" */
  qualifiedId?: string;
  /** CLI's versioned cache path, e.g. cache/marketplace/plugin/version/ */
  installPath?: string;
  /** Git commit SHA from CLI */
  gitCommitSha?: string;
}

export interface PluginManifest {
  name: string;
  displayName?: string;
  description?: string;
  version: string;
  author?: string;
  keywords?: string[];
  source?: string;
}

/** Map of qualifiedId -> single CLI entry matching the given scope */
type CliPluginMap = Map<string, InstalledPluginEntry>;

export class PluginSettingsService {
  private cacheDir: string | null = null;

  /**
   * Resolve the path to the plugin cache directory.
   * Uses the CLI-compatible path: ~/.claude/plugins/cache/
   */
  resolvePluginCacheDir(): string {
    if (this.cacheDir) return this.cacheDir;
    const cacheDir = join(homedir(), '.claude', 'plugins', 'cache');
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
    this.cacheDir = cacheDir;
    return cacheDir;
  }

  /**
   * Resolve the cache path for a specific plugin (flat format).
   */
  resolvePluginCachePath(pluginId: string): string {
    return join(this.resolvePluginCacheDir(), pluginId);
  }

  /**
   * Resolve the CLI-compatible versioned cache path for a plugin.
   * Format: ~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/
   * Matches CLI's getVersionedCachePath from pluginLoader.ts.
   */
  resolveVersionedCachePath(pluginId: string, marketplace: string, version: string): string {
    const cacheDir = this.resolvePluginCacheDir();
    const sanitizedMarketplace = marketplace.replace(/[^a-zA-Z0-9\-_]/g, '-');
    const sanitizedPlugin = pluginId.replace(/[^a-zA-Z0-9\-_]/g, '-');
    const sanitizedVersion = version.replace(/[^a-zA-Z0-9\-_.]/g, '-');
    return join(cacheDir, sanitizedMarketplace, sanitizedPlugin, sanitizedVersion);
  }

  /**
   * Resolve the settings file path for the given scope.
   */
  resolveSettingsPath(scope: PluginScope, workspacePath?: string): string {
    if (scope === 'user') {
      return resolveGlobalClaudeSettingsPath().settingsPath;
    }
    if (!workspacePath) {
      throw new Error('workspacePath is required for project and local scopes');
    }
    if (scope === 'project') {
      return resolveWorkspaceClaudeSettingsPath(workspacePath);
    }
    return resolveLocalClaudeSettingsPath(workspacePath);
  }

  // ---------------------------------------------------------------------------
  // CLI installed_plugins.json helpers
  // ---------------------------------------------------------------------------

  /**
   * Build a map of qualifiedId -> CLI entry for entries matching the given scope.
   * For project/local scopes, also matches projectPath.
   */
  private buildCliPluginsMap(
    cliData: InstalledPluginsFile,
    scope: PluginScope,
    workspacePath?: string,
  ): CliPluginMap {
    const map: CliPluginMap = new Map();
    for (const [qualifiedId, entries] of Object.entries(cliData.plugins)) {
      for (const entry of entries) {
        if (entry.scope !== scope) continue;
        if ((scope === 'project' || scope === 'local') && entry.projectPath && workspacePath) {
          if (entry.projectPath !== workspacePath) continue;
        }
        map.set(qualifiedId, entry);
      }
    }
    return map;
  }

  /**
   * Find the CLI qualified key for a plugin given its bare ID and source.
   * E.g. bareId="compound-engineering", source="compound-engineering-plugin"
   *      -> "compound-engineering@compound-engineering-plugin"
   */
  private findCliKeyForPlugin(
    bareId: string,
    source: string,
    cliData: InstalledPluginsFile,
  ): string | null {
    // Direct match: bareId@source
    const directKey = `${bareId}@${source}`;
    if (cliData.plugins[directKey]) return directKey;

    // Fuzzy match: search for any key where the name part matches
    for (const key of Object.keys(cliData.plugins)) {
      const atIndex = key.lastIndexOf('@');
      const name = atIndex > 0 ? key.slice(0, atIndex) : key;
      if (name === bareId) return key;
    }

    return null;
  }

  /**
   * Build a merged view of installed plugins for a given scope.
   * Priority: installed_plugins.json > settings.json.
   * The CLI file is the source of truth for version and installPath.
   * settings.json is the source of truth for enabled state.
   */
  private getMergedInstalledPlugins(
    scope: PluginScope,
    workspacePath?: string,
  ): InstalledPlugin[] {
    // Step 1: Read from settings.json
    const settingsPath = this.resolveSettingsPath(scope, workspacePath);
    const settings = readPluginSettings(settingsPath);
    const settingsPlugins = settings.pluginManager.plugins;

    // Step 2: Read from installed_plugins.json
    const cliData = readInstalledPluginsJson();
    const cliPluginsMap = this.buildCliPluginsMap(cliData, scope, workspacePath);

    // Step 3: Merge
    const result: InstalledPlugin[] = [];
    const seen = new Set<string>();

    // First pass: plugins in settings.json, enriched with CLI data
    for (const [id, entry] of Object.entries(settingsPlugins)) {
      seen.add(id);
      const cliKey = this.findCliKeyForPlugin(id, entry.source, cliData);
      const cliEntry = cliKey ? cliPluginsMap.get(cliKey) : undefined;

      result.push({
        id,
        version: cliEntry?.version || entry.version,
        source: entry.source,
        enabled: entry.enabled,
        installedAt: cliEntry?.installedAt || entry.installedAt,
        updatedAt: cliEntry?.lastUpdated || entry.updatedAt,
        qualifiedId: cliKey ?? undefined,
        installPath: cliEntry?.installPath,
        gitCommitSha: cliEntry?.gitCommitSha,
      });
    }

    // Second pass: plugins only in installed_plugins.json (CLI-installed, not in our settings)
    for (const [qualifiedId, cliEntry] of cliPluginsMap) {
      const atIndex = qualifiedId.lastIndexOf('@');
      const bareId = atIndex > 0 ? qualifiedId.slice(0, atIndex) : qualifiedId;
      if (seen.has(bareId)) continue;
      seen.add(bareId);

      const marketplace = atIndex > 0 ? qualifiedId.slice(atIndex + 1) : 'unknown';

      result.push({
        id: bareId,
        version: cliEntry.version || '0.0.0',
        source: marketplace,
        enabled: true, // CLI doesn't track enabled state per-scope in installed_plugins.json
        installedAt: cliEntry.installedAt || new Date().toISOString(),
        updatedAt: cliEntry.lastUpdated,
        qualifiedId,
        installPath: cliEntry.installPath,
        gitCommitSha: cliEntry.gitCommitSha,
      });
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Get all installed plugins for a scope (merged from both sources).
   */
  getInstalledPlugins(scope: PluginScope, workspacePath?: string): InstalledPlugin[] {
    return this.getMergedInstalledPlugins(scope, workspacePath);
  }

  /**
   * Get a single installed plugin by ID (merged from both sources).
   */
  getInstalledPlugin(
    scope: PluginScope,
    pluginId: string,
    workspacePath?: string,
  ): InstalledPlugin | null {
    const all = this.getMergedInstalledPlugins(scope, workspacePath);
    return all.find((p) => p.id === pluginId) ?? null;
  }

  /**
   * Add or update a plugin entry in the settings.
   */
  addPlugin(
    scope: PluginScope,
    pluginId: string,
    version: string,
    source: string,
    workspacePath?: string,
  ): InstalledPlugin {
    const settingsPath = this.resolveSettingsPath(scope, workspacePath);
    const settings = readPluginSettings(settingsPath);

    const now = new Date().toISOString();
    const existing = settings.pluginManager.plugins[pluginId];

    const entry: PluginStateEntry = {
      version,
      source,
      enabled: existing?.enabled ?? true,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
    };

    settings.pluginManager.plugins[pluginId] = entry;
    writePluginSettings(settingsPath, settings);

    sidecarLog(`[PluginSettingsService] Added plugin ${pluginId}@${version} to ${scope} settings`);
    return { id: pluginId, ...entry };
  }

  /**
   * Remove a plugin from the settings. Optionally purge cached data.
   */
  removePlugin(
    scope: PluginScope,
    pluginId: string,
    workspacePath?: string,
    options?: { purgeData?: boolean },
  ): boolean {
    const settingsPath = this.resolveSettingsPath(scope, workspacePath);
    const settings = readPluginSettings(settingsPath);

    if (!settings.pluginManager.plugins[pluginId]) {
      return false;
    }

    delete settings.pluginManager.plugins[pluginId];
    writePluginSettings(settingsPath, settings);

    if (options?.purgeData) {
      this.purgePluginCache(pluginId);
    }

    sidecarLog(`[PluginSettingsService] Removed plugin ${pluginId} from ${scope} settings`);
    return true;
  }

  /**
   * Enable or disable an installed plugin.
   */
  setPluginEnabled(
    scope: PluginScope,
    pluginId: string,
    enabled: boolean,
    workspacePath?: string,
  ): boolean {
    const settingsPath = this.resolveSettingsPath(scope, workspacePath);
    const settings = readPluginSettings(settingsPath);

    const entry = settings.pluginManager.plugins[pluginId];
    if (!entry) {
      return false;
    }

    entry.enabled = enabled;
    entry.updatedAt = new Date().toISOString();
    writePluginSettings(settingsPath, settings);

    sidecarLog(`[PluginSettingsService] Set plugin ${pluginId} enabled=${enabled} in ${scope} settings`);
    return true;
  }

  /**
   * Update a plugin's version after an update.
   */
  updatePluginVersion(
    scope: PluginScope,
    pluginId: string,
    newVersion: string,
    workspacePath?: string,
  ): boolean {
    const settingsPath = this.resolveSettingsPath(scope, workspacePath);
    const settings = readPluginSettings(settingsPath);

    const entry = settings.pluginManager.plugins[pluginId];
    if (!entry) {
      return false;
    }

    entry.version = newVersion;
    entry.updatedAt = new Date().toISOString();
    writePluginSettings(settingsPath, settings);

    sidecarLog(`[PluginSettingsService] Updated plugin ${pluginId} to ${newVersion} in ${scope} settings`);
    return true;
  }

  /**
   * Get per-plugin configuration.
   */
  getPluginConfig(
    scope: PluginScope,
    pluginId: string,
    workspacePath?: string,
  ): Record<string, unknown> | null {
    const settingsPath = this.resolveSettingsPath(scope, workspacePath);
    const settings = readPluginSettings(settingsPath);
    const config = settings.pluginConfigs[pluginId];
    if (!config || typeof config !== 'object') return null;
    return config as Record<string, unknown>;
  }

  /**
   * Set per-plugin configuration.
   */
  setPluginConfig(
    scope: PluginScope,
    pluginId: string,
    config: Record<string, unknown>,
    workspacePath?: string,
  ): void {
    const settingsPath = this.resolveSettingsPath(scope, workspacePath);
    const settings = readPluginSettings(settingsPath);
    settings.pluginConfigs[pluginId] = config;
    writePluginSettings(settingsPath, settings);
  }

  /**
   * Resolve all potential cache paths for a plugin.
   * Supports both our format (cache/<pluginId>/) and CLI format (cache/<marketplace>/<pluginId>/<version>/).
   */
  resolveAllPluginCachePaths(pluginId: string): string[] {
    const paths: string[] = [];

    // Our format
    paths.push(this.resolvePluginCachePath(pluginId));

    // CLI format: scan cache/<marketplace>/<pluginId>/<version>/
    const cacheDir = this.resolvePluginCacheDir();
    try {
      const marketplaces = readdirSync(cacheDir);
      for (const marketplace of marketplaces) {
        const marketplacePath = join(cacheDir, marketplace);
        try {
          if (!statSync(marketplacePath).isDirectory()) continue;
        } catch {
          continue;
        }
        const pluginPath = join(marketplacePath, pluginId);
        try {
          if (!statSync(pluginPath).isDirectory()) continue;
        } catch {
          continue;
        }
        // There may be multiple version directories — collect all
        try {
          const versions = readdirSync(pluginPath);
          for (const version of versions) {
            const versionPath = join(pluginPath, version);
            try {
              if (statSync(versionPath).isDirectory()) {
                paths.push(versionPath);
              }
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // cache dir may not exist
    }

    return paths;
  }

  /**
   * Read plugin.json manifest from the cache directory.
   * If an installPath is provided (from installed_plugins.json), prefer that path.
   */
  readPluginManifest(pluginId: string, preferredPath?: string): PluginManifest | null {
    // If we have a specific install path from installed_plugins.json, try it first
    if (preferredPath) {
      const manifest = this.readManifestFromPath(preferredPath);
      if (manifest) return manifest;
    }

    // Fall back to scanning all cache paths
    const cachePaths = this.resolveAllPluginCachePaths(pluginId);

    for (const cachePath of cachePaths) {
      const manifest = this.readManifestFromPath(cachePath);
      if (manifest) return manifest;
    }
    return null;
  }

  private readManifestFromPath(dirPath: string): PluginManifest | null {
    const manifestPath = join(dirPath, '.claude-plugin', 'plugin.json');
    const altManifestPath = join(dirPath, 'plugin.json');

    for (const p of [manifestPath, altManifestPath]) {
      try {
        const content = readFileSync(p, 'utf-8');
        const parsed = JSON.parse(content) as Record<string, unknown>;
        if (typeof parsed.name === 'string') {
          return {
            name: parsed.name,
            displayName: typeof parsed.displayName === 'string' ? parsed.displayName : undefined,
            description: typeof parsed.description === 'string' ? parsed.description : undefined,
            version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
            author: typeof parsed.author === 'string' ? parsed.author : undefined,
            keywords: Array.isArray(parsed.keywords)
              ? (parsed.keywords as unknown[]).filter((v): v is string => typeof v === 'string')
              : undefined,
            source: typeof parsed.source === 'string' ? parsed.source : undefined,
          };
        }
      } catch {
        // Try next path
      }
    }
    return null;
  }

  /**
   * List all plugin directories currently in the cache.
   */
  listCachedPlugins(): string[] {
    const cacheDir = this.resolvePluginCacheDir();
    try {
      return readdirSync(cacheDir).filter((name) => {
        const fullPath = join(cacheDir, name);
        try {
          return statSync(fullPath).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }

  /**
   * Check if a plugin is cached locally.
   */
  isPluginCached(pluginId: string): boolean {
    const cachePath = this.resolvePluginCachePath(pluginId);
    try {
      return statSync(cachePath).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Purge a plugin's cached data.
   */
  purgePluginCache(pluginId: string): boolean {
    const cachePath = this.resolvePluginCachePath(pluginId);
    try {
      rmSync(cachePath, { recursive: true, force: true });
      sidecarLog(`[PluginSettingsService] Purged cache for plugin ${pluginId}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Purge all orphaned cache directories (plugins in cache but not in any settings).
   */
  purgeOrphanedCache(installedPluginIds: string[]): number {
    const cached = this.listCachedPlugins();
    const allInstalled = new Set(installedPluginIds);
    let purged = 0;

    for (const pluginId of cached) {
      if (!allInstalled.has(pluginId)) {
        if (this.purgePluginCache(pluginId)) {
          purged++;
        }
      }
    }

    if (purged > 0) {
      sidecarLog(`[PluginSettingsService] Purged ${purged} orphaned cache directories`);
    }
    return purged;
  }
}

export const pluginSettingsService = new PluginSettingsService();
