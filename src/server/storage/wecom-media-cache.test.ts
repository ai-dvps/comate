import '../test-utils/test-env.js';
import os from 'node:os';
import path from 'node:path';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteStore } from './sqlite-store.js';

const ORIGINAL_DATA_DIR = process.env.COMATE_DATA_DIR;

describe('SqliteStore WeCom media cache', { concurrency: false }, () => {
  let store: SqliteStore;
  let dataDir: string;

  before(() => {
    dataDir = path.join(os.tmpdir(), `comate-media-cache-test-${Date.now()}`);
    process.env.COMATE_DATA_DIR = dataDir;
  });

  after(() => {
    if (ORIGINAL_DATA_DIR === undefined) {
      delete process.env.COMATE_DATA_DIR;
    } else {
      process.env.COMATE_DATA_DIR = ORIGINAL_DATA_DIR;
    }
  });

  beforeEach(() => {
    store = new SqliteStore();
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
    db.prepare('DELETE FROM wecom_media_cache').run();
  });

  function createInput(overrides: Partial<{
    workspaceId: string;
    relativePath: string;
    md5: string;
    filename: string;
    mediaId: string;
    createdAt: string;
  }> = {}) {
    return {
      workspaceId: overrides.workspaceId ?? 'ws-1',
      relativePath: overrides.relativePath ?? 'docs/report.pdf',
      md5: overrides.md5 ?? 'abc123',
      filename: overrides.filename ?? 'report.pdf',
      mediaId: overrides.mediaId ?? 'media-1',
      createdAt: overrides.createdAt ?? new Date().toISOString(),
    };
  }

  it('createWecomMediaCacheEntry writes a row and getWecomMediaCacheEntry reads it back', () => {
    const input = createInput();
    const entry = store.createWecomMediaCacheEntry(input);

    assert.strictEqual(entry.workspaceId, input.workspaceId);
    assert.strictEqual(entry.relativePath, input.relativePath);
    assert.strictEqual(entry.md5, input.md5);
    assert.strictEqual(entry.filename, input.filename);
    assert.strictEqual(entry.mediaId, input.mediaId);
    assert.strictEqual(entry.createdAt, input.createdAt);

    const found = store.getWecomMediaCacheEntry(input.workspaceId, input.relativePath, input.md5);
    assert.ok(found);
    assert.strictEqual(found.mediaId, input.mediaId);
  });

  it('getWecomMediaCacheEntry returns null for non-existent key', () => {
    const found = store.getWecomMediaCacheEntry('ws-1', 'docs/report.pdf', 'no-such-md5');
    assert.strictEqual(found, null);
  });

  it('returns a 70-hour-old entry', () => {
    const createdAt = new Date(Date.now() - 70 * 60 * 60 * 1000).toISOString();
    const input = createInput({ createdAt });
    store.createWecomMediaCacheEntry(input);

    const found = store.getWecomMediaCacheEntry(input.workspaceId, input.relativePath, input.md5);
    assert.ok(found);
    assert.strictEqual(found.mediaId, input.mediaId);
  });

  it('does not return a 72-hour-old entry', () => {
    const createdAt = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const input = createInput({ createdAt });
    store.createWecomMediaCacheEntry(input);

    const found = store.getWecomMediaCacheEntry(input.workspaceId, input.relativePath, input.md5);
    assert.strictEqual(found, null);
  });

  it('overwrites an existing row for the same lookup key', () => {
    const input = createInput({ mediaId: 'media-old' });
    store.createWecomMediaCacheEntry(input);

    const updated = createInput({ mediaId: 'media-new', createdAt: new Date(Date.now() + 1000).toISOString() });
    store.createWecomMediaCacheEntry(updated);

    const found = store.getWecomMediaCacheEntry(input.workspaceId, input.relativePath, input.md5);
    assert.ok(found);
    assert.strictEqual(found.mediaId, 'media-new');
  });

  it('isolates entries by workspace, path, and md5', () => {
    const a = createInput({ workspaceId: 'ws-a', md5: 'md5-a', mediaId: 'media-a' });
    const b = createInput({ workspaceId: 'ws-b', md5: 'md5-b', mediaId: 'media-b' });
    store.createWecomMediaCacheEntry(a);
    store.createWecomMediaCacheEntry(b);

    assert.strictEqual(store.getWecomMediaCacheEntry(a.workspaceId, a.relativePath, a.md5)?.mediaId, 'media-a');
    assert.strictEqual(store.getWecomMediaCacheEntry(b.workspaceId, b.relativePath, b.md5)?.mediaId, 'media-b');
    assert.strictEqual(store.getWecomMediaCacheEntry(a.workspaceId, a.relativePath, b.md5), null);
  });

  it('deleting a workspace cascades to media cache rows', async () => {
    const input = createInput();
    store.createWecomMediaCacheEntry(input);

    const ws = await store.create({ name: 'Cache Cascade', folderPath: '/tmp/cache-cascade' });
    const wsEntry = createInput({ workspaceId: ws.id, mediaId: 'media-ws' });
    store.createWecomMediaCacheEntry(wsEntry);

    assert.ok(store.getWecomMediaCacheEntry(ws.id, wsEntry.relativePath, wsEntry.md5));

    await store.delete(ws.id);

    assert.strictEqual(store.getWecomMediaCacheEntry(ws.id, wsEntry.relativePath, wsEntry.md5), null);
    // Other workspace entry remains
    assert.ok(store.getWecomMediaCacheEntry(input.workspaceId, input.relativePath, input.md5));
  });
});
