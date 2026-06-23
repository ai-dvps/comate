import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { FeishuBotService } from './feishu-bot-service.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import { feishuUserResolver } from './feishu-user-resolver.js';
import type { SseEvent } from '../types/message.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MockThread {
  id: string;
  channelId: string;
  isDM: boolean;
  posts: Array<{ type: 'text' | 'stream'; value: unknown }>;
  post(value: unknown): Promise<void>;
}

interface MockLarkClient {
  cardkit: {
    v1: {
      card: {
        create: (args: { data: { type: string; data: string } }) => Promise<unknown>;
        settings: (args: { path: { card_id: string }; data: { settings: string; sequence: number; uuid: string } }) => Promise<unknown>;
      };
      cardElement: {
        content: (args: { path: { card_id: string; element_id: string }; data: { content: string; sequence: number; uuid: string } }) => Promise<unknown>;
      };
    };
  };
  im: {
    v1: {
      message: {
        create: (args: { params: { receive_id_type: string }; data: { receive_id: string; msg_type: string; content: string } }) => Promise<unknown>;
      };
    };
  };
}

describe('FeishuBotService', () => {
  let service: FeishuBotService;
  let thread: MockThread;
  let originalGetFeishuActiveWorkspace: typeof workspaceStore.getFeishuActiveWorkspace;
  let originalGetFeishuActiveSession: typeof workspaceStore.getFeishuActiveSession;
  let originalSetFeishuActiveSession: typeof workspaceStore.setFeishuActiveSession;
  let originalAddFeishuUserSession: typeof workspaceStore.addFeishuUserSession;
  let originalListFeishuSessionsByUser: typeof workspaceStore.listFeishuSessionsByUser;
  let originalList: typeof workspaceStore.list;
  let originalGet: typeof workspaceStore.get;
  let originalChatServiceCreateSession: typeof chatService.createSession;
  let originalChatServiceGetSession: typeof chatService.getSession;
  let originalChatServicePushMessage: typeof chatService.pushMessage;
  let originalFeishuUserResolverResolveOnMessage: typeof feishuUserResolver.resolveOnMessage;
  let createdSessions: Array<{ workspaceId: string; name: string; source?: string }>;
  let activeSessions: Map<string, string>;
  let userSessions: Array<{ workspaceId: string; feishuUserId: string; sessionId: string }>;
  let resolverCalls: Array<{ workspaceId: string; openId: string }>;

  let larkCalls: Array<{ method: string; args: unknown }>;

  const feishuUserId = 'ou_123';

  const workspace = {
    id: 'ws-1',
    name: 'Test Workspace',
    folderPath: '/tmp/test',
    settings: {
      feishuBotEnabled: true,
      feishuAdminUserIds: [feishuUserId],
    },
  } as import('../models/workspace.js').Workspace;

  beforeEach(() => {
    service = new FeishuBotService();

    thread = {
      id: 'lark:oc_thread:root',
      channelId: 'oc_thread',
      isDM: true,
      posts: [],
      async post(value) {
        if (typeof value === 'string') {
          this.posts.push({ type: 'text', value });
        } else {
          this.posts.push({ type: 'stream', value });
        }
      },
    };

    createdSessions = [];
    activeSessions = new Map();
    userSessions = [];
    resolverCalls = [];
    larkCalls = [];

    originalGetFeishuActiveWorkspace = workspaceStore.getFeishuActiveWorkspace.bind(workspaceStore);
    originalGetFeishuActiveSession = workspaceStore.getFeishuActiveSession.bind(workspaceStore);
    originalSetFeishuActiveSession = workspaceStore.setFeishuActiveSession.bind(workspaceStore);
    originalAddFeishuUserSession = workspaceStore.addFeishuUserSession.bind(workspaceStore);
    originalListFeishuSessionsByUser = workspaceStore.listFeishuSessionsByUser.bind(workspaceStore);
    originalList = workspaceStore.list.bind(workspaceStore);
    originalGet = workspaceStore.get.bind(workspaceStore);
    originalChatServiceCreateSession = chatService.createSession.bind(chatService);
    originalChatServiceGetSession = chatService.getSession.bind(chatService);
    originalChatServicePushMessage = chatService.pushMessage.bind(chatService);
    originalFeishuUserResolverResolveOnMessage = feishuUserResolver.resolveOnMessage.bind(feishuUserResolver);

    workspaceStore.resetData();
    feishuUserResolver.resolveOnMessage = async (workspaceId: string, openId: string) => {
      resolverCalls.push({ workspaceId, openId });
    };

    workspaceStore.getFeishuActiveWorkspace = () => workspace.id;
    workspaceStore.get = async () => workspace;
    workspaceStore.getFeishuActiveSession = (workspaceId: string, userId: string) => {
      return activeSessions.get(`${workspaceId}:${userId}`) ?? null;
    };
    workspaceStore.setFeishuActiveSession = (workspaceId: string, userId: string, sessionId: string) => {
      activeSessions.set(`${workspaceId}:${userId}`, sessionId);
    };
    workspaceStore.addFeishuUserSession = (workspaceId: string, userId: string, sessionId: string) => {
      userSessions.push({ workspaceId, feishuUserId: userId, sessionId });
    };
    workspaceStore.listFeishuSessionsByUser = () => [];
    workspaceStore.list = async () => [workspace];

    let sessionCounter = 0;
    chatService.createSession = async (input) => {
      sessionCounter += 1;
      createdSessions.push({ workspaceId: input.workspaceId, name: input.name, source: input.source });
      return {
        id: `session-${sessionCounter}`,
        workspaceId: input.workspaceId,
        name: input.name,
        source: input.source ?? 'gui',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as import('../models/session.js').ChatSession;
    };
    chatService.getSession = async (sessionId: string, workspaceId: string) => {
      const created = createdSessions.find((s) => s.workspaceId === workspaceId);
      if (created) {
        return {
          id: sessionId,
          workspaceId,
          name: created.name,
          source: created.source ?? 'gui',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as import('../models/session.js').ChatSession;
      }
      return null;
    };
    chatService.pushMessage = async () => {
      // no-op: we only verify it was called
    };

    // Inject a minimal larkClient so FeishuStreamReply can be instantiated
    (service as unknown as { connection: { larkClient: MockLarkClient } }).connection = {
      larkClient: {
        cardkit: {
          v1: {
            card: {
              create: async (args: { data: { type: string; data: string } }) => {
                larkCalls.push({ method: 'card.create', args });
                return { data: { card_id: 'card-1' } };
              },
              settings: async (args: { path: { card_id: string }; data: { settings: string; sequence: number; uuid: string } }) => {
                larkCalls.push({ method: 'card.settings', args });
                return { data: {} };
              },
            },
            cardElement: {
              content: async (args: { path: { card_id: string; element_id: string }; data: { content: string; sequence: number; uuid: string } }) => {
                larkCalls.push({ method: 'cardElement.content', args });
                return { data: {} };
              },
            },
          },
        },
        im: {
          v1: {
            message: {
              create: async (args: {
                params: { receive_id_type: string };
                data: { receive_id: string; msg_type: string; content: string };
              }) => {
                larkCalls.push({ method: 'im.message.create', args });
                return { data: { message_id: 'msg-1' } };
              },
            },
          },
        },
      },
    };
    // Inject workspace binding so requireActiveWorkspace succeeds
    (service as unknown as { connection: { workspaceId: string } }).connection.workspaceId = workspace.id;
  });

  afterEach(() => {
    workspaceStore.getFeishuActiveWorkspace = originalGetFeishuActiveWorkspace;
    workspaceStore.getFeishuActiveSession = originalGetFeishuActiveSession;
    workspaceStore.setFeishuActiveSession = originalSetFeishuActiveSession;
    workspaceStore.addFeishuUserSession = originalAddFeishuUserSession;
    workspaceStore.listFeishuSessionsByUser = originalListFeishuSessionsByUser;
    workspaceStore.list = originalList;
    workspaceStore.get = originalGet;
    chatService.createSession = originalChatServiceCreateSession;
    chatService.getSession = originalChatServiceGetSession;
    chatService.pushMessage = originalChatServicePushMessage;
    feishuUserResolver.resolveOnMessage = originalFeishuUserResolverResolveOnMessage;
  });

  describe('auto-create session on first chat message', () => {
    it('creates a Feishu session, includes the hint in the stream, and forwards the message', async () => {
      let pushArgs: unknown[] = [];
      chatService.pushMessage = async (...args: unknown[]) => {
        pushArgs = args;
      };

      await (service as unknown as { handleChatMessage: (thread: MockThread, feishuUserId: string, text: string) => Promise<void> }).handleChatMessage(
        thread,
        feishuUserId,
        'hello',
      );

      assert.strictEqual(createdSessions.length, 1);
      assert.strictEqual(createdSessions[0].name, feishuUserId);
      assert.strictEqual(createdSessions[0].source, 'feishu');

      assert.strictEqual(userSessions.length, 1);
      assert.strictEqual(userSessions[0].sessionId, 'session-1');
      assert.strictEqual(activeSessions.get(`${workspace.id}:${feishuUserId}`), 'session-1');

      const textPosts = thread.posts.filter((p) => p.type === 'text').map((p) => p.value);
      assert.strictEqual(textPosts.length, 0, 'hint should not be a separate text post');

      const createCalls = larkCalls.filter((c) => c.method === 'card.create');
      assert.strictEqual(createCalls.length, 1, 'should create a streaming card');
      const cardJson = JSON.parse((createCalls[0].args as { data: { data: string } }).data.data);
      assert.strictEqual(cardJson.config.streaming_mode, true);
      assert.ok((cardJson.body.elements[0].content as string).includes('已为你创建新会话'));

      const messageCalls = larkCalls.filter((c) => c.method === 'im.message.create');
      assert.strictEqual(messageCalls.length, 1, 'should send the card message');
      assert.strictEqual(
        (messageCalls[0].args as { data: { msg_type: string } }).data.msg_type,
        'interactive',
      );

      assert.strictEqual(pushArgs[0], 'session-1');
      assert.strictEqual(pushArgs[1], workspace.id);
      assert.strictEqual(pushArgs[2], 'hello');
      assert.strictEqual(pushArgs[3], true);
      assert.strictEqual(pushArgs[5], feishuUserId);
    });

    it('reuses an active session and does not post the hint', async () => {
      activeSessions.set(`${workspace.id}:${feishuUserId}`, 'session-existing');
      createdSessions.push({ workspaceId: workspace.id, name: 'Existing', source: 'feishu' });

      let pushArgs: unknown[] = [];
      chatService.pushMessage = async (...args: unknown[]) => {
        pushArgs = args;
      };

      await (service as unknown as { handleChatMessage: (thread: MockThread, feishuUserId: string, text: string) => Promise<void> }).handleChatMessage(
        thread,
        feishuUserId,
        'hello again',
      );

      assert.strictEqual(createdSessions.length, 1);
      const textPosts = thread.posts.filter((p) => p.type === 'text').map((p) => p.value);
      assert.strictEqual(textPosts.length, 0);

      assert.strictEqual(pushArgs[0], 'session-existing');
      assert.strictEqual(pushArgs[2], 'hello again');
    });

    it('replies with an error when session creation fails', async () => {
      chatService.createSession = async () => {
        throw new Error('db down');
      };

      await (service as unknown as { handleChatMessage: (thread: MockThread, feishuUserId: string, text: string) => Promise<void> }).handleChatMessage(
        thread,
        feishuUserId,
        'hello',
      );

      const textPosts = thread.posts.filter((p) => p.type === 'text').map((p) => p.value);
      assert.ok(textPosts.some((text) => String(text).includes('创建会话失败')));
    });
  });

  describe('stream delivery after auto-create', () => {
    it('delivers the answer content via CardKit streaming APIs', async () => {
      chatService.pushMessage = async (_sessionId, _workspaceId, _text, _isBot, handler) => {
        const h = handler as ((id: number, event: SseEvent) => void) & { cleanup: () => void };
        // Mirror the real runtime: pushMessage enqueues the user message and
        // resolves immediately, then the assistant turn streams its events
        // asynchronously on a later tick. Finalizing as soon as pushMessage
        // resolves would race the turn and freeze the card on the hint.
        setTimeout(() => {
          h(1, { type: 'assistant_start' } as SseEvent);
          h(2, { type: 'text_delta', text: 'Hi' } as SseEvent);
          h(3, { type: 'text_delta', text: ' there' } as SseEvent);
          h(4, { type: 'assistant_done' } as SseEvent);
          h(5, { type: 'result', isError: false } as SseEvent);
        }, 10);
      };

      await (service as unknown as { handleChatMessage: (thread: MockThread, feishuUserId: string, text: string) => Promise<void> }).handleChatMessage(
        thread,
        feishuUserId,
        'hello',
      );
      // Let the asynchronously-streamed turn complete; the reply finalizes
      // itself on the `result` event.
      await sleep(120);

      const textPosts = thread.posts.filter((p) => p.type === 'text').map((p) => p.value);
      assert.strictEqual(textPosts.length, 0, 'hint should not be a separate text post');

      const createCalls = larkCalls.filter((c) => c.method === 'card.create');
      assert.strictEqual(createCalls.length, 1);
      const cardJson = JSON.parse((createCalls[0].args as { data: { data: string } }).data.data);
      assert.ok((cardJson.body.elements[0].content as string).includes('已为你创建新会话'));

      const contentCalls = larkCalls.filter((c) => c.method === 'cardElement.content');
      const lastContent = contentCalls[contentCalls.length - 1]?.args as {
        data: { content: string };
      };
      assert.strictEqual(lastContent?.data.content, 'Hi there');

      const settingsCalls = larkCalls.filter((c) => c.method === 'card.settings');
      assert.strictEqual(settingsCalls.length, 1);
      const settingsPayload = JSON.parse(
        (settingsCalls[0].args as { data: { settings: string } }).data.settings,
      );
      assert.strictEqual(settingsPayload.config.streaming_mode, false);
      assert.strictEqual(settingsPayload.config.summary.content, 'Hi there');
    });
  });

  describe('card commands use the user open_id', () => {
    it('/session sends the session list card to the user open_id', async () => {
      await (service as unknown as { handleSessionCommand: (thread: MockThread, feishuUserId: string) => Promise<void> }).handleSessionCommand(
        thread,
        feishuUserId,
      );

      const interactiveCalls = larkCalls.filter(
        (c) =>
          c.method === 'im.message.create' &&
          (c.args as { data: { msg_type: string } }).data.msg_type === 'interactive',
      );
      assert.strictEqual(interactiveCalls.length, 1, 'should send one interactive card');
      assert.strictEqual(
        (interactiveCalls[0].args as { params: { receive_id_type: string } }).params
          .receive_id_type,
        'open_id',
      );
      assert.strictEqual(
        (interactiveCalls[0].args as { data: { receive_id: string } }).data.receive_id,
        feishuUserId,
        'must use user open_id, not chat_id',
      );
    });

    it('/workspace sends the workspace list card to the user open_id', async () => {
      await (service as unknown as { handleWorkspaceCommand: (thread: MockThread, feishuUserId: string) => Promise<void> }).handleWorkspaceCommand(
        thread,
        feishuUserId,
      );

      const interactiveCalls = larkCalls.filter(
        (c) =>
          c.method === 'im.message.create' &&
          (c.args as { data: { msg_type: string } }).data.msg_type === 'interactive',
      );
      assert.strictEqual(interactiveCalls.length, 1, 'should send one interactive card');
      assert.strictEqual(
        (interactiveCalls[0].args as { params: { receive_id_type: string } }).params
          .receive_id_type,
        'open_id',
      );
      assert.strictEqual(
        (interactiveCalls[0].args as { data: { receive_id: string } }).data.receive_id,
        feishuUserId,
        'must use user open_id, not chat_id',
      );
    });

    it('/workspace denies non-admin users before sending any card', async () => {
      workspace.settings.feishuAdminUserIds = ['ou_other'];

      await (service as unknown as { handleWorkspaceCommand: (thread: MockThread, feishuUserId: string) => Promise<void> }).handleWorkspaceCommand(
        thread,
        feishuUserId,
      );

      const interactiveCalls = larkCalls.filter(
        (c) =>
          c.method === 'im.message.create' &&
          (c.args as { data: { msg_type: string } }).data.msg_type === 'interactive',
      );
      assert.strictEqual(interactiveCalls.length, 0, 'no card should be sent to non-admins');
      const textPosts = thread.posts.filter((p) => p.type === 'text').map((p) => p.value);
      assert.ok(textPosts.some((text) => String(text).includes('没有权限')));
    });
  });

  describe('card action handling via long connection', () => {
    function makeActionEvent(value: string, threadOverride?: MockThread | null, userId: string = feishuUserId): unknown {
      const eventThread = threadOverride === undefined ? thread : threadOverride;
      return {
        actionId: 'button',
        messageId: 'msg-card-1',
        threadId: 'lark:oc_thread:root',
        user: { userId, userName: 'User', fullName: 'User', isBot: false, isMe: false },
        value,
        thread: eventThread,
        raw: { operator: { open_id: userId } },
        adapter: { name: 'lark' },
        openModal: async () => undefined,
      };
    }

    it('handles select_session and posts the toast to the thread', async () => {
      workspaceStore.getFeishuSessionOwner = () => 'ou_select';
      let activeSessionId: string | null = null;
      workspaceStore.setFeishuActiveSession = (ws, user, sessionId) => {
        activeSessionId = sessionId;
      };

      const payload = JSON.stringify({ action: 'select_session', workspaceId: workspace.id, sessionId: 'session-42' });
      await (service as unknown as { handleCardAction: (event: unknown) => Promise<void> }).handleCardAction(
        makeActionEvent(payload, undefined, 'ou_select'),
      );

      assert.strictEqual(activeSessionId, 'session-42');
      const textPosts = thread.posts.filter((p) => p.type === 'text').map((p) => p.value);
      assert.ok(textPosts.some((text) => String(text).includes('会话已切换。')));
    });

    it('handles create_session and posts the toast to the thread', async () => {
      const payload = JSON.stringify({ action: 'create_session', workspaceId: workspace.id });
      await (service as unknown as { handleCardAction: (event: unknown) => Promise<void> }).handleCardAction(
        makeActionEvent(payload, undefined, 'ou_create'),
      );

      assert.strictEqual(createdSessions.length, 1);
      assert.strictEqual(createdSessions[0].name, 'Feishu Session');
      const textPosts = thread.posts.filter((p) => p.type === 'text').map((p) => p.value);
      assert.ok(textPosts.some((text) => String(text).includes('Feishu Session')));
    });

    it('falls back to larkClient direct message when thread is unavailable', async () => {
      workspaceStore.getFeishuSessionOwner = () => 'ou_fallback';

      const payload = JSON.stringify({ action: 'select_session', workspaceId: workspace.id, sessionId: 'session-42' });
      await (service as unknown as { handleCardAction: (event: unknown) => Promise<void> }).handleCardAction(
        makeActionEvent(payload, null, 'ou_fallback'),
      );

      const textCalls = larkCalls.filter(
        (c) =>
          c.method === 'im.message.create' &&
          (c.args as { data: { msg_type: string } }).data.msg_type === 'text',
      );
      assert.strictEqual(textCalls.length, 1);
      assert.strictEqual(
        (textCalls[0].args as { params: { receive_id_type: string } }).params.receive_id_type,
        'open_id',
      );
      assert.strictEqual(
        (textCalls[0].args as { data: { receive_id: string } }).data.receive_id,
        'ou_fallback',
      );
      assert.ok(
        (textCalls[0].args as { data: { content: string } }).data.content.includes('会话已切换。'),
      );
    });

    it('replies with an error when the action value is unparseable', async () => {
      await (service as unknown as { handleCardAction: (event: unknown) => Promise<void> }).handleCardAction(
        makeActionEvent('not-json', undefined, 'ou_parse'),
      );

      const textPosts = thread.posts.filter((p) => p.type === 'text').map((p) => p.value);
      assert.ok(textPosts.some((text) => String(text).includes('无法解析卡片操作')));
    });

    it('replies with an error when the action handler throws', async () => {
      workspaceStore.get = async () => {
        throw new Error('db down');
      };

      const payload = JSON.stringify({ action: 'create_session', workspaceId: workspace.id });
      await (service as unknown as { handleCardAction: (event: unknown) => Promise<void> }).handleCardAction(
        makeActionEvent(payload, undefined, 'ou_error'),
      );

      const textPosts = thread.posts.filter((p) => p.type === 'text').map((p) => p.value);
      assert.ok(textPosts.some((text) => String(text).includes('处理操作失败')));
    });
  });

  describe('/new command', () => {
    it('creates a session with the default title when no title is supplied', async () => {
      await (service as unknown as { handleNewSessionCommand: (thread: MockThread, feishuUserId: string, text: string) => Promise<void> }).handleNewSessionCommand(
        thread,
        feishuUserId,
        '/new',
      );

      assert.strictEqual(createdSessions.length, 1);
      assert.strictEqual(createdSessions[0].name, feishuUserId);
      assert.strictEqual(createdSessions[0].source, 'feishu');
      assert.strictEqual(activeSessions.get(`${workspace.id}:${feishuUserId}`), 'session-1');

      const textPosts = thread.posts.filter((p) => p.type === 'text').map((p) => p.value);
      assert.ok(textPosts.some((text) => String(text).includes(`已创建新会话：${feishuUserId}`)));
    });

    it('creates a session with the supplied title', async () => {
      await (service as unknown as { handleNewSessionCommand: (thread: MockThread, feishuUserId: string, text: string) => Promise<void> }).handleNewSessionCommand(
        thread,
        feishuUserId,
        '/new Project Planning',
      );

      assert.strictEqual(createdSessions.length, 1);
      assert.strictEqual(createdSessions[0].name, 'Project Planning');
      assert.strictEqual(activeSessions.get(`${workspace.id}:${feishuUserId}`), 'session-1');

      const textPosts = thread.posts.filter((p) => p.type === 'text').map((p) => p.value);
      assert.ok(textPosts.some((text) => String(text).includes('已创建新会话：Project Planning')));
    });

    it('falls back to the default title when the supplied title is only whitespace', async () => {
      await (service as unknown as { handleNewSessionCommand: (thread: MockThread, feishuUserId: string, text: string) => Promise<void> }).handleNewSessionCommand(
        thread,
        feishuUserId,
        '/new   ',
      );

      assert.strictEqual(createdSessions.length, 1);
      assert.strictEqual(createdSessions[0].name, feishuUserId);
    });

    it('replies with an error when session creation fails', async () => {
      chatService.createSession = async () => {
        throw new Error('db down');
      };

      await (service as unknown as { handleNewSessionCommand: (thread: MockThread, feishuUserId: string, text: string) => Promise<void> }).handleNewSessionCommand(
        thread,
        feishuUserId,
        '/new',
      );

      const textPosts = thread.posts.filter((p) => p.type === 'text').map((p) => p.value);
      assert.ok(textPosts.some((text) => String(text).includes('创建会话失败')));
    });
  });

  describe('direct message user discovery', () => {
    function makeThread(isDM: boolean): MockThread {
      return {
        id: 'lark:thread:root',
        channelId: 'channel-1',
        isDM,
        posts: [],
        async post(value) {
          this.posts.push({ type: typeof value === 'string' ? 'text' : 'stream', value });
        },
      };
    }

    function makeMessage(text: string, userId: string = feishuUserId): unknown {
      return {
        author: { userId },
        text,
      };
    }

    it('upserts the Feishu user and triggers name resolution on a direct message', async () => {
      const handler = (service as unknown as { createDispatchHandler: () => (thread: MockThread, message: unknown) => Promise<void> }).createDispatchHandler();

      await handler(makeThread(true), makeMessage('hello'));

      const user = workspaceStore.getFeishuWorkspaceUser(workspace.id, feishuUserId);
      assert.ok(user);
      assert.strictEqual(user.openId, feishuUserId);

      assert.strictEqual(resolverCalls.length, 1);
      assert.strictEqual(resolverCalls[0].workspaceId, workspace.id);
      assert.strictEqual(resolverCalls[0].openId, feishuUserId);
    });

    it('updates lastSeenAt without changing firstSeenAt on a repeat direct message', async () => {
      const handler = (service as unknown as { createDispatchHandler: () => (thread: MockThread, message: unknown) => Promise<void> }).createDispatchHandler();

      await handler(makeThread(true), makeMessage('hello'));
      const first = workspaceStore.getFeishuWorkspaceUser(workspace.id, feishuUserId);
      assert.ok(first);

      await new Promise((resolve) => setTimeout(resolve, 5));
      await handler(makeThread(true), makeMessage('hello again'));

      const second = workspaceStore.getFeishuWorkspaceUser(workspace.id, feishuUserId);
      assert.ok(second);
      assert.strictEqual(second.firstSeenAt, first.firstSeenAt);
      assert.notStrictEqual(second.lastSeenAt, first.lastSeenAt);
    });

    it('ignores group mentions and does not create a user record', async () => {
      const handler = (service as unknown as { createDispatchHandler: () => (thread: MockThread, message: unknown) => Promise<void> }).createDispatchHandler();

      await handler(makeThread(false), makeMessage('hello'));

      assert.strictEqual(workspaceStore.getFeishuWorkspaceUser(workspace.id, feishuUserId), null);
      assert.strictEqual(resolverCalls.length, 0);
    });
  });

  describe('bot menu events (handleMenuEvent)', () => {
    type LarkClientLike = import('@larksuiteoapi/node-sdk').Client;

    function makeMenuLarkClient(): LarkClientLike {
      return {
        im: {
          v1: {
            message: {
              create: async (args: {
                params: { receive_id_type: string };
                data: { receive_id: string; msg_type: string; content: string };
              }) => {
                larkCalls.push({ method: 'im.message.create', args });
                return { data: { message_id: 'msg-menu-1' } };
              },
            },
          },
        },
      } as unknown as LarkClientLike;
    }

    function makeFailingMenuLarkClient(): LarkClientLike {
      return {
        im: {
          v1: {
            message: {
              create: async () => {
                throw new Error('feishu api down');
              },
            },
          },
        },
      } as unknown as LarkClientLike;
    }

    function interactiveCardCalls() {
      return larkCalls.filter(
        (c) =>
          c.method === 'im.message.create' &&
          (c.args as { data: { msg_type: string } }).data.msg_type === 'interactive',
      );
    }

    function textCalls() {
      return larkCalls.filter(
        (c) =>
          c.method === 'im.message.create' &&
          (c.args as { data: { msg_type: string } }).data.msg_type === 'text',
      );
    }

    it('"session" sends the session-list card to the operator open_id', async () => {
      workspaceStore.listFeishuSessionsByUser = () => [
        { sessionId: 'session-existing', workspaceId: workspace.id, feishuUserId },
      ];
      createdSessions.push({ workspaceId: workspace.id, name: 'Existing', source: 'feishu' });

      await service.handleMenuEvent(makeMenuLarkClient(), workspace, feishuUserId, 'session');

      const interactive = interactiveCardCalls();
      assert.strictEqual(interactive.length, 1, 'should send one interactive session-list card');
      assert.strictEqual(
        (interactive[0].args as { params: { receive_id_type: string } }).params.receive_id_type,
        'open_id',
      );
      assert.strictEqual(
        (interactive[0].args as { data: { receive_id: string } }).data.receive_id,
        feishuUserId,
        'card must be addressed to the operator open_id',
      );
    });

    it('"session" still sends a card when the user has no sessions', async () => {
      workspaceStore.listFeishuSessionsByUser = () => [];

      await service.handleMenuEvent(makeMenuLarkClient(), workspace, feishuUserId, 'session');

      assert.strictEqual(interactiveCardCalls().length, 1, 'empty-state card should still be sent');
    });

    it('"new" creates a session scoped to the operator open_id and notifies them', async () => {
      await service.handleMenuEvent(makeMenuLarkClient(), workspace, feishuUserId, 'new');

      assert.strictEqual(createdSessions.length, 1);
      assert.strictEqual(createdSessions[0].name, feishuUserId);
      assert.strictEqual(createdSessions[0].source, 'feishu');
      assert.strictEqual(userSessions.length, 1);
      assert.strictEqual(userSessions[0].feishuUserId, feishuUserId);
      assert.strictEqual(activeSessions.get(`${workspace.id}:${feishuUserId}`), 'session-1');

      const text = textCalls();
      assert.strictEqual(text.length, 1);
      assert.ok(
        (text[0].args as { data: { content: string } }).data.content.includes(
          `已创建新会话：${feishuUserId}`,
        ),
      );
      assert.strictEqual(
        (text[0].args as { data: { receive_id: string } }).data.receive_id,
        feishuUserId,
      );
    });

    it('serializes concurrent menu new clicks for the same user (no interleaving)', async () => {
      const events: string[] = [];
      let counter = 0;
      chatService.createSession = async (input) => {
        counter += 1;
        const id = `session-${counter}`;
        events.push(`start:${id}`);
        await new Promise((r) => setTimeout(r, 15));
        events.push(`end:${id}`);
        return {
          id,
          workspaceId: input.workspaceId,
          name: input.name,
          source: input.source ?? 'feishu',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as import('../models/session.js').ChatSession;
      };

      const p1 = service.handleMenuEvent(makeMenuLarkClient(), workspace, feishuUserId, 'new');
      const p2 = service.handleMenuEvent(makeMenuLarkClient(), workspace, feishuUserId, 'new');
      await Promise.all([p1, p2]);

      // Serialized through runForUser: session-1 fully completes before
      // session-2 starts. Each click creates exactly one session (no dedup —
      // "new" semantics) but the two never interleave.
      assert.deepStrictEqual(events, [
        'start:session-1',
        'end:session-1',
        'start:session-2',
        'end:session-2',
      ]);
      assert.strictEqual(counter, 2);
    });

    it('sends an error text when the workspace is not Feishu-enabled', async () => {
      const disabledWorkspace = {
        ...workspace,
        settings: { ...workspace.settings, feishuBotEnabled: false },
      } as import('../models/workspace.js').Workspace;

      await service.handleMenuEvent(makeMenuLarkClient(), disabledWorkspace, feishuUserId, 'session');

      const text = textCalls();
      assert.strictEqual(text.length, 1);
      assert.ok(
        (text[0].args as { data: { content: string } }).data.content.includes('未启用'),
        'should report the workspace is not enabled',
      );
      assert.strictEqual(interactiveCardCalls().length, 0, 'must not send a card for a disabled workspace');
    });

    it('sends an error text for an unknown event_key', async () => {
      await service.handleMenuEvent(makeMenuLarkClient(), workspace, feishuUserId, 'delete');

      const text = textCalls();
      assert.strictEqual(text.length, 1);
      assert.ok(
        (text[0].args as { data: { content: string } }).data.content.includes('未知'),
        'should report an unknown menu operation',
      );
      assert.strictEqual(createdSessions.length, 0, 'must not create a session for an unknown key');
    });

    it('does not crash when the Feishu message send fails', async () => {
      await assert.doesNotReject(async () => {
        await service.handleMenuEvent(makeFailingMenuLarkClient(), workspace, feishuUserId, 'new');
      });
    });
  });
});
