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

const originalChatService = {
  createSession: chatService.createSession.bind(chatService),
  getSession: chatService.getSession.bind(chatService),
  pushMessage: chatService.pushMessage.bind(chatService),
  getOrCreateRuntime: chatService.getOrCreateRuntime.bind(chatService),
  getRuntimeIfExists: chatService.getRuntimeIfExists.bind(chatService),
};

afterEach(() => {
  Object.assign(chatService, originalChatService);
});

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

  // Spies
  let pushedMessages: string[];
  let sentMessages: Array<{ userId: string; body: any }>;

  beforeEach(async () => {
    service = new WeComBotService();
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'wecom-media-test-'));
    pushedMessages = [];
    sentMessages = [];

    // Patch chatService to use the singleton store (which test-env redirects to a temp dir)
    chatService.createSession = async (input: any) => {
      const session = workspaceStore.createLocalSession(
        input.workspaceId,
        input.name,
        undefined,
        undefined,
        input.source,
        input.customTitle,
        input.botId,
      );
      workspaceStore.clearDraftFlag(session.id);
      return { ...session, isDraft: false };
    };
    chatService.getSession = async (id: string) => {
      const s = workspaceStore.getLocalSession(id);
      return s as any;
    };
    chatService.pushMessage = (async (...args: unknown[]) => {
      pushedMessages.push(args[2] as string);
    }) as any;
    chatService.getOrCreateRuntime = async () =>
      ({ pushMessage: (content: string) => { pushedMessages.push(content); } }) as any;
  });

  afterEach(async () => {
    workspaceStore.resetData();
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  function createMockConnection(workspaceId: string, botId: string) {
    return {
      client: {
        downloadFile: async () => ({ buffer: Buffer.from('file-content'), filename: 'report.pdf' }),
        replyStream: async () => {},
        replyStreamNonBlocking: async () => {},
        sendMessage: async (userId: string, body: any) => {
          sentMessages.push({ userId, body });
        },
      },
      workspaceId,
      botId,
      folderPath: tempDir,
      status: 'connected' as const,
    };
  }

  function makeFrame(msgtype: string, body: any, wecomUserId = 'enc-user-1') {
    return {
      headers: { req_id: 'req-1' },
      body: {
        msgid: 'msg-1',
        aibotid: 'bot-1',
        chattype: 'single',
        from: { userid: wecomUserId },
        msgtype,
        ...body,
      },
    };
  }

  // Inject a connection into the service for testing
  function injectConnection(conn: any) {
    (service as any).connections.set(conn.botId, conn);
    (service as any).workspaceIdToBotId.set(conn.workspaceId, conn.botId);
    (service as any).botIdToWorkspaceId.set(conn.botId, conn.workspaceId);
  }

  async function setupWorkspaceAndBot() {
    const ws = await workspaceStore.create({ name: 'Test Workspace', folderPath: tempDir });
    const bot = workspaceStore.createBot({ name: 'Test Bot', activeWorkspaceId: ws.id });
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const role = workspaceStore.getBotRoleByKey(bot.id, 'normal')!;
    workspaceStore.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role.id,
      channelUserId: 'enc-user-1',
      plaintextUserId: 'ZhangWei',
    });
    return { ws, bot, channel };
  }

  it('handles file message: downloads, saves, pushes prompt (AE1)', async () => {
    const { ws, bot } = await setupWorkspaceAndBot();
    const conn = createMockConnection(ws.id, bot.id);
    injectConnection(conn);

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    await (service as any).handleMediaMessage(ws.id, frame);

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
    const { ws, bot } = await setupWorkspaceAndBot();
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const role = workspaceStore.getBotRoleByKey(bot.id, 'normal')!;
    workspaceStore.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role.id,
      channelUserId: 'enc-user-2',
      plaintextUserId: null,
    });

    const conn = createMockConnection(ws.id, bot.id);
    injectConnection(conn);

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    }, 'enc-user-2');

    await (service as any).handleMediaMessage(ws.id, frame);

    const savedFile = path.join(tempDir, 'data', 'enc-user-2', 'report.pdf');
    const content = await fsPromises.readFile(savedFile);
    assert.deepStrictEqual(content, Buffer.from('file-content'));

    assert.strictEqual(pushedMessages.length, 1);
    assert.ok(pushedMessages[0].includes('@data/enc-user-2/report.pdf'));
  });

  it('handles image message: downloads and saves', async () => {
    const { ws, bot } = await setupWorkspaceAndBot();
    const conn = createMockConnection(ws.id, bot.id);
    conn.client.downloadFile = async () => ({ buffer: Buffer.from('image-data'), filename: 'photo.png' });
    injectConnection(conn);

    const frame = makeFrame('image', {
      image: { url: 'https://example.com/img', aeskey: 'imgkey' },
    });

    await (service as any).handleMediaMessage(ws.id, frame);

    const savedFile = path.join(tempDir, 'data', 'ZhangWei', 'photo.png');
    const content = await fsPromises.readFile(savedFile);
    assert.deepStrictEqual(content, Buffer.from('image-data'));
    assert.strictEqual(pushedMessages.length, 1);
  });

  it('handles voice message as text-equivalent prompt', async () => {
    const { ws, bot } = await setupWorkspaceAndBot();
    const conn = createMockConnection(ws.id, bot.id);
    injectConnection(conn);

    const frame = makeFrame('voice', {
      voice: { content: '你好世界' },
    });

    await (service as any).handleMediaMessage(ws.id, frame);

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
    const { ws, bot } = await setupWorkspaceAndBot();
    const conn = createMockConnection(ws.id, bot.id);
    conn.client.downloadFile = async () => { throw new Error('Download failed'); };
    injectConnection(conn);

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    // Should NOT throw
    await (service as any).handleMediaMessage(ws.id, frame);

    // No prompt should be pushed
    assert.strictEqual(pushedMessages.length, 0);

    // Error reply should be sent
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].userId, 'enc-user-1');
    assert.ok(sentMessages[0].body.markdown.content.includes('文件处理失败'));
  });

  it('handles file save failure gracefully', async () => {
    const { ws, bot } = await setupWorkspaceAndBot();
    const conn = createMockConnection(ws.id, bot.id);
    // Make folderPath invalid to cause save failure
    conn.folderPath = '/nonexistent/path/that/cannot/be/written';
    injectConnection(conn);

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    await (service as any).handleMediaMessage(ws.id, frame);

    assert.strictEqual(pushedMessages.length, 0);
    assert.strictEqual(sentMessages.length, 1);
    assert.ok(sentMessages[0].body.markdown.content.includes('文件处理失败'));
  });

  it('handles session creation failure gracefully', async () => {
    const { ws, bot } = await setupWorkspaceAndBot();
    const conn = createMockConnection(ws.id, bot.id);
    injectConnection(conn);

    chatService.createSession = async () => { throw new Error('DB error'); };

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    await (service as any).handleMediaMessage(ws.id, frame);

    assert.strictEqual(pushedMessages.length, 0);
    assert.strictEqual(sentMessages.length, 1);
  });

  it('uses fallback filename when SDK does not provide one', async () => {
    const { ws, bot } = await setupWorkspaceAndBot();
    const conn = createMockConnection(ws.id, bot.id);
    conn.client.downloadFile = async () => ({ buffer: Buffer.from('data'), filename: undefined });
    injectConnection(conn);

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    await (service as any).handleMediaMessage(ws.id, frame);

    assert.strictEqual(pushedMessages.length, 1);
    // Should contain a fallback filename like file_<timestamp>.bin
    assert.ok(pushedMessages[0].includes('file_'));
    assert.ok(pushedMessages[0].includes('.bin'));
  });

  it('creates session for user with no prior session', async () => {
    const { ws, bot } = await setupWorkspaceAndBot();
    const conn = createMockConnection(ws.id, bot.id);
    injectConnection(conn);

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    await (service as any).handleMediaMessage(ws.id, frame);

    assert.strictEqual(pushedMessages.length, 1);
  });

  it('uses custom file prompt template with $file_name$ substitution', async () => {
    const { ws, bot } = await setupWorkspaceAndBot();
    const conn = createMockConnection(ws.id, bot.id);
    injectConnection(conn);

    workspaceStore.update(ws.id, { settings: { wecomFilePromptTemplate: 'Please summarize the file $file_name$' } });

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    await (service as any).handleMediaMessage(ws.id, frame);

    assert.strictEqual(pushedMessages.length, 1);
    assert.ok(pushedMessages[0].includes('Please summarize the file'));
  });

  it('falls back to default prompt when template is empty', async () => {
    const { ws, bot } = await setupWorkspaceAndBot();
    const conn = createMockConnection(ws.id, bot.id);
    injectConnection(conn);

    workspaceStore.update(ws.id, { settings: { wecomFilePromptTemplate: '' } });

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    await (service as any).handleMediaMessage(ws.id, frame);

    assert.strictEqual(pushedMessages.length, 1);
    assert.ok(pushedMessages[0].includes('a file named'));
    assert.ok(pushedMessages[0].includes('skill'));
  });

  it('does not apply file prompt template to voice messages', async () => {
    const { ws, bot } = await setupWorkspaceAndBot();
    const conn = createMockConnection(ws.id, bot.id);
    injectConnection(conn);

    workspaceStore.update(ws.id, { settings: { wecomFilePromptTemplate: 'Please summarize the file $file_name$' } });

    const frame = makeFrame('voice', {
      voice: { content: '你好世界' },
    });

    await (service as any).handleMediaMessage(ws.id, frame);

    // Voice prompt should NOT use the file template
    assert.strictEqual(pushedMessages.length, 1);
    assert.ok(pushedMessages[0].includes('voice message'));
    assert.ok(!pushedMessages[0].includes('$file_name$'));
  });

  it('skips stream reply when Reply category is denied (R11/AE6: bot runs but cannot reply)', async () => {
    const { ws, bot } = await setupWorkspaceAndBot();
    const conn = createMockConnection(ws.id, bot.id);
    let replyStreamCallCount = 0;
    conn.client.replyStream = async () => { replyStreamCallCount += 1; };
    conn.client.replyStreamNonBlocking = async () => { replyStreamCallCount += 1; };
    injectConnection(conn);

    // Policy denies Reply — bot will process but cannot respond
    workspaceStore.update(ws.id, {
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
    });

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    await (service as any).handleMediaMessage(ws.id, frame);

    // Agent still runs (pushMessage called)
    assert.strictEqual(pushedMessages.length, 1);
    // But no reply stream frames are sent (no placeholder, no animation, no leak)
    assert.strictEqual(replyStreamCallCount, 0, 'Reply-deny must skip createStreamReply entirely');
  });

  it('creates stream reply normally when Reply is allowed (default)', async () => {
    const { ws, bot } = await setupWorkspaceAndBot();
    const conn = createMockConnection(ws.id, bot.id);
    let replyStreamCallCount = 0;
    conn.client.replyStream = async () => { replyStreamCallCount += 1; };
    injectConnection(conn);

    // Default policy (no explicit wecomToolPermissions, bot enabled) → allow-all → Reply allowed
    workspaceStore.update(ws.id, { settings: { wecomBotEnabled: true } });

    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key123' },
    });

    await (service as any).handleMediaMessage(ws.id, frame);

    // Agent runs
    assert.strictEqual(pushedMessages.length, 1);
    // Stream reply IS created (placeholder frame is sent)
    assert.ok(replyStreamCallCount > 0, 'Reply-allow must construct the stream reply');
  });
});

