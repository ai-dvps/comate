import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { MarketplaceService } from './marketplace-service.js';

describe('marketplace-service', { concurrency: false }, () => {
  let service: MarketplaceService;

  beforeEach(() => {
    service = new MarketplaceService();
  });

  describe('compareVersions', () => {
    it('returns 0 for equal versions', () => {
      assert.strictEqual(service.compareVersions('1.0.0', '1.0.0'), 0);
    });

    it('returns positive when a > b', () => {
      assert.ok(service.compareVersions('2.0.0', '1.0.0') > 0);
      assert.ok(service.compareVersions('1.1.0', '1.0.0') > 0);
      assert.ok(service.compareVersions('1.0.1', '1.0.0') > 0);
    });

    it('returns negative when a < b', () => {
      assert.ok(service.compareVersions('1.0.0', '2.0.0') < 0);
      assert.ok(service.compareVersions('1.0.0', '1.1.0') < 0);
    });

    it('handles different segment lengths', () => {
      assert.ok(service.compareVersions('1.0', '1.0.0') === 0);
      assert.ok(service.compareVersions('1.0.0.1', '1.0.0') > 0);
    });
  });

  describe('checkForUpdate', () => {
    it('returns update when newer version exists', async () => {
      // Mock fetch to return a registry with a newer version
      const originalFetch = global.fetch;
      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => [
            {
              name: 'formatter',
              version: '2.0.0',
              description: 'Formats code',
            },
          ],
        }) as Response;

      try {
        const update = await service.checkForUpdate('formatter', '1.0.0');
        assert.ok(update);
        assert.strictEqual(update!.version, '2.0.0');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('returns null when no update exists', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => [
            {
              name: 'formatter',
              version: '1.0.0',
              description: 'Formats code',
            },
          ],
        }) as Response;

      try {
        const update = await service.checkForUpdate('formatter', '1.0.0');
        assert.strictEqual(update, null);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('returns null when plugin not found in registry', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => [],
        }) as Response;

      try {
        const update = await service.checkForUpdate('nonexistent', '1.0.0');
        assert.strictEqual(update, null);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('fetchMarketplaces', () => {
    it('aggregates plugins from multiple registries', async () => {
      const originalFetch = global.fetch;
      let callCount = 0;
      global.fetch = async () => {
        callCount++;
        const plugins =
          callCount === 1
            ? [{ name: 'formatter', version: '1.0.0' }]
            : [{ name: 'linter', version: '2.0.0' }];
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => plugins,
        } as Response;
      };

      try {
        const result = await service.fetchMarketplaces([
          { name: 'Custom Registry', url: 'https://custom.example.com/plugins' },
        ]);
        assert.strictEqual(result.plugins.length, 2);
        assert.ok(result.plugins.find((p) => p.id === 'formatter'));
        assert.ok(result.plugins.find((p) => p.id === 'linter'));
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('reports errors for unreachable registries', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => {
        throw new Error('Network error');
      };

      try {
        const result = await service.fetchMarketplaces([
          { name: 'Bad Registry', url: 'https://bad.example.com' },
        ]);
        assert.strictEqual(result.plugins.length, 0);
        assert.ok(result.errors.length >= 1);
        assert.ok(result.errors.some((e) => e.error.includes('Network error')));
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('filters plugins by search query', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => [
            { name: 'formatter', version: '1.0.0', description: 'Code formatting' },
            { name: 'linter', version: '2.0.0', description: 'Code linting' },
          ],
        }) as Response;

      try {
        const result = await service.fetchMarketplaces([], 'format');
        assert.strictEqual(result.plugins.length, 1);
        assert.strictEqual(result.plugins[0].id, 'formatter');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('fetches GitHub repo marketplace.json format', async () => {
      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('raw.githubusercontent.com')) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({
              name: 'test-marketplace',
              plugins: [
                {
                  name: 'my-plugin',
                  description: 'A test plugin',
                  version: '1.2.3',
                  author: { name: 'Test Author', url: 'https://example.com' },
                  tags: ['test', 'plugin'],
                  source: './plugins/my-plugin',
                },
              ],
            }),
          } as Response;
        }
        // Default registry (will fail)
        throw new Error('Network error');
      };

      try {
        const result = await service.fetchMarketplaces([
          { name: 'Test Marketplace', url: 'https://github.com/owner/repo', githubRepo: 'owner/repo' },
        ]);
        assert.strictEqual(result.plugins.length, 1);
        const plugin = result.plugins[0];
        assert.strictEqual(plugin.id, 'my-plugin');
        assert.strictEqual(plugin.name, 'my-plugin');
        assert.strictEqual(plugin.displayName, 'my-plugin');
        assert.strictEqual(plugin.description, 'A test plugin');
        assert.strictEqual(plugin.version, '1.2.3');
        assert.strictEqual(plugin.author, 'Test Author');
        assert.deepStrictEqual(plugin.keywords, ['test', 'plugin']);
        assert.strictEqual(plugin.sourceMarketplace, 'Test Marketplace');
        assert.strictEqual(plugin.sourceUrl, 'https://github.com/owner/repo.git');
        assert.strictEqual(plugin.sourceType, 'git');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('fetches local directory marketplace.json format', async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), 'marketplace-'));
      mkdirSync(join(tmpRoot, '.claude-plugin'), { recursive: true });
      mkdirSync(join(tmpRoot, 'plugins', 'wecom'), { recursive: true });
      writeFileSync(
        join(tmpRoot, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({
          name: 'local-test',
          owner: { name: 'Test' },
          plugins: [
            {
              name: 'wecom',
              description: 'Send WeCom messages',
              version: '0.1.0',
              source: './plugins/wecom',
            },
          ],
        }),
      );

      try {
        const result = await service.fetchMarketplaces([
          { name: 'Local Test', localPath: tmpRoot },
        ]);
        assert.strictEqual(result.plugins.length, 1);
        const plugin = result.plugins[0];
        assert.strictEqual(plugin.id, 'wecom');
        assert.strictEqual(plugin.sourceMarketplace, 'Local Test');
        assert.strictEqual(plugin.sourceType, 'local');
        assert.strictEqual(plugin.sourceUrl, resolve(tmpRoot, './plugins/wecom'));
      } finally {
        // node:test will clean up the temp directory on process exit
      }
    });

    it('reports errors for missing local marketplace.json', async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), 'marketplace-missing-'));
      const result = await service.fetchMarketplaces([
        { name: 'Missing Local', localPath: tmpRoot },
      ]);
      assert.strictEqual(result.plugins.length, 0);
      assert.ok(result.errors.some((e) => e.marketplace === 'Missing Local'));
      assert.ok(result.errors.some((e) => e.error.includes('marketplace.json not found')));
    });

    it('falls back to master branch when main branch marketplace.json is missing', async () => {
      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/main/')) {
          return { ok: false, status: 404, statusText: 'Not Found' } as Response;
        }
        if (urlStr.includes('/master/')) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({
              plugins: [{ name: 'fallback-plugin', version: '1.0.0' }],
            }),
          } as Response;
        }
        throw new Error('Network error');
      };

      try {
        const result = await service.fetchMarketplaces([
          { name: 'Fallback', url: 'https://github.com/fallback/repo', githubRepo: 'fallback/repo' },
        ]);
        assert.strictEqual(result.plugins.length, 1);
        assert.strictEqual(result.plugins[0].id, 'fallback-plugin');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('fetchBuiltInMarketplaces', () => {
    it('returns plugins from registered built-in marketplaces', async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), 'builtin-marketplace-'));
      mkdirSync(join(tmpRoot, '.claude-plugin'), { recursive: true });
      mkdirSync(join(tmpRoot, 'plugins', 'wecom'), { recursive: true });
      writeFileSync(
        join(tmpRoot, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({
          name: 'comate-built-in',
          plugins: [
            {
              name: 'wecom',
              description: 'Send WeCom messages',
              version: '0.1.0',
              source: './plugins/wecom',
            },
          ],
        }),
      );

      service.registerBuiltInMarketplace({ name: 'comate-built-in', localPath: tmpRoot });

      const result = await service.fetchBuiltInMarketplaces();
      assert.strictEqual(result.plugins.length, 1);
      assert.strictEqual(result.plugins[0].id, 'wecom');
      assert.strictEqual(result.plugins[0].sourceMarketplace, 'comate-built-in');
      assert.strictEqual(result.plugins[0].builtIn, true);
    });

    it('returns empty result when no built-in marketplaces are registered', async () => {
      const result = await service.fetchBuiltInMarketplaces();
      assert.strictEqual(result.plugins.length, 0);
      assert.strictEqual(result.errors.length, 0);
    });
  });

  describe('fetchAllMarketplaces', () => {
    it('merges built-in marketplaces with cached marketplaces', async () => {
      const originalHome = process.env.HOME;
      const homeRoot = mkdtempSync(join(tmpdir(), 'claude-home-'));
      process.env.HOME = homeRoot;

      const cachedMarketplaceDir = mkdtempSync(join(tmpdir(), 'cached-marketplace-'));
      writeFileSync(
        join(cachedMarketplaceDir, 'marketplace.json'),
        JSON.stringify({
          name: 'cached-mp',
          plugins: [{ name: 'cached-plugin', version: '1.0.0' }],
        }),
      );

      mkdirSync(join(homeRoot, '.claude', 'plugins'), { recursive: true });
      writeFileSync(
        join(homeRoot, '.claude', 'plugins', 'known_marketplaces.json'),
        JSON.stringify({
          'cached-mp': {
            source: { source: 'file' },
            installLocation: join(cachedMarketplaceDir, 'marketplace.json'),
          },
        }),
      );

      const builtInRoot = mkdtempSync(join(tmpdir(), 'builtin-marketplace-'));
      mkdirSync(join(builtInRoot, '.claude-plugin'), { recursive: true });
      mkdirSync(join(builtInRoot, 'plugins', 'wecom'), { recursive: true });
      writeFileSync(
        join(builtInRoot, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({
          name: 'comate-built-in',
          plugins: [
            {
              name: 'wecom',
              description: 'Send WeCom messages',
              version: '0.1.0',
              source: './plugins/wecom',
            },
          ],
        }),
      );

      service.registerBuiltInMarketplace({ name: 'comate-built-in', localPath: builtInRoot });

      try {
        const result = await service.fetchAllMarketplaces([], undefined);
        assert.strictEqual(result.plugins.length, 2);
        assert.ok(result.plugins.find((p) => p.id === 'cached-plugin'));
        assert.ok(result.plugins.find((p) => p.id === 'wecom' && p.builtIn));
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it('falls back to network registries when no cached marketplaces exist', async () => {
      const originalHome = process.env.HOME;
      const homeRoot = mkdtempSync(join(tmpdir(), 'claude-home-empty-'));
      process.env.HOME = homeRoot;

      const originalFetch = global.fetch;
      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => [{ name: 'network-plugin', version: '1.0.0' }],
        }) as Response;

      try {
        const result = await service.fetchAllMarketplaces([], undefined);
        assert.ok(result.plugins.find((p) => p.id === 'network-plugin'));
      } finally {
        process.env.HOME = originalHome;
        global.fetch = originalFetch;
      }
    });
  });
});
