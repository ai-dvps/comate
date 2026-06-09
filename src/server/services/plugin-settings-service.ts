import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  readPluginSettings,
  writePluginSettings,
  resolveWorkspaceClaudeSettingsPath,
  resolveLocalClaudeSettingsPath,
  resolveGlobalClaudeSettingsPath,
  type PluginSettings,
  type PluginStateEntry,
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
   * Resolve the cache path for a specific plugin.
   */
  resolvePluginCachePath(pluginId: string): string {
    return join(this.resolvePluginCacheDir(), pluginId);
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

  /**
   * Get all installed plugins for a scope.
   */
  getInstalledPlugins(scope: PluginScope, workspacePath?: string): InstalledPlugin[] {
    const settingsPath = this.resolveSettingsPath(scope, workspacePath);
    const settings = readPluginSettings(settingsPath);
    return Object.entries(settings.pluginManager.plugins).map(([id, entry]) => ({
      id,
      ...entry,
    }));
  }

  /**
   * Get a single installed plugin by ID.
   */
  getInstalledPlugin(
    scope: PluginScope,
    pluginId: string,
    workspacePath?: string,
  ): InstalledPlugin | null {
    const settingsPath = this.resolveSettingsPath(scope, workspacePath);
    const settings = readPluginSettings(settingsPath);
    const entry = settings.pluginManager.plugins[pluginId];
    if (!entry) return null;
    return { id: pluginId, ...entry };
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
   */
  readPluginManifest(pluginId: string): PluginManifest | null {
    const cachePaths = this.resolveAllPluginCachePaths(pluginId);

    for (const cachePath of cachePaths) {
      const manifestPath = join(cachePath, '.claude-plugin', 'plugin.json');
      const altManifestPath = join(cachePath, 'plugin.json');

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
