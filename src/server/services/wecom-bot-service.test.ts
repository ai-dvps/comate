import '../test-utils/test-env.js';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WeComBotService, parseWecomNewSessionCommand } from './wecom-bot-service.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import { encodeButtonKey } from './wecom-template-card.js';

describe('WeComBotService handleMediaMessage', { concurrency: false }, () => {
  let service: WeComBotService;
  let tempDir: string;

  // Saved originals for restoration
  let origGetActiveWecomSession: typeof workspaceStore.getActiveWecomSession;
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

    origGetActiveWecomSession = workspaceStore.getActiveWecomSession.bind(workspaceStore);
    origSetWecomSession = workspaceStore.setWecomSession.bind(workspaceStore);
    origGetWecomUserMapping = workspaceStore.getWecomUserMapping.bind(workspaceStore);
    origGet = workspaceStore.get.bind(workspaceStore);
    origGetSession = chatService.getSession.bind(chatService);
    origCreateSession = chatService.createSession.bind(chatService);
    origGetOrCreateRuntime = chatService.getOrCreateRuntime.bind(chatService);

    // Default: no existing session
    workspaceStore.getActiveWecomSession = () => null;
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
    workspaceStore.getActiveWecomSession = origGetActiveWecomSession;
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
    const savedFile = path.join(tempDir, 'data', 'ZhangWei', 'report.pdf');
    const content = await fsPromises.readFile(savedFile);
    assert.deepStrictEqual(content, Buffer.from('file-content'));

    // Prompt should be pushed
    assert.strictEqual(pushedMessages.length, 1);
    assert.ok(pushedMessages[0].includes('@data/ZhangWei/report.pdf'));
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

    const savedFile = path.join(tempDir, 'data', 'enc-user-1', 'report.pdf');
    const content = await fsPromises.readFile(savedFile);
    assert.deepStrictEqual(content, Buffer.from('file-content'));

    assert.strictEqual(pushedMessages.length, 1);
    assert.ok(pushedMessages[0].includes('@data/enc-user-1/report.pdf'));
  });

  it('handles image message: downloads and saves', async () => {
    const conn = createMockConnection();
    conn.client.downloadFile = async () => ({ buffer: Buffer.from('image-data'), filename: 'photo.png' });
    injectConnection(conn);

    const frame = makeFrame('image', {
      image: { url: 'https://example.com/img', aeskey: 'imgkey' },
    });

    await (service as any).handleMediaMessage('ws-1', frame);

    const savedFile = path.join(tempDir, 'data', 'enc-user-1', 'photo.png');
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
    workspaceStore.getActiveWecomSession = () => null;

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
    workspaceStore.getActiveWecomSession = () => null;
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
    assert.strictEqual(pushedMessages[0], 'Please summarize the file data/enc-user-1/report.pdf');
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
    assert.ok(pushedMessages[0].includes('a file named @data/enc-user-1/report.pdf'));
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

describe('WeComBotService template card events', { concurrency: false }, () => {
  let service: WeComBotService;
  let tempDir: string;

  let origGetWecomUserIdBySession: typeof workspaceStore.getWecomUserIdBySession;
  let origGetRuntimeIfExists: typeof chatService.getRuntimeIfExists;

  let resolvedApprovals: Array<{ requestId: string; result: any }>;
  let updatedCards: Array<{ frame: any; card: any }>;
  let pendingCardState: any;

  beforeEach(async () => {
    service = new WeComBotService();
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'wecom-card-test-'));

    origGetWecomUserIdBySession = workspaceStore.getWecomUserIdBySession.bind(workspaceStore);
    origGetRuntimeIfExists = chatService.getRuntimeIfExists.bind(chatService);

    resolvedApprovals = [];
    updatedCards = [];
    pendingCardState = { type: 'approval', suggestions: [{ id: 'suggestion-1' }] };

    workspaceStore.getWecomUserIdBySession = () => 'owner-1';

    chatService.getRuntimeIfExists = () => ({
      getPendingCardState: () => pendingCardState,
      resolveApproval: (requestId: string, result: any) => {
        resolvedApprovals.push({ requestId, result });
      },
    } as any);
  });

  afterEach(async () => {
    workspaceStore.getWecomUserIdBySession = origGetWecomUserIdBySession;
    chatService.getRuntimeIfExists = origGetRuntimeIfExists;
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  function createMockConnection() {
    return {
      client: {
        replyStream: async () => {},
        replyStreamNonBlocking: async () => {},
        sendMessage: async () => {},
        updateTemplateCard: async (frame: any, card: any) => {
          updatedCards.push({ frame, card });
        },
      },
      workspaceId: 'ws-1',
      botId: 'bot-1',
      folderPath: tempDir,
      status: 'connected' as const,
    };
  }

  function injectConnection(conn: any) {
    (service as any).connections.set('ws-1', conn);
  }

  function makeCardEvent(key: string, extras: any = {}) {
    const rawSelectedItems = extras.event?.selected_items;
    const normalizedSelectedItems = rawSelectedItems
      ? { selected_item: rawSelectedItems.map((item: any) => ({
          question_key: item.question_key,
          option_ids: { option_id: item.option_ids },
        })) }
      : undefined;
    return {
      headers: { req_id: 'req-1' },
      body: {
        msgid: 'msg-1',
        aibotid: 'bot-1',
        chattype: 'single',
        from: { userid: extras.userid ?? 'owner-1' },
        msgtype: 'event',
        event: {
          eventtype: 'template_card_event',
          template_card_event: {
            event_key: key,
            task_id: 'task-1',
            card_type: 'button_interaction',
            ...extras.event,
            ...(normalizedSelectedItems ? { selected_items: normalizedSelectedItems } : {}),
          },
        },
      },
    };
  }

  it('sends a template card via sendTemplateCard', async () => {
    const conn = createMockConnection();
    const sentMessages: Array<{ userId: string; body: any }> = [];
    conn.client.sendMessage = async (userId: string, body: any) => {
      sentMessages.push({ userId, body });
    };
    injectConnection(conn);

    await service.sendTemplateCard('ws-1', 'owner-1', {
      card_type: 'text_notice',
      main_title: { title: 'Test', desc: 'Desc' },
    } as any);

    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].userId, 'owner-1');
    assert.strictEqual(sentMessages[0].body.msgtype, 'template_card');
    assert.strictEqual(sentMessages[0].body.template_card.card_type, 'text_notice');
  });

  it('resolves approval when user clicks allow', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    const key = encodeButtonKey('req-1', 'allow', 'sess-1');
    await (service as any).handleTemplateCardEvent('ws-1', makeCardEvent(key));

    assert.strictEqual(resolvedApprovals.length, 1);
    assert.strictEqual(resolvedApprovals[0].requestId, 'req-1');
    assert.strictEqual(resolvedApprovals[0].result.behavior, 'allow');
    assert.strictEqual(resolvedApprovals[0].result.updatedPermissions, undefined);
    assert.strictEqual(updatedCards.length, 1);
    assert.strictEqual(updatedCards[0].card.card_type, 'text_notice');
    assert.strictEqual(updatedCards[0].card.main_title.desc, '已允许');
  });

  it('resolves approval when user clicks always_allow with suggestions', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    const key = encodeButtonKey('req-1', 'always_allow', 'sess-1');
    await (service as any).handleTemplateCardEvent('ws-1', makeCardEvent(key));

    assert.strictEqual(resolvedApprovals.length, 1);
    assert.strictEqual(resolvedApprovals[0].result.behavior, 'allow');
    assert.deepStrictEqual(resolvedApprovals[0].result.updatedPermissions, [{ id: 'suggestion-1' }]);
    assert.strictEqual(updatedCards[0].card.main_title.desc, '已始终允许');
  });

  it('resolves approval when user clicks deny', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    const key = encodeButtonKey('req-1', 'deny', 'sess-1');
    await (service as any).handleTemplateCardEvent('ws-1', makeCardEvent(key));

    assert.strictEqual(resolvedApprovals.length, 1);
    assert.strictEqual(resolvedApprovals[0].result.behavior, 'deny');
    assert.strictEqual(updatedCards[0].card.main_title.desc, '已拒绝');
  });

  it('ignores clicks from a non-owner user and updates card', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    const key = encodeButtonKey('req-1', 'allow', 'sess-1');
    await (service as any).handleTemplateCardEvent(
      'ws-1',
      makeCardEvent(key, { userid: 'attacker-1' }),
    );

    assert.strictEqual(resolvedApprovals.length, 0);
    assert.strictEqual(updatedCards.length, 1);
    assert.strictEqual(updatedCards[0].card.main_title.desc, '无法操作该会话');
  });

  it('updates card to terminal state when pending approval is missing', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    pendingCardState = undefined;

    const key = encodeButtonKey('req-1', 'allow', 'sess-1');
    await (service as any).handleTemplateCardEvent('ws-1', makeCardEvent(key));

    assert.strictEqual(resolvedApprovals.length, 0);
    assert.strictEqual(updatedCards.length, 1);
    assert.strictEqual(updatedCards[0].card.main_title.desc, '该请求已过期或已处理');
  });

  it('ignores non-Comate keys silently', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    await (service as any).handleTemplateCardEvent('ws-1', makeCardEvent('some-random-key'));

    assert.strictEqual(resolvedApprovals.length, 0);
    assert.strictEqual(updatedCards.length, 0);
  });

  it('resolves question when user submits an answer', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    pendingCardState = {
      type: 'question',
      questions: [
        {
          question: 'Choose one',
          options: [{ label: 'A' }, { label: 'B' }],
          multiSelect: false,
        },
      ],
    };

    const key = encodeButtonKey('req-1', 'allow', 'sess-1');
    await (service as any).handleTemplateCardEvent(
      'ws-1',
      makeCardEvent(key, {
        event: {
          selected_items: [
            { question_key: encodeButtonKey('req-1', 'allow', 'sess-1'), option_ids: ['1'] },
          ],
        },
      }),
    );

    assert.strictEqual(resolvedApprovals.length, 1);
    assert.strictEqual(resolvedApprovals[0].result.behavior, 'allow');
    assert.deepStrictEqual(resolvedApprovals[0].result.updatedInput, {
      questions: pendingCardState.questions,
      answers: { 'Choose one': 'B' },
    });
    assert.strictEqual(updatedCards[0].card.main_title.desc, '已提交');
  });

  it('resolves multiple questions from a multiple_interaction card', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    pendingCardState = {
      type: 'question',
      questions: [
        { question: 'Q1', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false },
        { question: 'Q2', options: [{ label: 'C' }, { label: 'D' }], multiSelect: false },
      ],
    };

    const key = encodeButtonKey('req-1', 'allow', 'sess-1');
    await (service as any).handleTemplateCardEvent(
      'ws-1',
      makeCardEvent(key, {
        event: {
          selected_items: [
            { question_key: encodeButtonKey('req-1:0', 'allow', 'sess-1'), option_ids: ['0'] },
            { question_key: encodeButtonKey('req-1:1', 'allow', 'sess-1'), option_ids: ['1'] },
          ],
        },
      }),
    );

    assert.deepStrictEqual(resolvedApprovals[0].result.updatedInput.answers, {
      Q1: 'A',
      Q2: 'D',
    });
  });

  it('joins multi-select options with a comma', async () => {
    const conn = createMockConnection();
    injectConnection(conn);

    pendingCardState = {
      type: 'question',
      questions: [
        {
          question: 'Pick all that apply',
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
          multiSelect: true,
        },
      ],
    };

    const key = encodeButtonKey('req-1', 'allow', 'sess-1');
    await (service as any).handleTemplateCardEvent(
      'ws-1',
      makeCardEvent(key, {
        event: {
          selected_items: [
            { question_key: encodeButtonKey('req-1', 'allow', 'sess-1'), option_ids: ['0', '2'] },
          ],
        },
      }),
    );

    assert.deepStrictEqual(resolvedApprovals[0].result.updatedInput.answers, {
      'Pick all that apply': 'A, C',
    });
  });
});

