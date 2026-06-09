import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { sidecarLog } from './sidecar-logger.js';

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
    ?? join(homeCandidates[0] ?? homedir(), '.claude', 'settings.json');
  return { settingsPath, homeCandidates };
}

function getHomeCandidates(): string[] {
  const candidates = [
    process.env.USERPROFILE,
    process.env.HOME,
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
      : undefined,
    homedir(),
  ];
  return [...new Set(candidates.filter((value): value is string => !!value))];
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

export interface KnownMarketplace {
  source: {
    source: string;
    repo: string;
  };
}

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
        if (typeof sourceObj.source === 'string' && typeof sourceObj.repo === 'string') {
          extraKnownMarketplaces[key] = {
            source: {
              source: sourceObj.source,
              repo: sourceObj.repo,
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
