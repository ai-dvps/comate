import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  ChatService,
  __setIdleGracePeriodForTesting,
  __restoreIdleGracePeriod,
} from './chat-service.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { SessionRuntime } from './session-runtime.js';
import type { Workspace, McpServer } from '../models/workspace.js';
import type { ChatSession, Provider } from '../models/session.js';

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
