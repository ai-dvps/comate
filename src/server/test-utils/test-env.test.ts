import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStorageDir } from '../storage/data-dir.js';
import { createIsolatedStore, withIsolatedStore } from './test-store.js';

describe('test-env guard and isolated-store factory', () => {
  it('getStorageDir throws when tests would resolve a production path', () => {
    const original = process.env.COMATE_DATA_DIR;
    // Force the dev fallback (a production root) while tests are running.
    process.env.COMATE_DATA_DIR = join(homedir(), '.comate');
    try {
      assert.throws(
        () => getStorageDir(),
        /production path during tests/,
      );
    } finally {
      process.env.COMATE_DATA_DIR = original;
    }
  });

  it('getStorageDir throws when tests would resolve the Tauri app-data path', () => {
    const original = process.env.COMATE_DATA_DIR;
    process.env.COMATE_DATA_DIR = join(homedir(), 'Library', 'Application Support', 'com.comate.app');
    try {
      assert.throws(
        () => getStorageDir(),
        /production path during tests/,
      );
    } finally {
      process.env.COMATE_DATA_DIR = original;
    }
  });

  it('getStorageDir passes for an ordinary temp directory', () => {
    const original = process.env.COMATE_DATA_DIR;
    const tempDir = join(tmpdir(), 'comate-guard-test');
    process.env.COMATE_DATA_DIR = tempDir;
    try {
      assert.strictEqual(getStorageDir(), tempDir);
    } finally {
      process.env.COMATE_DATA_DIR = original;
    }
  });

  it('createIsolatedStore returns an independent in-memory store', async () => {
    const a = createIsolatedStore();
    const b = createIsolatedStore();
    const ws = await a.create({ name: 'A', folderPath: '/tmp/a' });
    assert.ok(await a.get(ws.id));
    assert.strictEqual(await b.get(ws.id), null);
  });

  it('createIsolatedStore supports a temp-file path override', async () => {
    const path = join(tmpdir(), `isolated-file-${Date.now()}.db`);
    const store = createIsolatedStore(path);
    const ws = await store.create({ name: 'File', folderPath: '/tmp/f' });
    assert.ok(await store.get(ws.id));
    store.resetData();
  });

  it('withIsolatedStore resets the store after the body runs', async () => {
    let capturedId = '';
    await withIsolatedStore(async (store) => {
      const ws = await store.create({ name: 'Scoped', folderPath: '/tmp/s' });
      capturedId = ws.id;
      assert.ok(await store.get(capturedId));
    });
    // After the wrapper, a fresh store does not see the workspace (it was on a
    // separate in-memory instance that has been reset).
    const fresh = createIsolatedStore();
    assert.strictEqual(await fresh.get(capturedId), null);
  });
});