describe('WeComBotService template card events', { concurrency: false }, () => {
  let service: WeComBotService;
  let tempDir: string;
  let testSessionId: string;

  let resolvedApprovals: Array<{ requestId: string; result: any }>;
  let updatedCards: Array<{ frame: any; card: any }>;
  let pendingCardState: any;

  beforeEach(async () => {
    service = new WeComBotService();
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'wecom-card-test-'));

    resolvedApprovals = [];
    updatedCards = [];
    pendingCardState = { type: 'approval', toolName: 'Bash', toolUseId: 'tu-deny-1', suggestions: [{ id: 'suggestion-1' }] };

    // Set up workspace, bot, and user
    const ws = await workspaceStore.create({ name: 'Card Test', folderPath: tempDir });
    const bot = workspaceStore.createBot({ name: 'Card Bot', activeWorkspaceId: ws.id });
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const role = workspaceStore.getBotRoleByKey(bot.id, 'normal')!;
    workspaceStore.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role.id,
      channelUserId: 'owner-1',
      plaintextUserId: null,
    });

    // Inject connection
    (service as any).connections.set(bot.id, {
      client: {
        replyStream: async () => {},
        replyStreamNonBlocking: async () => {},
        sendMessage: async () => {},
        updateTemplateCard: async (frame: any, card: any) => {
          updatedCards.push({ frame, card });
        },
      },
      workspaceId: ws.id,
      botId: bot.id,
      folderPath: tempDir,
      status: 'connected' as const,
    });
    (service as any).workspaceIdToBotId.set(ws.id, bot.id);
    (service as any).botIdToWorkspaceId.set(bot.id, ws.id);

    // Mock chatService runtime
    chatService.getRuntimeIfExists = () =>
      ({
        getPendingCardState: () => pendingCardState,
        resolveApproval: (requestId: string, result: any) => {
          resolvedApprovals.push({ requestId, result });
        },
      }) as any;

    // Create a session owned by owner-1
    const session = workspaceStore.createLocalSession(ws.id, 'test-session', undefined, undefined, 'wecom', undefined, bot.id);
    testSessionId = session.id;
    workspaceStore.clearDraftFlag(session.id);
    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'owner-1')!;
    workspaceStore.addUserSession(ws.id, session.id, botUser.id);
    workspaceStore.setActiveUserSession(botUser.id, session.id);
  });

  afterEach(async () => {
    workspaceStore.resetData();
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

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
    const sentMessages: Array<{ userId: string; body: any }> = [];
    const conn = (service as any).connections.values().next().value;
    conn.client.sendMessage = async (userId: string, body: any) => {
      sentMessages.push({ userId, body });
    };

    const wsList = await workspaceStore.list();
    const ws = wsList[0];
    await service.sendTemplateCard(ws.id, 'owner-1', {
      card_type: 'text_notice',
      main_title: { title: 'Test', desc: 'Desc' },
    } as any);

    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].userId, 'owner-1');
    assert.strictEqual(sentMessages[0].body.msgtype, 'template_card');
    assert.strictEqual(sentMessages[0].body.template_card.card_type, 'text_notice');
  });

  it('resolves approval when user clicks allow', async () => {
    const ws = (await workspaceStore.list())[0];
    const key = encodeButtonKey('req-1', 'allow', testSessionId);
    await (service as any).handleTemplateCardEvent(ws.id, makeCardEvent(key));

    assert.strictEqual(resolvedApprovals.length, 1);
    assert.strictEqual(resolvedApprovals[0].requestId, 'req-1');
    assert.strictEqual(resolvedApprovals[0].result.behavior, 'allow');
    assert.strictEqual(resolvedApprovals[0].result.updatedPermissions, undefined);
    assert.strictEqual(updatedCards.length, 1);
    assert.strictEqual(updatedCards[0].card.card_type, 'text_notice');
    assert.strictEqual(updatedCards[0].card.main_title.desc, '已允许');
  });

  it('resolves approval when user clicks always_allow with suggestions', async () => {
    const ws = (await workspaceStore.list())[0];
    const key = encodeButtonKey('req-1', 'always_allow', testSessionId);
    await (service as any).handleTemplateCardEvent(ws.id, makeCardEvent(key));

    assert.strictEqual(resolvedApprovals.length, 1);
    assert.strictEqual(resolvedApprovals[0].requestId, 'req-1');
    assert.strictEqual(resolvedApprovals[0].result.behavior, 'allow');
    assert.deepStrictEqual(resolvedApprovals[0].result.updatedPermissions, [{ id: 'suggestion-1' }]);
    assert.strictEqual(updatedCards[0].card.main_title.desc, '已始终允许');
  });

  it('resolves approval when user clicks deny', async () => {
    const ws = (await workspaceStore.list())[0];
    const key = encodeButtonKey('req-1', 'deny', testSessionId);
    const { logs, restore } = collectDiagLogs();
    try {
      await (service as any).handleTemplateCardEvent(ws.id, makeCardEvent(key));
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
        line.includes('sessionId=' + testSessionId) &&
        line.includes('workspaceId=' + ws.id),
      ),
      'expected user-deny reason to be logged with correlators',
    );
  });

  it('ignores clicks from a non-owner user and updates card', async () => {
    const ws = (await workspaceStore.list())[0];
    const key = encodeButtonKey('req-1', 'allow', testSessionId);
    await (service as any).handleTemplateCardEvent(
      ws.id,
      makeCardEvent(key, { userid: 'attacker-1' }),
    );

    assert.strictEqual(resolvedApprovals.length, 0);
    assert.strictEqual(updatedCards.length, 1);
    assert.strictEqual(updatedCards[0].card.main_title.desc, '无法操作该会话');
  });

  it('updates card to terminal state when pending approval is missing', async () => {
    const ws = (await workspaceStore.list())[0];
    pendingCardState = undefined;

    const key = encodeButtonKey('req-1', 'allow', testSessionId);
    await (service as any).handleTemplateCardEvent(ws.id, makeCardEvent(key));

    assert.strictEqual(resolvedApprovals.length, 0);
    assert.strictEqual(updatedCards.length, 1);
    assert.strictEqual(updatedCards[0].card.main_title.desc, '该请求已过期或已处理');
  });

  it('ignores non-Comate keys silently', async () => {
    const ws = (await workspaceStore.list())[0];
    await (service as any).handleTemplateCardEvent(ws.id, makeCardEvent('some-random-key'));

    assert.strictEqual(resolvedApprovals.length, 0);
    assert.strictEqual(updatedCards.length, 0);
  });

  it('resolves question when user submits an answer', async () => {
    const ws = (await workspaceStore.list())[0];
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

    const key = encodeButtonKey('req-1', 'allow', testSessionId);
    await (service as any).handleTemplateCardEvent(
      ws.id,
      makeCardEvent(key, {
        event: {
          selected_items: [
            { question_key: encodeButtonKey('req-1', 'allow', testSessionId), option_ids: ['1'] },
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
    const ws = (await workspaceStore.list())[0];
    pendingCardState = {
      type: 'question',
      questions: [
        { question: 'Q1', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false },
        { question: 'Q2', options: [{ label: 'C' }, { label: 'D' }], multiSelect: false },
      ],
    };

    const key = encodeButtonKey('req-1', 'allow', testSessionId);
    await (service as any).handleTemplateCardEvent(
      ws.id,
      makeCardEvent(key, {
        event: {
          selected_items: [
            { question_key: encodeButtonKey('req-1:0', 'allow', testSessionId), option_ids: ['0'] },
            { question_key: encodeButtonKey('req-1:1', 'allow', testSessionId), option_ids: ['1'] },
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
    const ws = (await workspaceStore.list())[0];
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

    const key = encodeButtonKey('req-1', 'allow', testSessionId);
    await (service as any).handleTemplateCardEvent(
      ws.id,
      makeCardEvent(key, {
        event: {
          selected_items: [
            { question_key: encodeButtonKey('req-1', 'allow', testSessionId), option_ids: ['0', '2'] },
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

  beforeEach(() => {
    service = new WeComBotService();
    sentMessages = [];
    pushedContents = [];

    chatService.pushMessage = (async (...args: unknown[]) => {
      pushedContents.push(args[2] as string);
    }) as any;
  });

  afterEach(() => {
    workspaceStore.resetData();
  });

  async function setupWorkspace() {
    const ws = await workspaceStore.create({ name: 'Test Workspace', folderPath: '/tmp' });
    const bot = workspaceStore.createBot({ name: 'Test Bot', activeWorkspaceId: ws.id });
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const role = workspaceStore.getBotRoleByKey(bot.id, 'normal')!;
    workspaceStore.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role.id,
      channelUserId: 'enc-user-1',
      plaintextUserId: null,
    });
    return { ws, bot };
  }

  function injectConnection(wsId: string, botId: string) {
    (service as any).connections.set(botId, {
      client: {
        sendMessage: async (userId: string, body: any) => {
          sentMessages.push({ userId, content: body.markdown.content });
        },
        replyStream: async () => {},
        replyStreamNonBlocking: async () => {},
      },
      workspaceId: wsId,
      botId,
      folderPath: '/tmp',
      status: 'connected' as const,
    });
    (service as any).workspaceIdToBotId.set(wsId, botId);
    (service as any).botIdToWorkspaceId.set(botId, wsId);
  }

  function makeTextFrame(content: string, userid = 'enc-user-1') {
    return {
      headers: { req_id: 'r' },
      body: {
        msgid: 'm',
        aibotid: 'bot-1',
        chattype: 'single',
        from: { userid },
        msgtype: 'text',
        text: { content },
      },
    };
  }

  it('/new with title creates, activates, replies with the title, and does not forward to agent (AE1)', async () => {
    const { ws, bot } = await setupWorkspace();
    injectConnection(ws.id, bot.id);

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/new 项目X'));

    // Check that a session was created and the user has an active session
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const activeSession = workspaceStore.getActiveUserSession(botUser.id);
    assert.ok(activeSession, 'active session should exist');

    assert.strictEqual(sentMessages.length, 1);
    assert.ok(sentMessages[0].content.includes('项目X'));
    assert.strictEqual(pushedContents.length, 0);
  });

  it('/clear is an alias of /new (AE2)', async () => {
    const { ws, bot } = await setupWorkspace();
    injectConnection(ws.id, bot.id);

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/clear 项目X'));

    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const activeSession = workspaceStore.getActiveUserSession(botUser.id);
    assert.ok(activeSession);
    assert.strictEqual(pushedContents.length, 0);
  });

  it('/new with no title uses the default name and leaves customTitle unset (AE3)', async () => {
    const { ws, bot } = await setupWorkspace();
    injectConnection(ws.id, bot.id);

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/new'));

    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const activeSession = workspaceStore.getActiveUserSession(botUser.id);
    assert.ok(activeSession);
    const session = workspaceStore.getLocalSession(activeSession)!;
    assert.strictEqual(session.name, 'enc-user-1');
    assert.strictEqual(session.customTitle, undefined);
    assert.ok(sentMessages[0].content.includes('enc-user-1'));
  });

  it('/newer does not trigger a command (no session created)', async () => {
    const { ws, bot } = await setupWorkspace();
    injectConnection(ws.id, bot.id);

    // Create an existing session first
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const session = workspaceStore.createLocalSession(ws.id, 'existing', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(session.id);
    workspaceStore.addUserSession(ws.id, session.id, botUser.id);
    workspaceStore.setActiveUserSession(botUser.id, session.id);

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/newer idea'));

    // No new session should be created
    const sessions = workspaceStore.listLocalSessions(ws.id);
    assert.strictEqual(sessions.length, 1);
  });

  it('getOrCreateSession reuses the active session when one exists (R6)', async () => {
    const { ws, bot } = await setupWorkspace();
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const session = workspaceStore.createLocalSession(ws.id, 'active', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(session.id);
    workspaceStore.addUserSession(ws.id, session.id, botUser.id);
    workspaceStore.setActiveUserSession(botUser.id, session.id);

    const id = await (service as any).getOrCreateSession(ws.id, 'enc-user-1');
    assert.strictEqual(id, session.id);
  });

  it('getOrCreateSession creates and activates a fresh session when none is active (R8)', async () => {
    const { ws, bot } = await setupWorkspace();
    const id = await (service as any).getOrCreateSession(ws.id, 'enc-user-1');
    assert.ok(id);
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const activeSession = workspaceStore.getActiveUserSession(botUser.id);
    assert.strictEqual(activeSession, id);
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

  beforeEach(() => {
    service = new WeComBotService();
    sentBodies = [];
    pushedContents = [];

    chatService.pushMessage = (async (...args: unknown[]) => {
      pushedContents.push(args[2] as string);
    }) as any;
  });

  afterEach(() => {
    workspaceStore.resetData();
  });

  async function setupWorkspace() {
    const ws = await workspaceStore.create({ name: 'Resume Test', folderPath: '/tmp' });
    const bot = workspaceStore.createBot({ name: 'Resume Bot', activeWorkspaceId: ws.id });
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const role = workspaceStore.getBotRoleByKey(bot.id, 'normal')!;
    workspaceStore.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role.id,
      channelUserId: 'enc-user-1',
      plaintextUserId: null,
    });
    return { ws, bot, channel };
  }

  function injectConnection(wsId: string, botId: string) {
    (service as any).connections.set(botId, {
      client: {
        sendMessage: async (_userId: string, body: any) => {
          sentBodies.push(body);
        },
      },
      workspaceId: wsId,
      botId,
      folderPath: '/tmp',
      status: 'connected' as const,
    });
    (service as any).workspaceIdToBotId.set(wsId, botId);
    (service as any).botIdToWorkspaceId.set(botId, wsId);
  }

  function makeTextFrame(content: string, userid = 'enc-user-1') {
    return {
      headers: { req_id: 'r' },
      body: {
        msgid: 'm',
        aibotid: 'bot-1',
        chattype: 'single',
        from: { userid },
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
    const { ws, bot, channel } = await setupWorkspace();
    injectConnection(ws.id, bot.id);

    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const session = workspaceStore.createLocalSession(ws.id, 'sess-a', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(session.id);
    workspaceStore.addUserSession(ws.id, session.id, botUser.id);

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/resume'));
    assert.strictEqual(pushedContents.length, 0);
    assert.strictEqual(lastBody().msgtype, 'template_card');
  });

  it('card lists sessions with option id = sessionId and marks active (Covers AE5)', async () => {
    const { ws, bot, channel } = await setupWorkspace();
    injectConnection(ws.id, bot.id);

    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const sessionA = workspaceStore.createLocalSession(ws.id, 'sess-a', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(sessionA.id);
    workspaceStore.addUserSession(ws.id, sessionA.id, botUser.id);

    const sessionActive = workspaceStore.createLocalSession(ws.id, 'sess-active', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(sessionActive.id);
    workspaceStore.addUserSession(ws.id, sessionActive.id, botUser.id);
    workspaceStore.setActiveUserSession(botUser.id, sessionActive.id);

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/resume'));
    const card = lastCard();
    assert.ok(card);
    assert.strictEqual(card.card_type, 'multiple_interaction');
    const selector = card.select_list[0];
    const ids = selector.option_list.map((o: any) => o.id);
    assert.deepStrictEqual(ids.sort(), [sessionA.id, sessionActive.id].sort());
    const activeOpt = selector.option_list.find((o: any) => o.id === sessionActive.id);
    assert.ok(activeOpt?.text.includes('（当前）'));
  });

  it('excludes archived sessions and degrades to a text reply when none remain', async () => {
    const { ws, bot, channel } = await setupWorkspace();
    injectConnection(ws.id, bot.id);

    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const session = workspaceStore.createLocalSession(ws.id, 'sess-archived', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(session.id);
    workspaceStore.updateLocalSession(session.id, { isArchived: true });
    workspaceStore.addUserSession(ws.id, session.id, botUser.id);

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/resume'));
    assert.strictEqual(lastBody().msgtype, 'markdown');
    assert.ok((lastBody() as any).markdown.content.includes('暂无会话可恢复'));
  });

  it('truncates to the cap when over N (Covers AE3/F4)', async () => {
    const { ws, bot, channel } = await setupWorkspace();
    injectConnection(ws.id, bot.id);

    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    for (let i = 0; i < 12; i++) {
      const session = workspaceStore.createLocalSession(ws.id, `s${i}`, undefined, undefined, 'wecom', undefined, bot.id);
      workspaceStore.clearDraftFlag(session.id);
      workspaceStore.addUserSession(ws.id, session.id, botUser.id);
    }

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/resume'));
    assert.strictEqual(lastCard().select_list[0].option_list.length, 10);
  });

  it('still sends a card with a single session (Covers AE2/F3)', async () => {
    const { ws, bot, channel } = await setupWorkspace();
    injectConnection(ws.id, bot.id);

    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const session = workspaceStore.createLocalSession(ws.id, 'sess-only', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(session.id);
    workspaceStore.addUserSession(ws.id, session.id, botUser.id);
    workspaceStore.setActiveUserSession(botUser.id, session.id);

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/resume'));
    assert.strictEqual(lastCard().select_list[0].option_list.length, 1);
  });

  it('ignores trailing text after /resume (R2)', async () => {
    const { ws, bot, channel } = await setupWorkspace();
    injectConnection(ws.id, bot.id);

    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const session = workspaceStore.createLocalSession(ws.id, 'sess-a', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(session.id);
    workspaceStore.addUserSession(ws.id, session.id, botUser.id);

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/resume ignored args'));
    assert.strictEqual(pushedContents.length, 0);
    assert.strictEqual(lastBody().msgtype, 'template_card');
  });
});

describe('WeComBotService /resume submit (stateless switch)', { concurrency: false }, () => {
  let service: WeComBotService;
  let tempDir: string;
  let sentMessages: Array<{ userId: string; content: string }>;
  let updatedCards: Array<{ card: any }>;

  beforeEach(async () => {
    service = new WeComBotService();
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'wecom-resume-submit-'));
    sentMessages = [];
    updatedCards = [];

    const ws = await workspaceStore.create({ name: 'Resume Submit Test', folderPath: tempDir });
    const bot = workspaceStore.createBot({ name: 'Resume Bot', activeWorkspaceId: ws.id });
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const role = workspaceStore.getBotRoleByKey(bot.id, 'normal')!;
    workspaceStore.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role.id,
      channelUserId: 'owner-1',
      plaintextUserId: null,
    });

    // Inject connection
    (service as any).connections.set(bot.id, {
      client: {
        sendMessage: async (userId: string, body: any) => {
          sentMessages.push({ userId, content: body.markdown?.content ?? '' });
        },
        updateTemplateCard: async (_frame: any, card: any) => {
          updatedCards.push({ card });
        },
      },
      workspaceId: ws.id,
      botId: bot.id,
      folderPath: tempDir,
      status: 'connected' as const,
    });
    (service as any).workspaceIdToBotId.set(ws.id, bot.id);
    (service as any).botIdToWorkspaceId.set(bot.id, ws.id);
  });

  afterEach(async () => {
    workspaceStore.resetData();
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

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
    const ws = (await workspaceStore.list())[0];
    const bot = workspaceStore.listBotsForWorkspace(ws.id)[0];
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'owner-1')!;

    const sourceSession = workspaceStore.createLocalSession(ws.id, 'source', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(sourceSession.id);
    workspaceStore.addUserSession(ws.id, sourceSession.id, botUser.id);

    const targetSession = workspaceStore.createLocalSession(ws.id, 'target', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(targetSession.id);
    workspaceStore.addUserSession(ws.id, targetSession.id, botUser.id);
    workspaceStore.setActiveUserSession(botUser.id, sourceSession.id);

    await (service as any).handleTemplateCardEvent(ws.id, makeResumeEvent(sourceSession.id, targetSession.id));

    const activeSession = workspaceStore.getActiveUserSession(botUser.id);
    assert.strictEqual(activeSession, targetSession.id);
    assert.strictEqual(updatedCards[0].card.replace_text, '已恢复会话');
    assert.strictEqual(updatedCards[0].card.submit_button?.text, '已恢复会话');
    assert.ok(sentMessages.some((m) => m.content.includes('target')));
  });

  it('rejects when the target session is not owned by the submitter (Covers AE6/R12)', async () => {
    const ws = (await workspaceStore.list())[0];
    const bot = workspaceStore.listBotsForWorkspace(ws.id)[0];
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;

    // Create another user
    const role = workspaceStore.getBotRoleByKey(bot.id, 'normal')!;
    workspaceStore.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role.id,
      channelUserId: 'other-user',
      plaintextUserId: null,
    });

    const otherUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'other-user')!;
    const targetSession = workspaceStore.createLocalSession(ws.id, 'target', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(targetSession.id);
    workspaceStore.addUserSession(ws.id, targetSession.id, otherUser.id);
    workspaceStore.setActiveUserSession(otherUser.id, targetSession.id);

    await (service as any).handleTemplateCardEvent(ws.id, makeResumeEvent('source-id', targetSession.id, 'owner-1'));
    assert.strictEqual(updatedCards[0].card.replace_text, '无法操作该会话');
  });

  it('rejects when the selected option id is missing (Covers AE6/R12)', async () => {
    const ws = (await workspaceStore.list())[0];
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
    await (service as any).handleTemplateCardEvent(ws.id, frame);
    assert.strictEqual(updatedCards[0].card.replace_text, '无法操作该会话');
  });

  it('a repeat submit is handled without error (idempotent at the store layer)', async () => {
    const ws = (await workspaceStore.list())[0];
    const bot = workspaceStore.listBotsForWorkspace(ws.id)[0];
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'owner-1')!;

    const sourceSession = workspaceStore.createLocalSession(ws.id, 'source', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(sourceSession.id);
    workspaceStore.addUserSession(ws.id, sourceSession.id, botUser.id);

    const targetSession = workspaceStore.createLocalSession(ws.id, 'target', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(targetSession.id);
    workspaceStore.addUserSession(ws.id, targetSession.id, botUser.id);
    workspaceStore.setActiveUserSession(botUser.id, sourceSession.id);

    await (service as any).handleTemplateCardEvent(ws.id, makeResumeEvent(sourceSession.id, targetSession.id));
    // Clear the per-user rate-limit window so the second event is processed.
    (service as any).cardClickRateLimit.clear();
    await (service as any).handleTemplateCardEvent(ws.id, makeResumeEvent(sourceSession.id, targetSession.id));

    const activeSession = workspaceStore.getActiveUserSession(botUser.id);
    assert.strictEqual(activeSession, targetSession.id);
  });

  it('updates the card to terminal BEFORE sending the confirmation (WeCom 5s update window)', async () => {
    const ws = (await workspaceStore.list())[0];
    const bot = workspaceStore.listBotsForWorkspace(ws.id)[0];
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'owner-1')!;

    const sourceSession = workspaceStore.createLocalSession(ws.id, 'source', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(sourceSession.id);
    workspaceStore.addUserSession(ws.id, sourceSession.id, botUser.id);

    const targetSession = workspaceStore.createLocalSession(ws.id, 'target', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(targetSession.id);
    workspaceStore.addUserSession(ws.id, targetSession.id, botUser.id);
    workspaceStore.setActiveUserSession(botUser.id, sourceSession.id);

    const calls: string[] = [];
    const conn = (service as any).connections.get(bot.id);
    conn.client.sendMessage = async () => {
      calls.push('send');
    };
    conn.client.updateTemplateCard = async () => {
      calls.push('update');
    };

    await (service as any).handleTemplateCardEvent(ws.id, makeResumeEvent(sourceSession.id, targetSession.id));

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

  beforeEach(() => {
    service = new WeComBotService();
    sentMessages = [];
    interruptCalls = [];
    cancelPendingApprovalsCalls = [];
    streamReplyInterruptCalls = [];
  });

  afterEach(() => {
    workspaceStore.resetData();
  });

  async function setupWorkspace() {
    const ws = await workspaceStore.create({ name: 'Stop Test', folderPath: '/tmp' });
    const bot = workspaceStore.createBot({ name: 'Stop Bot', activeWorkspaceId: ws.id });
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const role = workspaceStore.getBotRoleByKey(bot.id, 'normal')!;
    workspaceStore.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role.id,
      channelUserId: 'enc-user-1',
      plaintextUserId: null,
    });
    return { ws, bot, channel };
  }

  function createMockConnection(wsId: string, botId: string) {
    return {
      client: {
        replyStream: async () => {},
        replyStreamNonBlocking: async () => {},
        sendMessage: async (userId: string, body: any) => {
          sentMessages.push({ userId, body });
        },
      },
      workspaceId: wsId,
      botId,
      folderPath: '/tmp',
      status: 'connected' as const,
    };
  }

  function injectConnection(conn: any) {
    (service as any).connections.set(conn.botId, conn);
    (service as any).workspaceIdToBotId.set(conn.workspaceId, conn.botId);
    (service as any).botIdToWorkspaceId.set(conn.botId, conn.workspaceId);
  }

  function makeTextFrame(content: string, userid = 'enc-user-1') {
    return {
      headers: { req_id: 'req-1' },
      body: {
        msgid: 'msg-1',
        aibotid: 'bot-1',
        chattype: 'single',
        from: { userid },
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
    const { ws, bot, channel } = await setupWorkspace();
    const conn = createMockConnection(ws.id, bot.id);
    injectConnection(conn);

    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const session = workspaceStore.createLocalSession(ws.id, 'stop-test', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(session.id);
    workspaceStore.addUserSession(ws.id, session.id, botUser.id);
    workspaceStore.setActiveUserSession(botUser.id, session.id);

    setRuntime(true);
    injectStreamReply(session.id, true);

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/stop'));

    assert.strictEqual(interruptCalls.length, 1);
    assert.strictEqual(cancelPendingApprovalsCalls.length, 1);
    assert.strictEqual(streamReplyInterruptCalls.length, 1);
    assert.strictEqual(streamReplyInterruptCalls[0].sessionId, session.id);
    assert.strictEqual(streamReplyInterruptCalls[0].message, '已中断');
    assert.strictEqual(
      sentMessages.filter((m) => m.body.markdown?.content === '已中断').length,
      1,
      'confirmation should also be sent proactively so the user always receives it',
    );
  });

  it('sends proactive confirmation even when the stream reply delivery path may be stale', async () => {
    const { ws, bot, channel } = await setupWorkspace();
    const conn = createMockConnection(ws.id, bot.id);
    injectConnection(conn);

    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const session = workspaceStore.createLocalSession(ws.id, 'stop-test', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(session.id);
    workspaceStore.addUserSession(ws.id, session.id, botUser.id);
    workspaceStore.setActiveUserSession(botUser.id, session.id);

    setRuntime(true);

    // Simulate an active stream reply whose own connection is stale/dead.
    (service as any).activeStreamReplies.set(session.id, {
      interrupt: (message: string) => {
        streamReplyInterruptCalls.push({ sessionId: session.id, message });
        return true;
      },
    });

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/stop'));

    assert.strictEqual(streamReplyInterruptCalls.length, 1);
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].userId, 'enc-user-1');
    assert.strictEqual(sentMessages[0].body.markdown.content, '已中断');
  });

  it('replies with no active session message when none exists (R2)', async () => {
    const { ws, bot } = await setupWorkspace();
    const conn = createMockConnection(ws.id, bot.id);
    injectConnection(conn);

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/stop'));

    assert.strictEqual(interruptCalls.length, 0);
    assert.strictEqual(sentMessages.length, 1);
    assert.ok(sentMessages[0].body.markdown.content.includes('没有活跃的会话可中断'));
  });

  it('replies with nothing in flight when runtime is idle (R3)', async () => {
    const { ws, bot, channel } = await setupWorkspace();
    const conn = createMockConnection(ws.id, bot.id);
    injectConnection(conn);

    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const session = workspaceStore.createLocalSession(ws.id, 'stop-test', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(session.id);
    workspaceStore.addUserSession(ws.id, session.id, botUser.id);
    workspaceStore.setActiveUserSession(botUser.id, session.id);

    setRuntime(false);

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/stop'));

    assert.strictEqual(interruptCalls.length, 0);
    assert.strictEqual(sentMessages.length, 1);
    assert.ok(sentMessages[0].body.markdown.content.includes('当前没有正在进行的对话'));
  });

  it('replies with nothing in flight when runtime is missing (R3)', async () => {
    const { ws, bot, channel } = await setupWorkspace();
    const conn = createMockConnection(ws.id, bot.id);
    injectConnection(conn);

    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const session = workspaceStore.createLocalSession(ws.id, 'stop-test', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(session.id);
    workspaceStore.addUserSession(ws.id, session.id, botUser.id);
    workspaceStore.setActiveUserSession(botUser.id, session.id);

    chatService.getRuntimeIfExists = () => undefined;

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/stop'));

    assert.strictEqual(interruptCalls.length, 0);
    assert.strictEqual(sentMessages.length, 1);
    assert.ok(sentMessages[0].body.markdown.content.includes('当前没有正在进行的对话'));
  });

  it('cancels pending approvals after interrupt (R5)', async () => {
    const { ws, bot, channel } = await setupWorkspace();
    const conn = createMockConnection(ws.id, bot.id);
    injectConnection(conn);

    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const session = workspaceStore.createLocalSession(ws.id, 'stop-test', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(session.id);
    workspaceStore.addUserSession(ws.id, session.id, botUser.id);
    workspaceStore.setActiveUserSession(botUser.id, session.id);

    setRuntime(true);
    injectStreamReply(session.id, true);

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/stop'));

    assert.strictEqual(interruptCalls.length, 1);
    assert.strictEqual(cancelPendingApprovalsCalls.length, 1);
    assert.strictEqual(cancelPendingApprovalsCalls[0], 'Turn interrupted by user.');
  });

  it('falls back to a standalone confirmation when no stream reply is active', async () => {
    const { ws, bot, channel } = await setupWorkspace();
    const conn = createMockConnection(ws.id, bot.id);
    injectConnection(conn);

    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const session = workspaceStore.createLocalSession(ws.id, 'stop-test', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(session.id);
    workspaceStore.addUserSession(ws.id, session.id, botUser.id);
    workspaceStore.setActiveUserSession(botUser.id, session.id);

    setRuntime(true);

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/stop'));

    assert.strictEqual(streamReplyInterruptCalls.length, 0);
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].userId, 'enc-user-1');
    assert.strictEqual(sentMessages[0].body.msgtype, 'markdown');
    assert.strictEqual(sentMessages[0].body.markdown.content, '已中断');
  });

  it('falls back to a standalone confirmation when the stream reply is past the safeguard', async () => {
    const { ws, bot, channel } = await setupWorkspace();
    const conn = createMockConnection(ws.id, bot.id);
    injectConnection(conn);

    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const session = workspaceStore.createLocalSession(ws.id, 'stop-test', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(session.id);
    workspaceStore.addUserSession(ws.id, session.id, botUser.id);
    workspaceStore.setActiveUserSession(botUser.id, session.id);

    setRuntime(true);
    injectStreamReply(session.id, false);

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/stop'));

    assert.strictEqual(streamReplyInterruptCalls.length, 1);
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].body.markdown.content, '已中断');
  });

  it('does not crash the bot when interrupt fails (R7)', async () => {
    const { ws, bot, channel } = await setupWorkspace();
    const conn = createMockConnection(ws.id, bot.id);
    injectConnection(conn);

    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const session = workspaceStore.createLocalSession(ws.id, 'stop-test', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(session.id);
    workspaceStore.addUserSession(ws.id, session.id, botUser.id);
    workspaceStore.setActiveUserSession(botUser.id, session.id);

    setRuntime(true, true);

    await assert.doesNotReject(async () => {
      await (service as any).handleTextMessage(ws.id, makeTextFrame('/stop'));
    });

    assert.strictEqual(interruptCalls.length, 1);
    assert.strictEqual(sentMessages.length, 1);
    assert.ok(sentMessages[0].body.markdown.content.includes('中断会话失败'));
  });

  it('does not create a new session when /stop is sent (R1)', async () => {
    const { ws, bot } = await setupWorkspace();
    const conn = createMockConnection(ws.id, bot.id);
    injectConnection(conn);

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/stop'));

    const sessions = workspaceStore.listLocalSessions(ws.id);
    assert.strictEqual(sessions.length, 0);
    assert.strictEqual(sentMessages.length, 1);
  });

  it('keeps the stream reply active after replacing a stale bot handler (regression)', async () => {
    const { ws, bot, channel } = await setupWorkspace();
    const conn = createMockConnection(ws.id, bot.id);
    injectConnection(conn);

    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const session = workspaceStore.createLocalSession(ws.id, 'regression-test', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(session.id);
    workspaceStore.addUserSession(ws.id, session.id, botUser.id);
    workspaceStore.setActiveUserSession(botUser.id, session.id);

    let currentHandler: any;
    let processing = false;
    const staleHandler = Object.assign(() => {}, {
      cleanup: () => {
        (service as any).activeStreamReplies.delete(session.id);
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

    // First message creates a stream reply while a runtime already exists.
    await (service as any).handleTextMessage(ws.id, makeTextFrame('hello'));

    assert.ok(
      (service as any).activeStreamReplies.get(session.id),
      'stream reply should stay active after replacing a stale handler',
    );

    // /stop should append the confirmation to the stream reply and also send a
    // proactive confirmation so the user reliably receives feedback.
    await (service as any).handleTextMessage(ws.id, makeTextFrame('/stop'));

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

  let sentMessages: Array<{ userId: string; body: any }>;
  let updatedCards: Array<{ card: any }>;

  beforeEach(async () => {
    service = new WeComBotService();
    sentMessages = [];
    updatedCards = [];

    tempDirA = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'wecom-ws-a-'));
    tempDirB = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'wecom-ws-b-'));
  });

  afterEach(async () => {
    workspaceStore.resetData();
    await fsPromises.rm(tempDirA, { recursive: true, force: true }).catch(() => {});
    await fsPromises.rm(tempDirB, { recursive: true, force: true }).catch(() => {});
  });

  async function setupWorkspaces() {
    const wsA = await workspaceStore.create({ name: 'Workspace A', folderPath: tempDirA });
    const wsB = await workspaceStore.create({ name: 'Workspace B', folderPath: tempDirB });
    const bot = workspaceStore.createBot({
      name: 'Test Bot',
      activeWorkspaceId: wsA.id,
      channelSettings: {
        wecom: {
          enabled: true,
          botId: 'wecom-bot-id',
          botSecret: 'wecom-bot-secret',
        },
      },
    });
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const ownerRole = workspaceStore.getBotRoleByKey(bot.id, 'owner')!;
    const normalRole = workspaceStore.getBotRoleByKey(bot.id, 'normal')!;
    workspaceStore.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: ownerRole.id,
      channelUserId: 'owner-1',
      plaintextUserId: null,
    });
    workspaceStore.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: normalRole.id,
      channelUserId: 'user-1',
      plaintextUserId: null,
    });
    return { wsA, wsB, bot };
  }

  function injectConnection(wsAId: string, botId: string) {
    const conn = {
      client: {
        sendMessage: async (userId: string, body: any) => {
          sentMessages.push({ userId, body });
        },
        updateTemplateCard: async (_frame: any, card: any) => {
          updatedCards.push({ card });
        },
      },
      workspaceId: wsAId,
      botId,
      folderPath: tempDirA,
      status: 'connected' as const,
    };
    (service as any).connections.set(botId, conn);
    (service as any).workspaceIdToBotId.set(wsAId, botId);
    (service as any).botIdToWorkspaceId.set(botId, wsAId);
  }

  function makeTextFrame(content: string, userid = 'owner-1') {
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

  function makeWorkspaceSubmitEvent(targetWorkspaceId: string, botId: string, userid = 'owner-1') {
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
    const { wsA, bot } = await setupWorkspaces();
    injectConnection(wsA.id, bot.id);

    await (service as any).handleTextMessage(wsA.id, makeTextFrame('/workspace', 'user-1'));

    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].body.msgtype, 'markdown');
    assert.ok(sentMessages[0].body.markdown.content.includes('没有权限'));
  });

  it('/workspace sends a workspace list card to Owners with the active workspace highlighted', async () => {
    const { wsA, bot } = await setupWorkspaces();
    injectConnection(wsA.id, bot.id);

    await (service as any).handleTextMessage(wsA.id, makeTextFrame('/workspace', 'owner-1'));

    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].body.msgtype, 'template_card');
    const card = sentMessages[0].body.template_card;
    assert.strictEqual(card.card_type, 'vote_interaction');
    assert.strictEqual(card.checkbox.option_list.length, 2);
    const activeOption = card.checkbox.option_list.find((o: any) => o.id === wsA.id);
    assert.ok(activeOption.text.includes('（当前）'));
  });

  it('select_workspace switches the active workspace, updates routing maps, and confirms', async () => {
    const { wsA, wsB, bot } = await setupWorkspaces();
    injectConnection(wsA.id, bot.id);

    await (service as any).handleTemplateCardEvent(wsA.id, makeWorkspaceSubmitEvent(wsB.id, bot.id));

    assert.strictEqual(botService.resolveActiveWorkspace(bot.id), wsB.id);
    assert.strictEqual((service as any).botIdToWorkspaceId.get(bot.id), wsB.id);
    assert.strictEqual((service as any).workspaceIdToBotId.get(wsB.id), bot.id);
    assert.strictEqual((service as any).connections.get(bot.id).workspaceId, wsB.id);

    assert.strictEqual(updatedCards.length, 1);
    assert.ok(updatedCards[0].card.replace_text.includes('已切换到工作空间'));
    assert.ok(sentMessages.some((m) => m.body.markdown?.content.includes('已切换到工作空间')));
  });

  it('select_workspace rejects non-Owners', async () => {
    const { wsA, wsB, bot } = await setupWorkspaces();
    injectConnection(wsA.id, bot.id);

    await (service as any).handleTemplateCardEvent(
      wsA.id,
      makeWorkspaceSubmitEvent(wsB.id, bot.id, 'user-1'),
    );

    assert.strictEqual(botService.resolveActiveWorkspace(bot.id), wsA.id);
    assert.strictEqual(updatedCards[0].card.replace_text, '你没有权限切换工作空间');
  });

  it('select_workspace best-effort notifies users in the previous workspace', async () => {
    const { wsA, wsB, bot } = await setupWorkspaces();
    injectConnection(wsA.id, bot.id);

    // Add a previous workspace user
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const normalRole = workspaceStore.getBotRoleByKey(bot.id, 'normal')!;
    workspaceStore.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: normalRole.id,
      channelUserId: 'prev-user-1',
      plaintextUserId: null,
    });

    await (service as any).handleTemplateCardEvent(wsA.id, makeWorkspaceSubmitEvent(wsB.id, bot.id));

    // The workspace switch notification to the acting user is always sent.
    const switchNotification = sentMessages.find((m) => m.userId === 'owner-1');
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

  beforeEach(() => {
    service = new WeComBotService();
    sentMessages = [];
  });

  afterEach(() => {
    workspaceStore.resetData();
  });

  async function setupWorkspace() {
    const ws = await workspaceStore.create({ name: 'Test Workspace', folderPath: '/tmp' });
    const bot = workspaceStore.createBot({ name: 'Status Bot', activeWorkspaceId: ws.id });
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const role = workspaceStore.getBotRoleByKey(bot.id, 'normal')!;
    workspaceStore.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role.id,
      channelUserId: 'enc-user-1',
      plaintextUserId: null,
    });
    return { ws, bot, channel };
  }

  function injectConnection(wsId: string, botId: string) {
    (service as any).connections.set(botId, {
      client: {
        sendMessage: async (userId: string, body: any) => {
          sentMessages.push({ userId, body });
        },
      },
      workspaceId: wsId,
      botId,
      folderPath: '/tmp',
      status: 'connected' as const,
    });
    (service as any).workspaceIdToBotId.set(wsId, botId);
    (service as any).botIdToWorkspaceId.set(botId, wsId);
  }

  function makeTextFrame(content: string, userid = 'enc-user-1') {
    return {
      headers: { req_id: 'r' },
      body: {
        msgid: 'm',
        aibotid: 'bot-1',
        chattype: 'single',
        from: { userid },
        msgtype: 'text',
        text: { content },
      },
    };
  }

  it('/status replies with workspace name and active session name', async () => {
    const { ws, bot, channel } = await setupWorkspace();
    injectConnection(ws.id, bot.id);

    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const session = workspaceStore.createLocalSession(ws.id, 'Active Session', undefined, undefined, 'wecom', 'Active Custom', bot.id);
    workspaceStore.clearDraftFlag(session.id);
    workspaceStore.addUserSession(ws.id, session.id, botUser.id);
    workspaceStore.setActiveUserSession(botUser.id, session.id);

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/status'));

    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].body.msgtype, 'markdown');
    const content = sentMessages[0].body.markdown.content;
    assert.ok(content.includes('Test Workspace'));
    assert.ok(content.includes('Active Custom'));
    assert.ok(!content.includes('Active Session'));
  });

  it('/status falls back to session name when customTitle is absent', async () => {
    const { ws, bot, channel } = await setupWorkspace();
    injectConnection(ws.id, bot.id);

    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const session = workspaceStore.createLocalSession(ws.id, 'Active Session', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(session.id);
    workspaceStore.addUserSession(ws.id, session.id, botUser.id);
    workspaceStore.setActiveUserSession(botUser.id, session.id);

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/status'));

    assert.ok(sentMessages[0].body.markdown.content.includes('Active Session'));
  });

  it('/status replies with no active session message when none exists', async () => {
    const { ws, bot } = await setupWorkspace();
    injectConnection(ws.id, bot.id);

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/status'));

    assert.strictEqual(sentMessages.length, 1);
    const content = sentMessages[0].body.markdown.content;
    assert.ok(content.includes('Test Workspace'));
    assert.ok(content.includes('暂无活跃会话'));
  });

  it('/status replies with binding hint when workspace is missing', async () => {
    injectConnection('missing-ws', 'missing-bot');

    await (service as any).handleTextMessage('missing-ws', makeTextFrame('/status'));

    assert.strictEqual(sentMessages.length, 1);
    assert.ok(sentMessages[0].body.markdown.content.includes('机器人尚未绑定工作空间'));
  });

  it('/status replies with a fallback error when session lookup fails', async () => {
    const { ws, bot, channel } = await setupWorkspace();
    injectConnection(ws.id, bot.id);

    const botUser = workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, 'enc-user-1')!;
    const session = workspaceStore.createLocalSession(ws.id, 'fail-test', undefined, undefined, 'wecom', undefined, bot.id);
    workspaceStore.clearDraftFlag(session.id);
    workspaceStore.addUserSession(ws.id, session.id, botUser.id);
    workspaceStore.setActiveUserSession(botUser.id, session.id);

    // Force session lookup to fail while the active-session record remains valid.
    chatService.getSession = async () => {
      throw new Error('session lookup failed');
    };

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/status'));

    assert.strictEqual(sentMessages.length, 1);
    const content = sentMessages[0].body.markdown.content;
    assert.ok(content.includes('Test Workspace'));
    assert.ok(content.includes('读取会话失败'));
  });

  it('/status is intercepted and not forwarded to the agent', async () => {
    const { ws, bot } = await setupWorkspace();
    injectConnection(ws.id, bot.id);

    let pushed = false;
    chatService.pushMessage = (async () => {
      pushed = true;
    }) as any;

    await (service as any).handleTextMessage(ws.id, makeTextFrame('/status'));

    assert.strictEqual(sentMessages.length, 1);
    assert.ok(!pushed);
  });
});

describe('auto-add bot members on first inbound message', { concurrency: false }, () => {
  let service: WeComBotService;

  beforeEach(async () => {
    service = new WeComBotService();

    const ws = await workspaceStore.create({ name: 'Auto-add Workspace', folderPath: '/tmp/auto-add' });
    const bot = workspaceStore.createBot({
      name: 'Auto-add Bot',
      activeWorkspaceId: ws.id,
      channelSettings: {
        wecom: { enabled: true, botId: 'wecom-bot-id', botSecret: 'wecom-bot-secret' },
      },
    });
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const ownerRole = workspaceStore.getBotRoleByKey(bot.id, 'owner')!;
    workspaceStore.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: ownerRole.id,
      channelUserId: 'owner-1',
      plaintextUserId: null,
    });

    (service as any).connections.set(bot.id, {
      client: { sendMessage: async () => {}, replyStream: async () => {} },
      workspaceId: ws.id,
      botId: bot.id,
      folderPath: ws.folderPath,
      status: 'connected' as const,
    });
    (service as any).workspaceIdToBotId.set(ws.id, bot.id);
    (service as any).botIdToWorkspaceId.set(bot.id, ws.id);

    chatService.getOrCreateRuntime = async () =>
      ({ pushMessage: () => {} }) as any;
  });

  afterEach(() => {
    workspaceStore.resetData();
  });

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
    const ws = (await workspaceStore.list())[0];
    const bot = workspaceStore.listBotsForWorkspace(ws.id)[0];

    assert.strictEqual(botService.getMemberRole(bot.id, 'wecom', 'new-user-1'), null);

    await (service as any).handleTextMessage(ws.id, makeTextFrame('new-user-1'));

    assert.strictEqual(botService.getMemberRole(bot.id, 'wecom', 'new-user-1'), 'normal');
  });

  it('does not overwrite an existing member role on repeat messages', async () => {
    const ws = (await workspaceStore.list())[0];
    const bot = workspaceStore.listBotsForWorkspace(ws.id)[0];
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom')!;
    const adminRole = workspaceStore.getBotRoleByKey(bot.id, 'admin')!;
    workspaceStore.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: adminRole.id,
      channelUserId: 'new-user-1',
      plaintextUserId: null,
    });

    assert.strictEqual(botService.getMemberRole(bot.id, 'wecom', 'new-user-1'), 'admin');

    await (service as any).handleTextMessage(ws.id, makeTextFrame('new-user-1'));

    assert.strictEqual(botService.getMemberRole(bot.id, 'wecom', 'new-user-1'), 'admin');
  });

  it('does not downgrade the channel owner', async () => {
    const ws = (await workspaceStore.list())[0];
    const bot = workspaceStore.listBotsForWorkspace(ws.id)[0];

    await (service as any).handleTextMessage(ws.id, makeTextFrame('owner-1'));

    assert.strictEqual(botService.getMemberRole(bot.id, 'wecom', 'owner-1'), 'owner');
  });
});