describe('parseWecomNewSessionCommand', () => {
  it('matches exact /new and /clear with no title', () => {
    assert.deepStrictEqual(parseWecomNewSessionCommand('/new'), { isCommand: true, title: '' });
    assert.deepStrictEqual(parseWecomNewSessionCommand('/clear'), { isCommand: true, title: '' });
  });

  it('matches /new and /clear with a title', () => {
    assert.deepStrictEqual(parseWecomNewSessionCommand('/new 项目X'), { isCommand: true, title: '项目X' });
    assert.deepStrictEqual(parseWecomNewSessionCommand('/clear Project X'), { isCommand: true, title: 'Project X' });
  });

  it('does not trigger on /newer or /clearx (prefix without trailing space)', () => {
    assert.deepStrictEqual(parseWecomNewSessionCommand('/newer'), { isCommand: false, title: '' });
    assert.deepStrictEqual(parseWecomNewSessionCommand('/clearx'), { isCommand: false, title: '' });
  });

  it('does not trigger on plain text', () => {
    assert.deepStrictEqual(parseWecomNewSessionCommand('hello world'), { isCommand: false, title: '' });
  });

  it('trims a leading space before the command and extra spaces around the title', () => {
    assert.deepStrictEqual(parseWecomNewSessionCommand('  /new   Project X  '), { isCommand: true, title: 'Project X' });
  });
});

