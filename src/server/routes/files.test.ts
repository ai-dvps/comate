import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'fs/promises';
import type { AddressInfo } from 'net';
import http from 'http';
import os from 'os';
import path from 'path';
import express from 'express';
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

async function importResolveHandler() {
  const mod = await import('./files.js');
  const layer = (mod.default as unknown as {
    stack: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }>;
      };
    }>;
  }).stack.find((entry) => entry.route?.path === '/resolve' && entry.route.methods.post);

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

  it('POST /resolve returns only existing regular files from a mixed batch', async () => {
    await writeFile(path.join(tempDir, 'alpha.ts'), 'alpha');
    await mkdir(path.join(tempDir, 'nested'));
    await writeFile(path.join(tempDir, 'nested', 'beta.ts'), 'beta');
    const workspace = await workspaceStore.create({ name: 'test-ws', folderPath: tempDir });
    const handler = await importResolveHandler();
    const res = createMockRes();

    await handler(
      {
        params: { id: workspace.id },
        body: {
          paths: [
            'alpha.ts',
            'missing.ts',
            'nested',
            'nested/beta.ts',
            'alpha.ts',
          ],
        },
      },
      res,
    );

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.jsonBody, {
      paths: ['alpha.ts', 'nested/beta.ts'],
    });
  });

  it('POST /resolve omits paths outside the workspace and unsafe candidates', async () => {
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'comate-files-outside-'));
    const outsidePath = path.join(outsideDir, 'private.ts');
    await writeFile(outsidePath, 'private');
    await symlink(outsidePath, path.join(tempDir, 'linked.ts'));
    const workspace = await workspaceStore.create({ name: 'test-ws', folderPath: tempDir });
    const handler = await importResolveHandler();
    const res = createMockRes();

    try {
      await handler(
        {
          params: { id: workspace.id },
          body: {
            paths: [
              outsidePath,
              '../private.ts',
              'linked.ts',
              'bad\0path',
              '',
            ],
          },
        },
        res,
      );

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.jsonBody, { paths: [] });
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('POST /resolve rejects malformed and over-limit request bodies', async () => {
    const workspace = await workspaceStore.create({ name: 'test-ws', folderPath: tempDir });
    const handler = await importResolveHandler();

    for (const body of [
      undefined,
      {},
      { paths: 'alpha.ts' },
      { paths: [42] },
      { paths: Array.from({ length: 65 }, (_, index) => `file-${index}.ts`) },
      { paths: ['x'.repeat(4097)] },
    ]) {
      const res = createMockRes();
      await handler({ params: { id: workspace.id }, body }, res);
      assert.strictEqual(res.statusCode, 400);
      assert.deepStrictEqual(res.jsonBody, { error: 'Invalid paths request' });
    }
  });

  it('POST /resolve returns workspace-not-found for an unknown workspace', async () => {
    const handler = await importResolveHandler();
    const res = createMockRes();

    await handler(
      { params: { id: 'missing-workspace' }, body: { paths: ['alpha.ts'] } },
      res,
    );

    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(res.jsonBody, { error: 'Workspace not found' });
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

  it('GET /content returns video metadata without loading the video into JSON', async () => {
    const video = Buffer.from('video-bytes');
    await writeFile(path.join(tempDir, 'clip.mp4'), video);
    const workspace = await workspaceStore.create({ name: 'test-ws', folderPath: tempDir });
    const handler = await importContentHandler();
    const res = createMockRes();

    await handler(
      { params: { id: workspace.id }, query: { path: 'clip.mp4' } },
      res,
    );

    assert.deepStrictEqual(res.jsonBody, {
      path: 'clip.mp4',
      content: null,
      mimeType: 'video/mp4',
      isBinary: true,
      size: video.length,
    });
  });

  it('GET /content returns audio metadata without loading the audio into JSON', async () => {
    const audio = Buffer.from('audio-bytes');
    await writeFile(path.join(tempDir, 'tone.wav'), audio);
    const workspace = await workspaceStore.create({ name: 'test-ws', folderPath: tempDir });
    const handler = await importContentHandler();
    const res = createMockRes();

    await handler(
      { params: { id: workspace.id }, query: { path: 'tone.wav' } },
      res,
    );

    assert.deepStrictEqual(res.jsonBody, {
      path: 'tone.wav',
      content: null,
      mimeType: 'audio/wav',
      isBinary: true,
      size: audio.length,
    });
  });

  it('GET /media streams byte ranges for supported workspace videos', async () => {
    const video = Buffer.from('0123456789');
    await writeFile(path.join(tempDir, 'clip.webm'), video);
    const workspace = await workspaceStore.create({ name: 'test-ws', folderPath: tempDir });
    const { default: fileRoutes } = await import('./files.js');
    const app = express();
    app.use('/api/workspaces/:id/files', fileRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/${workspace.id}/files/media?path=clip.webm`,
        { headers: { Range: 'bytes=2-5' } },
      );

      assert.strictEqual(response.status, 206);
      assert.strictEqual(response.headers.get('accept-ranges'), 'bytes');
      assert.strictEqual(response.headers.get('content-range'), 'bytes 2-5/10');
      assert.strictEqual(response.headers.get('content-type'), 'video/webm');
      assert.strictEqual(Buffer.from(await response.arrayBuffer()).toString(), '2345');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('GET /media streams byte ranges for supported workspace audio', async () => {
    const audio = Buffer.from('0123456789');
    await writeFile(path.join(tempDir, 'track.mp3'), audio);
    const workspace = await workspaceStore.create({ name: 'test-ws', folderPath: tempDir });
    const { default: fileRoutes } = await import('./files.js');
    const app = express();
    app.use('/api/workspaces/:id/files', fileRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/${workspace.id}/files/media?path=track.mp3`,
        { headers: { Range: 'bytes=2-5' } },
      );

      assert.strictEqual(response.status, 206);
      assert.strictEqual(response.headers.get('accept-ranges'), 'bytes');
      assert.strictEqual(response.headers.get('content-range'), 'bytes 2-5/10');
      assert.strictEqual(response.headers.get('content-type'), 'audio/mpeg');
      assert.strictEqual(Buffer.from(await response.arrayBuffer()).toString(), '2345');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('GET /media rejects unsupported media formats', async () => {
    await writeFile(path.join(tempDir, 'song.wma'), Buffer.from('not-really-wma'));
    const workspace = await workspaceStore.create({ name: 'test-ws', folderPath: tempDir });
    const { default: fileRoutes } = await import('./files.js');
    const app = express();
    app.use('/api/workspaces/:id/files', fileRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/${workspace.id}/files/media?path=song.wma`,
      );

      assert.strictEqual(response.status, 415);
      assert.deepStrictEqual(await response.json(), { error: 'Unsupported media format' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('GET /media contains client cancellations and continues serving video', async () => {
    const video = Buffer.alloc(4 * 1024 * 1024, 7);
    await writeFile(path.join(tempDir, 'clip.mp4'), video);
    const workspace = await workspaceStore.create({ name: 'test-ws', folderPath: tempDir });
    const { default: fileRoutes } = await import('./files.js');
    const app = express();
    app.use('/api/workspaces/:id/files', fileRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));

    try {
      const { port } = server.address() as AddressInfo;
      const mediaPath = `/api/workspaces/${workspace.id}/files/media?path=clip.mp4`;
      await new Promise<void>((resolve, reject) => {
        const request = http.get({ hostname: '127.0.0.1', port, path: mediaPath }, (response) => {
          response.once('data', () => response.destroy());
          response.once('close', resolve);
        });
        request.once('error', reject);
      });

      const response = await fetch(`http://127.0.0.1:${port}${mediaPath}`, {
        headers: { Range: 'bytes=0-3' },
      });
      assert.strictEqual(response.status, 206);
      assert.deepStrictEqual(Buffer.from(await response.arrayBuffer()), video.subarray(0, 4));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('GET /media rejects unsatisfiable ranges without returning file bytes', async () => {
    const video = Buffer.from('0123456789');
    await writeFile(path.join(tempDir, 'clip.mp4'), video);
    const workspace = await workspaceStore.create({ name: 'test-ws', folderPath: tempDir });
    const { default: fileRoutes } = await import('./files.js');
    const app = express();
    app.use('/api/workspaces/:id/files', fileRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/${workspace.id}/files/media?path=clip.mp4`,
        { headers: { Range: 'bytes=20-30' } },
      );

      assert.strictEqual(response.status, 416);
      assert.strictEqual(response.headers.get('content-range'), 'bytes */10');
      assert.strictEqual((await response.arrayBuffer()).byteLength, 0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('GET /media refuses symlinked videos outside the workspace', async () => {
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'comate-video-outside-'));
    const outsidePath = path.join(outsideDir, 'private.mp4');
    await writeFile(outsidePath, Buffer.from('private-video'));
    await symlink(outsidePath, path.join(tempDir, 'linked.mp4'));
    const workspace = await workspaceStore.create({ name: 'test-ws', folderPath: tempDir });
    const { default: fileRoutes } = await import('./files.js');
    const app = express();
    app.use('/api/workspaces/:id/files', fileRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/${workspace.id}/files/media?path=linked.mp4`,
      );
      assert.strictEqual(response.status, 403);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(outsideDir, { recursive: true, force: true });
    }
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
