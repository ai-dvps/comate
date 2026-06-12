import { Router } from 'express';
import { existsSync, statSync } from 'fs';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { pluginSettingsService, assertPluginScope } from '../services/plugin-settings-service.js';
import { marketplaceService } from '../services/marketplace-service.js';
import { PluginDownloader } from '../utils/plugin-downloader.js';
import { sidecarLog } from '../utils/sidecar-logger.js';
import { readPluginSettings, resolveGlobalClaudeSettingsPath } from '../utils/claude-settings.js';
import type { PluginScope } from '../services/plugin-settings-service.js';
import type { MarketplaceRegistry } from '../services/marketplace-service.js';

const router = Router();

const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Load custom marketplace registries from Claude Code's extraKnownMarketplaces.
 */
function loadCustomMarketplaces(): MarketplaceRegistry[] {
  try {
    const { settingsPath } = resolveGlobalClaudeSettingsPath();
    const settings = readPluginSettings(settingsPath);
    const registries: MarketplaceRegistry[] = [];

    for (const [marketplaceName, marketplace] of Object.entries(settings.extraKnownMarketplaces)) {
      if (marketplace.source.source === 'github' && marketplace.source.repo) {
        registries.push({
          name: marketplaceName,
          url: `https://github.com/${marketplace.source.repo}`,
          githubRepo: marketplace.source.repo,
        });
      } else if (marketplace.source.source === 'directory' && marketplace.source.path) {
        registries.push({
          name: marketplaceName,
          localPath: marketplace.source.path,
        });
      }
    }

    return registries;
  } catch {
    return [];
  }
}

async function getWorkspacePath(workspaceId?: string): Promise<string | undefined> {
  if (!workspaceId) return undefined;
  const workspace = await workspaceStore.get(workspaceId);
  return workspace?.folderPath;
}

function scopeNeedsWorkspace(scope: PluginScope): boolean {
  return scope === 'project' || scope === 'local';
}

/**
 * Check if a plugin is already installed in any scope for the given workspace.
 */
function isPluginInstalledInAnyScope(pluginId: string, workspacePath?: string): { scope: PluginScope } | null {
  const userPlugin = pluginSettingsService.getInstalledPlugin('user', pluginId);
  if (userPlugin) return { scope: 'user' };

  if (workspacePath) {
    const projectPlugin = pluginSettingsService.getInstalledPlugin('project', pluginId, workspacePath);
    if (projectPlugin) return { scope: 'project' };

    const localPlugin = pluginSettingsService.getInstalledPlugin('local', pluginId, workspacePath);
    if (localPlugin) return { scope: 'local' };
  }

  return null;
}

// GET /api/plugins/installed?workspaceId=
router.get('/installed', async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    const workspacePath = await getWorkspacePath(workspaceId);

    const userPlugins = pluginSettingsService.getInstalledPlugins('user');
    const projectPlugins = workspacePath
      ? pluginSettingsService.getInstalledPlugins('project', workspacePath)
      : [];
    const localPlugins = workspacePath
      ? pluginSettingsService.getInstalledPlugins('local', workspacePath)
      : [];

    // Merge and mark scope, enriching with manifest data
    // Local takes precedence over project over user for deduplication
    const seen = new Set<string>();
    const all: Array<{
      id: string;
      version: string;
      enabled: boolean;
      installedAt: string;
      updatedAt?: string;
      scope: PluginScope;
      name: string;
      displayName?: string;
      description?: string;
      author?: string;
      keywords?: string[];
      sourceMarketplace?: string;
    }> = [];

    const scopes: Array<{ plugins: typeof userPlugins; scope: PluginScope }> = [
      { plugins: localPlugins, scope: 'local' },
      { plugins: projectPlugins, scope: 'project' },
      { plugins: userPlugins, scope: 'user' },
    ];

    for (const { plugins, scope } of scopes) {
      for (const p of plugins) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);

        const manifest = pluginSettingsService.readPluginManifest(p.id);
        const { source, ...rest } = p;
        all.push({
          ...rest,
          scope,
          version: manifest?.version || rest.version,
          name: manifest?.name ?? p.id,
          displayName: manifest?.displayName,
          description: manifest?.description,
          author: manifest?.author,
          keywords: manifest?.keywords,
          sourceMarketplace: source || undefined,
        });
      }
    }

    res.json({ plugins: all });
  } catch (error) {
    console.error('Failed to list installed plugins:', error);
    res.status(500).json({ error: 'Failed to list installed plugins' });
  }
});

// GET /api/plugins/marketplace?query=
router.get('/marketplace', async (req, res) => {
  try {
    const query = req.query.query as string | undefined;
    const customRegistries = loadCustomMarketplaces();
    const result = await marketplaceService.fetchAllMarketplaces(customRegistries, query);
    res.json({ plugins: result.plugins, errors: result.errors });
  } catch (error) {
    console.error('Failed to fetch marketplace:', error);
    res.status(500).json({ error: 'Failed to fetch marketplace' });
  }
});

