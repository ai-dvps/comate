import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { store as workspaceStore } from '../storage/sqlite-store.js';

async function importContentHandler() {
  const mod = await import('./files.js');
  const layer = (mod.default as unknown as {
    stack: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }>;
      };
    }>;
  }).stack.find((entry) => entry.route?.path === '/content' && entry.route.methods.get);

  assert.ok(layer?.route);
  return layer.route.stack[0].handle;
}

function createMockRes(): {
  statusCode: number;
  jsonBody: unknown;
  status(code: number): typeof res;
  json(body: unknown): void;
} {
  const res = {
    statusCode: 200,
    jsonBody: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
    },
  };
  return res;
}

describe('files routes', { concurrency: false }, () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'comate-files-test-'));
    workspaceStore.resetData();
  });

  afterEach(async () => {
    workspaceStore.resetData();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('GET /content returns supported images as base64 preview data', async () => {
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    await writeFile(path.join(tempDir, 'pixel.png'), image);
    const workspace = await workspaceStore.create({ name: 'test-ws', folderPath: tempDir });
    const handler = await importContentHandler();
    const res = createMockRes();

    await handler(
      { params: { id: workspace.id }, query: { path: 'pixel.png' } },
      res,
    );

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.jsonBody, {
      path: 'pixel.png',
      content: image.toString('base64'),
      encoding: 'base64',
      mimeType: 'image/png',
      isBinary: true,
      size: image.length,
    });
  });

  it('GET /content declines to inline images larger than the preview limit', async () => {
    const imagePath = path.join(tempDir, 'large.png');
    const imageFile = await open(imagePath, 'w');
    await imageFile.truncate((20 * 1024 * 1024) + 1);
    await imageFile.close();
    const workspace = await workspaceStore.create({ name: 'test-ws', folderPath: tempDir });
    const handler = await importContentHandler();
    const res = createMockRes();

    await handler(
      { params: { id: workspace.id }, query: { path: 'large.png' } },
      res,
    );

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.jsonBody, {
      path: 'large.png',
      content: null,
      mimeType: 'image/png',
      isBinary: true,
      size: (20 * 1024 * 1024) + 1,
      previewUnavailable: 'too_large',
    });
  });

  it('GET /content continues to return text files as UTF-8', async () => {
    await writeFile(path.join(tempDir, 'notes.txt'), 'hello image preview');
    const workspace = await workspaceStore.create({ name: 'test-ws', folderPath: tempDir });
    const handler = await importContentHandler();
    const res = createMockRes();

    await handler(
      { params: { id: workspace.id }, query: { path: 'notes.txt' } },
      res,
    );

    assert.deepStrictEqual(res.jsonBody, {
      path: 'notes.txt',
      content: 'hello image preview',
      isBinary: false,
      size: 19,
    });
  });

  it('GET /content continues to omit non-image binary content', async () => {
    await writeFile(path.join(tempDir, 'archive.bin'), Buffer.from([1, 0, 2, 3]));
    const workspace = await workspaceStore.create({ name: 'test-ws', folderPath: tempDir });
    const handler = await importContentHandler();
    const res = createMockRes();

    await handler(
      { params: { id: workspace.id }, query: { path: 'archive.bin' } },
      res,
    );

    assert.deepStrictEqual(res.jsonBody, {
      path: 'archive.bin',
      content: null,
      isBinary: true,
      size: 4,
    });
  });

  it('GET /content rejects sibling-prefix paths outside the workspace', async () => {
    const siblingDir = `${tempDir}-secret`;
    await mkdir(siblingDir);
    await writeFile(path.join(siblingDir, 'private.png'), Buffer.from([137, 80, 78, 71]));
    const workspace = await workspaceStore.create({ name: 'test-ws', folderPath: tempDir });
    const handler = await importContentHandler();
    const res = createMockRes();

    try {
      await handler(
        {
          params: { id: workspace.id },
          query: { path: `../${path.basename(siblingDir)}/private.png` },
        },
        res,
      );

      assert.strictEqual(res.statusCode, 403);
      assert.deepStrictEqual(res.jsonBody, { error: 'Path outside workspace' });
    } finally {
      await rm(siblingDir, { recursive: true, force: true });
    }
  });

  it('GET /content rejects symlinks that resolve outside the workspace', async () => {
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'comate-files-outside-'));
    await writeFile(path.join(outsideDir, 'private.png'), Buffer.from([137, 80, 78, 71]));
    await symlink(path.join(outsideDir, 'private.png'), path.join(tempDir, 'linked.png'));
    const workspace = await workspaceStore.create({ name: 'test-ws', folderPath: tempDir });
    const handler = await importContentHandler();
    const res = createMockRes();

    try {
      await handler(
        { params: { id: workspace.id }, query: { path: 'linked.png' } },
        res,
      );

      assert.strictEqual(res.statusCode, 403);
      assert.deepStrictEqual(res.jsonBody, { error: 'Path outside workspace' });
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
