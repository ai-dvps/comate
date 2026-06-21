import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveBuiltInMarketplacePath } from './resolve-builtin-marketplace-path.js';

describe('resolve-builtin-marketplace-path', { concurrency: false }, () => {
  it('returns the repo-root claude-code-plugin when TAURI_RESOURCE_DIR is missing', () => {
    delete process.env.TAURI_RESOURCE_DIR;
    const result = resolveBuiltInMarketplacePath();
    assert.ok(result);
    assert.ok(result!.endsWith('claude-code-plugin'));
  });

  it('returns the repo-root claude-code-plugin when TAURI_RESOURCE_DIR does not contain it', () => {
    const emptyResourceDir = mkdtempSync(join(tmpdir(), 'tauri-resources-'));
    process.env.TAURI_RESOURCE_DIR = emptyResourceDir;

    try {
      const result = resolveBuiltInMarketplacePath();
      assert.ok(result);
      assert.ok(result!.endsWith('claude-code-plugin'));
      assert.ok(!result!.startsWith(emptyResourceDir));
    } finally {
      delete process.env.TAURI_RESOURCE_DIR;
    }
  });

  it('prefers TAURI_RESOURCE_DIR when it contains claude-code-plugin', () => {
    const resourceDir = mkdtempSync(join(tmpdir(), 'tauri-resources-'));
    const builtInDir = join(resourceDir, 'claude-code-plugin');
    mkdirSync(join(builtInDir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(builtInDir, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [] }));
    process.env.TAURI_RESOURCE_DIR = resourceDir;

    try {
      const result = resolveBuiltInMarketplacePath();
      assert.strictEqual(result, builtInDir);
    } finally {
      delete process.env.TAURI_RESOURCE_DIR;
    }
  });
});