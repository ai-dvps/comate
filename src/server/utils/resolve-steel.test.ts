import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { resolveSteelBundle } from './resolve-steel.js';

/**
 * Resolution ladder contract (U2): TAURI_RESOURCE_DIR > data dir > dev tree;
 * when every rung misses the resolver returns undefined so callers can fail
 * explicitly (R17), never silently.
 */

function makeDeps(existing: Set<string>, env: NodeJS.ProcessEnv = {}) {
  return {
    env,
    fileExists: (p: string) => existing.has(p),
    devCandidates: ['/dev-tree/steel'],
    storageDir: '/data-dir',
  };
}

const ENTRY = join('build', 'index.js');

describe('resolve-steel ladder', { concurrency: false }, () => {
  it('prefers TAURI_RESOURCE_DIR over data dir and dev tree', () => {
    const existing = new Set([
      join('/resource/steel', ENTRY),
      join('/data-dir/steel', ENTRY),
      join('/dev-tree/steel', ENTRY),
    ]);
    const hit = resolveSteelBundle(makeDeps(existing, { TAURI_RESOURCE_DIR: '/resource' }));
    assert.ok(hit);
    assert.strictEqual(hit.source, 'resource');
    assert.strictEqual(hit.steelDir, join('/resource', 'steel'));
    assert.strictEqual(hit.entryPath, join('/resource/steel', ENTRY));
  });

  it('also probes the nested resources/ variant of TAURI_RESOURCE_DIR', () => {
    const existing = new Set([join('/resource/resources/steel', ENTRY)]);
    const hit = resolveSteelBundle(makeDeps(existing, { TAURI_RESOURCE_DIR: '/resource' }));
    assert.ok(hit);
    assert.strictEqual(hit.source, 'resource');
    assert.strictEqual(hit.steelDir, join('/resource/resources', 'steel'));
  });

  it('falls back to the data dir when the resource dir misses', () => {
    const existing = new Set([
      join('/data-dir/steel', ENTRY),
      join('/dev-tree/steel', ENTRY),
    ]);
    const hit = resolveSteelBundle(makeDeps(existing, { TAURI_RESOURCE_DIR: '/resource' }));
    assert.ok(hit);
    assert.strictEqual(hit.source, 'data');
    assert.strictEqual(hit.steelDir, join('/data-dir', 'steel'));
  });

  it('falls back to the dev tree when resource and data dirs miss', () => {
    const existing = new Set([join('/dev-tree/steel', ENTRY)]);
    const hit = resolveSteelBundle(makeDeps(existing, { TAURI_RESOURCE_DIR: '/resource' }));
    assert.ok(hit);
    assert.strictEqual(hit.source, 'dev');
    assert.strictEqual(hit.steelDir, join('/dev-tree', 'steel'));
  });

  it('requires the entrypoint file, not just the directory', () => {
    // Directory exists but build/index.js does not -> not a valid bundle.
    const existing = new Set<string>();
    const hit = resolveSteelBundle(makeDeps(existing, { TAURI_RESOURCE_DIR: '/resource' }));
    assert.strictEqual(hit, undefined);
  });

  it('returns undefined when every rung misses', () => {
    const hit = resolveSteelBundle(makeDeps(new Set(), {}));
    assert.strictEqual(hit, undefined);
  });
});