// POST /api/plugins/install
router.post('/install', async (req, res) => {
  try {
    const { pluginId, source, scope, workspaceId } = req.body as {
      pluginId: string;
      source: string;
      scope: PluginScope;
      workspaceId?: string;
    };

    if (!pluginId || typeof pluginId !== 'string') {
      res.status(400).json({ error: 'pluginId is required' });
      return;
    }
    if (!source || typeof source !== 'string') {
      res.status(400).json({ error: 'source is required' });
      return;
    }
    try {
      assertPluginScope(scope);
    } catch {
      res.status(400).json({ error: 'scope must be "user", "project", or "local"' });
      return;
    }

    const workspacePath = scopeNeedsWorkspace(scope) ? await getWorkspacePath(workspaceId) : undefined;
    if (scopeNeedsWorkspace(scope) && !workspacePath) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // Check if already installed in ANY scope
    const existingAnywhere = isPluginInstalledInAnyScope(pluginId, workspacePath);
    if (existingAnywhere) {
      res.status(409).json({ error: `Plugin is already installed in ${existingAnywhere.scope} scope` });
      return;
    }

    // Download plugin if not cached
    const cacheDir = pluginSettingsService.resolvePluginCacheDir();
    const downloader = new PluginDownloader({ cacheDir, timeoutMs: DEFAULT_TIMEOUT_MS });

    let downloadResult;
    const isLocalPath = existsSync(source) && statSync(source).isDirectory();
    if (isLocalPath) {
      downloadResult = await downloader.downloadLocal(pluginId, source);
    } else if (source.startsWith('http') || source.endsWith('.git') || source.includes('@')) {
      downloadResult = await downloader.downloadFromUrl(pluginId, source);
    } else {
      // Treat as marketplace plugin — try to resolve from marketplace first
      const customRegistries = loadCustomMarketplaces();
      const { plugins } = await marketplaceService.fetchMarketplaces(customRegistries);
      const marketPlugin = plugins.find((p) => p.id === pluginId);
      if (marketPlugin?.sourceType === 'local' && marketPlugin.sourceUrl) {
        downloadResult = await downloader.downloadLocal(pluginId, marketPlugin.sourceUrl);
      } else if (marketPlugin?.sourceUrl && marketPlugin.pluginSourcePath) {
        // Plugin lives in a subdirectory of a git repo (e.g. marketplace repo)
        downloadResult = await downloader.downloadGitSubdirectory(
          pluginId, marketPlugin.sourceUrl, marketPlugin.pluginSourcePath,
        );
      } else if (marketPlugin?.sourceUrl) {
        downloadResult = await downloader.downloadFromUrl(pluginId, marketPlugin.sourceUrl);
      } else {
        res.status(422).json({ error: `Cannot resolve source for plugin ${pluginId}` });
        return;
      }
    }

    if (!downloadResult.success) {
      res.status(422).json({ error: downloadResult.error || 'Download failed' });
      return;
    }

    // Read manifest for version
    const manifest = pluginSettingsService.readPluginManifest(pluginId);
    const version = manifest?.version || '0.0.0';

    // Write to settings
    const installed = pluginSettingsService.addPlugin(scope, pluginId, version, source, workspacePath);

    sidecarLog(`[Plugins API] Installed ${pluginId}@${version} to ${scope}`);
    res.status(201).json({ plugin: { ...installed, scope } });
  } catch (error) {
    console.error('Failed to install plugin:', error);
    res.status(500).json({ error: 'Failed to install plugin' });
  }
});

// POST /api/plugins/uninstall
router.post('/uninstall', async (req, res) => {
  try {
    const { pluginId, scope, workspaceId, purgeData } = req.body as {
      pluginId: string;
      scope: PluginScope;
      workspaceId?: string;
      purgeData?: boolean;
    };

    if (!pluginId || typeof pluginId !== 'string') {
      res.status(400).json({ error: 'pluginId is required' });
      return;
    }
    try {
      assertPluginScope(scope);
    } catch {
      res.status(400).json({ error: 'scope must be "user", "project", or "local"' });
      return;
    }

    const workspacePath = scopeNeedsWorkspace(scope) ? await getWorkspacePath(workspaceId) : undefined;
    if (scopeNeedsWorkspace(scope) && !workspacePath) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const removed = pluginSettingsService.removePlugin(scope, pluginId, workspacePath, {
      purgeData: purgeData ?? false,
    });

    if (!removed) {
      res.status(404).json({ error: 'Plugin not found' });
      return;
    }

    sidecarLog(`[Plugins API] Uninstalled ${pluginId} from ${scope}`);
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to uninstall plugin:', error);
    res.status(500).json({ error: 'Failed to uninstall plugin' });
  }
});

