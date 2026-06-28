import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { FeishuBotService } from './feishu-bot-service.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { botService } from './bot-service.js';
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
        patch: (args: { path: { card_id: string; element_id: string }; data: { partial_element: string; sequence: number; uuid: string } }) => Promise<unknown>;
        update: (args: { path: { card_id: string; element_id: string }; data: { element: string; sequence: number; uuid: string } }) => Promise<unknown>;
      };
    };
  };
  im: {
    v1: {
      message: {
        create: (args: { params: { receive_id_type: string }; data: { receive_id: string; msg_type: string; content: string } }) => Promise<unknown>;
        patch: (args: { path: { message_id: string }; data: { content: string } }) => Promise<unknown>;
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
  let originalChatServiceGetRuntimeIfExists: typeof chatService.getRuntimeIfExists;
  let originalFeishuUserResolverResolveOnMessage: typeof feishuUserResolver.resolveOnMessage;
  let createdSessions: Array<{ workspaceId: string; name: string; source?: string }>;
  let activeSessions: Map<string, string>;
  let userSessions: Array<{ workspaceId: string; feishuUserId: string; sessionId: string }>;
  let resolverCalls: Array<{ workspaceId: string; openId: string }>;

  let larkCalls: Array<{ method: string; args: unknown }>;
  let botId: string;

  const feishuUserId = 'ou_123';

  function getTextPosts(): string[] {
    return thread.posts.filter((p) => p.type === 'text').map((p) => String(p.value));
  }

  function makeMockRuntime(overrides?: {
    isProcessingTurn?: boolean;
    interrupt?: () => Promise<void>;
    cancelPendingApprovals?: (message?: string) => void;
  }) {
    return {
      isProcessingTurn: () => overrides?.isProcessingTurn ?? true,
      interrupt: overrides?.interrupt ?? (async () => {}),
      cancelPendingApprovals: overrides?.cancelPendingApprovals ?? (() => {}),
    };
  }

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
    originalChatServiceGetRuntimeIfExists = chatService.getRuntimeIfExists.bind(chatService);
    originalFeishuUserResolverResolveOnMessage = feishuUserResolver.resolveOnMessage.bind(feishuUserResolver);

    workspaceStore.resetData();

    const bot = botService.createBot({
      name: 'Test Bot',
      activeWorkspaceId: workspace.id,
      providerSettings: {
        feishu: {
          enabled: true,
          appId: 'app-id',
          appSecret: 'app-secret',
        },
      },
    });
    botId = bot.id;
    botService.addMember(botId, { provider: 'feishu', providerUserId: feishuUserId, role: 'owner' });

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
    chatService.getRuntimeIfExists = () => undefined;

    // Inject a minimal active connection so internal handlers can reach a mock
    // larkClient without initializing the real Lark SDK.
    const injectedConnection = {
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
              patch: async (args: { path: { card_id: string; element_id: string }; data: { partial_element: string; sequence: number; uuid: string } }) => {
                larkCalls.push({ method: 'cardElement.patch', args });
                return { data: {} };
              },
              update: async (args: { path: { card_id: string; element_id: string }; data: { element: string; sequence: number; uuid: string } }) => {
                larkCalls.push({ method: 'cardElement.update', args });
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
              patch: async (args: { path: { message_id: string }; data: { content: string } }) => {
                larkCalls.push({ method: 'im.message.patch', args });
                return { data: {} };
              },
            },
          },
        },
      },
      workspaceId: workspace.id,
      botId,
    };
    const internals = service as unknown as {
      connections: Map<string, { larkClient: MockLarkClient; workspaceId: string; botId: string }>;
      activeBotId: string | null;
      workspaceIdToBotId: Map<string, string>;
      botIdToWorkspaceId: Map<string, string>;
    };
    internals.connections.set(botId, injectedConnection);
    internals.activeBotId = injectedConnection.botId;
    internals.workspaceIdToBotId.set(workspace.id, injectedConnection.botId);
    internals.botIdToWorkspaceId.set(injectedConnection.botId, workspace.id);
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
    chatService.getRuntimeIfExists = originalChatServiceGetRuntimeIfExists;
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

      const textPosts = getTextPosts();
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
      const textPosts = getTextPosts();
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

      const textPosts = getTextPosts();
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

      const textPosts = getTextPosts();
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
    it('/resume sends the session list card to the user open_id', async () => {
      await (service as unknown as { handleSessionCommand: (thread: MockThread, feishuUserId: string) => Promise<void> }).handleSessionCommand(
        thread,
        feishuUserId,
      );

      const createCalls = larkCalls.filter((c) => c.method === 'card.create');
      assert.strictEqual(createCalls.length, 1, 'should create a CardKit card');
      const cardJson = JSON.parse((createCalls[0].args as { data: { data: string } }).data.data);
      assert.strictEqual(cardJson.schema, '2.0');

      const interactiveCalls = larkCalls.filter(
        (c) =>
          c.method === 'im.message.create' &&
          (c.args as { data: { msg_type: string } }).data.msg_type === 'interactive',
      );
      assert.strictEqual(interactiveCalls.length, 1, 'should send one interactive card message');
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
      const messageContent = JSON.parse(
        (interactiveCalls[0].args as { data: { content: string } }).data.content,
      );
      assert.deepStrictEqual(messageContent, { type: 'card', data: { card_id: 'card-1' } });
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

    it('/workspace denies non-Owner users before sending any card', async () => {
      const nonOwnerId = 'ou_non_owner';
      botService.addMember(botId, { provider: 'feishu', providerUserId: nonOwnerId, role: 'normal' });

      await (service as unknown as { handleWorkspaceCommand: (thread: MockThread, feishuUserId: string) => Promise<void> }).handleWorkspaceCommand(
        thread,
        nonOwnerId,
      );

      const interactiveCalls = larkCalls.filter(
        (c) =>
          c.method === 'im.message.create' &&
          (c.args as { data: { msg_type: string } }).data.msg_type === 'interactive',
      );
      assert.strictEqual(interactiveCalls.length, 0, 'no card should be sent to non-Owners');
      const textPosts = getTextPosts();
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

    function makeFormEvent(
      value: string,
      formValue: Record<string, unknown>,
      userId: string = feishuUserId,
    ): unknown {
      const event = makeActionEvent(value, undefined, userId);
      (event as Record<string, unknown>).raw = {
        raw: {
          action: {
            value: JSON.parse(value),
            form_value: formValue,
          },
        },
      };
      return event;
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
      const textPosts = getTextPosts();
      assert.ok(textPosts.some((text) => String(text).includes('会话已切换。')));
    });

    it('handles v2 form submit select_session from form_value and replaces the original form disabled', async () => {
      workspaceStore.getFeishuSessionOwner = () => 'ou_form';
      workspaceStore.listFeishuSessionsByUser = () => [{ sessionId: 'session-42' }];
      let activeSessionId: string | null = null;
      workspaceStore.setFeishuActiveSession = (ws, user, sessionId) => {
        activeSessions.set(`${ws}:${user}`, sessionId);
        activeSessionId = sessionId;
      };
      chatService.getSession = async () =>
        ({
          id: 'session-42',
          workspaceId: workspace.id,
          name: 'Selected Session',
          source: 'feishu',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as import('../models/session.js').ChatSession);

      // Seed the card-ID tracker so the handler uses CardKit form replacement.
      (
        service as unknown as { sessionListCardIds: Map<string, string> }
      ).sessionListCardIds.set('msg-card-1', 'card-1');

      const payload = JSON.stringify({ action: 'select_session', workspaceId: workspace.id });
      const event = makeFormEvent(payload, { sessionId: 'session-42' }, 'ou_form');

      await (service as unknown as { handleCardAction: (event: unknown) => Promise<void> }).handleCardAction(event);

      assert.strictEqual(activeSessionId, 'session-42');
      const textPosts = getTextPosts();
      assert.ok(textPosts.some((text) => String(text).includes('会话已切换。')));

      const updateCalls = larkCalls.filter((c) => c.method === 'cardElement.update');
      assert.strictEqual(updateCalls.length, 1, 'should replace the session-list form disabled');
      const updateArgs = updateCalls[0].args as {
        path: { card_id: string; element_id: string };
        data: { element: string; sequence: number; uuid: string };
      };
      assert.strictEqual(updateArgs.path.card_id, 'card-1');
      assert.strictEqual(updateArgs.path.element_id, 'session_form');

      const formElement = JSON.parse(updateArgs.data.element);
      assert.strictEqual(formElement.tag, 'form');
      assert.strictEqual(formElement.element_id, 'session_form');
      const formElements = formElement.elements as unknown[];

      const selectPartial = formElements.find(
        (el) => (el as Record<string, unknown>).tag === 'select_static',
      ) as Record<string, unknown>;
      assert.ok(selectPartial, 'updated form should include the select element');
      assert.strictEqual(selectPartial.disabled, true);
      assert.strictEqual(selectPartial.initial_index, 0);
      assert.ok(
        (selectPartial.options as Array<{ text: { content: string } }>).some((o) =>
          o.text.content.includes('Selected Session （当前）'),
        ),
      );

      const buttonPartial = formElements.find(
        (el) => (el as Record<string, unknown>).tag === 'button',
      ) as Record<string, unknown>;
      assert.ok(buttonPartial, 'updated form should include the submit button');
      assert.strictEqual(buttonPartial.disabled, true);

      const pendingResponses = (service as unknown as { pendingCardActionResponses: Map<string, unknown> }).pendingCardActionResponses;
      const response = pendingResponses.get('msg-card-1');
      assert.ok(response, 'should store a card action response for the message');
      assert.strictEqual((response as { toast?: { type: string } }).toast?.type, 'success');
      assert.strictEqual((response as { card?: { type: string } }).card?.type, 'raw');
      const responseCard = (response as { card?: { data?: { body?: { elements?: unknown[] } } } }).card?.data;
      assert.ok(responseCard, 'response should include the disabled card');
      const responseForm = (responseCard.body.elements as Array<Record<string, unknown>>).find(
        (el) => el.tag === 'form',
      );
      assert.ok(responseForm, 'response card should contain the form');
    });

    it('rejects v2 form submit when sessionId is missing from form_value', async () => {
      workspaceStore.getFeishuSessionOwner = () => 'ou_form';
      const payload = JSON.stringify({ action: 'select_session', workspaceId: workspace.id });
      const event = makeFormEvent(payload, {}, 'ou_form');

      await (service as unknown as { handleCardAction: (event: unknown) => Promise<void> }).handleCardAction(event);

      const textPosts = getTextPosts();
      assert.ok(textPosts.some((text) => String(text).includes('无法解析会话选择')));
      const updateCalls = larkCalls.filter((c) => c.method === 'cardElement.update');
      assert.strictEqual(updateCalls.length, 0);
    });

    it('handles create_session and posts the toast to the thread', async () => {
      const payload = JSON.stringify({ action: 'create_session', workspaceId: workspace.id });
      await (service as unknown as { handleCardAction: (event: unknown) => Promise<void> }).handleCardAction(
        makeActionEvent(payload, undefined, 'ou_create'),
      );

      assert.strictEqual(createdSessions.length, 1);
      assert.strictEqual(createdSessions[0].name, 'ou_create');
      const textPosts = getTextPosts();
      assert.ok(textPosts.some((text) => String(text).includes('ou_create')));
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

      const textPosts = getTextPosts();
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

      const textPosts = getTextPosts();
      assert.ok(textPosts.some((text) => String(text).includes('处理操作失败')));
    });

    it('select_workspace switches the active workspace and updates routing maps', async () => {
      workspaceStore.get = async () => workspace;
      workspaceStore.getFeishuActiveWorkspace = originalGetFeishuActiveWorkspace;

      const payload = JSON.stringify({ action: 'select_workspace', workspaceId: 'ws-2', botId });
      await (service as unknown as { handleCardAction: (event: unknown) => Promise<void> }).handleCardAction(
        makeActionEvent(payload, undefined, feishuUserId),
      );

      const internals = service as unknown as {
        connections: Map<string, { workspaceId: string; botId: string }>;
        workspaceIdToBotId: Map<string, string>;
      };
      const connection = internals.connections.get(botId);
      assert.ok(connection);
      assert.strictEqual(connection.workspaceId, 'ws-2');
      assert.strictEqual(internals.workspaceIdToBotId.get('ws-2'), botId);
      assert.strictEqual(workspaceStore.getFeishuActiveWorkspace(), 'ws-2');

      const textPosts = getTextPosts();
      assert.ok(textPosts.some((text) => String(text).includes('工作空间已切换')));
    });

    it('wraps dispatcher card.action.trigger to return the disabled card response', async () => {
      workspaceStore.getFeishuSessionOwner = () => 'ou_dispatcher';
      workspaceStore.listFeishuSessionsByUser = () => [{ sessionId: 'session-42' }];
      chatService.getSession = async () =>
        ({
          id: 'session-42',
          workspaceId: workspace.id,
          name: 'Selected Session',
          source: 'feishu',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as import('../models/session.js').ChatSession);
      (service as unknown as { sessionListCardIds: Map<string, string> }).sessionListCardIds.set(
        'msg-dispatcher-1',
        'card-dispatcher-1',
      );

      const payload = JSON.stringify({ action: 'select_session', workspaceId: workspace.id });
      const rawEvent = {
        context: { open_message_id: 'msg-dispatcher-1', open_chat_id: 'chat-dispatcher-1' },
        operator: { open_id: 'ou_dispatcher' },
        action: { name: 'submit_session', value: JSON.parse(payload), tag: 'button', form_value: { sessionId: 'session-42' } },
      };

      let handleCardActionCalled = false;
      const dispatcher = {
        handles: new Map([
          [
            'card.action.trigger',
            async () => {
              handleCardActionCalled = true;
              await (service as unknown as { handleCardAction: (event: unknown) => Promise<void> }).handleCardAction({
                actionId: 'submit_session',
                messageId: 'msg-dispatcher-1',
                threadId: 'lark:chat-dispatcher-1:root',
                user: { userId: 'ou_dispatcher', userName: 'User', fullName: 'User', isBot: false, isMe: false },
                value: payload,
                raw: { raw: { action: { value: JSON.parse(payload), form_value: { sessionId: 'session-42' } } } },
                adapter: { name: 'lark' },
              });
            },
          ],
        ]),
      };
      const mockAdapter = {
        _getChannel: () => ({ dispatcher }),
      };

      (service as unknown as { registerWSCardActionResponseHandler: (adapter: unknown) => void }).registerWSCardActionResponseHandler(
        mockAdapter,
      );

      const wrappedHandler = dispatcher.handles.get('card.action.trigger');
      assert.ok(wrappedHandler, 'dispatcher should have a wrapped card.action.trigger handler');
      const response = await wrappedHandler(rawEvent);

      assert.strictEqual(handleCardActionCalled, true);
      assert.ok(response, 'wrapped handler should return a response');
      assert.strictEqual((response as { toast?: { type: string } }).toast?.type, 'success');
      assert.strictEqual((response as { card?: { type: string } }).card?.type, 'raw');
      const responseCard = (response as { card?: { data?: { body?: { elements?: unknown[] } } } }).card?.data;
      assert.ok(responseCard, 'response should include the disabled card');
    });
  });

  describe('/new and /clear commands', () => {
    it('/new creates a session with the default title when no title is supplied', async () => {
      await (service as unknown as { handleNewSessionCommand: (thread: MockThread, feishuUserId: string, text: string) => Promise<void> }).handleNewSessionCommand(
        thread,
        feishuUserId,
        '/new',
      );

      assert.strictEqual(createdSessions.length, 1);
      assert.strictEqual(createdSessions[0].name, feishuUserId);
      assert.strictEqual(createdSessions[0].source, 'feishu');
      assert.strictEqual(activeSessions.get(`${workspace.id}:${feishuUserId}`), 'session-1');

      const textPosts = getTextPosts();
      assert.ok(textPosts.some((text) => String(text).includes(`已创建新会话：${feishuUserId}`)));
    });

    it('/clear creates a session with the default title when no title is supplied', async () => {
      await (service as unknown as { handleNewSessionCommand: (thread: MockThread, feishuUserId: string, text: string) => Promise<void> }).handleNewSessionCommand(
        thread,
        feishuUserId,
        '/clear',
      );

      assert.strictEqual(createdSessions.length, 1);
      assert.strictEqual(createdSessions[0].name, feishuUserId);
      assert.strictEqual(activeSessions.get(`${workspace.id}:${feishuUserId}`), 'session-1');

      const textPosts = getTextPosts();
      assert.ok(textPosts.some((text) => String(text).includes(`已创建新会话：${feishuUserId}`)));
    });

    it('/new creates a session with the supplied title', async () => {
      await (service as unknown as { handleNewSessionCommand: (thread: MockThread, feishuUserId: string, text: string) => Promise<void> }).handleNewSessionCommand(
        thread,
        feishuUserId,
        '/new Project Planning',
      );

      assert.strictEqual(createdSessions.length, 1);
      assert.strictEqual(createdSessions[0].name, 'Project Planning');
      assert.strictEqual(activeSessions.get(`${workspace.id}:${feishuUserId}`), 'session-1');

      const textPosts = getTextPosts();
      assert.ok(textPosts.some((text) => String(text).includes('已创建新会话：Project Planning')));
    });

    it('/clear creates a session with the supplied title', async () => {
      await (service as unknown as { handleNewSessionCommand: (thread: MockThread, feishuUserId: string, text: string) => Promise<void> }).handleNewSessionCommand(
        thread,
        feishuUserId,
        '/clear Project Planning',
      );

      assert.strictEqual(createdSessions.length, 1);
      assert.strictEqual(createdSessions[0].name, 'Project Planning');
      assert.strictEqual(activeSessions.get(`${workspace.id}:${feishuUserId}`), 'session-1');

      const textPosts = getTextPosts();
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

    it('/clear falls back to the default title when the supplied title is only whitespace', async () => {
      await (service as unknown as { handleNewSessionCommand: (thread: MockThread, feishuUserId: string, text: string) => Promise<void> }).handleNewSessionCommand(
        thread,
        feishuUserId,
        '/clear   ',
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

      const textPosts = getTextPosts();
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
        cardkit: {
          v1: {
            card: {
              create: async (args: { data: { type: string; data: string } }) => {
                larkCalls.push({ method: 'card.create', args });
                return { data: { card_id: 'card-menu-1' } };
              },
            },
            cardElement: {
              patch: async (args: { path: { card_id: string; element_id: string }; data: { partial_element: string; sequence: number; uuid: string } }) => {
                larkCalls.push({ method: 'cardElement.patch', args });
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

    it('"resume" sends the session-list card to the operator open_id', async () => {
      workspaceStore.listFeishuSessionsByUser = () => [
        { sessionId: 'session-existing', workspaceId: workspace.id, feishuUserId },
      ];
      createdSessions.push({ workspaceId: workspace.id, name: 'Existing', source: 'feishu' });

      await service.handleMenuEvent(makeMenuLarkClient(), workspace, feishuUserId, 'resume');

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

    it('"resume" still sends a card when the user has no sessions', async () => {
      workspaceStore.listFeishuSessionsByUser = () => [];

      await service.handleMenuEvent(makeMenuLarkClient(), workspace, feishuUserId, 'resume');

      assert.strictEqual(interactiveCardCalls().length, 1, 'empty-state card should still be sent');
    });

    it('"/resume" (with leading slash) sends the session-list card to the operator open_id', async () => {
      workspaceStore.listFeishuSessionsByUser = () => [
        { sessionId: 'session-existing', workspaceId: workspace.id, feishuUserId },
      ];
      createdSessions.push({ workspaceId: workspace.id, name: 'Existing', source: 'feishu' });

      await service.handleMenuEvent(makeMenuLarkClient(), workspace, feishuUserId, '/resume');

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

    it('"/new" (with leading slash) creates a session scoped to the operator open_id and notifies them', async () => {
      await service.handleMenuEvent(makeMenuLarkClient(), workspace, feishuUserId, '/new');

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

    it('"/clear" (with leading slash) creates a session scoped to the operator open_id and notifies them', async () => {
      await service.handleMenuEvent(makeMenuLarkClient(), workspace, feishuUserId, '/clear');

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

    it('"stop" interrupts an in-flight turn and appends 已中断 to the active stream reply', async () => {
      activeSessions.set(`${workspace.id}:${feishuUserId}`, 'session-1');
      createdSessions.push({ workspaceId: workspace.id, name: 'Existing', source: 'feishu' });

      let capturedHandler: ((id: number, event: SseEvent) => void) & { cleanup: () => void } | undefined;
      chatService.pushMessage = async (_sessionId, _workspaceId, _text, _isBot, handler) => {
        capturedHandler = handler as typeof capturedHandler;
      };

      await (service as unknown as { handleChatMessage: (thread: MockThread, feishuUserId: string, text: string) => Promise<void> }).handleChatMessage(
        thread,
        feishuUserId,
        'hello',
      );

      assert.ok(capturedHandler, 'handler should be passed to pushMessage');
      capturedHandler!(1, { type: 'assistant_start' } as SseEvent);
      capturedHandler!(2, { type: 'text_delta', text: 'working' } as SseEvent);

      let interruptCalled = false;
      let cancelCalled = false;
      chatService.getRuntimeIfExists = () =>
        makeMockRuntime({
          interrupt: async () => {
            interruptCalled = true;
          },
          cancelPendingApprovals: () => {
            cancelCalled = true;
          },
        });

      await service.handleMenuEvent(makeMenuLarkClient(), workspace, feishuUserId, 'stop');
      await sleep(100);

      assert.strictEqual(interruptCalled, true);
      assert.strictEqual(cancelCalled, true);

      const contentCalls = larkCalls.filter((c) => c.method === 'cardElement.content');
      const lastContent = contentCalls[contentCalls.length - 1]?.args as {
        data: { content: string };
      };
      assert.ok(lastContent?.data.content.endsWith('已中断'));

      const text = textCalls();
      assert.strictEqual(text.length, 0, 'no standalone text should be sent when stream is active');
    });

    it('"/stop" (with leading slash) interrupts an in-flight turn and appends 已中断', async () => {
      activeSessions.set(`${workspace.id}:${feishuUserId}`, 'session-1');

      let interruptCalled = false;
      chatService.getRuntimeIfExists = () =>
        makeMockRuntime({
          interrupt: async () => {
            interruptCalled = true;
          },
        });

      await service.handleMenuEvent(makeMenuLarkClient(), workspace, feishuUserId, '/stop');

      assert.strictEqual(interruptCalled, true);
      const text = textCalls();
      assert.strictEqual(text.length, 1);
      const content = (text[0].args as { data: { content: string } }).data.content;
      assert.ok(content.includes('已中断'));
      assert.strictEqual(
        (text[0].args as { data: { receive_id: string } }).data.receive_id,
        feishuUserId,
      );
    });

    it('"stop" replies with no active session message when none exists', async () => {
      await service.handleMenuEvent(makeMenuLarkClient(), workspace, feishuUserId, 'stop');

      const text = textCalls();
      assert.strictEqual(text.length, 1);
      assert.ok((text[0].args as { data: { content: string } }).data.content.includes('没有活跃的会话'));
      assert.strictEqual(createdSessions.length, 0);
    });

    it('"stop" replies with idle message when no turn is in flight', async () => {
      activeSessions.set(`${workspace.id}:${feishuUserId}`, 'session-1');
      chatService.getRuntimeIfExists = () => makeMockRuntime({ isProcessingTurn: false });

      await service.handleMenuEvent(makeMenuLarkClient(), workspace, feishuUserId, 'stop');

      const text = textCalls();
      assert.strictEqual(text.length, 1);
      assert.ok((text[0].args as { data: { content: string } }).data.content.includes('当前没有正在进行的对话'));
    });

    it('"stop" does not crash when the interrupt fails', async () => {
      activeSessions.set(`${workspace.id}:${feishuUserId}`, 'session-1');
      chatService.getRuntimeIfExists = () =>
        makeMockRuntime({
          interrupt: async () => {
            throw new Error('interrupt exploded');
          },
        });

      await service.handleMenuEvent(makeMenuLarkClient(), workspace, feishuUserId, 'stop');

      const text = textCalls();
      assert.strictEqual(text.length, 1);
      assert.ok((text[0].args as { data: { content: string } }).data.content.includes('中断会话失败'));
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

    it('registers a WS dispatcher handler that routes application.bot.menu_v6 to handleMenuEvent', async () => {
      const registeredHandlers: Record<string, (data: Record<string, unknown>) => Promise<void> | void> = {};
      const mockDispatcher = {
        register: (handlers: Record<string, (data: Record<string, unknown>) => Promise<void> | void>) => {
          Object.assign(registeredHandlers, handlers);
        },
      };
      const mockAdapter = {
        _getChannel: () => ({ dispatcher: mockDispatcher }),
      };

      (service as unknown as { registerWSMenuHandler: (adapter: unknown, ws: typeof workspace, client: MockLarkClient) => void }).registerWSMenuHandler(
        mockAdapter,
        workspace,
        makeMenuLarkClient() as unknown as MockLarkClient,
      );

      assert.ok('application.bot.menu_v6' in registeredHandlers, 'should register menu_v6 handler');

      workspaceStore.listFeishuSessionsByUser = () => [
        { sessionId: 'session-existing', workspaceId: workspace.id, feishuUserId },
      ];
      createdSessions.push({ workspaceId: workspace.id, name: 'Existing', source: 'feishu' });

      await registeredHandlers['application.bot.menu_v6']({
        operator: { operator_id: { open_id: feishuUserId } },
        event_key: '/resume',
      });

      assert.strictEqual(interactiveCardCalls().length, 1, 'WS menu /resume should send session-list card');
    });
  });

  describe('/stop command', () => {
    it('interrupts the active streaming reply and does not send a standalone text', async () => {
      activeSessions.set(`${workspace.id}:${feishuUserId}`, 'session-1');
      createdSessions.push({ workspaceId: workspace.id, name: 'Existing', source: 'feishu' });

      let capturedHandler: ((id: number, event: SseEvent) => void) & { cleanup: () => void } | undefined;
      chatService.pushMessage = async (_sessionId, _workspaceId, _text, _isBot, handler) => {
        capturedHandler = handler as typeof capturedHandler;
      };

      await (service as unknown as { handleChatMessage: (thread: MockThread, feishuUserId: string, text: string) => Promise<void> }).handleChatMessage(
        thread,
        feishuUserId,
        'hello',
      );

      assert.ok(capturedHandler, 'handler should be passed to pushMessage');
      capturedHandler!(1, { type: 'assistant_start' } as SseEvent);
      capturedHandler!(2, { type: 'text_delta', text: 'working' } as SseEvent);

      const activeMap = (service as unknown as { activeStreamReplies: Map<string, unknown> }).activeStreamReplies;
      assert.strictEqual(activeMap.has('session-1'), true, 'stream reply should be tracked');

      let interruptCalled = false;
      let cancelMessage: string | undefined;
      chatService.getRuntimeIfExists = () =>
        makeMockRuntime({
          interrupt: async () => {
            interruptCalled = true;
          },
          cancelPendingApprovals: (message) => {
            cancelMessage = message;
          },
        });

      await (service as unknown as { handleStopCommand: (thread: MockThread, feishuUserId: string) => Promise<void> }).handleStopCommand(
        thread,
        feishuUserId,
      );
      await sleep(100);

      assert.strictEqual(interruptCalled, true, 'runtime.interrupt should be called');
      assert.strictEqual(cancelMessage, 'Turn interrupted by user.', 'pending approvals should be cancelled');

      const contentCalls = larkCalls.filter((c) => c.method === 'cardElement.content');
      const lastContent = contentCalls[contentCalls.length - 1]?.args as {
        data: { content: string };
      };
      assert.ok(lastContent?.data.content.endsWith('已中断'), 'stream should end with the interrupt marker');

      const textPosts = getTextPosts();
      assert.strictEqual(textPosts.length, 0, 'should not send a standalone text when the stream is interrupted');
      assert.strictEqual(activeMap.has('session-1'), false, 'stream reply should be removed after finalization');
    });

    it('sends a standalone 已中断 when there is no active stream reply', async () => {
      activeSessions.set(`${workspace.id}:${feishuUserId}`, 'session-1');

      let interruptCalled = false;
      let cancelCalled = false;
      chatService.getRuntimeIfExists = () =>
        makeMockRuntime({
          interrupt: async () => {
            interruptCalled = true;
          },
          cancelPendingApprovals: () => {
            cancelCalled = true;
          },
        });

      await (service as unknown as { handleStopCommand: (thread: MockThread, feishuUserId: string) => Promise<void> }).handleStopCommand(
        thread,
        feishuUserId,
      );

      assert.strictEqual(interruptCalled, true);
      assert.strictEqual(cancelCalled, true);

      const textPosts = getTextPosts();
      assert.strictEqual(textPosts.length, 1);
      assert.strictEqual(textPosts[0], '已中断');
    });

    it('replies with a no-active-session message and does not create a session', async () => {
      await (service as unknown as { handleStopCommand: (thread: MockThread, feishuUserId: string) => Promise<void> }).handleStopCommand(
        thread,
        feishuUserId,
      );

      const textPosts = getTextPosts();
      assert.strictEqual(textPosts.length, 1);
      assert.ok(textPosts[0].includes('没有活跃的会话'));
      assert.strictEqual(createdSessions.length, 0, 'should not create a session for /stop');
    });

    it('replies with an idle message when the session has no in-flight turn', async () => {
      activeSessions.set(`${workspace.id}:${feishuUserId}`, 'session-1');
      chatService.getRuntimeIfExists = () => makeMockRuntime({ isProcessingTurn: false });

      await (service as unknown as { handleStopCommand: (thread: MockThread, feishuUserId: string) => Promise<void> }).handleStopCommand(
        thread,
        feishuUserId,
      );

      const textPosts = getTextPosts();
      assert.strictEqual(textPosts.length, 1);
      assert.ok(textPosts[0].includes('当前没有正在进行的对话'));
    });

    it('replies with a fallback error when the interrupt fails', async () => {
      activeSessions.set(`${workspace.id}:${feishuUserId}`, 'session-1');
      chatService.getRuntimeIfExists = () =>
        makeMockRuntime({
          interrupt: async () => {
            throw new Error('interrupt exploded');
          },
        });

      await (service as unknown as { handleStopCommand: (thread: MockThread, feishuUserId: string) => Promise<void> }).handleStopCommand(
        thread,
        feishuUserId,
      );

      const textPosts = getTextPosts();
      assert.strictEqual(textPosts.length, 1);
      assert.ok(textPosts[0].includes('中断会话失败'));
    });
  });
});
