import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BuiltinPluginService, WECOM_PLUGIN_ID, BUILTIN_MARKETPLACE_NAME } from './builtin-plugin-service.js';
import { PluginSettingsService } from './plugin-settings-service.js';
import { createIsolatedStore } from '../test-utils/test-store.js';

describe('builtin-plugin-service', { concurrency: false }, () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let marketplacePath: string;
  let workspacePath: string;
  let store: ReturnType<typeof createIsolatedStore>;
  let settingsService: PluginSettingsService;
  let service: BuiltinPluginService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'comate-builtin-plugin-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = join(tempDir, 'user');

    marketplacePath = join(tempDir, 'claude-code-plugin');
    workspacePath = join(tempDir, 'workspace');

    mkdirSync(join(marketplacePath, 'plugins', WECOM_PLUGIN_ID, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(marketplacePath, 'plugins', WECOM_PLUGIN_ID, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: WECOM_PLUGIN_ID, version: '0.1.0' }),
    );
    writeFileSync(join(marketplacePath, 'plugins', WECOM_PLUGIN_ID, 'SKILL.md'), '# WeCom');

    mkdirSync(join(workspacePath, '.claude'), { recursive: true });
    mkdirSync(join(tempDir, 'user', '.claude'), { recursive: true });

    store = createIsolatedStore();
    settingsService = new PluginSettingsService();
    (settingsService as unknown as Record<string, string>).cacheDir = join(tempDir, 'cache');

    service = new BuiltinPluginService(store, settingsService, () => marketplacePath);
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    store.resetData();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('installs the wecom plugin into project scope when it is not already installed', async () => {
    const workspace = await store.create({ name: 'WeCom Workspace', folderPath: workspacePath });

    const result = await service.ensureWecomPluginInstalled(workspace.id);

    assert.strictEqual(result, true);
    const installed = settingsService.getInstalledPlugin('project', WECOM_PLUGIN_ID, workspacePath);
    assert.ok(installed);
    assert.strictEqual(installed!.enabled, true);
    assert.strictEqual(installed!.source, BUILTIN_MARKETPLACE_NAME);
    assert.strictEqual(installed!.version, '0.1.0');
  });

  it('is idempotent when the project-scoped plugin is already installed', async () => {
    const workspace = await store.create({ name: 'WeCom Workspace', folderPath: workspacePath });
    await service.ensureWecomPluginInstalled(workspace.id);

    const result = await service.ensureWecomPluginInstalled(workspace.id);

    assert.strictEqual(result, true);
    const all = settingsService.getInstalledPlugins('project', workspacePath);
    assert.strictEqual(all.filter((p) => p.id === WECOM_PLUGIN_ID).length, 1);
  });

  it('does not install into project scope when the plugin is already installed in user scope', async () => {
    settingsService.addPlugin('user', WECOM_PLUGIN_ID, '0.1.0', BUILTIN_MARKETPLACE_NAME);
    const workspace = await store.create({ name: 'WeCom Workspace', folderPath: workspacePath });

    const result = await service.ensureWecomPluginInstalled(workspace.id);

    assert.strictEqual(result, true);
    const projectPlugin = settingsService.getInstalledPlugin('project', WECOM_PLUGIN_ID, workspacePath);
    assert.strictEqual(projectPlugin, null);
  });

  it('returns false when the workspace does not exist', async () => {
    const result = await service.ensureWecomPluginInstalled('missing-workspace-id');
    assert.strictEqual(result, false);
  });

  it('returns false when the built-in marketplace is not available', async () => {
    const workspace = await store.create({ name: 'WeCom Workspace', folderPath: workspacePath });
    const noMarketplaceService = new BuiltinPluginService(store, settingsService, () => undefined);

    const result = await noMarketplaceService.ensureWecomPluginInstalled(workspace.id);

    assert.strictEqual(result, false);
    const projectPlugin = settingsService.getInstalledPlugin('project', WECOM_PLUGIN_ID, workspacePath);
    assert.strictEqual(projectPlugin, null);
  });
});
