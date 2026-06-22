import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WeComBotService } from './wecom-bot-service.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import type { Workspace } from '../models/workspace.js';

interface MarkdownMessageBody {
  markdown: {
    content: string;
  };
}

describe('WeComBotService.sendFile', { concurrency: false }, () => {
  let service: WeComBotService;
  let tempDir: string;

  let origGet: typeof workspaceStore.get;
  let origGetEncryptedUserIdByPlaintext: typeof workspaceStore.getEncryptedUserIdByPlaintext;
  let origGetWecomUserMapping: typeof workspaceStore.getWecomUserMapping;
  let origGetWecomMediaCacheEntry: typeof workspaceStore.getWecomMediaCacheEntry;
  let origCreateWecomMediaCacheEntry: typeof workspaceStore.createWecomMediaCacheEntry;

  let uploadedFiles: Array<{ buffer: Buffer; options: { type: string; filename: string } }>;
  let sentMessages: Array<{ userId: string; body: unknown }>;
  let sentFiles: Array<{ userId: string; mediaType: string; mediaId: string }>;
  let cacheEntries: Array<{
    workspaceId: string;
    relativePath: string;
    md5: string;
    filename: string;
    mediaId: string;
    createdAt: string;
  }>;

  beforeEach(async () => {
    service = new WeComBotService();
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'wecom-send-file-test-'));

    uploadedFiles = [];
    sentMessages = [];
    sentFiles = [];
    cacheEntries = [];

    origGet = workspaceStore.get.bind(workspaceStore);
    origGetEncryptedUserIdByPlaintext = workspaceStore.getEncryptedUserIdByPlaintext.bind(workspaceStore);
    origGetWecomUserMapping = workspaceStore.getWecomUserMapping.bind(workspaceStore);
    origGetWecomMediaCacheEntry = workspaceStore.getWecomMediaCacheEntry.bind(workspaceStore);
    origCreateWecomMediaCacheEntry = workspaceStore.createWecomMediaCacheEntry.bind(workspaceStore);

    workspaceStore.get = async () => ({ id: 'ws-1', folderPath: tempDir, settings: {} } as unknown as Workspace);
    workspaceStore.getEncryptedUserIdByPlaintext = (plaintext: string) => {
      if (plaintext === 'ZhangWei') return 'enc-zhangwei';
      if (plaintext === 'LiSi') return 'enc-lisi';
      return null;
    };
    workspaceStore.getWecomUserMapping = (encrypted: string) => {
      if (encrypted === 'enc-zhangwei') return 'ZhangWei';
      if (encrypted === 'enc-lisi') return 'LiSi';
      return null;
    };
    workspaceStore.getWecomMediaCacheEntry = () => null;
    workspaceStore.createWecomMediaCacheEntry = (input) => {
      cacheEntries.push(input);
      return { ...input };
    };
  });

  afterEach(async () => {
    workspaceStore.get = origGet;
    workspaceStore.getEncryptedUserIdByPlaintext = origGetEncryptedUserIdByPlaintext;
    workspaceStore.getWecomUserMapping = origGetWecomUserMapping;
    workspaceStore.getWecomMediaCacheEntry = origGetWecomMediaCacheEntry;
    workspaceStore.createWecomMediaCacheEntry = origCreateWecomMediaCacheEntry;

    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  function createMockConnection(status: 'connected' | 'disconnected' = 'connected') {
    return {
      client: {
        uploadMedia: async (buffer: Buffer, options: { type: string; filename: string }) => {
          uploadedFiles.push({ buffer, options });
          return { media_id: `media-${uploadedFiles.length}`, created_at: Date.now() };
        },
        sendMediaMessage: async (userId: string, mediaType: string, mediaId: string) => {
          sentFiles.push({ userId, mediaType, mediaId });
        },
        sendMessage: async (userId: string, body: unknown) => {
          sentMessages.push({ userId, body });
        },
      },
      workspaceId: 'ws-1',
      botId: 'bot-1',
      folderPath: tempDir,
      status,
    };
  }

  function injectConnection(conn: unknown) {
    (service as unknown as { connections: Map<string, unknown> }).connections.set('ws-1', conn);
  }

  async function writeFile(relPath: string, content: string): Promise<string> {
    const fullPath = path.join(tempDir, relPath);
    await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
    await fsPromises.writeFile(fullPath, content);
    return fullPath;
  }

  it('uploads, caches, and sends a valid file with no cache entry', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    await writeFile('docs/report.pdf', 'report content');
    await service.sendFile('ws-1', 'ZhangWei', 'docs/report.pdf');

    assert.strictEqual(uploadedFiles.length, 1);
    assert.strictEqual(uploadedFiles[0].options.filename, 'report.pdf');
    assert.strictEqual(sentFiles.length, 1);
    assert.strictEqual(sentFiles[0].userId, 'enc-zhangwei');
    assert.strictEqual(sentFiles[0].mediaType, 'file');
    assert.strictEqual(sentFiles[0].mediaId, 'media-1');
    assert.strictEqual(cacheEntries.length, 1);
    assert.strictEqual(cacheEntries[0].mediaId, 'media-1');
  });

  it('reuses a 70-hour-old cached media_id without uploading', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    await writeFile('docs/report.pdf', 'report content');
    workspaceStore.getWecomMediaCacheEntry = () => ({
      workspaceId: 'ws-1',
      relativePath: 'docs/report.pdf',
      md5: 'abc',
      filename: 'report.pdf',
      mediaId: 'cached-media-id',
      createdAt: new Date(Date.now() - 70 * 60 * 60 * 1000).toISOString(),
    });

    await service.sendFile('ws-1', 'ZhangWei', 'docs/report.pdf');

    assert.strictEqual(uploadedFiles.length, 0);
    assert.strictEqual(sentFiles.length, 1);
    assert.strictEqual(sentFiles[0].mediaId, 'cached-media-id');
  });

  it('re-uploads when the cache entry is stale (72 hours old)', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    await writeFile('docs/report.pdf', 'report content');
    workspaceStore.getWecomMediaCacheEntry = () => null;

    await service.sendFile('ws-1', 'ZhangWei', 'docs/report.pdf');

    assert.strictEqual(uploadedFiles.length, 1);
    assert.strictEqual(sentFiles.length, 1);
    assert.strictEqual(cacheEntries.length, 1);
  });

  it('sends an unauthorized message and throws for cross-user data folder access', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    await writeFile('data/ZhangWei/private.pdf', 'private content');

    await assert.rejects(
      async () => service.sendFile('ws-1', 'LiSi', 'data/ZhangWei/private.pdf'),
      /File access denied: other-user-dir/,
    );

    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].userId, 'enc-lisi');
    assert.deepStrictEqual((sentMessages[0].body as MarkdownMessageBody).markdown, { content: 'unauthorized file access' });
    assert.strictEqual(uploadedFiles.length, 0);
    assert.strictEqual(sentFiles.length, 0);
  });

  it('allows sending from the matching user data folder', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    await writeFile('data/ZhangWei/private.pdf', 'private content');
    await service.sendFile('ws-1', 'ZhangWei', 'data/ZhangWei/private.pdf');

    assert.strictEqual(uploadedFiles.length, 1);
    assert.strictEqual(sentFiles.length, 1);
  });

  it('throws when the bot is not connected', async () => {
    const conn = createMockConnection('disconnected');
    injectConnection(conn);

    await writeFile('docs/report.pdf', 'report content');

    await assert.rejects(
      async () => service.sendFile('ws-1', 'ZhangWei', 'docs/report.pdf'),
      /Bot for workspace ws-1 is not connected/,
    );
  });

  it('throws when the file exceeds the maximum size', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    await writeFile('docs/huge.pdf', 'x');

    const origStat = fsPromises.stat;
    fsPromises.stat = async () => ({ size: 21 * 1024 * 1024 } as Stats);

    try {
      await assert.rejects(
        async () => service.sendFile('ws-1', 'ZhangWei', 'docs/huge.pdf'),
        /File exceeds maximum send size/,
      );
      assert.strictEqual(uploadedFiles.length, 0);
    } finally {
      fsPromises.stat = origStat;
    }
  });

  it('throws when upload fails and does not send a message', async () => {
    const conn = createMockConnection();
    conn.client.uploadMedia = async () => { throw new Error('upload error'); };
    injectConnection(conn);

    await writeFile('docs/report.pdf', 'report content');

    await assert.rejects(
      async () => service.sendFile('ws-1', 'ZhangWei', 'docs/report.pdf'),
      /upload error/,
    );

    assert.strictEqual(sentFiles.length, 0);
  });

  it('throws when send fails', async () => {
    const conn = createMockConnection();
    conn.client.sendMediaMessage = async () => { throw new Error('send error'); };
    injectConnection(conn);

    await writeFile('docs/report.pdf', 'report content');

    await assert.rejects(
      async () => service.sendFile('ws-1', 'ZhangWei', 'docs/report.pdf'),
      /send error/,
    );

    assert.strictEqual(uploadedFiles.length, 1);
  });

  it('throws when the workspace does not exist', async () => {
    workspaceStore.get = async () => null;

    await assert.rejects(
      async () => service.sendFile('ws-1', 'ZhangWei', 'docs/report.pdf'),
      /Workspace ws-1 not found/,
    );
  });

  it('throws when the recipient cannot be resolved', async () => {
    workspaceStore.getEncryptedUserIdByPlaintext = () => null;

    const conn = createMockConnection();
    injectConnection(conn);

    await writeFile('docs/report.pdf', 'report content');

    await assert.rejects(
      async () => service.sendFile('ws-1', 'UnknownUser', 'docs/report.pdf'),
      /WeCom user ID has not been decrypted yet/,
    );
  });
});
