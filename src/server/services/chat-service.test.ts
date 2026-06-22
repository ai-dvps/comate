import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  ChatService,
  __setIdleGracePeriodForTesting,
  __restoreIdleGracePeriod,
} from './chat-service.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { SessionRuntime } from './session-runtime.js';
import { SdkClient } from './sdk-client.js';
import type { Workspace, McpServer } from '../models/workspace.js';
import type { ChatSession, Provider } from '../models/session.js';
import type { SseEvent } from '../types/message.js';
import type { Options, SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';

function createMockWorkspace(id: string): Workspace {
  return {
    id,
    name: 'Test',
    description: '',
    folderPath: '/tmp/test',
    settings: {},
    skills: [],
    mcpServers: [] as McpServer[],
    hooks: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createMockSession(id: string): ChatSession {
  return {
    id,
    workspaceId: 'ws-1',
    name: 'Test Session',
    isDraft: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createMockProvider(): Provider {
  return {
    id: 'p1',
    name: 'Test Provider',
    baseUrl: 'http://test',
    authToken: 'test',
    model: 'test-model',
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('chat-service idle-close', { concurrency: false }, () => {
  let service: ChatService;
  const originalOpen = SessionRuntime.open;
  const originalGet = workspaceStore.get.bind(workspaceStore);
  const originalGetLocalSession = workspaceStore.getLocalSession.bind(workspaceStore);
  const originalGetDefaultProvider = workspaceStore.getDefaultProvider.bind(workspaceStore);

  beforeEach(() => {
    __setIdleGracePeriodForTesting(100);
    service = new ChatService();
  });

  afterEach(async () => {
    await service.closeAllRuntimes();
    SessionRuntime.open = originalOpen;
    workspaceStore.get = originalGet;
    workspaceStore.getLocalSession = originalGetLocalSession;
    workspaceStore.getDefaultProvider = originalGetDefaultProvider;
    __restoreIdleGracePeriod();
  });

  function setupStoreMocks() {
    workspaceStore.get = async () => createMockWorkspace('ws-1');
    workspaceStore.getLocalSession = () => createMockSession('s1');
    workspaceStore.getDefaultProvider = () => createMockProvider();
  }

  function createMockRuntime(
    callbacks: {
      onSubscribed?: () => void;
      onUnsubscribed?: () => void;
      onActivity?: () => void;
    } = {},
  ): SessionRuntime {
    const mock = {
      isClosed: () => false,
      getStatus: () => ({ pendingCount: 0, isProcessing: false, workspaceId: 'ws-1' }),
      close: () => Promise.resolve(),
      subscribe: () => {
        callbacks.onSubscribed?.();
        callbacks.onActivity?.();
      },
      unsubscribe: () => {
        callbacks.onUnsubscribed?.();
      },
      pushMessage: () => {
        callbacks.onActivity?.();
      },
      resolveApproval: () => {},
      interrupt: () => Promise.resolve(),
      addBotEventHandler: () => {},
      clearBotEventHandlers: () => {},
      removeBotEventHandler: () => {},
      setApprovalMode: () => {},
      getApprovalMode: () => 'manual' as const,
    };
    return mock as unknown as SessionRuntime;
  }

  it('schedules idle-close immediately on new runtime creation', async () => {
    setupStoreMocks();

    SessionRuntime.open = (...args: unknown[]) => {
      const runtime = createMockRuntime({
        onSubscribed: args[6] as (() => void) | undefined,
        onUnsubscribed: args[7] as (() => void) | undefined,
        onActivity: args[8] as (() => void) | undefined,
      });
      return runtime;
    };

    const runtime = await service.getOrCreateRuntime('s1', 'ws-1');
    assert.ok(runtime);

    const timeouts = (service as unknown as { idleTimeouts: Map<string, NodeJS.Timeout> }).idleTimeouts;
    assert.ok(timeouts.has('s1'), 'idle timeout should be scheduled immediately after runtime creation');
  });

  it('onActivity resets the idle timer', async () => {
    setupStoreMocks();

    let capturedActivity: (() => void) | undefined;
    SessionRuntime.open = (...args: unknown[]) => {
      capturedActivity = args[8] as (() => void) | undefined;
      return createMockRuntime();
    };

    await service.getOrCreateRuntime('s1', 'ws-1');

    const timeouts = (service as unknown as { idleTimeouts: Map<string, NodeJS.Timeout> }).idleTimeouts;
    assert.ok(timeouts.has('s1'));

    const oldTimeout = timeouts.get('s1');
    await new Promise((r) => setTimeout(r, 10));
    capturedActivity?.();
    const newTimeout = timeouts.get('s1');
    assert.notStrictEqual(oldTimeout, newTimeout, 'onActivity should reschedule idle timer');
  });

  it('unsubscribe does not trigger or affect idle timer', async () => {
    setupStoreMocks();

    let capturedUnsubscribed: (() => void) | undefined;
    SessionRuntime.open = (...args: unknown[]) => {
      capturedUnsubscribed = args[7] as (() => void) | undefined;
      return createMockRuntime();
    };

    await service.getOrCreateRuntime('s1', 'ws-1');

    const timeouts = (service as unknown as { idleTimeouts: Map<string, NodeJS.Timeout> }).idleTimeouts;
    assert.ok(timeouts.has('s1'));

    capturedUnsubscribed?.();
    assert.ok(timeouts.has('s1'), 'unsubscribe should not cancel or reschedule idle timer');
  });

  it('idle-close fires after grace period and closes the runtime', async () => {
    setupStoreMocks();

    SessionRuntime.open = () => createMockRuntime();

    await service.getOrCreateRuntime('s1', 'ws-1');
    assert.strictEqual(service.getActiveSessionCount(), 1);

    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(service.getActiveSessionCount(), 0, 'runtime should be closed after idle timeout');
  });

  it('closeRuntime cancels pending idle timer before closing', async () => {
    setupStoreMocks();

    let closeCalled = false;
    SessionRuntime.open = () => {
      const rt = createMockRuntime();
      return {
        ...rt,
        close: async () => {
          closeCalled = true;
        },
      } as unknown as SessionRuntime;
    };

    await service.getOrCreateRuntime('s1', 'ws-1');

    const timeouts = (service as unknown as { idleTimeouts: Map<string, NodeJS.Timeout> }).idleTimeouts;
    assert.ok(timeouts.has('s1'));

    await service.closeRuntime('s1');
    assert.ok(closeCalled, 'close should be called');
    assert.ok(!timeouts.has('s1'), 'idle timer should be cancelled');
  });

  it('rapid successive onActivity calls do not leak timers', async () => {
    setupStoreMocks();

    let capturedActivity: (() => void) | undefined;
    SessionRuntime.open = (...args: unknown[]) => {
      capturedActivity = args[8] as (() => void) | undefined;
      return createMockRuntime();
    };

    await service.getOrCreateRuntime('s1', 'ws-1');

    const timeouts = (service as unknown as { idleTimeouts: Map<string, NodeJS.Timeout> }).idleTimeouts;
    const seen = new Set<NodeJS.Timeout>();

    for (let i = 0; i < 5; i++) {
      capturedActivity?.();
      const t = timeouts.get('s1');
      if (t) seen.add(t);
    }

    assert.strictEqual(seen.size, 5, 'each onActivity should create a new timeout');
    assert.strictEqual(timeouts.size, 1, 'only one timeout should be tracked in the map');
  });

  it('reports pending and processing status for workspace runtimes', async () => {
    setupStoreMocks();

    SessionRuntime.open = () => ({
      ...createMockRuntime(),
      getStatus: () => ({
        pendingCount: 2,
        isProcessing: true,
        workspaceId: 'ws-1',
      }),
    } as unknown as SessionRuntime);

    await service.getOrCreateRuntime('s1', 'ws-1');

    assert.deepStrictEqual(service.getSessionsStatus('ws-1'), {
      s1: {
        pendingCount: 2,
        isProcessing: true,
      },
    });
    assert.deepStrictEqual(service.getSessionsStatus('other-ws'), {});
  });

  it('onSubscribed cancels idle timer', async () => {
    setupStoreMocks();

    let capturedSubscribed: (() => void) | undefined;
    SessionRuntime.open = (...args: unknown[]) => {
      capturedSubscribed = args[6] as (() => void) | undefined;
      return createMockRuntime();
    };

    await service.getOrCreateRuntime('s1', 'ws-1');

    const timeouts = (service as unknown as { idleTimeouts: Map<string, NodeJS.Timeout> }).idleTimeouts;
    assert.ok(timeouts.has('s1'));

    capturedSubscribed?.();
    assert.ok(!timeouts.has('s1'), 'onSubscribed should cancel idle timer');
  });
});

describe('chat-service pushMessage', { concurrency: false }, () => {
  let service: ChatService;
  const originalOpen = SessionRuntime.open;
  const originalGet = workspaceStore.get.bind(workspaceStore);
  const originalGetLocalSession = workspaceStore.getLocalSession.bind(workspaceStore);
  const originalGetDefaultProvider = workspaceStore.getDefaultProvider.bind(workspaceStore);
  const originalClearDraftFlag = workspaceStore.clearDraftFlag.bind(workspaceStore);

  class MockSdkClient extends SdkClient {
    override async getSessionInfo(): Promise<SDKSessionInfo | undefined> {
      return {
        sessionId: 's1',
        summary: 'Test Session',
        createdAt: new Date().toISOString(),
        lastModified: new Date().toISOString(),
      } as SDKSessionInfo;
    }
    override async listSessions(): Promise<SDKSessionInfo[]> {
      return [];
    }
    override async listSubagents(): Promise<string[]> {
      return [];
    }
    override async getSessionMessages(): Promise<SessionMessage[]> {
      return [];
    }
    override async getSubagentMessages(): Promise<SessionMessage[]> {
      return [];
    }
    override async renameSession(): Promise<void> {}
    override async forkSession(): Promise<{ sessionId: string }> {
      return { sessionId: 'fork-s1' };
    }
  }

  class TestChatService extends ChatService {
    constructor() {
      super(new MockSdkClient());
    }
    protected override async testClaudeBinary(): Promise<void> {
      // no-op to avoid spawning the real Claude binary in tests
    }
  }

  function createMockRuntime(
    callbacks: {
      onSubscribed?: () => void;
      onUnsubscribed?: () => void;
      onActivity?: () => void;
    } = {},
  ): SessionRuntime & { pushMessageCalls: string[]; botHandlers: Array<(id: number, event: SseEvent) => void> } {
    const pushMessageCalls: string[] = [];
    const botHandlers: Array<(id: number, event: SseEvent) => void> = [];
    const mock = {
      isClosed: () => false,
      getStatus: () => ({ pendingCount: 0, isProcessing: false, workspaceId: 'ws-1' }),
      close: () => Promise.resolve(),
      subscribe: () => {
        callbacks.onSubscribed?.();
        callbacks.onActivity?.();
      },
      unsubscribe: () => {
        callbacks.onUnsubscribed?.();
      },
      pushMessage: (message: string) => {
        pushMessageCalls.push(message);
        callbacks.onActivity?.();
      },
      resolveApproval: () => {},
      interrupt: () => Promise.resolve(),
      addBotEventHandler: (handler: (id: number, event: SseEvent) => void) => {
        botHandlers.push(handler);
      },
      clearBotEventHandlers: () => {
        botHandlers.length = 0;
      },
      removeBotEventHandler: () => {},
      setApprovalMode: () => {},
      getApprovalMode: () => 'manual' as const,
      pushMessageCalls,
      botHandlers,
    };
    return mock as unknown as SessionRuntime & { pushMessageCalls: string[]; botHandlers: Array<(id: number, event: SseEvent) => void> };
  }

  function setupStoreMocks(session: ChatSession = createMockSession('s1')) {
    workspaceStore.get = async () => createMockWorkspace('ws-1');
    workspaceStore.getLocalSession = () => session;
    workspaceStore.getDefaultProvider = () => createMockProvider();
  }

  beforeEach(() => {
    service = new TestChatService();
  });

  afterEach(async () => {
    await service.closeAllRuntimes();
    SessionRuntime.open = originalOpen;
    workspaceStore.get = originalGet;
    workspaceStore.getLocalSession = originalGetLocalSession;
    workspaceStore.getDefaultProvider = originalGetDefaultProvider;
    workspaceStore.clearDraftFlag = originalClearDraftFlag;
  });

  it('clears the draft flag on first message', async () => {
    setupStoreMocks();
    let clearDraftCalled = false;
    workspaceStore.clearDraftFlag = (id: string) => {
      clearDraftCalled = true;
      return originalClearDraftFlag(id);
    };

    SessionRuntime.open = () => createMockRuntime();

    await service.pushMessage('s1', 'ws-1', 'hello');
    assert.ok(clearDraftCalled, 'clearDraftFlag should be called for a draft session');
  });

  it('does not clear the draft flag for non-draft sessions', async () => {
    setupStoreMocks({ ...createMockSession('s1'), isDraft: false });
    let clearDraftCalled = false;
    workspaceStore.clearDraftFlag = (id: string) => {
      clearDraftCalled = true;
      return originalClearDraftFlag(id);
    };

    SessionRuntime.open = () => createMockRuntime();

    await service.pushMessage('s1', 'ws-1', 'hello');
    assert.ok(!clearDraftCalled, 'clearDraftFlag should not be called for a non-draft session');
  });

  it('passes the message to the runtime', async () => {
    setupStoreMocks();
    SessionRuntime.open = () => createMockRuntime();

    await service.pushMessage('s1', 'ws-1', 'hello world');
    const runtime = (service as unknown as { runtimes: Map<string, SessionRuntime> }).runtimes.get('s1');
    const calls = (runtime as unknown as { pushMessageCalls: string[] }).pushMessageCalls;
    assert.deepStrictEqual(calls, ['hello world']);
  });

  it('registers bot event handler when isBotSession is true', async () => {
    setupStoreMocks();
    const handler = (() => {}) as (id: number, event: SseEvent) => void;
    SessionRuntime.open = (...args: unknown[]) => {
      const rt = createMockRuntime();
      const botHandler = args[5] as ((id: number, event: SseEvent) => void) | undefined;
      if (botHandler) {
        rt.addBotEventHandler(botHandler);
      }
      return rt;
    };

    await service.pushMessage('s1', 'ws-1', 'hello', true, handler);
    const runtime = (service as unknown as { runtimes: Map<string, SessionRuntime> }).runtimes.get('s1');
    const handlers = (runtime as unknown as { botHandlers: Array<(id: number, event: SseEvent) => void> }).botHandlers;
    assert.strictEqual(handlers.length, 1);
    assert.strictEqual(handlers[0], handler);
  });
});

describe('chat-service canUseTool policy gating', { concurrency: false }, () => {
  let service: ChatService;
  const originalOpen = SessionRuntime.open;
  const originalGet = workspaceStore.get.bind(workspaceStore);
  const originalGetLocalSession = workspaceStore.getLocalSession.bind(workspaceStore);
  const originalGetDefaultProvider = workspaceStore.getDefaultProvider.bind(workspaceStore);
  const originalGetWecomUserIdBySession = workspaceStore.getWecomUserIdBySession.bind(workspaceStore);
  const originalGetWecomUserMapping = workspaceStore.getWecomUserMapping.bind(workspaceStore);
  const originalListWecomWorkspaceUsers = workspaceStore.listWecomWorkspaceUsers.bind(workspaceStore);
  const originalListWecomUserMappings = workspaceStore.listWecomUserMappings.bind(workspaceStore);

  class MockSdkClient extends SdkClient {
    override async getSessionInfo(): Promise<SDKSessionInfo | undefined> {
      return {
        sessionId: 's1',
        summary: 'Test Session',
        createdAt: new Date().toISOString(),
        lastModified: new Date().toISOString(),
      } as SDKSessionInfo;
    }
    override async listSessions(): Promise<SDKSessionInfo[]> {
      return [];
    }
    override async listSubagents(): Promise<string[]> {
      return [];
    }
    override async getSessionMessages(): Promise<SessionMessage[]> {
      return [];
    }
    override async getSubagentMessages(): Promise<SessionMessage[]> {
      return [];
    }
    override async renameSession(): Promise<void> {}
    override async forkSession(): Promise<{ sessionId: string }> {
      return { sessionId: 'fork-s1' };
    }
  }

  class TestChatService extends ChatService {
    constructor() {
      super(new MockSdkClient());
    }
    protected override async testClaudeBinary(): Promise<void> {}
  }

  beforeEach(() => {
    service = new TestChatService();
  });

  afterEach(async () => {
    await service.closeAllRuntimes();
    SessionRuntime.open = originalOpen;
    workspaceStore.get = originalGet;
    workspaceStore.getLocalSession = originalGetLocalSession;
    workspaceStore.getDefaultProvider = originalGetDefaultProvider;
    workspaceStore.getWecomUserIdBySession = originalGetWecomUserIdBySession;
    workspaceStore.getWecomUserMapping = originalGetWecomUserMapping;
    workspaceStore.listWecomWorkspaceUsers = originalListWecomWorkspaceUsers;
    workspaceStore.listWecomUserMappings = originalListWecomUserMappings;
  });

  function createMockRuntime(): SessionRuntime {
    const mock = {
      isClosed: () => false,
      getStatus: () => ({ pendingCount: 0, isProcessing: false, workspaceId: 'ws-1' }),
      close: () => Promise.resolve(),
      subscribe: () => {},
      unsubscribe: () => {},
      pushMessage: () => {},
      resolveApproval: () => {},
      interrupt: () => Promise.resolve(),
      addBotEventHandler: () => {},
      clearBotEventHandlers: () => {},
      removeBotEventHandler: () => {},
      setApprovalMode: () => {},
      getApprovalMode: () => 'manual' as const,
    };
    return mock as unknown as SessionRuntime;
  }

  async function captureBotCanUseTool(
    workspaceSettingsOverrides: Record<string, unknown>,
  ): Promise<NonNullable<Options['canUseTool']>> {
    const mockWorkspace = createMockWorkspace('ws-1');
    Object.assign(mockWorkspace.settings, workspaceSettingsOverrides);
    workspaceStore.get = async () => mockWorkspace;
    workspaceStore.getLocalSession = () => createMockSession('s1');
    workspaceStore.getDefaultProvider = () => createMockProvider();
    workspaceStore.getWecomUserIdBySession = () => 'wecom-user-1';
    workspaceStore.getWecomUserMapping = () => 'user1';
    workspaceStore.listWecomWorkspaceUsers = () => [];
    workspaceStore.listWecomUserMappings = () => [];
    if (!mockWorkspace.settings.wecomBotIsolation?.bashWhitelist) {
      mockWorkspace.settings.wecomBotIsolation = {
        ...(mockWorkspace.settings.wecomBotIsolation ?? {}),
        bashWhitelist: [{ command: 'ls', args: [] }],
      };
    }

    let capturedOptions: Options | undefined;
    SessionRuntime.open = (...args: unknown[]) => {
      capturedOptions = args[3] as Options;
      return createMockRuntime();
    };

    await service.getOrCreateRuntime('s1', 'ws-1', true);
    assert.ok(capturedOptions?.canUseTool, 'canUseTool must be set for bot sessions');
    return capturedOptions.canUseTool;
  }

  it('bot session with policy denying Shell: canUseTool returns deny for Bash with generic message', async () => {
    const canUseTool = await captureBotCanUseTool({
      wecomBotEnabled: true,
      wecomToolPermissions: {
        posture: 'safe',
        categoryDefaults: {
          fileRead: 'allow',
          fileWrite: 'deny',
          shell: 'deny',
          network: 'deny',
          subagents: 'deny',
          reply: 'allow',
        },
      },
    });

    const result = await canUseTool('Bash', { command: 'ls' });
    assert.strictEqual(result.behavior, 'deny');
    if (result.behavior === 'deny') {
      assert.ok(!result.message.toLowerCase().includes('shell'), 'denial message must not leak capability name');
      assert.ok(!result.message.toLowerCase().includes('bash'), 'denial message must not leak tool name');
    }
  });

  it('bot session with policy allowing File Read: canUseTool returns allow for Read', async () => {
    const canUseTool = await captureBotCanUseTool({
      wecomBotEnabled: true,
      wecomToolPermissions: {
        posture: 'safe',
        categoryDefaults: {
          fileRead: 'allow',
          fileWrite: 'deny',
          shell: 'deny',
          network: 'deny',
          subagents: 'deny',
          reply: 'allow',
        },
      },
    });

    const result = await canUseTool('Read', { file_path: '/tmp/test/user1/x' });
    assert.strictEqual(result.behavior, 'allow');
  });

  it('bot session: allow override on denied category inverts the decision', async () => {
    const canUseTool = await captureBotCanUseTool({
      wecomBotEnabled: true,
      wecomToolPermissions: {
        posture: 'custom',
        categoryDefaults: {
          fileRead: 'allow',
          fileWrite: 'deny',
          shell: 'deny',
          network: 'deny',
          subagents: 'deny',
          reply: 'allow',
        },
        overrides: { Bash: 'allow' },
      },
    });

    const result = await canUseTool('Bash', { command: 'ls' });
    assert.strictEqual(result.behavior, 'allow');
  });

  it('bot session: deny override on allowed category inverts the decision', async () => {
    const canUseTool = await captureBotCanUseTool({
      wecomBotEnabled: true,
      wecomToolPermissions: {
        posture: 'custom',
        categoryDefaults: {
          fileRead: 'allow',
          fileWrite: 'allow',
          shell: 'allow',
          network: 'allow',
          subagents: 'allow',
          reply: 'allow',
        },
        overrides: { Edit: 'deny' },
      },
    });

    const editResult = await canUseTool('Edit', { file_path: '/tmp/x' });
    assert.strictEqual(editResult.behavior, 'deny');
    const writeResult = await canUseTool('Write', { file_path: '/tmp/test/user1/x' });
    assert.strictEqual(writeResult.behavior, 'allow');
  });

  it('bot session: MCP tool falls through to allow (R10)', async () => {
    const canUseTool = await captureBotCanUseTool({
      wecomBotEnabled: true,
      wecomToolPermissions: {
        posture: 'safe',
        categoryDefaults: {
          fileRead: 'allow',
          fileWrite: 'deny',
          shell: 'deny',
          network: 'deny',
          subagents: 'deny',
          reply: 'allow',
        },
      },
    });

    const result = await canUseTool('mcp__myserver__tool', {});
    assert.strictEqual(result.behavior, 'allow');
  });

  it('bot session with no policy and bot enabled: grandfathered allow-all (R7)', async () => {
    const canUseTool = await captureBotCanUseTool({
      wecomBotEnabled: true,
      // No wecomToolPermissions — grandfathered
    });

    const bashResult = await canUseTool('Bash', { command: 'ls' });
    assert.strictEqual(bashResult.behavior, 'allow');
    const writeResult = await canUseTool('Write', { file_path: '/tmp/test/user1/x' });
    assert.strictEqual(writeResult.behavior, 'allow');
  });

  it('GUI session (isBotSession undefined): canUseTool is not set', async () => {
    const mockWorkspace = createMockWorkspace('ws-1');
    workspaceStore.get = async () => mockWorkspace;
    workspaceStore.getLocalSession = () => createMockSession('s1');
    workspaceStore.getDefaultProvider = () => createMockProvider();

    let capturedOptions: Options | undefined;
    SessionRuntime.open = (...args: unknown[]) => {
      capturedOptions = args[3] as Options;
      return createMockRuntime();
    };

    // No isBotSession arg → GUI session
    await service.getOrCreateRuntime('s1', 'ws-1');
    assert.ok(capturedOptions);
    assert.strictEqual(capturedOptions!.canUseTool, undefined, 'GUI sessions must not have canUseTool set by this branch');
  });
});

describe('chat-service loadMessages subagents', { concurrency: false }, () => {
  let service: ChatService;
  const originalGet = workspaceStore.get.bind(workspaceStore);
  const originalGetLocalSession = workspaceStore.getLocalSession.bind(workspaceStore);
  const originalGetDefaultProvider = workspaceStore.getDefaultProvider.bind(workspaceStore);

  class TestChatService extends ChatService {
    constructor(sdkClient?: SdkClient) {
      super(sdkClient ?? new SdkClient());
    }
    protected override async testClaudeBinary(): Promise<void> {}
  }

  function setupStoreMocks() {
    workspaceStore.get = async () => createMockWorkspace('ws-1');
    workspaceStore.getLocalSession = () => createMockSession('s1');
    workspaceStore.getDefaultProvider = () => createMockProvider();
  }

  beforeEach(() => {
    setupStoreMocks();
  });

  afterEach(async () => {
    await service?.closeAllRuntimes();
    workspaceStore.get = originalGet;
    workspaceStore.getLocalSession = originalGetLocalSession;
    workspaceStore.getDefaultProvider = originalGetDefaultProvider;
  });

  it('returns reconstructed subagents alongside messages and tasks', async () => {
    const mainMessages: SessionMessage[] = [
      {
        type: 'assistant',
        uuid: 'm1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-123',
              name: 'Agent',
              input: { description: 'Grounding scout' },
            },
          ],
        },
      } as unknown as SessionMessage,
      {
        type: 'user',
        uuid: 'm2',
        session_id: 's1',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-123',
              content: 'Async agent launched. agentId: agent-1 (internal ID)',
              is_error: false,
            },
          ],
        },
      } as unknown as SessionMessage,
    ];

    const subagentMessages: SessionMessage[] = [
      {
        type: 'user',
        uuid: 'u1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'go' },
      } as unknown as SessionMessage,
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
      } as unknown as SessionMessage,
    ];

    class SubagentMockSdkClient extends SdkClient {
      override async getSessionMessages(): Promise<SessionMessage[]> {
        return mainMessages;
      }
      override async listSubagents(): Promise<string[]> {
        return ['agent-1'];
      }
      override async getSubagentMessages(): Promise<SessionMessage[]> {
        return subagentMessages;
      }
    }

    service = new TestChatService(new SubagentMockSdkClient());
    const result = await service.loadMessages('s1', 'ws-1');

    assert.strictEqual(result.subagents.length, 1);
    assert.strictEqual(result.subagents[0].parentToolUseId, 'tool-123');
    assert.strictEqual(result.subagents[0].description, 'Grounding scout');
    assert.strictEqual(result.subagents[0].state, 'completed');
    assert.strictEqual(result.subagents[0].messages.length, 2);
    assert.strictEqual(result.subagents[0].toolCount, 0);
  });

  it('survives listSubagents failures and returns empty subagents', async () => {
    class FailingListSdkClient extends SdkClient {
      override async getSessionMessages(): Promise<SessionMessage[]> {
        return [];
      }
      override async listSubagents(): Promise<string[]> {
        throw new Error('disk read failed');
      }
    }

    service = new TestChatService(new FailingListSdkClient());
    const result = await service.loadMessages('s1', 'ws-1');

    assert.deepStrictEqual(result.messages, []);
    assert.deepStrictEqual(result.tasks, []);
    assert.deepStrictEqual(result.subagents, []);
  });

  it('falls back to main transcript tool_result when subagent meta file is missing', async () => {
    const mainMessages: SessionMessage[] = [
      {
        type: 'user',
        uuid: 'm1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-456',
              content: 'Async agent launched. agentId: agent-2 (internal ID)',
              is_error: false,
            },
          ],
        },
        toolUseResult: { description: 'Fallback agent' },
      } as unknown as SessionMessage,
    ];

    const subagentMessages: SessionMessage[] = [
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'found it' }],
        },
      } as unknown as SessionMessage,
    ];

    class FallbackSdkClient extends SdkClient {
      override async getSessionMessages(): Promise<SessionMessage[]> {
        return mainMessages;
      }
      override async listSubagents(): Promise<string[]> {
        return ['agent-2'];
      }
      override async getSubagentMessages(): Promise<SessionMessage[]> {
        return subagentMessages;
      }
    }

    service = new TestChatService(new FallbackSdkClient());
    const result = await service.loadMessages('s1', 'ws-1');

    assert.strictEqual(result.subagents.length, 1);
    assert.strictEqual(result.subagents[0].parentToolUseId, 'tool-456');
    assert.strictEqual(result.subagents[0].description, 'Fallback agent');
  });
});

