import { existsSync, statSync } from 'fs';
import path from 'path';
import { store as defaultStore, type SqliteStore } from '../storage/sqlite-store.js';
import {
  pluginSettingsService as defaultPluginSettingsService,
  PluginSettingsService,
} from './plugin-settings-service.js';
import { PluginDownloader } from '../utils/plugin-downloader.js';
import { resolveBuiltInMarketplacePath } from '../utils/resolve-builtin-marketplace-path.js';
import { updateInstalledPluginsEntry } from '../utils/claude-settings.js';
import { sidecarLog } from '../utils/sidecar-logger.js';

export const WECOM_PLUGIN_ID = 'wecom';
export const BUILTIN_MARKETPLACE_NAME = 'comate-built-in';

export class BuiltinPluginService {
  private store: SqliteStore;
  private settingsService: PluginSettingsService;
  private resolveBuiltInMarketplacePath: () => string | undefined;

  constructor(
    store?: SqliteStore,
    settingsService?: PluginSettingsService,
    resolveBuiltInMarketplacePathFn?: () => string | undefined,
  ) {
    this.store = store ?? defaultStore;
    this.settingsService = settingsService ?? defaultPluginSettingsService;
    this.resolveBuiltInMarketplacePath = resolveBuiltInMarketplacePathFn ?? resolveBuiltInMarketplacePath;
  }

  /**
   * Ensure the built-in wecom plugin is installed in the workspace's project scope
   * when the workspace has a WeCom-enabled bot bound to it.
   *
   * Idempotent: does nothing if the plugin is already installed in user, project,
   * or local scope for the workspace.
   *
   * Returns `true` if the plugin is present after the call, `false` if it could
   * not be installed (e.g. workspace missing, built-in marketplace unavailable,
   * download failed).
   */
  async ensureWecomPluginInstalled(workspaceId: string): Promise<boolean> {
    const workspace = await this.store.get(workspaceId);
    if (!workspace) {
      sidecarLog(`[BuiltinPluginService] Workspace ${workspaceId} not found; skipping wecom plugin install`);
      return false;
    }

    const workspacePath = workspace.folderPath;
    if (this.isPluginInstalledInAnyScope(WECOM_PLUGIN_ID, workspacePath)) {
      return true;
    }

    const marketplacePath = this.resolveBuiltInMarketplacePath();
    if (!marketplacePath) {
      sidecarLog('[BuiltinPluginService] Built-in marketplace not found; skipping wecom plugin install');
      return false;
    }

    const pluginSourcePath = path.join(marketplacePath, 'plugins', WECOM_PLUGIN_ID);
    if (!existsSync(pluginSourcePath) || !statSync(pluginSourcePath).isDirectory()) {
      sidecarLog(`[BuiltinPluginService] wecom plugin source not found at ${pluginSourcePath}`);
      return false;
    }

    const cacheDir = this.settingsService.resolvePluginCacheDir();
    const downloader = new PluginDownloader({ cacheDir });
    const result = await downloader.downloadLocal(WECOM_PLUGIN_ID, pluginSourcePath);
    if (!result.success) {
      sidecarLog(`[BuiltinPluginService] Failed to download wecom plugin: ${result.error}`);
      return false;
    }

    const manifest = this.settingsService.readPluginManifest(WECOM_PLUGIN_ID, result.cachePath);
    const version = manifest?.version || '0.1.0';

    this.settingsService.addPlugin(
      'project',
      WECOM_PLUGIN_ID,
      version,
      BUILTIN_MARKETPLACE_NAME,
      workspacePath,
    );

    updateInstalledPluginsEntry(`${WECOM_PLUGIN_ID}@${BUILTIN_MARKETPLACE_NAME}`, {
      scope: 'project',
      installPath: result.cachePath,
      version,
      projectPath: workspacePath,
    });

    sidecarLog(`[BuiltinPluginService] Installed wecom plugin for workspace ${workspaceId}`);
    return true;
  }

  private isPluginInstalledInAnyScope(pluginId: string, workspacePath: string): boolean {
    if (this.settingsService.getInstalledPlugin('user', pluginId)) {
      return true;
    }
    if (workspacePath) {
      if (this.settingsService.getInstalledPlugin('project', pluginId, workspacePath)) {
        return true;
      }
      if (this.settingsService.getInstalledPlugin('local', pluginId, workspacePath)) {
        return true;
      }
    }
    return false;
  }
}

export const builtinPluginService = new BuiltinPluginService();
