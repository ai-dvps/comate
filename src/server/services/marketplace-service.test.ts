import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
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
});