describe('chat-service forkSession', { concurrency: false }, () => {
  let service: ChatService;
  const originalGet = workspaceStore.get.bind(workspaceStore);

  class TestChatService extends ChatService {
    constructor(sdkClient?: SdkClient) {
      super(sdkClient ?? new SdkClient());
    }
    protected override async testClaudeBinary(): Promise<void> {}
  }

  function setupStoreMocks() {
    workspaceStore.get = async () => createMockWorkspace('ws-1');
  }

  beforeEach(() => {
    setupStoreMocks();
  });

  afterEach(async () => {
    await service?.closeAllRuntimes();
    workspaceStore.get = originalGet;
  });

  it('forks a session and returns the new session id', async () => {
    class ForkMockSdkClient extends SdkClient {
      override async forkSession(
        sessionId: string,
        options?: { dir?: string },
      ): Promise<{ sessionId: string }> {
        assert.strictEqual(sessionId, 's1');
        assert.strictEqual(options?.dir, '/tmp/test');
        return { sessionId: 'fork-s1' };
      }
    }

    service = new TestChatService(new ForkMockSdkClient());
    const result = await service.forkSession('s1', 'ws-1');
    assert.strictEqual(result.sessionId, 'fork-s1');
  });

  it('throws ChatError when workspace is not found', async () => {
    workspaceStore.get = async () => undefined as unknown as Workspace;
    service = new TestChatService();
    await assert.rejects(
      () => service.forkSession('s1', 'ws-1'),
      (err: Error) => err instanceof Error && err.message === 'Workspace not found',
    );
  });
});