// POST /api/plugins/update
router.post('/update', async (req, res) => {
  try {
    const { pluginId, scope, workspaceId } = req.body as {
      pluginId: string;
      scope: PluginScope;
      workspaceId?: string;
    };

    if (!pluginId || typeof pluginId !== 'string') {
      res.status(400).json({ error: 'pluginId is required' });
      return;
    }
    try {
      assertPluginScope(scope);
    } catch {
      res.status(400).json({ error: 'scope must be "user", "project", or "local"' });
      return;
    }

    const workspacePath = scopeNeedsWorkspace(scope) ? await getWorkspacePath(workspaceId) : undefined;
    if (scopeNeedsWorkspace(scope) && !workspacePath) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const installed = pluginSettingsService.getInstalledPlugin(scope, pluginId, workspacePath);
    if (!installed) {
      res.status(404).json({ error: 'Plugin not found' });
      return;
    }

    // Find update in marketplace
    const customRegistries = loadCustomMarketplaces();
    const update = await marketplaceService.checkForUpdate(pluginId, installed.version, customRegistries);
    if (!update || !update.sourceUrl) {
      res.status(422).json({ error: 'No update available or source not resolvable' });
      return;
    }

    // Download new version
    const cacheDir = pluginSettingsService.resolvePluginCacheDir();
    const downloader = new PluginDownloader({ cacheDir, timeoutMs: DEFAULT_TIMEOUT_MS });

    let downloadResult;
    if (update.sourceType === 'local') {
      downloadResult = await downloader.downloadLocal(pluginId, update.sourceUrl);
    } else if (update.pluginSourcePath) {
      // Plugin lives in a subdirectory of a git repo (e.g. marketplace repo)
      downloadResult = await downloader.downloadGitSubdirectory(
        pluginId, update.sourceUrl, update.pluginSourcePath,
      );
    } else {
      downloadResult = await downloader.downloadFromUrl(pluginId, update.sourceUrl);
    }

    if (!downloadResult.success) {
      res.status(422).json({ error: downloadResult.error || 'Download failed' });
      return;
    }

    // Update settings with new version
    pluginSettingsService.updatePluginVersion(scope, pluginId, update.version, workspacePath);

    sidecarLog(`[Plugins API] Updated ${pluginId} to ${update.version}`);
    res.json({ ok: true, version: update.version });
  } catch (error) {
    console.error('Failed to update plugin:', error);
    res.status(500).json({ error: 'Failed to update plugin' });
  }
});

// POST /api/plugins/enable
router.post('/enable', async (req, res) => {
  try {
    const { pluginId, scope, workspaceId, enabled } = req.body as {
      pluginId: string;
      scope: PluginScope;
      workspaceId?: string;
      enabled: boolean;
    };

    if (!pluginId || typeof pluginId !== 'string') {
      res.status(400).json({ error: 'pluginId is required' });
      return;
    }
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    try {
      assertPluginScope(scope);
    } catch {
      res.status(400).json({ error: 'scope must be "user", "project", or "local"' });
      return;
    }

    const workspacePath = scopeNeedsWorkspace(scope) ? await getWorkspacePath(workspaceId) : undefined;
    if (scopeNeedsWorkspace(scope) && !workspacePath) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const updated = pluginSettingsService.setPluginEnabled(scope, pluginId, enabled, workspacePath);
    if (!updated) {
      res.status(404).json({ error: 'Plugin not found' });
      return;
    }

    sidecarLog(`[Plugins API] Set ${pluginId} enabled=${enabled} in ${scope}`);
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to enable/disable plugin:', error);
    res.status(500).json({ error: 'Failed to enable/disable plugin' });
  }
});

// GET /api/plugins/updates
router.get('/updates', async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    const workspacePath = await getWorkspacePath(workspaceId);

    const userPlugins = pluginSettingsService.getInstalledPlugins('user');
    const projectPlugins = workspacePath
      ? pluginSettingsService.getInstalledPlugins('project', workspacePath)
      : [];
    const localPlugins = workspacePath
      ? pluginSettingsService.getInstalledPlugins('local', workspacePath)
      : [];

    // Deduplicate by plugin ID — local takes precedence, then project, then user
    const seen = new Set<string>();
    const allInstalled: Array<{ id: string; version: string }> = [];
    for (const p of [...localPlugins, ...projectPlugins, ...userPlugins]) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);

      // Enrich version from cached manifest (same as /installed endpoint does)
      // so CLI-installed plugins with '0.0.0' in settings get their real version.
      const manifest = pluginSettingsService.readPluginManifest(p.id);
      allInstalled.push({
        id: p.id,
        version: manifest?.version || p.version,
      });
    }

    const updates: { id: string; currentVersion: string; newVersion: string }[] = [];

    const customRegistries = loadCustomMarketplaces();

    for (const plugin of allInstalled) {
      const update = await marketplaceService.checkForUpdate(plugin.id, plugin.version, customRegistries);
      if (update) {
        updates.push({
          id: plugin.id,
          currentVersion: plugin.version,
          newVersion: update.version,
        });
      }
    }

    res.json({ updates });
  } catch (error) {
    console.error('Failed to check for updates:', error);
    res.status(500).json({ error: 'Failed to check for updates' });
  }
});

export default router;