describe('WeComBotService /clear & /new commands + active lookup', { concurrency: false }, () => {
  let service: WeComBotService;
  let sentMessages: Array<{ userId: string; content: string }>;
  let pushedContents: string[];
  let createdSessions: Array<{ name: string; customTitle?: string }>;
  let activatedSessionIds: string[];

  let origGetActive: typeof workspaceStore.getActiveWecomSession;
  let origSet: typeof workspaceStore.setWecomSession;
  let origSetActive: typeof workspaceStore.setActiveWecomSession;
  let origGetMapping: typeof workspaceStore.getWecomUserMapping;
  let origCreate: typeof chatService.createSession;
  let origGetSession: typeof chatService.getSession;
  let origPush: typeof chatService.pushMessage;

  beforeEach(() => {
    service = new WeComBotService();
    sentMessages = [];
    pushedContents = [];
    createdSessions = [];
    activatedSessionIds = [];

    origGetActive = workspaceStore.getActiveWecomSession.bind(workspaceStore);
    origSet = workspaceStore.setWecomSession.bind(workspaceStore);
    origSetActive = workspaceStore.setActiveWecomSession.bind(workspaceStore);
    origGetMapping = workspaceStore.getWecomUserMapping.bind(workspaceStore);
    origCreate = chatService.createSession.bind(chatService);
    origGetSession = chatService.getSession.bind(chatService);
    origPush = chatService.pushMessage.bind(chatService);

    workspaceStore.getActiveWecomSession = () => null;
    workspaceStore.setWecomSession = () => {};
    workspaceStore.setActiveWecomSession = (_ws, _u, sid) => {
      activatedSessionIds.push(sid);
    };
    workspaceStore.getWecomUserMapping = () => null;
    chatService.createSession = async (input) => {
      createdSessions.push({ name: input.name, customTitle: input.customTitle });
      return { id: `sess-${createdSessions.length}`, workspaceId: input.workspaceId } as any;
    };
    chatService.getSession = async () => ({ id: 'sess-1', workspaceId: 'ws-1' } as any);
    chatService.pushMessage = (async (...args: unknown[]) => {
      pushedContents.push(args[2] as string);
    }) as any;
  });

  afterEach(() => {
    workspaceStore.getActiveWecomSession = origGetActive;
    workspaceStore.setWecomSession = origSet;
    workspaceStore.setActiveWecomSession = origSetActive;
    workspaceStore.getWecomUserMapping = origGetMapping;
    chatService.createSession = origCreate;
    chatService.getSession = origGetSession;
    chatService.pushMessage = origPush;
  });

  function injectConnection() {
    (service as any).connections.set('ws-1', {
      client: {
        sendMessage: async (userId: string, body: any) => {
          sentMessages.push({ userId, content: body.markdown.content });
        },
      },
      workspaceId: 'ws-1',
      botId: 'bot-1',
      folderPath: '/tmp',
      status: 'connected' as const,
    });
  }

  function makeTextFrame(content: string) {
    return {
      headers: { req_id: 'r' },
      body: {
        msgid: 'm',
        aibotid: 'bot-1',
        chattype: 'single',
        from: { userid: 'enc-user-1' },
        msgtype: 'text',
        text: { content },
      },
    };
  }

  it('/new with title creates, activates, replies with the title, and does not forward to agent (AE1)', async () => {
    injectConnection();
    await (service as any).handleTextMessage('ws-1', makeTextFrame('/new 项目X'));
    assert.strictEqual(createdSessions.length, 1);
    assert.strictEqual(createdSessions[0].name, '项目X');
    assert.strictEqual(createdSessions[0].customTitle, '项目X');
    assert.strictEqual(activatedSessionIds.length, 1);
    assert.strictEqual(sentMessages.length, 1);
    assert.ok(sentMessages[0].content.includes('项目X'));
    assert.strictEqual(pushedContents.length, 0);
  });

  it('/clear is an alias of /new (AE2)', async () => {
    injectConnection();
    await (service as any).handleTextMessage('ws-1', makeTextFrame('/clear 项目X'));
    assert.strictEqual(createdSessions.length, 1);
    assert.strictEqual(createdSessions[0].name, '项目X');
    assert.strictEqual(pushedContents.length, 0);
  });

  it('/new with no title uses the default name and leaves customTitle unset (AE3)', async () => {
    injectConnection();
    await (service as any).handleTextMessage('ws-1', makeTextFrame('/new'));
    assert.strictEqual(createdSessions.length, 1);
    assert.strictEqual(createdSessions[0].name, 'enc-user-1');
    assert.strictEqual(createdSessions[0].customTitle, undefined);
    assert.ok(sentMessages[0].content.includes('enc-user-1'));
  });

  it('/newer does not trigger a command (no session created)', async () => {
    injectConnection();
    workspaceStore.getActiveWecomSession = () => 'sess-existing';
    await (service as any).handleTextMessage('ws-1', makeTextFrame('/newer idea'));
    assert.strictEqual(createdSessions.length, 0);
  });

  it('getOrCreateSession reuses the active session when one exists (R6)', async () => {
    workspaceStore.getActiveWecomSession = () => 'sess-active';
    chatService.getSession = async () => ({ id: 'sess-active', workspaceId: 'ws-1' } as any);
    const id = await (service as any).getOrCreateSession('ws-1', 'user-a');
    assert.strictEqual(id, 'sess-active');
    assert.strictEqual(createdSessions.length, 0);
  });

  it('getOrCreateSession creates and activates a fresh session when none is active (R8)', async () => {
    workspaceStore.getActiveWecomSession = () => null;
    const id = await (service as any).getOrCreateSession('ws-1', 'user-a');
    assert.strictEqual(createdSessions.length, 1);
    assert.strictEqual(activatedSessionIds.length, 1);
    assert.strictEqual(id, activatedSessionIds[0]);
  });
});