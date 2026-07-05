import '../test-utils/test-env.js';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  WeComBotService,
  parseWecomNewSessionCommand,
  parseWecomResumeCommand,
  parseWecomStopCommand,
  parseWecomStatusCommand,
  parseWecomWorkspaceCommand,
} from './wecom-bot-service.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import { botService } from './bot-service.js';
import { encodeButtonKey } from './wecom-template-card.js';

function collectDiagLogs(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalSidecar = process.env.COMATE_SIDECAR;
  process.env.COMATE_SIDECAR = '';
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  return {
    logs,
    restore: () => {
      console.log = originalLog;
      process.env.COMATE_SIDECAR = originalSidecar;
    },
  };
}

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
    pendingCardState = { type: 'approval', toolName: 'Bash', toolUseId: 'tu-deny-1', suggestions: [{ id: 'suggestion-1' }] };

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
    const { logs, restore } = collectDiagLogs();
    try {
      await (service as any).handleTemplateCardEvent('ws-1', makeCardEvent(key));
    } finally {
      restore();
    }

    assert.strictEqual(resolvedApprovals.length, 1);
    assert.strictEqual(resolvedApprovals[0].result.behavior, 'deny');
    assert.strictEqual(updatedCards[0].card.main_title.desc, '已拒绝');
    assert.ok(
      logs.some((line) =>
        line.includes('reason=user-deny') &&
        line.includes('tool=Bash') &&
        line.includes('toolUseId=tu-deny-1') &&
        line.includes('requestId=req-1') &&
        line.includes('sessionId=sess-1') &&
        line.includes('workspaceId=ws-1'),
      ),
      'expected user-deny reason to be logged with correlators',
    );
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

describe('parseWecomResumeCommand', () => {
  it('matches exact /resume and /resume with trailing text (ignored)', () => {
    assert.strictEqual(parseWecomResumeCommand('/resume'), true);
    assert.strictEqual(parseWecomResumeCommand('/resume 项目X'), true);
    assert.strictEqual(parseWecomResumeCommand('  /resume   '), true);
  });

  it('does not trigger on /resumex or plain text', () => {
    assert.strictEqual(parseWecomResumeCommand('/resumex'), false);
    assert.strictEqual(parseWecomResumeCommand('/resumes'), false);
    assert.strictEqual(parseWecomResumeCommand('hello'), false);
  });
});

