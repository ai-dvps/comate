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
import type { Options, Query, SDKMessage, SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';

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
    override async getSessionMessages(): Promise<SessionMessage[]> {
      return [];
    }
    override async renameSession(): Promise<void> {}
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
    const handler = (_id: number, _event: SseEvent) => {};
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
