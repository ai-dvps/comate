import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PluginSettingsService, assertPluginScope } from './plugin-settings-service.js';
import {
  writeInstalledPluginsJson,
  readInstalledPluginsJson,
} from '../utils/claude-settings.js';

describe('plugin-settings-service', { concurrency: false }, () => {
  let tempDir: string;
  let userSettingsPath: string;
  let workspacePath: string;
  let workspaceSettingsPath: string;
  let localSettingsPath: string;
  let service: PluginSettingsService;
  let originalHomedir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'comate-plugin-test-'));
    userSettingsPath = join(tempDir, 'user', '.claude', 'settings.json');
    workspacePath = join(tempDir, 'workspace');
    workspaceSettingsPath = join(workspacePath, '.claude', 'settings.json');
    localSettingsPath = join(workspacePath, '.claude', 'settings.local.json');

    // Create workspace settings dir
    mkdirSync(join(workspacePath, '.claude'), { recursive: true });

    service = new PluginSettingsService();

    // Override cache dir to temp
    (service as unknown as Record<string, string>).cacheDir = join(tempDir, 'cache');

    // Override global settings path resolution
    originalHomedir = process.env.HOME || '';
    process.env.HOME = join(tempDir, 'user');
    mkdirSync(join(tempDir, 'user', '.claude'), { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = originalHomedir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  // --- Helpers ---

  function writeUserSettings(content: unknown): void {
    writeFileSync(userSettingsPath, JSON.stringify(content, null, 2), 'utf-8');
  }

  function writeWorkspaceSettings(content: unknown): void {
    writeFileSync(workspaceSettingsPath, JSON.stringify(content, null, 2), 'utf-8');
  }

  function writeLocalSettings(content: unknown): void {
    writeFileSync(localSettingsPath, JSON.stringify(content, null, 2), 'utf-8');
  }

  function readUserSettings(): Record<string, unknown> {
    const content = readFileSync(userSettingsPath, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  }

  function readWorkspaceSettings(): Record<string, unknown> {
    const content = readFileSync(workspaceSettingsPath, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  }

  function readLocalSettings(): Record<string, unknown> {
    const content = readFileSync(localSettingsPath, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  }

  function writeInstalledPlugins(content: Record<string, unknown>): void {
    writeInstalledPluginsJson(content as { version: number; plugins: Record<string, unknown[]> });
  }

  function readInstalledPlugins(): { version: number; plugins: Record<string, unknown[]> } {
    return readInstalledPluginsJson();
  }

  // --- Tests ---

  describe('assertPluginScope', () => {
    it('accepts valid scopes', () => {
      assert.doesNotThrow(() => assertPluginScope('user'));
      assert.doesNotThrow(() => assertPluginScope('project'));
      assert.doesNotThrow(() => assertPluginScope('local'));
    });

    it('rejects invalid scopes', () => {
      assert.throws(() => assertPluginScope('global'), /Invalid plugin scope/);
      assert.throws(() => assertPluginScope('workspace'), /Invalid plugin scope/);
      assert.throws(() => assertPluginScope('managed'), /Invalid plugin scope/);
    });
  });

  describe('resolveSettingsPath', () => {
    it('returns user settings path for user scope', () => {
      const path = service.resolveSettingsPath('user');
      assert.ok(path.endsWith('.claude/settings.json'));
      assert.ok(!path.includes('workspace'));
    });

    it('returns workspace settings path for project scope', () => {
      const path = service.resolveSettingsPath('project', workspacePath);
      assert.strictEqual(path, workspaceSettingsPath);
    });

    it('returns local settings path for local scope', () => {
      const path = service.resolveSettingsPath('local', workspacePath);
      assert.strictEqual(path, localSettingsPath);
    });

    it('throws when workspacePath is missing for project scope', () => {
      assert.throws(() => service.resolveSettingsPath('project'), /workspacePath is required/);
    });

    it('throws when workspacePath is missing for local scope', () => {
      assert.throws(() => service.resolveSettingsPath('local'), /workspacePath is required/);
    });
  });

  describe('getInstalledPlugins', () => {
    it('returns empty array when settings file is missing', () => {
      const result = service.getInstalledPlugins('user');
      assert.deepStrictEqual(result, []);
    });

    it('reads enabledPlugins from user settings', () => {
      writeUserSettings({
        env: { ANTHROPIC_API_KEY: 'test' },
        pluginManager: {
          plugins: {
            formatter: {
              version: '1.0.0',
              source: 'marketplace',
              enabled: true,
              installedAt: '2026-06-01T00:00:00Z',
            },
          },
        },
      });

      const result = service.getInstalledPlugins('user');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, 'formatter');
      assert.strictEqual(result[0].version, '1.0.0');
      assert.strictEqual(result[0].enabled, true);
    });

    it('reads plugins from project settings', () => {
      writeWorkspaceSettings({
        pluginManager: {
          plugins: {
            linter: {
              version: '2.0.0',
              source: 'direct',
              enabled: false,
              installedAt: '2026-06-02T00:00:00Z',
            },
          },
        },
      });

      const result = service.getInstalledPlugins('project', workspacePath);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, 'linter');
      assert.strictEqual(result[0].enabled, false);
    });

    it('reads plugins from local settings', () => {
      writeLocalSettings({
        pluginManager: {
          plugins: {
            customTool: {
              version: '3.0.0',
              source: 'direct',
              enabled: true,
              installedAt: '2026-06-03T00:00:00Z',
            },
          },
        },
      });

      const result = service.getInstalledPlugins('local', workspacePath);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, 'customTool');
      assert.strictEqual(result[0].version, '3.0.0');
      assert.strictEqual(result[0].enabled, true);
    });

    it('returns empty array when local settings file is missing', () => {
      const result = service.getInstalledPlugins('local', workspacePath);
      assert.deepStrictEqual(result, []);
    });

    it('reads Claude Code CLI enabledPlugins object format', () => {
      writeUserSettings({
        enabledPlugins: {
          'plugin-dev@claude-plugins-official': true,
          'rust-analyzer-lsp@claude-plugins-official': false,
        },
      });

      const result = service.getInstalledPlugins('user');
      assert.strictEqual(result.length, 2);

      const pluginDev = result.find((p) => p.id === 'plugin-dev');
      assert.ok(pluginDev);
      assert.strictEqual(pluginDev!.enabled, true);
      assert.strictEqual(pluginDev!.source, 'claude-plugins-official');

      const rustAnalyzer = result.find((p) => p.id === 'rust-analyzer-lsp');
      assert.ok(rustAnalyzer);
      assert.strictEqual(rustAnalyzer!.enabled, false);
      assert.strictEqual(rustAnalyzer!.source, 'claude-plugins-official');
    });

    it('merges pluginManager and enabledPlugins object formats', () => {
      writeUserSettings({
        pluginManager: {
          plugins: {
            formatter: {
              version: '1.0.0',
              source: 'marketplace',
              enabled: true,
              installedAt: '2026-06-01T00:00:00Z',
            },
          },
        },
        enabledPlugins: {
          'linter@claude-plugins-official': true,
        },
      });

      const result = service.getInstalledPlugins('user');
      assert.strictEqual(result.length, 2);
      assert.ok(result.find((p) => p.id === 'formatter'));
      assert.ok(result.find((p) => p.id === 'linter'));
    });
  });

  describe('addPlugin', () => {
    it('creates missing user settings file with plugin entry', () => {
      const result = service.addPlugin('user', 'formatter', '1.0.0', 'marketplace');

      assert.strictEqual(result.id, 'formatter');
      assert.strictEqual(result.version, '1.0.0');
      assert.strictEqual(result.source, 'marketplace');
      assert.strictEqual(result.enabled, true);

      const settings = readUserSettings();
      assert.ok(settings.enabledPlugins && typeof settings.enabledPlugins === 'object' && !Array.isArray(settings.enabledPlugins));
      assert.strictEqual((settings.enabledPlugins as Record<string, boolean>)['formatter@marketplace'], true);
      assert.ok(settings.pluginManager);
      const plugins = (settings.pluginManager as Record<string, unknown>).plugins as Record<string, unknown>;
      assert.ok(plugins.formatter);
    });

    it('preserves existing settings keys when adding plugin', () => {
      writeUserSettings({
        env: { ANTHROPIC_API_KEY: 'secret' },
        customKey: 'value',
      });

      service.addPlugin('user', 'formatter', '1.0.0', 'marketplace');

      const settings = readUserSettings();
      assert.strictEqual((settings.env as Record<string, string>).ANTHROPIC_API_KEY, 'secret');
      assert.strictEqual(settings.customKey, 'value');
    });

    it('adds plugin to project settings', () => {
      service.addPlugin('project', 'linter', '2.0.0', 'direct', workspacePath);

      const settings = readWorkspaceSettings();
      const plugins = (settings.pluginManager as Record<string, unknown>).plugins as Record<string, unknown>;
      assert.ok(plugins.linter);
      assert.strictEqual((plugins.linter as Record<string, string>).version, '2.0.0');
    });

    it('adds plugin to local settings', () => {
      service.addPlugin('local', 'customTool', '3.0.0', 'direct', workspacePath);

      const settings = readLocalSettings();
      const plugins = (settings.pluginManager as Record<string, unknown>).plugins as Record<string, unknown>;
      assert.ok(plugins.customTool);
      assert.strictEqual((plugins.customTool as Record<string, string>).version, '3.0.0');
    });

    it('creates local settings file and parent directory if missing', () => {
      const freshWorkspace = join(tempDir, 'fresh-workspace');
      service.addPlugin('local', 'newPlugin', '1.0.0', 'marketplace', freshWorkspace);

      assert.strictEqual(existsSync(join(freshWorkspace, '.claude', 'settings.local.json')), true);
    });

    it('is idempotent when adding same plugin twice', () => {
      service.addPlugin('user', 'formatter', '1.0.0', 'marketplace');
      service.addPlugin('user', 'formatter', '1.0.0', 'marketplace');

      const settings = readUserSettings();
      const plugins = (settings.pluginManager as Record<string, unknown>).plugins as Record<string, unknown>;
      assert.strictEqual(Object.keys(plugins).length, 1);
    });
  });

  describe('removePlugin', () => {
    it('removes plugin from user settings', () => {
      writeUserSettings({
        pluginManager: {
          plugins: {
            formatter: { version: '1.0.0', source: 'marketplace', enabled: true, installedAt: '2026-06-01T00:00:00Z' },
            linter: { version: '2.0.0', source: 'marketplace', enabled: true, installedAt: '2026-06-01T00:00:00Z' },
          },
        },
      });

      const result = service.removePlugin('user', 'formatter');
      assert.strictEqual(result, true);

      const settings = readUserSettings();
      const plugins = (settings.pluginManager as Record<string, unknown>).plugins as Record<string, unknown>;
      assert.strictEqual(Object.keys(plugins).length, 1);
      assert.ok(!plugins.formatter);
      assert.strictEqual((settings.enabledPlugins as Record<string, boolean>)['linter@marketplace'], true);
    });

    it('removes plugin from local settings', () => {
      writeLocalSettings({
        pluginManager: {
          plugins: {
            customTool: { version: '3.0.0', source: 'direct', enabled: true, installedAt: '2026-06-01T00:00:00Z' },
          },
        },
      });

      const result = service.removePlugin('local', 'customTool', workspacePath);
      assert.strictEqual(result, true);

      const settings = readLocalSettings();
      const plugins = (settings.pluginManager as Record<string, unknown>).plugins as Record<string, unknown>;
      assert.strictEqual(Object.keys(plugins).length, 0);
    });

    it('returns false when plugin does not exist', () => {
      writeUserSettings({ pluginManager: { plugins: {} } });
      const result = service.removePlugin('user', 'nonexistent');
      assert.strictEqual(result, false);
    });

    it('purges cache when requested', () => {
      writeUserSettings({
        pluginManager: {
          plugins: {
            formatter: { version: '1.0.0', source: 'marketplace', enabled: true, installedAt: '2026-06-01T00:00:00Z' },
          },
        },
      });

      // Create cache dir
      const cachePath = service.resolvePluginCachePath('formatter');
      mkdirSync(cachePath, { recursive: true });
      assert.strictEqual(existsSync(cachePath), true);

      service.removePlugin('user', 'formatter', undefined, { purgeData: true });

      assert.strictEqual(existsSync(cachePath), false);
    });

    it('removes a plugin that only exists in installed_plugins.json (CLI-installed)', () => {
      writeInstalledPlugins({
        version: 2,
        plugins: {
          'warp@claude-plugins-official': [
            { scope: 'user', installPath: '/tmp/cache/warp', version: '1.0.0', installedAt: '2026-06-01T00:00:00Z' },
          ],
        },
      });

      const result = service.removePlugin('user', 'warp');
      assert.strictEqual(result, true);

      const cli = readInstalledPlugins();
      assert.deepStrictEqual(cli.plugins, {});
    });

    it('removes a plugin from both settings.json and installed_plugins.json', () => {
      writeUserSettings({
        pluginManager: {
          plugins: {
            warp: { version: '1.0.0', source: 'claude-plugins-official', enabled: true, installedAt: '2026-06-01T00:00:00Z' },
          },
        },
      });
      writeInstalledPlugins({
        version: 2,
        plugins: {
          'warp@claude-plugins-official': [
            { scope: 'user', installPath: '/tmp/cache/warp', version: '1.0.0', installedAt: '2026-06-01T00:00:00Z' },
          ],
        },
      });

      const result = service.removePlugin('user', 'warp');
      assert.strictEqual(result, true);

      const settings = readUserSettings();
      const plugins = (settings.pluginManager as Record<string, unknown>).plugins as Record<string, unknown>;
      assert.ok(!plugins.warp);

      const cli = readInstalledPlugins();
      assert.deepStrictEqual(cli.plugins, {});
    });

    it('removes a project-scoped plugin from installed_plugins.json matching projectPath', () => {
      writeInstalledPlugins({
        version: 2,
        plugins: {
          'warp@marketplace': [
            { scope: 'project', projectPath: workspacePath, installPath: '/tmp/cache/warp', version: '1.0.0', installedAt: '2026-06-01T00:00:00Z' },
          ],
        },
      });

      const result = service.removePlugin('project', 'warp', workspacePath);
      assert.strictEqual(result, true);

      const cli = readInstalledPlugins();
      assert.deepStrictEqual(cli.plugins, {});
    });

    it('returns false for project scope when installed_plugins.json entry has a different projectPath', () => {
      writeInstalledPlugins({
        version: 2,
        plugins: {
          'warp@marketplace': [
            { scope: 'project', projectPath: '/some/other/path', installPath: '/tmp/cache/warp', version: '1.0.0', installedAt: '2026-06-01T00:00:00Z' },
          ],
        },
      });

      const result = service.removePlugin('project', 'warp', workspacePath);
      assert.strictEqual(result, false);

      const cli = readInstalledPlugins();
      assert.strictEqual(Object.keys(cli.plugins).length, 1);
    });

    it('purges cache when uninstalling a CLI-only plugin', () => {
      writeInstalledPlugins({
        version: 2,
        plugins: {
          'warp@claude-plugins-official': [
            { scope: 'user', installPath: '/tmp/cache/warp', version: '1.0.0', installedAt: '2026-06-01T00:00:00Z' },
          ],
        },
      });

      const cachePath = service.resolvePluginCachePath('warp');
      mkdirSync(cachePath, { recursive: true });
      assert.strictEqual(existsSync(cachePath), true);

      const result = service.removePlugin('user', 'warp', undefined, { purgeData: true });
      assert.strictEqual(result, true);
      assert.strictEqual(existsSync(cachePath), false);
    });
  });

  describe('setPluginEnabled', () => {
    it('disables an enabled plugin in user scope', () => {
      writeUserSettings({
        pluginManager: {
          plugins: {
            formatter: { version: '1.0.0', source: 'marketplace', enabled: true, installedAt: '2026-06-01T00:00:00Z' },
          },
        },
      });

      const result = service.setPluginEnabled('user', 'formatter', false);
      assert.strictEqual(result, true);

      const settings = readUserSettings();
      assert.deepStrictEqual(settings.enabledPlugins, { 'formatter@marketplace': false });
      const plugins = (settings.pluginManager as Record<string, unknown>).plugins as Record<string, unknown>;
      assert.strictEqual((plugins.formatter as Record<string, boolean>).enabled, false);
    });

    it('enables a disabled plugin in local scope', () => {
      writeLocalSettings({
        pluginManager: {
          plugins: {
            customTool: { version: '3.0.0', source: 'direct', enabled: false, installedAt: '2026-06-01T00:00:00Z' },
          },
        },
      });

      const result = service.setPluginEnabled('local', 'customTool', true, workspacePath);
      assert.strictEqual(result, true);

      const settings = readLocalSettings();
      assert.deepStrictEqual((settings.enabledPlugins as Record<string, boolean>)['customTool@direct'], true);
      const plugins = (settings.pluginManager as Record<string, unknown>).plugins as Record<string, unknown>;
      assert.strictEqual((plugins.customTool as Record<string, boolean>).enabled, true);
    });

    it('returns false for unknown plugin', () => {
      writeUserSettings({ pluginManager: { plugins: {} } });
      const result = service.setPluginEnabled('user', 'unknown', true);
      assert.strictEqual(result, false);
    });
  });

  describe('updatePluginVersion', () => {
    it('updates version in local scope', () => {
      writeLocalSettings({
        pluginManager: {
          plugins: {
            customTool: { version: '3.0.0', source: 'direct', enabled: true, installedAt: '2026-06-01T00:00:00Z' },
          },
        },
      });

      const result = service.updatePluginVersion('local', 'customTool', '3.1.0', workspacePath);
      assert.strictEqual(result, true);

      const settings = readLocalSettings();
      const plugins = (settings.pluginManager as Record<string, unknown>).plugins as Record<string, unknown>;
      assert.strictEqual((plugins.customTool as Record<string, string>).version, '3.1.0');
    });
  });

  describe('resolvePluginCachePath', () => {
    it('returns CLI-compatible cache path', () => {
      const freshService = new PluginSettingsService();
      const path = freshService.resolvePluginCachePath('formatter');
      assert.ok(path.includes('.claude/plugins/cache'));
      assert.ok(path.endsWith('/formatter'));
    });
  });

  describe('readPluginManifest', () => {
    it('reads manifest from .claude-plugin/plugin.json', () => {
      const cachePath = service.resolvePluginCachePath('formatter');
      const pluginDir = join(cachePath, '.claude-plugin');
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(
        join(pluginDir, 'plugin.json'),
        JSON.stringify({
          name: 'formatter',
          displayName: 'Code Formatter',
          description: 'Formats code',
          version: '1.0.0',
          author: 'test',
          keywords: ['format', 'code'],
        }),
        'utf-8',
      );

      const manifest = service.readPluginManifest('formatter');
      assert.ok(manifest);
      assert.strictEqual(manifest!.name, 'formatter');
      assert.strictEqual(manifest!.displayName, 'Code Formatter');
      assert.deepStrictEqual(manifest!.keywords, ['format', 'code']);
    });

    it('falls back to root plugin.json', () => {
      const cachePath = service.resolvePluginCachePath('linter');
      mkdirSync(cachePath, { recursive: true });
      writeFileSync(
        join(cachePath, 'plugin.json'),
        JSON.stringify({ name: 'linter', version: '2.0.0' }),
        'utf-8',
      );

      const manifest = service.readPluginManifest('linter');
      assert.ok(manifest);
      assert.strictEqual(manifest!.name, 'linter');
    });

    it('returns null when manifest is missing', () => {
      const manifest = service.readPluginManifest('nonexistent');
      assert.strictEqual(manifest, null);
    });
  });

  describe('corrupted settings recovery', () => {
    it('handles corrupted JSON by starting fresh', () => {
      writeUserSettings('not valid json');
      // File is there but corrupted
      assert.strictEqual(existsSync(userSettingsPath), true);

      // addPlugin should handle corrupted file gracefully
      const result = service.addPlugin('user', 'formatter', '1.0.0', 'marketplace');
      assert.strictEqual(result.id, 'formatter');
    });
  });

  describe('pluginConfigs', () => {
    it('sets and gets plugin config', () => {
      service.setPluginConfig('user', 'formatter', { tabWidth: 2, useTabs: false });

      const config = service.getPluginConfig('user', 'formatter');
      assert.deepStrictEqual(config, { tabWidth: 2, useTabs: false });
    });

    it('returns null for missing config', () => {
      const config = service.getPluginConfig('user', 'nonexistent');
      assert.strictEqual(config, null);
    });
  });
});