describe('WeComBotService /resume command', { concurrency: false }, () => {
  let service: WeComBotService;
  let sentBodies: Array<{ msgtype: string; [k: string]: unknown }>;
  let pushedContents: string[];

  let origGetActive: typeof workspaceStore.getActiveWecomSession;
  let origListByUser: typeof workspaceStore.listWecomSessionsByUser;
  let origGetSession: typeof chatService.getSession;
  let origPush: typeof chatService.pushMessage;

  beforeEach(() => {
    service = new WeComBotService();
    sentBodies = [];
    pushedContents = [];

    origGetActive = workspaceStore.getActiveWecomSession.bind(workspaceStore);
    origListByUser = workspaceStore.listWecomSessionsByUser.bind(workspaceStore);
    origGetSession = chatService.getSession.bind(chatService);
    origPush = chatService.pushMessage.bind(chatService);

    workspaceStore.getActiveWecomSession = () => 'sess-active';
    workspaceStore.listWecomSessionsByUser = () => [];
    chatService.getSession = async () => ({ id: 'sess-1', workspaceId: 'ws-1' } as any);
    chatService.pushMessage = (async (...args: unknown[]) => {
      pushedContents.push(args[2] as string);
    }) as any;
  });

  afterEach(() => {
    workspaceStore.getActiveWecomSession = origGetActive;
    workspaceStore.listWecomSessionsByUser = origListByUser;
    chatService.getSession = origGetSession;
    chatService.pushMessage = origPush;
  });

  function injectConnection() {
    (service as any).connections.set('ws-1', {
      client: {
        sendMessage: async (_userId: string, body: any) => {
          sentBodies.push(body);
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

  function lastBody() {
    return sentBodies[sentBodies.length - 1];
  }
  function lastCard() {
    return (lastBody() as any)?.template_card;
  }

  it('/resume is intercepted and not forwarded to the agent (Covers AE4)', async () => {
    injectConnection();
    workspaceStore.listWecomSessionsByUser = () => [
      { sessionId: 'sess-a', createdAt: '2026-06-01T00:00:00.000Z' },
    ];
    await (service as any).handleTextMessage('ws-1', makeTextFrame('/resume'));
    assert.strictEqual(pushedContents.length, 0);
    assert.strictEqual(lastBody().msgtype, 'template_card');
  });

  it('card lists sessions with option id = sessionId and marks active (Covers AE5)', async () => {
    injectConnection();
    workspaceStore.listWecomSessionsByUser = () => [
      { sessionId: 'sess-a', createdAt: '2026-06-01T00:00:00.000Z' },
      { sessionId: 'sess-active', createdAt: '2026-06-02T00:00:00.000Z' },
    ];
    let calls = 0;
    chatService.getSession = async (id: string) => ({
      id,
      workspaceId: 'ws-1',
      name: id,
      updatedAt: `2026-06-0${++calls}T00:00:00.000Z`,
    } as any);
    await (service as any).handleTextMessage('ws-1', makeTextFrame('/resume'));
    const card = lastCard();
    assert.ok(card);
    assert.strictEqual(card.card_type, 'multiple_interaction');
    const selector = card.select_list[0];
    const ids = selector.option_list.map((o: any) => o.id);
    assert.deepStrictEqual(ids.sort(), ['sess-a', 'sess-active']);
    const activeOpt = selector.option_list.find((o: any) => o.id === 'sess-active');
    assert.ok(activeOpt?.text.includes('（当前）'));
  });

  it('excludes archived sessions and degrades to a text reply when none remain', async () => {
    injectConnection();
    workspaceStore.listWecomSessionsByUser = () => [
      { sessionId: 'sess-archived', createdAt: '2026-06-01T00:00:00.000Z' },
    ];
    chatService.getSession = async () => ({
      id: 'sess-archived',
      isArchived: true,
      updatedAt: '2026-06-01T00:00:00.000Z',
    } as any);
    await (service as any).handleTextMessage('ws-1', makeTextFrame('/resume'));
    assert.strictEqual(lastBody().msgtype, 'markdown');
    assert.ok((lastBody() as any).markdown.content.includes('暂无会话可恢复'));
  });

  it('truncates to the cap when over N (Covers AE3/F4)', async () => {
    injectConnection();
    workspaceStore.listWecomSessionsByUser = () =>
      Array.from({ length: 12 }, (_, i) => ({
        sessionId: `s${i}`,
        createdAt: '2026-06-01T00:00:00.000Z',
      }));
    workspaceStore.getActiveWecomSession = () => null;
    chatService.getSession = async (id: string) => ({
      id,
      workspaceId: 'ws-1',
      name: id,
      updatedAt: `2026-06-${20 - Number(id.slice(1))}T00:00:00.000Z`,
    } as any);
    await (service as any).handleTextMessage('ws-1', makeTextFrame('/resume'));
    assert.strictEqual(lastCard().select_list[0].option_list.length, 10);
  });

  it('still sends a card with a single session (Covers AE2/F3)', async () => {
    injectConnection();
    workspaceStore.listWecomSessionsByUser = () => [
      { sessionId: 'sess-only', createdAt: '2026-06-01T00:00:00.000Z' },
    ];
    workspaceStore.getActiveWecomSession = () => 'sess-only';
    chatService.getSession = async () => ({
      id: 'sess-only',
      workspaceId: 'ws-1',
      name: 'only',
      updatedAt: '2026-06-01T00:00:00.000Z',
    } as any);
    await (service as any).handleTextMessage('ws-1', makeTextFrame('/resume'));
    assert.strictEqual(lastCard().select_list[0].option_list.length, 1);
  });

  it('ignores trailing text after /resume (R2)', async () => {
    injectConnection();
    workspaceStore.listWecomSessionsByUser = () => [
      { sessionId: 'sess-a', createdAt: '2026-06-01T00:00:00.000Z' },
    ];
    chatService.getSession = async () => ({
      id: 'sess-a',
      workspaceId: 'ws-1',
      name: 'a',
      updatedAt: '2026-06-01T00:00:00.000Z',
    } as any);
    await (service as any).handleTextMessage('ws-1', makeTextFrame('/resume ignored args'));
    assert.strictEqual(pushedContents.length, 0);
    assert.strictEqual(lastBody().msgtype, 'template_card');
  });
});

describe('WeComBotService /resume submit (stateless switch)', { concurrency: false }, () => {
  let service: WeComBotService;
  let tempDir: string;
  let origGetOwner: typeof workspaceStore.getWecomUserIdBySession;
  let origSetActive: typeof workspaceStore.setActiveWecomSession;
  let origGetSession: typeof chatService.getSession;
  let switchedTo: Array<{ wecomUserId: string; sessionId: string }>;
  let sentMessages: Array<{ userId: string; content: string }>;
  let updatedCards: Array<{ card: any }>;
  let ownerBySession: (ws: string, sess: string) => string | null;

  beforeEach(async () => {
    service = new WeComBotService();
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'wecom-resume-submit-'));
    switchedTo = [];
    sentMessages = [];
    updatedCards = [];
    ownerBySession = () => 'owner-1';

    origGetOwner = workspaceStore.getWecomUserIdBySession.bind(workspaceStore);
    origSetActive = workspaceStore.setActiveWecomSession.bind(workspaceStore);
    origGetSession = chatService.getSession.bind(chatService);

    workspaceStore.getWecomUserIdBySession = (ws: string, sess: string) => ownerBySession(ws, sess);
    workspaceStore.setActiveWecomSession = (_ws: string, u: string, sid: string) => {
      switchedTo.push({ wecomUserId: u, sessionId: sid });
    };
    chatService.getSession = async (id: string) =>
      ({ id, workspaceId: 'ws-1', name: `name-${id}`, updatedAt: '2026-06-01T00:00:00.000Z' } as any);
  });

  afterEach(async () => {
    workspaceStore.getWecomUserIdBySession = origGetOwner;
    workspaceStore.setActiveWecomSession = origSetActive;
    chatService.getSession = origGetSession;
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  function inject() {
    (service as any).connections.set('ws-1', {
      client: {
        sendMessage: async (userId: string, body: any) => {
          sentMessages.push({ userId, content: body.markdown?.content ?? '' });
        },
        updateTemplateCard: async (_frame: any, card: any) => {
          updatedCards.push({ card });
        },
      },
      workspaceId: 'ws-1',
      botId: 'bot-1',
      folderPath: tempDir,
      status: 'connected' as const,
    });
  }

  function makeResumeEvent(sourceSessionId: string, targetSessionId: string, userid = 'owner-1') {
    const key = encodeButtonKey('req-resume', 'resume', sourceSessionId);
    return {
      headers: { req_id: 'r' },
      body: {
        msgid: 'm',
        aibotid: 'bot-1',
        chattype: 'single',
        from: { userid },
        msgtype: 'event',
        event: {
          eventtype: 'template_card_event',
          template_card_event: {
            event_key: key,
            task_id: 'task-1',
            card_type: 'multiple_interaction',
            selected_items: {
              selected_item: [{ question_key: key, option_ids: { option_id: [targetSessionId] } }],
            },
          },
        },
      },
    };
  }

  it('switches active session to the selected target and confirms (Covers AE1/F1)', async () => {
    inject();
    await (service as any).handleTemplateCardEvent('ws-1', makeResumeEvent('sess-source', 'sess-target'));
    assert.strictEqual(switchedTo.length, 1);
    assert.strictEqual(switchedTo[0].sessionId, 'sess-target');
    assert.strictEqual(updatedCards[0].card.replace_text, '已恢复会话');
    assert.strictEqual(updatedCards[0].card.submit_button?.text, '已恢复会话');
    assert.ok(sentMessages.some((m) => m.content.includes('name-sess-target')));
  });

  it('rejects when the target session is not owned by the submitter (Covers AE6/R12)', async () => {
    inject();
    ownerBySession = (_ws, sess) => (sess === 'sess-source' ? 'owner-1' : 'owner-other');
    await (service as any).handleTemplateCardEvent('ws-1', makeResumeEvent('sess-source', 'sess-target'));
    assert.strictEqual(switchedTo.length, 0);
    assert.strictEqual(updatedCards[0].card.replace_text, '无法操作该会话');
    assert.strictEqual(updatedCards[0].card.submit_button?.text, '无法操作该会话');
    assert.strictEqual(sentMessages.length, 0);
  });

  it('rejects when the selected option id is missing (Covers AE6/R12)', async () => {
    inject();
    const key = encodeButtonKey('req-resume', 'resume', 'sess-source');
    const frame = {
      headers: { req_id: 'r' },
      body: {
        msgid: 'm',
        aibotid: 'bot-1',
        chattype: 'single',
        from: { userid: 'owner-1' },
        msgtype: 'event',
        event: {
          eventtype: 'template_card_event',
          template_card_event: { event_key: key, task_id: 'task-1', card_type: 'multiple_interaction' },
        },
      },
    };
    await (service as any).handleTemplateCardEvent('ws-1', frame);
    assert.strictEqual(switchedTo.length, 0);
    assert.strictEqual(updatedCards[0].card.replace_text, '无法操作该会话');
  });

  it('a repeat submit is handled without error (idempotent at the store layer)', async () => {
    inject();
    await (service as any).handleTemplateCardEvent('ws-1', makeResumeEvent('sess-source', 'sess-target'));
    // Clear the per-user rate-limit window so the second event is processed.
    (service as any).cardClickRateLimit.clear();
    await (service as any).handleTemplateCardEvent('ws-1', makeResumeEvent('sess-source', 'sess-target'));
    assert.strictEqual(switchedTo.length, 2);
    assert.strictEqual(switchedTo[1].sessionId, 'sess-target');
    assert.strictEqual(updatedCards[1].card.replace_text, '已恢复会话');
    assert.strictEqual(updatedCards[1].card.submit_button?.text, '已恢复会话');
  });

  it('updates the card to terminal BEFORE sending the confirmation (WeCom 5s update window)', async () => {
    // WeCom only honors a card-update response within ~5s of the template_card_event.
    // The update must therefore precede any slow I/O (getSession / sendMessage).
    const calls: string[] = [];
    (service as any).connections.set('ws-1', {
      client: {
        sendMessage: async () => {
          calls.push('send');
        },
        updateTemplateCard: async () => {
          calls.push('update');
        },
      },
      workspaceId: 'ws-1',
      botId: 'bot-1',
      folderPath: tempDir,
      status: 'connected' as const,
    });

    await (service as any).handleTemplateCardEvent('ws-1', makeResumeEvent('sess-source', 'sess-target'));

    const updateIdx = calls.indexOf('update');
    const sendIdx = calls.indexOf('send');
    assert.notStrictEqual(updateIdx, -1, 'updateTemplateCard must be called');
    assert.notStrictEqual(sendIdx, -1, 'sendMessage must be called');
    assert.ok(
      updateIdx < sendIdx,
      `card update must precede confirmation send; order was: ${calls.join(' -> ')}`,
    );
  });
});

describe('WeComBotService /stop command', { concurrency: false }, () => {
  let service: WeComBotService;
  let sentMessages: Array<{ userId: string; body: any }>;
  let interruptCalls: string[];
  let cancelPendingApprovalsCalls: string[];
  let streamReplyInterruptCalls: Array<{ sessionId: string; message: string }>;

  let origGetActiveWecomSession: typeof workspaceStore.getActiveWecomSession;
  let origGetRuntimeIfExists: typeof chatService.getRuntimeIfExists;

  beforeEach(() => {
    service = new WeComBotService();
    sentMessages = [];
    interruptCalls = [];
    cancelPendingApprovalsCalls = [];
    streamReplyInterruptCalls = [];

    origGetActiveWecomSession = workspaceStore.getActiveWecomSession.bind(workspaceStore);
    origGetRuntimeIfExists = chatService.getRuntimeIfExists.bind(chatService);

    workspaceStore.getActiveWecomSession = () => null;
    chatService.getRuntimeIfExists = () => undefined;
  });

  afterEach(() => {
    workspaceStore.getActiveWecomSession = origGetActiveWecomSession;
    chatService.getRuntimeIfExists = origGetRuntimeIfExists;
  });

  function createMockConnection() {
    return {
      client: {
        replyStream: async () => {},
        replyStreamNonBlocking: async () => {},
        sendMessage: async (userId: string, body: any) => {
          sentMessages.push({ userId, body });
        },
      },
      workspaceId: 'ws-1',
      botId: 'bot-1',
      folderPath: '/tmp',
      status: 'connected' as const,
    };
  }

  function injectConnection(conn: any) {
    (service as any).connections.set('ws-1', conn);
  }

  function makeTextFrame(content: string) {
    return {
      headers: { req_id: 'req-1' },
      body: {
        msgid: 'msg-1',
        aibotid: 'bot-1',
        chattype: 'single',
        from: { userid: 'enc-user-1' },
        msgtype: 'text',
        text: { content },
      },
    };
  }

  function injectStreamReply(sessionId: string, returnValue: boolean) {
    (service as any).activeStreamReplies.set(sessionId, {
      interrupt: (message: string) => {
        streamReplyInterruptCalls.push({ sessionId, message });
        return returnValue;
      },
    });
  }

  function setRuntime(processing: boolean, failInterrupt = false) {
    chatService.getRuntimeIfExists = () =>
      ({
        isProcessingTurn: () => processing,
        interrupt: async () => {
          interruptCalls.push('interrupt');
          if (failInterrupt) throw new Error('interrupt failed');
        },
        cancelPendingApprovals: (message?: string) => {
          cancelPendingApprovalsCalls.push(message ?? '');
        },
      }) as any;
  }

  it('recognizes exact /stop as a command (U1)', () => {
    assert.ok(parseWecomStopCommand('/stop'));
    assert.ok(parseWecomStopCommand('  /stop  '));
  });

  it('recognizes /stop with trailing text as a command (U1)', () => {
    assert.ok(parseWecomStopCommand('/stop now'));
    assert.ok(parseWecomStopCommand('/stop please'));
  });

  it('does not recognize /stopping as a command (U1)', () => {
    assert.ok(!parseWecomStopCommand('/stopping'));
    assert.ok(!parseWecomStopCommand('/stopx'));
  });

  it('interrupts an in-flight turn and sends a proactive confirmation (R1, R4, R6)', async () => {
    workspaceStore.getActiveWecomSession = () => 'sess-1';
    setRuntime(true);
    injectStreamReply('sess-1', true);

    const conn = createMockConnection();
    injectConnection(conn);

    await (service as any).handleTextMessage('ws-1', makeTextFrame('/stop'));

    assert.strictEqual(interruptCalls.length, 1);
    assert.strictEqual(cancelPendingApprovalsCalls.length, 1);
    assert.strictEqual(streamReplyInterruptCalls.length, 1);
    assert.strictEqual(streamReplyInterruptCalls[0].sessionId, 'sess-1');
    assert.strictEqual(streamReplyInterruptCalls[0].message, '已中断');
    assert.strictEqual(
      sentMessages.filter((m) => m.body.markdown?.content === '已中断').length,
      1,
      'confirmation should also be sent proactively so the user always receives it',
    );
  });

  it('sends proactive confirmation even when the stream reply delivery path may be stale', async () => {
    workspaceStore.getActiveWecomSession = () => 'sess-1';
    setRuntime(true);

    // Simulate an active stream reply whose own connection is stale/dead.
    // It reports success, but its internal delivery will never reach the user.
    (service as any).activeStreamReplies.set('sess-1', {
      interrupt: (message: string) => {
        streamReplyInterruptCalls.push({ sessionId: 'sess-1', message });
        return true;
      },
    });

    const conn = createMockConnection();
    injectConnection(conn);

    await (service as any).handleTextMessage('ws-1', makeTextFrame('/stop'));

    assert.strictEqual(streamReplyInterruptCalls.length, 1);
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].userId, 'enc-user-1');
    assert.strictEqual(sentMessages[0].body.markdown.content, '已中断');
  });

  it('replies with no active session message when none exists (R2)', async () => {
    workspaceStore.getActiveWecomSession = () => null;

    const conn = createMockConnection();
    injectConnection(conn);

    await (service as any).handleTextMessage('ws-1', makeTextFrame('/stop'));

    assert.strictEqual(interruptCalls.length, 0);
    assert.strictEqual(sentMessages.length, 1);
    assert.ok(sentMessages[0].body.markdown.content.includes('没有活跃的会话可中断'));
  });

  it('replies with nothing in flight when runtime is idle (R3)', async () => {
    workspaceStore.getActiveWecomSession = () => 'sess-1';
    setRuntime(false);

    const conn = createMockConnection();
    injectConnection(conn);

    await (service as any).handleTextMessage('ws-1', makeTextFrame('/stop'));

    assert.strictEqual(interruptCalls.length, 0);
    assert.strictEqual(sentMessages.length, 1);
    assert.ok(sentMessages[0].body.markdown.content.includes('当前没有正在进行的对话'));
  });

  it('replies with nothing in flight when runtime is missing (R3)', async () => {
    workspaceStore.getActiveWecomSession = () => 'sess-1';
    chatService.getRuntimeIfExists = () => undefined;

    const conn = createMockConnection();
    injectConnection(conn);

    await (service as any).handleTextMessage('ws-1', makeTextFrame('/stop'));

    assert.strictEqual(interruptCalls.length, 0);
    assert.strictEqual(sentMessages.length, 1);
    assert.ok(sentMessages[0].body.markdown.content.includes('当前没有正在进行的对话'));
  });

  it('cancels pending approvals after interrupt (R5)', async () => {
    workspaceStore.getActiveWecomSession = () => 'sess-1';
    setRuntime(true);
    injectStreamReply('sess-1', true);

    const conn = createMockConnection();
    injectConnection(conn);

    await (service as any).handleTextMessage('ws-1', makeTextFrame('/stop'));

    assert.strictEqual(interruptCalls.length, 1);
    assert.strictEqual(cancelPendingApprovalsCalls.length, 1);
    assert.strictEqual(cancelPendingApprovalsCalls[0], 'Turn interrupted by user.');
  });

  it('falls back to a standalone confirmation when no stream reply is active', async () => {
    workspaceStore.getActiveWecomSession = () => 'sess-1';
    setRuntime(true);

    const conn = createMockConnection();
    injectConnection(conn);

    await (service as any).handleTextMessage('ws-1', makeTextFrame('/stop'));

    assert.strictEqual(streamReplyInterruptCalls.length, 0);
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].userId, 'enc-user-1');
    assert.strictEqual(sentMessages[0].body.msgtype, 'markdown');
    assert.strictEqual(sentMessages[0].body.markdown.content, '已中断');
  });

  it('falls back to a standalone confirmation when the stream reply is past the safeguard', async () => {
    workspaceStore.getActiveWecomSession = () => 'sess-1';
    setRuntime(true);
    injectStreamReply('sess-1', false);

    const conn = createMockConnection();
    injectConnection(conn);

    await (service as any).handleTextMessage('ws-1', makeTextFrame('/stop'));

    assert.strictEqual(streamReplyInterruptCalls.length, 1);
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].body.markdown.content, '已中断');
  });

  it('does not crash the bot when interrupt fails (R7)', async () => {
    workspaceStore.getActiveWecomSession = () => 'sess-1';
    setRuntime(true, true);

    const conn = createMockConnection();
    injectConnection(conn);

    await assert.doesNotReject(async () => {
      await (service as any).handleTextMessage('ws-1', makeTextFrame('/stop'));
    });

    assert.strictEqual(interruptCalls.length, 1);
    assert.strictEqual(sentMessages.length, 1);
    assert.ok(sentMessages[0].body.markdown.content.includes('中断会话失败'));
  });

  it('does not create a new session when /stop is sent (R1)', async () => {
    workspaceStore.getActiveWecomSession = () => null;
    let sessionCreated = false;
    chatService.createSession = async () => {
      sessionCreated = true;
      return { id: 'new-sess', workspaceId: 'ws-1' } as any;
    };

    const conn = createMockConnection();
    injectConnection(conn);

    await (service as any).handleTextMessage('ws-1', makeTextFrame('/stop'));

    assert.ok(!sessionCreated);
    assert.strictEqual(sentMessages.length, 1);
  });

  it('keeps the stream reply active after replacing a stale bot handler (regression)', async () => {
    workspaceStore.getActiveWecomSession = () => 'sess-1';
    workspaceStore.get = async () => ({ id: 'ws-1', settings: {} } as any);
    workspaceStore.getWecomUserMapping = () => null;
    workspaceStore.setWecomSession = () => {};
    chatService.getSession = async () => ({ id: 'sess-1', workspaceId: 'ws-1' } as any);

    let currentHandler: any;
    let processing = false;
    // Simulate a runtime that already holds a stale handler from a prior turn.
    // getOrCreateRuntime clears the old handler before adding the new one, just
    // like the real implementation.
    const staleHandler = Object.assign(() => {}, {
      cleanup: () => {
        (service as any).activeStreamReplies.delete('sess-1');
      },
    });
    currentHandler = staleHandler;

    chatService.getOrCreateRuntime = async (
      _sessionId: string,
      _workspaceId: string,
      _isBotSession?: boolean,
      handler?: any,
    ) => {
      if (currentHandler) {
        currentHandler.cleanup?.();
      }
      currentHandler = handler;
      return {
        pushMessage: () => {
          processing = true;
        },
        isProcessingTurn: () => processing,
        interrupt: async () => {},
        cancelPendingApprovals: () => {},
      } as any;
    };
    chatService.getRuntimeIfExists = () =>
      ({
        isProcessingTurn: () => processing,
        interrupt: async () => {},
        cancelPendingApprovals: () => {},
      }) as any;

    const conn = createMockConnection();
    injectConnection(conn);

    // First message creates a stream reply while a runtime already exists.
    await (service as any).handleTextMessage('ws-1', makeTextFrame('hello'));

    assert.ok(
      (service as any).activeStreamReplies.get('sess-1'),
      'stream reply should stay active after replacing a stale handler',
    );

    // /stop should append the confirmation to the stream reply and also send a
    // proactive confirmation so the user reliably receives feedback.
    await (service as any).handleTextMessage('ws-1', makeTextFrame('/stop'));

    assert.strictEqual(
      sentMessages.filter((m) => m.body.markdown?.content === '已中断').length,
      1,
      'confirmation should also be sent proactively',
    );
  });
});

