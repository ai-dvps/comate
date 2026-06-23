import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PluginDownloader } from './plugin-downloader.js';

describe('plugin-downloader', { concurrency: false }, () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'comate-plugin-cache-'));
  });

  it('copies a local plugin directory into the cache', async () => {
    const pluginDir = mkdtempSync(join(tmpdir(), 'comate-local-plugin-'));
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'wecom', version: '0.1.0' }),
    );
    writeFileSync(join(pluginDir, 'SKILL.md'), '# send-wecom-msg\n');

    const downloader = new PluginDownloader({ cacheDir });
    const result = await downloader.downloadLocal('wecom', pluginDir);

    assert.strictEqual(result.success, true);
    assert.ok(existsSync(join(result.cachePath, '.claude-plugin', 'plugin.json')));
    assert.ok(existsSync(join(result.cachePath, 'SKILL.md')));

    const manifest = JSON.parse(
      readFileSync(join(result.cachePath, '.claude-plugin', 'plugin.json'), 'utf-8'),
    );
    assert.strictEqual(manifest.name, 'wecom');
    assert.strictEqual(manifest.version, '0.1.0');
  });

  it('fails when local plugin manifest is invalid', async () => {
    const pluginDir = mkdtempSync(join(tmpdir(), 'comate-local-plugin-bad-'));
    writeFileSync(join(pluginDir, 'README.md'), 'no manifest');

    const downloader = new PluginDownloader({ cacheDir });
    const result = await downloader.downloadLocal('wecom', pluginDir);

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('missing a valid plugin.json manifest'));
  });

  it('fails when local plugin path does not exist', async () => {
    const downloader = new PluginDownloader({ cacheDir });
    const result = await downloader.downloadLocal('wecom', join(tmpdir(), 'does-not-exist'));

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('does not exist'));
  });

  it('overwrites existing cache on local copy', async () => {
    const pluginDir = mkdtempSync(join(tmpdir(), 'comate-local-plugin-'));
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'wecom', version: '0.2.0' }),
    );

    const cachePath = join(cacheDir, 'wecom');
    mkdirSync(cachePath, { recursive: true });
    writeFileSync(join(cachePath, 'stale.txt'), 'old');

    const downloader = new PluginDownloader({ cacheDir });
    const result = await downloader.downloadLocal('wecom', pluginDir);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.cachePath, cachePath);
    assert.ok(!existsSync(join(cachePath, 'stale.txt')));
    const manifest = JSON.parse(
      readFileSync(join(cachePath, '.claude-plugin', 'plugin.json'), 'utf-8'),
    );
    assert.strictEqual(manifest.version, '0.2.0');
  });
});