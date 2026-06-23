import '../test-utils/test-env.js';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WeComBotService } from './wecom-bot-service.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';

describe('WeComBotService handleMediaMessage', { concurrency: false }, () => {
  let service: WeComBotService;
  let tempDir: string;

  // Saved originals for restoration
  let origGetWecomSession: typeof workspaceStore.getWecomSession;
  let origSetWecomSession: typeof workspaceStore.setWecomSession;
  let origGetWecomUserMapping: typeof workspaceStore.getWecomUserMapping;
  let origGet: typeof workspaceStore.get;
  let origGetSession: typeof chatService.getSession;
  let origCreateSession: typeof chatService.createSession;
  let origGetOrCreateRuntime: typeof chatService.getOrCreateRuntime;

  // Spies
  let pushedMessages: string[];
  let sentMessages: Array<{ userId: string; body: any }>;

  beforeEach(async () => {
    service = new WeComBotService();
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'wecom-media-test-'));
    pushedMessages = [];
    sentMessages = [];

    origGetWecomSession = workspaceStore.getWecomSession.bind(workspaceStore);
    origSetWecomSession = workspaceStore.setWecomSession.bind(workspaceStore);
    origGetWecomUserMapping = workspaceStore.getWecomUserMapping.bind(workspaceStore);
    origGet = workspaceStore.get.bind(workspaceStore);
    origGetSession = chatService.getSession.bind(chatService);
    origCreateSession = chatService.createSession.bind(chatService);
    origGetOrCreateRuntime = chatService.getOrCreateRuntime.bind(chatService);

    // Default: no existing session
    workspaceStore.getWecomSession = () => null;
    workspaceStore.setWecomSession = () => {};
    workspaceStore.getWecomUserMapping = () => null;
    workspaceStore.get = async () => ({ id: 'ws-1', settings: {} } as any);

    // Default: session creation returns a fake session
    chatService.getSession = async () => ({ id: 'sess-1', workspaceId: 'ws-1' } as any);
    chatService.createSession = async () => ({ id: 'sess-1', workspaceId: 'ws-1' } as any);

    // Default: runtime with pushMessage spy
    chatService.getOrCreateRuntime = async () => ({
      pushMessage: (content: string) => { pushedMessages.push(content); },
    } as any);
  });

  afterEach(async () => {
    workspaceStore.getWecomSession = origGetWecomSession;
    workspaceStore.setWecomSession = origSetWecomSession;
    workspaceStore.getWecomUserMapping = origGetWecomUserMapping;
    workspaceStore.get = origGet;
    chatService.getSession = origGetSession;
    chatService.createSession = origCreateSession;
    chatService.getOrCreateRuntime = origGetOrCreateRuntime;
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  function createMockConnection() {
    return {
      client: {
        downloadFile: async () => ({ buffer: Buffer.from('file-content'), filename: 'report.pdf' }),
        replyStream: async () => {},
        replyStreamNonBlocking: async () => {},
        sendMessage: async (userId: string, body: any) => {
          sentMessages.push({ userId, body });
        },
      },
      workspaceId: 'ws-1',
      botId: 'bot-1',
      folderPath: tempDir,
      status: 'connected' as const,
    };
  }

  function makeFrame(msgtype: string, body: any) {
    return {
      headers: { req_id: 'req-1' },
      body: {
        msgid: 'msg-1',
        aibotid: 'bot-1',
        chattype: 'single',
        from: { userid: 'enc-user-1' },
        msgtype,
        ...body,
      },
    };
  }

  // Inject a connection into the service for testing
  function injectConnection(conn: any) {
    (service as any).connections.set('ws-1', conn);
  }

  it('handles file message: downloads, saves, pushes prompt (AE1)', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    workspaceStore.getWecomUserMapping = () => 'ZhangWei';

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    await (service as any).handleMediaMessage('ws-1', frame);

    // File should be saved
    const savedFile = path.join(tempDir, 'ZhangWei', 'report.pdf');
    const content = await fsPromises.readFile(savedFile);
    assert.deepStrictEqual(content, Buffer.from('file-content'));

    // Prompt should be pushed
    assert.strictEqual(pushedMessages.length, 1);
    assert.ok(pushedMessages[0].includes('@ZhangWei/report.pdf'));
    assert.ok(pushedMessages[0].includes('ZhangWei'));
    assert.ok(pushedMessages[0].includes('skill'));
  });

  it('handles file message with encrypted user ID (AE3)', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    // No plaintext mapping
    workspaceStore.getWecomUserMapping = () => null;

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    await (service as any).handleMediaMessage('ws-1', frame);

    const savedFile = path.join(tempDir, 'enc-user-1', 'report.pdf');
    const content = await fsPromises.readFile(savedFile);
    assert.deepStrictEqual(content, Buffer.from('file-content'));

    assert.strictEqual(pushedMessages.length, 1);
    assert.ok(pushedMessages[0].includes('@enc-user-1/report.pdf'));
  });

  it('handles image message: downloads and saves', async () => {
    const conn = createMockConnection();
    conn.client.downloadFile = async () => ({ buffer: Buffer.from('image-data'), filename: 'photo.png' });
    injectConnection(conn);

    const frame = makeFrame('image', {
      image: { url: 'https://example.com/img', aeskey: 'imgkey' },
    });

    await (service as any).handleMediaMessage('ws-1', frame);

    const savedFile = path.join(tempDir, 'enc-user-1', 'photo.png');
    const content = await fsPromises.readFile(savedFile);
    assert.deepStrictEqual(content, Buffer.from('image-data'));
    assert.strictEqual(pushedMessages.length, 1);
  });

  it('handles voice message as text-equivalent prompt', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    const frame = makeFrame('voice', {
      voice: { content: '你好世界' },
    });

    await (service as any).handleMediaMessage('ws-1', frame);

    // Voice should NOT trigger download — just push text prompt
    assert.strictEqual(pushedMessages.length, 1);
    assert.ok(pushedMessages[0].includes('voice message'));
    assert.ok(pushedMessages[0].includes('你好世界'));
    assert.ok(pushedMessages[0].includes('enc-user-1'));

    // No file should be saved
    const entries = await fsPromises.readdir(tempDir);
    assert.strictEqual(entries.length, 0);
  });

  it('handles download failure gracefully (AE4)', async () => {
    const conn = createMockConnection();
    conn.client.downloadFile = async () => { throw new Error('Download failed'); };
    injectConnection(conn);

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    // Should NOT throw
    await (service as any).handleMediaMessage('ws-1', frame);

    // No prompt should be pushed
    assert.strictEqual(pushedMessages.length, 0);

    // Error reply should be sent
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].userId, 'enc-user-1');
    assert.ok(sentMessages[0].body.markdown.content.includes('文件处理失败'));
  });

  it('handles file save failure gracefully', async () => {
    const conn = createMockConnection();
    // Make folderPath invalid to cause save failure
    conn.folderPath = '/nonexistent/path/that/cannot/be/written';
    injectConnection(conn);

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    await (service as any).handleMediaMessage('ws-1', frame);

    assert.strictEqual(pushedMessages.length, 0);
    assert.strictEqual(sentMessages.length, 1);
    assert.ok(sentMessages[0].body.markdown.content.includes('文件处理失败'));
  });

  it('handles session creation failure gracefully', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    chatService.createSession = async () => { throw new Error('DB error'); };
    workspaceStore.getWecomSession = () => null;

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    await (service as any).handleMediaMessage('ws-1', frame);

    assert.strictEqual(pushedMessages.length, 0);
    assert.strictEqual(sentMessages.length, 1);
  });

  it('uses fallback filename when SDK does not provide one', async () => {
    const conn = createMockConnection();
    conn.client.downloadFile = async () => ({ buffer: Buffer.from('data'), filename: undefined });
    injectConnection(conn);

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    await (service as any).handleMediaMessage('ws-1', frame);

    assert.strictEqual(pushedMessages.length, 1);
    // Should contain a fallback filename like file_<timestamp>.bin
    assert.ok(pushedMessages[0].includes('file_'));
    assert.ok(pushedMessages[0].includes('.bin'));
  });

  it('creates session for user with no prior session', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    let sessionCreated = false;
    workspaceStore.getWecomSession = () => null;
    workspaceStore.setWecomSession = () => { sessionCreated = true; };
    chatService.createSession = async () => ({ id: 'new-sess', workspaceId: 'ws-1' } as any);

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    await (service as any).handleMediaMessage('ws-1', frame);

    assert.ok(sessionCreated);
    assert.strictEqual(pushedMessages.length, 1);
  });

  it('uses custom file prompt template with $file_name$ substitution', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    workspaceStore.get = async () => ({
      id: 'ws-1',
      settings: { wecomFilePromptTemplate: 'Please summarize the file $file_name$' },
    } as any);

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    await (service as any).handleMediaMessage('ws-1', frame);

    assert.strictEqual(pushedMessages.length, 1);
    assert.strictEqual(pushedMessages[0], 'Please summarize the file enc-user-1/report.pdf');
  });

  it('falls back to default prompt when template is empty', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    workspaceStore.get = async () => ({
      id: 'ws-1',
      settings: { wecomFilePromptTemplate: '' },
    } as any);

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    await (service as any).handleMediaMessage('ws-1', frame);

    assert.strictEqual(pushedMessages.length, 1);
    assert.ok(pushedMessages[0].includes('a file named @enc-user-1/report.pdf'));
    assert.ok(pushedMessages[0].includes('skill'));
  });

  it('does not apply file prompt template to voice messages', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    workspaceStore.get = async () => ({
      id: 'ws-1',
      settings: { wecomFilePromptTemplate: 'Please summarize the file $file_name$' },
    } as any);

    const frame = makeFrame('voice', {
      voice: { content: '你好世界' },
    });

    await (service as any).handleMediaMessage('ws-1', frame);

    // Voice prompt should NOT use the file template
    assert.strictEqual(pushedMessages.length, 1);
    assert.ok(pushedMessages[0].includes('voice message'));
    assert.ok(!pushedMessages[0].includes('$file_name$'));
  });

  it('skips stream reply when Reply category is denied (R11/AE6: bot runs but cannot reply)', async () => {
    const conn = createMockConnection();
    let replyStreamCallCount = 0;
    conn.client.replyStream = async () => { replyStreamCallCount += 1; };
    conn.client.replyStreamNonBlocking = async () => { replyStreamCallCount += 1; };
    injectConnection(conn);

    // Policy denies Reply — bot will process but cannot respond
    workspaceStore.get = async () => ({
      id: 'ws-1',
      settings: {
        wecomBotEnabled: true,
        wecomToolPermissions: {
          posture: 'custom',
          categoryDefaults: {
            fileRead: 'allow',
            fileWrite: 'deny',
            shell: 'deny',
            network: 'deny',
            subagents: 'deny',
            reply: 'deny',
          },
        },
      },
    } as any);

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    await (service as any).handleMediaMessage('ws-1', frame);

    // Agent still runs (pushMessage called)
    assert.strictEqual(pushedMessages.length, 1);
    // But no reply stream frames are sent (no placeholder, no animation, no leak)
    assert.strictEqual(replyStreamCallCount, 0, 'Reply-deny must skip createStreamReply entirely');
  });

  it('creates stream reply normally when Reply is allowed (default)', async () => {
    const conn = createMockConnection();
    let replyStreamCallCount = 0;
    conn.client.replyStream = async () => { replyStreamCallCount += 1; };
    injectConnection(conn);

    // Default policy (no explicit wecomToolPermissions, bot enabled) → allow-all → Reply allowed
    workspaceStore.get = async () => ({
      id: 'ws-1',
      settings: { wecomBotEnabled: true },
    } as any);

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    await (service as any).handleMediaMessage('ws-1', frame);

    // Agent runs
    assert.strictEqual(pushedMessages.length, 1);
    // Stream reply IS created (placeholder frame is sent)
    assert.ok(replyStreamCallCount > 0, 'Reply-allow must construct the stream reply');
  });
});