import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { sidecarLog } from './sidecar-logger.js';
import { getHomeCandidates, getPrimaryHomeDir } from './home-dir.js';

/**
 * Read the user's Claude Code settings.json and extract ANTHROPIC_* string values.
 * This ensures auth credentials are available when Claude Code is spawned from
 * the sidecar, where environment propagation may be incomplete (especially on
 * Windows with pkg-bundled binaries).
 */
export function loadClaudeSettings(): Record<string, string> {
  const { settingsPath, homeCandidates } = resolveClaudeSettingsPath();

  try {
    const content = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content) as Record<string, unknown>;
    const envSettings = getObject(settings.env);
    const result: Record<string, string> = {};

    copyAnthropicValues(settings, result);
    copyAnthropicValues(envSettings, result);

    sidecarLog(`[loadClaudeSettings] loaded from ${settingsPath}, keys=[${Object.keys(result).join(', ')}]`);
    return result;
  } catch {
    sidecarLog(`[loadClaudeSettings] no readable settings at ${settingsPath}, homeCandidates=[${homeCandidates.join(', ')}]`);
    return {};
  }
}

export function resolveClaudeConfigDir(): string {
  return dirname(resolveClaudeSettingsPath().settingsPath);
}

function resolveClaudeSettingsPath(): {
  settingsPath: string;
  homeCandidates: string[];
} {
  const homeCandidates = getHomeCandidates();
  const settingsPath = homeCandidates
    .map((home) => join(home, '.claude', 'settings.json'))
    .find((candidate) => existsSync(candidate))
    ?? join(getPrimaryHomeDir(), '.claude', 'settings.json');
  return { settingsPath, homeCandidates };
}

function getObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function copyAnthropicValues(
  source: Record<string, unknown>,
  target: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('ANTHROPIC_') && typeof value === 'string') {
      target[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin settings helpers
// ---------------------------------------------------------------------------

export interface PluginStateEntry {
  version: string;
  source: 'marketplace' | 'direct' | string;
  enabled: boolean;
  installedAt: string;
  updatedAt?: string;
}

export interface PluginManagerSettings {
  plugins: Record<string, PluginStateEntry>;
}

export interface GitHubKnownMarketplace {
  source: {
    source: 'github';
    repo: string;
  };
}

export interface DirectoryKnownMarketplace {
  source: {
    source: 'directory';
    path: string;
  };
}

export type KnownMarketplace = GitHubKnownMarketplace | DirectoryKnownMarketplace;

export interface PluginSettings {
  enabledPlugins: string[];
  pluginManager: PluginManagerSettings;
  pluginConfigs: Record<string, unknown>;
  extraKnownMarketplaces: Record<string, KnownMarketplace>;
}

export function readPluginSettings(settingsPath: string): PluginSettings {
  try {
    const content = readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;

    // --- Parse pluginConfigs ---
    const pluginConfigs = getObject(parsed.pluginConfigs);

    // --- Parse pluginManager.plugins (our rich format) ---
    const rawManager = getObject(parsed.pluginManager);
    const rawPlugins = getObject(rawManager.plugins);
    const plugins: Record<string, PluginStateEntry> = {};
    for (const [key, value] of Object.entries(rawPlugins)) {
      if (value && typeof value === 'object') {
        const entry = value as Record<string, unknown>;
        if (typeof entry.version === 'string') {
          plugins[key] = {
            version: entry.version,
            source: typeof entry.source === 'string' ? entry.source : 'unknown',
            enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
            installedAt: typeof entry.installedAt === 'string' ? entry.installedAt : new Date().toISOString(),
            updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : undefined,
          };
        }
      }
    }

    // --- Parse enabledPlugins (Claude Code CLI format) ---
    // Claude Code stores: enabledPlugins: { "pluginId@marketplaceId": boolean }
    // We also support our older array format: enabledPlugins: ["pluginId"]
    if (parsed.enabledPlugins && typeof parsed.enabledPlugins === 'object' && !Array.isArray(parsed.enabledPlugins)) {
      const enabledObj = parsed.enabledPlugins as Record<string, unknown>;
      for (const [key, value] of Object.entries(enabledObj)) {
        if (typeof value !== 'boolean') continue;
        // Parse "pluginId@marketplaceId" or just "pluginId"
        const atIndex = key.lastIndexOf('@');
        const pluginId = atIndex > 0 ? key.slice(0, atIndex) : key;
        const marketplaceId = atIndex > 0 ? key.slice(atIndex + 1) : 'unknown';

        if (!plugins[pluginId]) {
          // Synthetic entry for CLI-installed plugins without rich metadata
          plugins[pluginId] = {
            version: '0.0.0',
            source: marketplaceId,
            enabled: value,
            installedAt: new Date().toISOString(),
          };
        } else {
          // Merge: use CLI enabled state if present
          plugins[pluginId].enabled = value;
        }
      }
    } else if (Array.isArray(parsed.enabledPlugins)) {
      // Legacy array format — just track which are enabled
      const arr = (parsed.enabledPlugins as unknown[]).filter((v): v is string => typeof v === 'string');
      for (const pluginId of arr) {
        if (!plugins[pluginId]) {
          plugins[pluginId] = {
            version: '0.0.0',
            source: 'unknown',
            enabled: true,
            installedAt: new Date().toISOString(),
          };
        }
      }
    }

    // --- Parse extraKnownMarketplaces ---
    const extraKnownMarketplaces: Record<string, KnownMarketplace> = {};
    const rawMarketplaces = getObject(parsed.extraKnownMarketplaces);
    for (const [key, value] of Object.entries(rawMarketplaces)) {
      if (value && typeof value === 'object') {
        const mk = value as Record<string, unknown>;
        const sourceObj = getObject(mk.source);
        const sourceType = typeof sourceObj.source === 'string' ? sourceObj.source : undefined;

        if (sourceType === 'github' && typeof sourceObj.repo === 'string') {
          extraKnownMarketplaces[key] = {
            source: {
              source: 'github',
              repo: sourceObj.repo,
            },
          };
        } else if (sourceType === 'directory' && typeof sourceObj.path === 'string') {
          extraKnownMarketplaces[key] = {
            source: {
              source: 'directory',
              path: sourceObj.path,
            },
          };
        }
      }
    }

    // Build enabledPlugins array for internal consistency
    const enabledPlugins = Object.entries(plugins)
      .filter(([, entry]) => entry.enabled)
      .map(([id]) => id);

    return { enabledPlugins, pluginManager: { plugins }, pluginConfigs, extraKnownMarketplaces };
  } catch {
    return {
      enabledPlugins: [],
      pluginManager: { plugins: {} },
      pluginConfigs: {},
      extraKnownMarketplaces: {},
    };
  }
}

export function writePluginSettings(
  settingsPath: string,
  settings: PluginSettings,
): void {
  const dir = dirname(settingsPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let existing: Record<string, unknown> = {};
  try {
    const content = readFileSync(settingsPath, 'utf-8');
    existing = JSON.parse(content) as Record<string, unknown>;
  } catch {
    // File missing or corrupted — start fresh
  }

  // Build enabledPlugins in Claude Code CLI format: { "pluginId@marketplaceId": boolean }
  const enabledPlugins: Record<string, boolean> = {};
  for (const [id, entry] of Object.entries(settings.pluginManager.plugins)) {
    // Use source as marketplaceId if it looks like one (no URL scheme)
    const marketplaceId = entry.source && !entry.source.includes('://')
      ? entry.source
      : 'unknown';
    enabledPlugins[`${id}@${marketplaceId}`] = entry.enabled;
  }

  const merged: Record<string, unknown> = {
    ...existing,
    enabledPlugins,
    pluginManager: settings.pluginManager,
  };

  if (Object.keys(settings.pluginConfigs).length > 0) {
    merged.pluginConfigs = settings.pluginConfigs;
  } else if (existing.pluginConfigs) {
    // Preserve existing pluginConfigs if not modifying
    merged.pluginConfigs = existing.pluginConfigs;
  }

  // Preserve extraKnownMarketplaces if not modifying
  if (Object.keys(settings.extraKnownMarketplaces).length > 0) {
    merged.extraKnownMarketplaces = settings.extraKnownMarketplaces;
  } else if (existing.extraKnownMarketplaces) {
    merged.extraKnownMarketplaces = existing.extraKnownMarketplaces;
  }

  // Atomic write via temp file + rename
  const tempPath = `${settingsPath}.tmp`;
  const backupPath = `${settingsPath}.bak`;
  try {
    writeFileSync(tempPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    if (existsSync(settingsPath)) {
      renameSync(settingsPath, backupPath);
    }
    renameSync(tempPath, settingsPath);
    if (existsSync(backupPath)) {
      // Clean up backup on success; keep it if something fails later
      try {
        unlinkSync(backupPath);
      } catch {
        // ignore cleanup error
      }
    }
  } catch (err) {
    // Attempt to restore backup on failure
    try {
      if (existsSync(backupPath) && !existsSync(settingsPath)) {
        renameSync(backupPath, settingsPath);
      }
    } catch {
      // ignore restore error
    }
    throw err;
  }
}

/**
 * Add or update a single entry in the user's global extraKnownMarketplaces.
 * Performs a non-destructive merge: existing keys (including other marketplaces,
 * enabledPlugins, pluginManager, etc.) are preserved. The file is only rewritten
 * when the requested entry is missing or its value differs.
 */
export function addExtraKnownMarketplace(name: string, marketplace: KnownMarketplace): void {
  const { settingsPath } = resolveGlobalClaudeSettingsPath();

  let existing: Record<string, unknown> = {};
  try {
    const content = readFileSync(settingsPath, 'utf-8');
    existing = JSON.parse(content) as Record<string, unknown>;
  } catch {
    // File missing or corrupted — start fresh
  }

  const extraKnownMarketplaces = getObject(existing.extraKnownMarketplaces);
  const currentEntry = extraKnownMarketplaces[name];
  if (currentEntry && typeof currentEntry === 'object') {
    const currentSource = getObject((currentEntry as Record<string, unknown>).source);
    if (
      currentSource.source === marketplace.source.source &&
      ((marketplace.source.source === 'github' &&
        currentSource.repo === marketplace.source.repo) ||
        (marketplace.source.source === 'directory' &&
          currentSource.path === marketplace.source.path))
    ) {
      return;
    }
  }

  const merged: Record<string, unknown> = {
    ...existing,
    extraKnownMarketplaces: {
      ...extraKnownMarketplaces,
      [name]: marketplace,
    },
  };

  const dir = dirname(settingsPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Atomic write via temp file + rename, with backup restore on failure
  const tempPath = `${settingsPath}.tmp`;
  const backupPath = `${settingsPath}.bak`;
  try {
    writeFileSync(tempPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    if (existsSync(settingsPath)) {
      renameSync(settingsPath, backupPath);
    }
    renameSync(tempPath, settingsPath);
    if (existsSync(backupPath)) {
      try {
        unlinkSync(backupPath);
      } catch {
        // ignore cleanup error
      }
    }
    sidecarLog(`[addExtraKnownMarketplace] Registered ${name} in ${settingsPath}`);
  } catch (err) {
    try {
      if (existsSync(backupPath) && !existsSync(settingsPath)) {
        renameSync(backupPath, settingsPath);
      }
    } catch {
      // ignore restore error
    }
    throw err;
  }
}

export interface KnownMarketplaceEntry {
  source: {
    source: string;
    repo?: string;
    url?: string;
  };
  installLocation: string;
  lastUpdated?: string;
}

/**
 * Read Claude Code's known_marketplaces.json which contains the actual
 * marketplace state with installLocation pointing to cached marketplace data.
 *
 * This is the source of truth for what marketplaces Claude Code CLI knows about,
 * as opposed to extraKnownMarketplaces in settings.json which is just the intent layer.
 */
export function readKnownMarketplacesFile(): Record<string, KnownMarketplaceEntry> {
  const { settingsPath } = resolveGlobalClaudeSettingsPath();
  const knownMarketplacesPath = join(dirname(settingsPath), 'plugins', 'known_marketplaces.json');

  try {
    const content = readFileSync(knownMarketplacesPath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const result: Record<string, KnownMarketplaceEntry> = {};

    for (const [name, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      const sourceObj = getObject(entry.source);

      const installLocation = typeof entry.installLocation === 'string' ? entry.installLocation : '';
      if (!installLocation) continue;

      result[name] = {
        source: {
          source: typeof sourceObj.source === 'string' ? sourceObj.source : 'unknown',
          repo: typeof sourceObj.repo === 'string' ? sourceObj.repo : undefined,
          url: typeof sourceObj.url === 'string' ? sourceObj.url : undefined,
        },
        installLocation,
        lastUpdated: typeof entry.lastUpdated === 'string' ? entry.lastUpdated : undefined,
      };
    }

    sidecarLog(`[readKnownMarketplacesFile] loaded ${Object.keys(result).length} marketplaces from ${knownMarketplacesPath}`);
    return result;
  } catch {
    sidecarLog(`[readKnownMarketplacesFile] no readable known_marketplaces.json at ${knownMarketplacesPath}`);
    return {};
  }
}

export function resolveWorkspaceClaudeSettingsPath(workspacePath: string): string {
  return join(workspacePath, '.claude', 'settings.json');
}

export function resolveLocalClaudeSettingsPath(workspacePath: string): string {
  return join(workspacePath, '.claude', 'settings.local.json');
}

export function resolveGlobalClaudeSettingsPath(): {
  settingsPath: string;
  homeCandidates: string[];
} {
  return resolveClaudeSettingsPath();
}

// ---------------------------------------------------------------------------
// installed_plugins.json reader/writer (CLI V2 format)
// ---------------------------------------------------------------------------

export interface InstalledPluginEntry {
  scope: string;
  projectPath?: string;
  installPath: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
  gitCommitSha?: string;
}

export interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, InstalledPluginEntry[]>;
}

/**
 * Resolve the path to installed_plugins.json.
 * Located at ~/.claude/plugins/installed_plugins.json
 */
export function resolveInstalledPluginsPath(): string {
  const { settingsPath } = resolveGlobalClaudeSettingsPath();
  return join(dirname(settingsPath), 'plugins', 'installed_plugins.json');
}

/**
 * Read and parse installed_plugins.json (CLI V2 format).
 * Returns an empty V2 structure if the file does not exist or is corrupt.
 * NEVER throws.
 */
export function readInstalledPluginsJson(): InstalledPluginsFile {
  const filePath = resolveInstalledPluginsPath();
  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const version = typeof parsed.version === 'number' ? parsed.version : 1;

    if (version === 2 && parsed.plugins && typeof parsed.plugins === 'object') {
      const plugins: Record<string, InstalledPluginEntry[]> = {};
      const rawPlugins = parsed.plugins as Record<string, unknown>;
      for (const [key, value] of Object.entries(rawPlugins)) {
        if (Array.isArray(value)) {
          plugins[key] = value
            .filter((v): v is Record<string, unknown> => v != null && typeof v === 'object')
            .map((entry) => ({
              scope: typeof entry.scope === 'string' ? entry.scope : 'user',
              projectPath: typeof entry.projectPath === 'string' ? entry.projectPath : undefined,
              installPath: typeof entry.installPath === 'string' ? entry.installPath : '',
              version: typeof entry.version === 'string' ? entry.version : undefined,
              installedAt: typeof entry.installedAt === 'string' ? entry.installedAt : undefined,
              lastUpdated: typeof entry.lastUpdated === 'string' ? entry.lastUpdated : undefined,
              gitCommitSha: typeof entry.gitCommitSha === 'string' ? entry.gitCommitSha : undefined,
            }));
        }
      }
      return { version: 2, plugins };
    }

    // V1 format: each plugin maps to a single object, not an array
    if (parsed.plugins && typeof parsed.plugins === 'object') {
      const plugins: Record<string, InstalledPluginEntry[]> = {};
      const rawPlugins = parsed.plugins as Record<string, unknown>;
      for (const [key, value] of Object.entries(rawPlugins)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const entry = value as Record<string, unknown>;
          plugins[key] = [{
            scope: typeof entry.scope === 'string' ? entry.scope : 'user',
            projectPath: typeof entry.projectPath === 'string' ? entry.projectPath : undefined,
            installPath: typeof entry.installPath === 'string' ? entry.installPath : '',
            version: typeof entry.version === 'string' ? entry.version : undefined,
            installedAt: typeof entry.installedAt === 'string' ? entry.installedAt : undefined,
            lastUpdated: typeof entry.lastUpdated === 'string' ? entry.lastUpdated : undefined,
            gitCommitSha: typeof entry.gitCommitSha === 'string' ? entry.gitCommitSha : undefined,
          }];
        }
      }
      return { version: 2, plugins };
    }

    return { version: 2, plugins: {} };
  } catch {
    return { version: 2, plugins: {} };
  }
}

/**
 * Write installed_plugins.json atomically (temp + rename + backup).
 * Preserves any keys not in the provided data.
 */
export function writeInstalledPluginsJson(data: InstalledPluginsFile): void {
  const filePath = resolveInstalledPluginsPath();
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${filePath}.tmp`;
  const backupPath = `${filePath}.bak`;
  try {
    writeFileSync(tempPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    if (existsSync(filePath)) {
      renameSync(filePath, backupPath);
    }
    renameSync(tempPath, filePath);
    if (existsSync(backupPath)) {
      try { unlinkSync(backupPath); } catch { /* ignore */ }
    }
  } catch (err) {
    try {
      if (existsSync(backupPath) && !existsSync(filePath)) {
        renameSync(backupPath, filePath);
      }
    } catch { /* ignore restore error */ }
    throw err;
  }
}

/**
 * Update a single plugin entry in installed_plugins.json.
 * Finds by qualifiedId + scope + projectPath, updates installPath/version/lastUpdated.
 * If the entry doesn't exist, adds it.
 */
export function updateInstalledPluginsEntry(
  qualifiedId: string,
  update: {
    scope: string;
    installPath: string;
    version: string;
    projectPath?: string;
    gitCommitSha?: string;
  },
): void {
  const data = readInstalledPluginsJson();
  if (!data.plugins[qualifiedId]) {
    data.plugins[qualifiedId] = [];
  }

  const existing = data.plugins[qualifiedId].find(
    (e) => e.scope === update.scope && e.projectPath === update.projectPath,
  );

  if (existing) {
    existing.installPath = update.installPath;
    existing.version = update.version;
    existing.lastUpdated = new Date().toISOString();
    if (update.gitCommitSha !== undefined) {
      existing.gitCommitSha = update.gitCommitSha;
    }
  } else {
    data.plugins[qualifiedId].push({
      scope: update.scope,
      projectPath: update.projectPath,
      installPath: update.installPath,
      version: update.version,
      installedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      gitCommitSha: update.gitCommitSha,
    });
  }

  writeInstalledPluginsJson(data);
}

/**
 * Remove a plugin entry from installed_plugins.json.
 * Matches by bare plugin id + scope + projectPath (independent of qualified key formatting).
 * Returns true if any entry was removed.
 */
export function removeInstalledPluginsEntry(
  pluginId: string,
  options: {
    scope: string;
    projectPath?: string;
  },
): boolean {
  const data = readInstalledPluginsJson();
  let changed = false;

  for (const [qualifiedId, entries] of Object.entries(data.plugins)) {
    const atIndex = qualifiedId.lastIndexOf('@');
    const bareId = atIndex > 0 ? qualifiedId.slice(0, atIndex) : qualifiedId;
    if (bareId !== pluginId) continue;

    const remaining = entries.filter(
      (e) => !(e.scope === options.scope && e.projectPath === options.projectPath),
    );

    if (remaining.length !== entries.length) {
      if (remaining.length === 0) {
        delete data.plugins[qualifiedId];
      } else {
        data.plugins[qualifiedId] = remaining;
      }
      changed = true;
    }
  }

  if (changed) {
    writeInstalledPluginsJson(data);
  }

  return changed;
}