describe('WeComBotService /workspace command', { concurrency: false }, () => {
  let service: WeComBotService;
  let tempDirA: string;
  let tempDirB: string;
  let workspaceA: { id: string; name: string; folderPath: string };
  let workspaceB: { id: string; name: string; folderPath: string };
  let botId: string;
  const ownerUserId = 'owner-1';
  const nonOwnerUserId = 'user-1';

  let sentMessages: Array<{ userId: string; body: any }>;
  let updatedCards: Array<{ card: any }>;

  beforeEach(async () => {
    workspaceStore.resetData();
    service = new WeComBotService();
    sentMessages = [];
    updatedCards = [];

    tempDirA = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'wecom-ws-a-'));
    tempDirB = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'wecom-ws-b-'));

    workspaceA = await workspaceStore.create({ name: 'Workspace A', folderPath: tempDirA });
    workspaceB = await workspaceStore.create({ name: 'Workspace B', folderPath: tempDirB });

    const bot = botService.createBot({
      name: 'Test Bot',
      activeWorkspaceId: workspaceA.id,
      channelSettings: {
        wecom: {
          enabled: true,
          botId: 'wecom-bot-id',
          botSecret: 'wecom-bot-secret',
        },
      },
    });
    botId = bot.id;
    botService.addMember(botId, { channelKey: 'wecom', channelUserId: ownerUserId, roleKey: 'owner' });
    botService.addMember(botId, { channelKey: 'wecom', channelUserId: nonOwnerUserId, roleKey: 'normal' });
  });

  afterEach(async () => {
    await fsPromises.rm(tempDirA, { recursive: true, force: true }).catch(() => {});
    await fsPromises.rm(tempDirB, { recursive: true, force: true }).catch(() => {});
  });

  function injectConnection() {
    const conn = {
      client: {
        sendMessage: async (userId: string, body: any) => {
          sentMessages.push({ userId, body });
        },
        updateTemplateCard: async (_frame: any, card: any) => {
          updatedCards.push({ card });
        },
      },
      workspaceId: workspaceA.id,
      botId,
      folderPath: workspaceA.folderPath,
      status: 'connected' as const,
    };
    (service as any).connections.set(botId, conn);
    (service as any).workspaceIdToBotId.set(workspaceA.id, botId);
    (service as any).botIdToWorkspaceId.set(botId, workspaceA.id);
  }

  function makeTextFrame(content: string, userid = ownerUserId) {
    return {
      headers: { req_id: 'req-1' },
      body: {
        msgid: 'msg-1',
        aibotid: 'wecom-bot-id',
        chattype: 'single',
        from: { userid },
        msgtype: 'text',
        text: { content },
      },
    };
  }

  function makeWorkspaceSubmitEvent(targetWorkspaceId: string, userid = ownerUserId) {
    const requestId = 'req-workspace';
    const key = encodeButtonKey(requestId, 'select_workspace', botId);
    return {
      headers: { req_id: 'r' },
      body: {
        msgid: 'm',
        aibotid: 'wecom-bot-id',
        chattype: 'single',
        from: { userid },
        msgtype: 'event',
        event: {
          eventtype: 'template_card_event',
          template_card_event: {
            event_key: key,
            task_id: 'task-1',
            card_type: 'vote_interaction',
            selected_items: {
              selected_item: [{ question_key: key, option_ids: { option_id: [targetWorkspaceId] } }],
            },
          },
        },
      },
    };
  }

  it('recognizes /workspace and /workspace with trailing text as commands', () => {
    assert.ok(parseWecomWorkspaceCommand('/workspace'));
    assert.ok(parseWecomWorkspaceCommand('  /workspace  '));
    assert.ok(parseWecomWorkspaceCommand('/workspace ignored args'));
  });

  it('does not recognize /workspacex as a command', () => {
    assert.ok(!parseWecomWorkspaceCommand('/workspacex'));
    assert.ok(!parseWecomWorkspaceCommand('/workspaceX'));
  });

  it('/workspace rejects non-Owners and does not send a card', async () => {
    injectConnection();

    await (service as any).handleTextMessage(workspaceA.id, makeTextFrame('/workspace', nonOwnerUserId));

    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].body.msgtype, 'markdown');
    assert.ok(sentMessages[0].body.markdown.content.includes('没有权限'));
  });

  it('/workspace sends a workspace list card to Owners with the active workspace highlighted', async () => {
    injectConnection();

    await (service as any).handleTextMessage(workspaceA.id, makeTextFrame('/workspace', ownerUserId));

    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].body.msgtype, 'template_card');
    const card = sentMessages[0].body.template_card;
    assert.strictEqual(card.card_type, 'vote_interaction');
    assert.strictEqual(card.checkbox.option_list.length, 2);
    const activeOption = card.checkbox.option_list.find((o: any) => o.id === workspaceA.id);
    assert.ok(activeOption.text.includes('（当前）'));
  });

  it('select_workspace switches the active workspace, updates routing maps, and confirms', async () => {
    injectConnection();

    await (service as any).handleTemplateCardEvent(workspaceA.id, makeWorkspaceSubmitEvent(workspaceB.id));

    assert.strictEqual(botService.resolveActiveWorkspace(botId), workspaceB.id);
    assert.strictEqual((service as any).botIdToWorkspaceId.get(botId), workspaceB.id);
    assert.strictEqual((service as any).workspaceIdToBotId.get(workspaceB.id), botId);
    assert.strictEqual((service as any).connections.get(botId).workspaceId, workspaceB.id);

    assert.strictEqual(updatedCards.length, 1);
    assert.ok(updatedCards[0].card.replace_text.includes('已切换到工作空间'));
    assert.ok(sentMessages.some((m) => m.body.markdown?.content.includes('已切换到工作空间')));
  });

  it('select_workspace rejects non-Owners', async () => {
    injectConnection();

    await (service as any).handleTemplateCardEvent(
      workspaceA.id,
      makeWorkspaceSubmitEvent(workspaceB.id, nonOwnerUserId),
    );

    assert.strictEqual(botService.resolveActiveWorkspace(botId), workspaceA.id);
    assert.strictEqual(updatedCards[0].card.replace_text, '你没有权限切换工作空间');
  });

  it('select_workspace best-effort notifies users in the previous workspace', async () => {
    // After switching, the bot's active workspace changes, so the previous
    // workspace no longer has a bot associated with it. Users in the previous
    // workspace won't be notified because listWecomWorkspaceUsers looks up
    // users via the bot currently bound to that workspace.
    workspaceStore.setWecomWorkspaceUser(workspaceA.id, 'prev-user-1');
    injectConnection();

    await (service as any).handleTemplateCardEvent(workspaceA.id, makeWorkspaceSubmitEvent(workspaceB.id));

    // The workspace switch notification to the acting user is always sent.
    const switchNotification = sentMessages.find((m) => m.userId === ownerUserId);
    assert.ok(switchNotification);
    assert.ok(switchNotification.body.markdown.content.includes('已切换到工作空间'));
  });
});

  describe('parseWecomStatusCommand', () => {
    it('matches exact /status and /status with trailing text', () => {
      assert.ok(parseWecomStatusCommand('/status'));
      assert.ok(parseWecomStatusCommand('/status ignored args'));
      assert.ok(parseWecomStatusCommand('  /status  '));
    });

    it('does not trigger on /statusx or plain text', () => {
      assert.ok(!parseWecomStatusCommand('/statusx'));
      assert.ok(!parseWecomStatusCommand('/statuses'));
      assert.ok(!parseWecomStatusCommand('hello'));
    });
  });

  describe('WeComBotService /status command', { concurrency: false }, () => {
    let service: WeComBotService;
    let sentMessages: Array<{ userId: string; body: any }>;

    let origGetActiveWecomSession: typeof workspaceStore.getActiveWecomSession;
    let origGetSession: typeof chatService.getSession;
    let origGet: typeof workspaceStore.get;

    beforeEach(() => {
      service = new WeComBotService();
      sentMessages = [];

      origGetActiveWecomSession = workspaceStore.getActiveWecomSession.bind(workspaceStore);
      origGetSession = chatService.getSession.bind(chatService);
      origGet = workspaceStore.get.bind(workspaceStore);

      workspaceStore.getActiveWecomSession = () => null;
      workspaceStore.get = async () => ({ id: 'ws-1', name: 'Test Workspace', settings: {} } as any);
      chatService.getSession = async () => ({ id: 'sess-1', workspaceId: 'ws-1' } as any);
    });

    afterEach(() => {
      workspaceStore.getActiveWecomSession = origGetActiveWecomSession;
      chatService.getSession = origGetSession;
      workspaceStore.get = origGet;
    });

    function injectConnection() {
      (service as any).connections.set('ws-1', {
        client: {
          sendMessage: async (userId: string, body: any) => {
            sentMessages.push({ userId, body });
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

    it('/status replies with workspace name and active session name', async () => {
      injectConnection();
      workspaceStore.getActiveWecomSession = () => 'sess-active';
      chatService.getSession = async (id: string) =>
        ({ id, workspaceId: 'ws-1', name: 'Active Session', customTitle: 'Active Custom' } as any);

      await (service as any).handleTextMessage('ws-1', makeTextFrame('/status'));

      assert.strictEqual(sentMessages.length, 1);
      assert.strictEqual(sentMessages[0].body.msgtype, 'markdown');
      const content = sentMessages[0].body.markdown.content;
      assert.ok(content.includes('Test Workspace'));
      assert.ok(content.includes('Active Custom'));
      assert.ok(!content.includes('Active Session'));
    });

    it('/status falls back to session name when customTitle is absent', async () => {
      injectConnection();
      workspaceStore.getActiveWecomSession = () => 'sess-active';
      chatService.getSession = async (id: string) =>
        ({ id, workspaceId: 'ws-1', name: 'Active Session' } as any);

      await (service as any).handleTextMessage('ws-1', makeTextFrame('/status'));

      assert.ok(sentMessages[0].body.markdown.content.includes('Active Session'));
    });

    it('/status replies with no active session message when none exists', async () => {
      injectConnection();

      await (service as any).handleTextMessage('ws-1', makeTextFrame('/status'));

      assert.strictEqual(sentMessages.length, 1);
      const content = sentMessages[0].body.markdown.content;
      assert.ok(content.includes('Test Workspace'));
      assert.ok(content.includes('暂无活跃会话'));
    });

    it('/status replies with binding hint when workspace is missing', async () => {
      injectConnection();
      workspaceStore.get = async () => null;

      await (service as any).handleTextMessage('ws-1', makeTextFrame('/status'));

      assert.strictEqual(sentMessages.length, 1);
      assert.ok(sentMessages[0].body.markdown.content.includes('机器人尚未绑定工作空间'));
    });

    it('/status replies with a fallback error when session lookup fails', async () => {
      injectConnection();
      workspaceStore.getActiveWecomSession = () => 'sess-active';
      chatService.getSession = async () => {
        throw new Error('db down');
      };

      await (service as any).handleTextMessage('ws-1', makeTextFrame('/status'));

      assert.strictEqual(sentMessages.length, 1);
      const content = sentMessages[0].body.markdown.content;
      assert.ok(content.includes('Test Workspace'));
      assert.ok(content.includes('读取会话失败'));
    });

    it('/status is intercepted and not forwarded to the agent', async () => {
      injectConnection();
      let pushed = false;
      chatService.pushMessage = (async () => {
        pushed = true;
      }) as any;

      await (service as any).handleTextMessage('ws-1', makeTextFrame('/status'));

      assert.strictEqual(sentMessages.length, 1);
      assert.ok(!pushed);
    });
  });

  describe('auto-add bot members on first inbound message', { concurrency: false }, () => {
    let service: WeComBotService;
    let workspace: { id: string; name: string; folderPath: string };
    let botId: string;
    const ownerUserId = 'owner-1';
    const newUserId = 'new-user-1';

    beforeEach(async () => {
      workspaceStore.resetData();
      service = new WeComBotService();

      workspace = await workspaceStore.create({ name: 'Auto-add Workspace', folderPath: '/tmp/auto-add' });
      const bot = botService.createBot({
        name: 'Auto-add Bot',
        activeWorkspaceId: workspace.id,
        channelSettings: {
          wecom: { enabled: true, botId: 'wecom-bot-id', botSecret: 'wecom-bot-secret' },
        },
      });
      botId = bot.id;
      botService.addMember(botId, { channelKey: 'wecom', channelUserId: ownerUserId, roleKey: 'owner' });

      chatService.getOrCreateRuntime = async () =>
        ({ pushMessage: () => {} }) as any;
    });

    function injectConnection() {
      const conn = {
        client: { sendMessage: async () => {}, replyStream: async () => {} },
        workspaceId: workspace.id,
        botId,
        folderPath: workspace.folderPath,
        status: 'connected' as const,
      };
      (service as any).connections.set(botId, conn);
      (service as any).workspaceIdToBotId.set(workspace.id, botId);
      (service as any).botIdToWorkspaceId.set(botId, workspace.id);
    }

    function makeTextFrame(userid: string, content = 'hello') {
      return {
        headers: { req_id: 'req-1' },
        body: {
          msgid: 'msg-1',
          aibotid: 'wecom-bot-id',
          chattype: 'single',
          from: { userid },
          msgtype: 'text',
          text: { content },
        },
      };
    }

    it('adds a first-time text messenger as a normal member', async () => {
      injectConnection();

      assert.strictEqual(botService.getMemberRole(botId, 'wecom', newUserId), null);

      await (service as any).handleTextMessage(workspace.id, makeTextFrame(newUserId));

      assert.strictEqual(botService.getMemberRole(botId, 'wecom', newUserId), 'normal');
    });

    it('does not overwrite an existing member role on repeat messages', async () => {
      injectConnection();
      botService.addMember(botId, { channelKey: 'wecom', channelUserId: newUserId, roleKey: 'admin' });

      await (service as any).handleTextMessage(workspace.id, makeTextFrame(newUserId));

      assert.strictEqual(botService.getMemberRole(botId, 'wecom', newUserId), 'admin');
    });

    it('does not downgrade the channel owner', async () => {
      injectConnection();

      await (service as any).handleTextMessage(workspace.id, makeTextFrame(ownerUserId));

      assert.strictEqual(botService.getMemberRole(botId, 'wecom', ownerUserId), 'owner');
    });
  });

