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
import type { Options, SDKSessionInfo, SessionMessage, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { BotPersona, BotRole } from '../models/bot.js';
import type { QuestionPayload } from '../types/message.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { botService } from './bot-service.js';
import { SAFE_PRESET } from './tool-permission-policy.js';

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

function collectDiagLogs(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalSidecar = process.env.COMATE_SIDECAR;
  // diagLog only mirrors to console when COMATE_SIDECAR is not '1'. Tests run
  // under the sidecar harness, so temporarily clear it so console.log captures
  // diagnostic lines without writing them to the real log file.
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
    options: { isProcessing?: () => boolean } = {},
  ): SessionRuntime {
    const mock = {
      isClosed: () => false,
      isProcessingTurn: () => options.isProcessing?.() ?? false,
      getStatus: () => ({ pendingCount: 0, isProcessing: options.isProcessing?.() ?? false, workspaceId: 'ws-1' }),
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

  it('idle-close defers while a turn is in flight', async () => {
    setupStoreMocks();
    const processing = true;
    SessionRuntime.open = () => createMockRuntime({}, { isProcessing: () => processing });

    await service.getOrCreateRuntime('s1', 'ws-1');
    assert.strictEqual(service.getActiveSessionCount(), 1);

    // Grace period elapses, but the runtime stays open because a turn is in flight.
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(service.getActiveSessionCount(), 1, 'runtime should stay open while a turn is in flight');
    const timeouts = (service as unknown as { idleTimeouts: Map<string, NodeJS.Timeout> }).idleTimeouts;
    assert.ok(timeouts.has('s1'), 'idle timer should be re-armed (deferred)');
  });

  it('idle-close fires once the in-flight turn completes', async () => {
    setupStoreMocks();
    let processing = true;
    SessionRuntime.open = () => createMockRuntime({}, { isProcessing: () => processing });

    await service.getOrCreateRuntime('s1', 'ws-1');
    await new Promise((r) => setTimeout(r, 150)); // deferred while processing
    assert.strictEqual(service.getActiveSessionCount(), 1);

    processing = false; // turn completes
    await new Promise((r) => setTimeout(r, 150)); // re-armed timer now fires and closes
    assert.strictEqual(service.getActiveSessionCount(), 0, 'runtime should close after the turn completes');
  });

  it('idle-close is a no-op when the runtime was already closed', async () => {
    setupStoreMocks();
    SessionRuntime.open = () => createMockRuntime();

    await service.getOrCreateRuntime('s1', 'ws-1');
    // Simulate the runtime being removed by another path while the timer is pending.
    (service as unknown as { runtimes: Map<string, SessionRuntime> }).runtimes.delete('s1');

    // The pending timer fires; it must not throw and must not resurrect the runtime.
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(service.getActiveSessionCount(), 0, 'already-closed runtime should not be tracked');
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
    const pendingApprovals = new Map<string, { resolve: (result: PermissionResult) => void }>();

    const mock = {
      isClosed: () => false,
      getStatus: () => ({ pendingCount: pendingApprovals.size, isProcessing: pendingApprovals.size > 0, workspaceId: 'ws-1' }),
      close: () => Promise.resolve(),
      subscribe: () => {},
      unsubscribe: () => {},
      pushMessage: () => {},
      resolveApproval: (requestId: string, result: PermissionResult) => {
        const pending = pendingApprovals.get(requestId);
        if (!pending) return;
        pendingApprovals.delete(requestId);
        pending.resolve(result);
      },
      requestToolApproval: (requestId: string, _toolName: string, _toolUseId: string, _input: Record<string, unknown>, options: { signal?: AbortSignal; timeout?: number; suggestions?: PermissionUpdate[] } = {}) => {
        return new Promise<PermissionResult>((resolve) => {
          pendingApprovals.set(requestId, { resolve });
          if (options.timeout) {
            setTimeout(() => {
              const p = pendingApprovals.get(requestId);
              if (p) {
                pendingApprovals.delete(requestId);
                p.resolve({ behavior: 'deny', message: 'Request timed out waiting for user response.' });
              }
            }, options.timeout);
          }
        });
      },
      requestToolQuestion: (requestId: string, _questions: QuestionPayload[], _input: Record<string, unknown>, options: { signal?: AbortSignal; timeout?: number } = {}) => {
        return new Promise<PermissionResult>((resolve) => {
          pendingApprovals.set(requestId, { resolve });
          if (options.timeout) {
            setTimeout(() => {
              const p = pendingApprovals.get(requestId);
              if (p) {
                pendingApprovals.delete(requestId);
                p.resolve({ behavior: 'deny', message: 'Request timed out waiting for user response.' });
              }
            }, options.timeout);
          }
        });
      },
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
    identity?: {
      botUserId?: string;
      wecomUserId?: string | null;
      mapping?: string | null;
      knownUserDirNames?: string[];
    },
  ): Promise<NonNullable<Options['canUseTool']>> {
    const mockWorkspace = createMockWorkspace('ws-1');
    Object.assign(mockWorkspace.settings, workspaceSettingsOverrides);
    workspaceStore.get = async () => mockWorkspace;
    workspaceStore.getLocalSession = () => createMockSession('s1');
    workspaceStore.getDefaultProvider = () => createMockProvider();
    workspaceStore.getWecomUserIdBySession = () =>
      identity?.wecomUserId === undefined ? 'wecom-user-1' : identity.wecomUserId;
    workspaceStore.getWecomUserMapping = () =>
      identity?.mapping === undefined ? 'user1' : identity.mapping;
    const knownUserDirNames = identity?.knownUserDirNames ?? [];
    workspaceStore.listWecomWorkspaceUsers = () => knownUserDirNames.map((name) => ({ encryptedUserId: name, plaintextUserId: name }));
    workspaceStore.listWecomUserMappings = () => [];

    let capturedOptions: Options | undefined;
    SessionRuntime.open = (...args: unknown[]) => {
      capturedOptions = args[3] as Options;
      return createMockRuntime();
    };

    await service.getOrCreateRuntime('s1', 'ws-1', true, undefined, identity?.botUserId);
    assert.ok(capturedOptions?.canUseTool, 'canUseTool must be set for bot sessions');
    return capturedOptions.canUseTool;
  }

  async function captureBotOptions(
    workspaceSettingsOverrides: Record<string, unknown> = {},
    botUserId?: string,
    sessionOverrides: Partial<ChatSession> = {},
  ): Promise<Options> {
    const mockWorkspace = createMockWorkspace('ws-1');
    Object.assign(mockWorkspace.settings, workspaceSettingsOverrides);
    workspaceStore.get = async () => mockWorkspace;
    workspaceStore.getLocalSession = () => ({ ...createMockSession('s1'), ...sessionOverrides });
    workspaceStore.getDefaultProvider = () => createMockProvider();
    workspaceStore.listWecomWorkspaceUsers = () => [];
    workspaceStore.listWecomUserMappings = () => [];

    let capturedOptions: Options | undefined;
    SessionRuntime.open = (...args: unknown[]) => {
      capturedOptions = args[3] as Options;
      return createMockRuntime();
    };

    await service.getOrCreateRuntime('s1', 'ws-1', true, undefined, botUserId);
    assert.ok(capturedOptions, 'options must be captured');
    return capturedOptions;
  }

  it('Feishu bot session does not set WECOM_USER_ID', async () => {
    workspaceStore.getWecomUserIdBySession = () => undefined;
    workspaceStore.getWecomUserMapping = () => undefined;
    const options = await captureBotOptions({ wecomBotEnabled: true }, 'feishu-user-1');
    assert.strictEqual(options.env.WECOM_USER_ID, undefined);
  });

  it('GUI session does not set WECOM_USER_ID', async () => {
    workspaceStore.getWecomUserIdBySession = () => 'wecom-user-1';
    workspaceStore.getWecomUserMapping = () => 'user1';
    const mockWorkspace = createMockWorkspace('ws-1');
    workspaceStore.get = async () => mockWorkspace;
    workspaceStore.getLocalSession = () => createMockSession('s1');
    workspaceStore.getDefaultProvider = () => createMockProvider();

    let capturedOptions: Options | undefined;
    SessionRuntime.open = (...args: unknown[]) => {
      capturedOptions = args[3] as Options;
      return createMockRuntime();
    };

    await service.getOrCreateRuntime('s1', 'ws-1', false);
    assert.ok(capturedOptions, 'options must be captured');
    assert.strictEqual(capturedOptions.env.WECOM_USER_ID, undefined);
  });

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

    const { logs, restore } = collectDiagLogs();
    let result;
    try {
      result = await canUseTool('Bash', { command: 'ls' });
    } finally {
      restore();
    }

    assert.strictEqual(result.behavior, 'deny');
    if (result.behavior === 'deny') {
      assert.ok(!result.message.toLowerCase().includes('shell'), 'denial message must not leak capability name');
      assert.ok(!result.message.toLowerCase().includes('bash'), 'denial message must not leak tool name');
    }
    assert.ok(
      logs.some((line) => line.includes('reason=category-deny') && line.includes('tool=Bash')),
      'expected category-deny to be logged',
    );
    assert.ok(!logs.some((line) => line.includes('command')), 'log line must not contain tool input');
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

    const result = await canUseTool('Read', { file_path: '/tmp/test/data/user1/x' });
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

    const { logs, restore } = collectDiagLogs();
    let editResult;
    try {
      editResult = await canUseTool('Edit', { file_path: '/tmp/x' });
    } finally {
      restore();
    }
    assert.strictEqual(editResult.behavior, 'deny');
    assert.ok(
      logs.some((line) => line.includes('reason=override-deny') && line.includes('tool=Edit')),
      'expected override-deny to be logged',
    );

    const writeResult = await canUseTool('Write', { file_path: '/tmp/test/data/user1/x' });
    assert.strictEqual(writeResult.behavior, 'allow');
  });

  it('bot session: missing identity denies identity-sensitive tools and logs missing-identity', async () => {
    const canUseTool = await captureBotCanUseTool(
      {
        wecomBotEnabled: true,
        wecomToolPermissions: {
          posture: 'safe',
          categoryDefaults: {
            fileRead: 'allow',
            fileWrite: 'allow',
            shell: 'allow',
            network: 'allow',
            subagents: 'allow',
            reply: 'allow',
          },
        },
      },
      { wecomUserId: null, mapping: null },
    );

    const { logs, restore } = collectDiagLogs();
    let result;
    try {
      result = await canUseTool('Read', { file_path: '/tmp/test/data/user1/x' });
    } finally {
      restore();
    }
    assert.strictEqual(result.behavior, 'deny');
    assert.ok(
      logs.some((line) => line.includes('reason=missing-identity') && line.includes('tool=Read')),
      'expected missing-identity to be logged',
    );
  });

  it('bot session: path policy deny logs the path reason', async () => {
    const canUseTool = await captureBotCanUseTool({
      wecomBotEnabled: true,
      wecomToolPermissions: {
        posture: 'safe',
        categoryDefaults: {
          fileRead: 'allow',
          fileWrite: 'allow',
          shell: 'allow',
          network: 'allow',
          subagents: 'allow',
          reply: 'allow',
        },
      },
    });

    const { logs, restore } = collectDiagLogs();
    let result;
    try {
      result = await canUseTool('Read', { file_path: '/tmp/outside-workspace' });
    } finally {
      restore();
    }
    assert.strictEqual(result.behavior, 'deny');
    assert.ok(
      logs.some((line) => line.includes('reason=outside-workspace') && line.includes('tool=Read')),
      'expected outside-workspace path reason to be logged',
    );
    assert.ok(!logs.some((line) => line.includes('/tmp/outside-workspace')), 'log line must not contain the path');
  });

  it('bot session: skill policy deny logs the skill reason', async () => {
    const canUseTool = await captureBotCanUseTool({
      wecomBotEnabled: true,
      wecomToolPermissions: {
        posture: 'safe',
        categoryDefaults: {
          fileRead: 'allow',
          fileWrite: 'allow',
          shell: 'allow',
          network: 'allow',
          subagents: 'allow',
          reply: 'allow',
        },
      },
      wecomBotIsolation: {
        adminUserIds: [],
        defaultAllowedSkills: [],
        adminAllowedSkills: [],
      },
    });

    const { logs, restore } = collectDiagLogs();
    let result;
    try {
      result = await canUseTool('Skill', { skill_name: 'DisallowedSkill' });
    } finally {
      restore();
    }
    assert.strictEqual(result.behavior, 'deny');
    assert.ok(
      logs.some((line) => line.includes('reason=skill-not-allowed') && line.includes('tool=Skill')),
      'expected skill-not-allowed to be logged',
    );
    assert.ok(!logs.some((line) => line.includes('DisallowedSkill')), 'log line must not contain the skill name');
  });

  it('bot session: AskUserQuestion without runtime logs missing-runtime', async () => {
    const canUseTool = await captureBotCanUseTool({
      wecomBotEnabled: true,
      wecomToolPermissions: {
        posture: 'safe',
        categoryDefaults: {
          fileRead: 'allow',
          fileWrite: 'allow',
          shell: 'allow',
          network: 'allow',
          subagents: 'allow',
          reply: 'allow',
        },
      },
    });

    // Remove the runtime so the ask path cannot find it.
    (service as unknown as { runtimes: Map<string, SessionRuntime> }).runtimes.delete('s1');

    const { logs, restore } = collectDiagLogs();
    let result;
    try {
      result = await canUseTool('AskUserQuestion', {
        questions: [{ question: 'ok?', options: [{ label: 'yes' }] }],
      });
    } finally {
      restore();
    }
    assert.strictEqual(result.behavior, 'deny');
    assert.ok(
      logs.some((line) => line.includes('reason=missing-runtime') && line.includes('tool=AskUserQuestion')),
      'expected missing-runtime to be logged',
    );
    assert.ok(
      !logs.some((line) => line.includes('ok?')),
      'log line must not contain question text',
    );
  });

  it('bot session: ask policy without runtime logs missing-runtime', async () => {
    const canUseTool = await captureBotCanUseTool({
      wecomBotEnabled: true,
      wecomToolPermissions: {
        posture: 'custom',
        categoryDefaults: {
          fileRead: 'allow',
          fileWrite: 'deny',
          shell: 'ask',
          network: 'deny',
          subagents: 'deny',
          reply: 'allow',
        },
      },
    });

    // Remove the runtime so the ask path cannot find it.
    (service as unknown as { runtimes: Map<string, SessionRuntime> }).runtimes.delete('s1');

    const { logs, restore } = collectDiagLogs();
    let result;
    try {
      result = await canUseTool('Bash', { command: 'ls' });
    } finally {
      restore();
    }
    assert.strictEqual(result.behavior, 'deny');
    assert.ok(
      logs.some((line) => line.includes('reason=missing-runtime') && line.includes('tool=Bash')),
      'expected missing-runtime to be logged',
    );
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
    const writeResult = await canUseTool('Write', { file_path: '/tmp/test/data/user1/x' });
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

  it('bot session with policy ask for Shell: canUseTool returns a pending Promise', async () => {
    const canUseTool = await captureBotCanUseTool({
      wecomBotEnabled: true,
      wecomToolPermissions: {
        posture: 'custom',
        categoryDefaults: {
          fileRead: 'allow',
          fileWrite: 'deny',
          shell: 'ask',
          network: 'deny',
          subagents: 'deny',
          reply: 'allow',
        },
      },
    });

    const promise = canUseTool('Bash', { command: 'ls' }, { toolUseID: 'tu-ask-1', signal: new AbortController().signal });
    assert.ok(promise instanceof Promise, 'ask policy should return a Promise');

    const runtime = (service as unknown as { runtimes: Map<string, SessionRuntime> }).runtimes.get('s1')!;
    runtime.resolveApproval('tu-ask-1', { behavior: 'allow', updatedInput: { command: 'ls' } });

    const result = await promise;
    assert.strictEqual(result.behavior, 'allow');
    if (result.behavior === 'allow') {
      assert.deepStrictEqual(result.updatedInput, { command: 'ls' });
    }
  });

  it('bot session ask policy: always allow resolves with updatedPermissions', async () => {
    const canUseTool = await captureBotCanUseTool({
      wecomBotEnabled: true,
      wecomToolPermissions: {
        posture: 'custom',
        categoryDefaults: {
          fileRead: 'allow',
          fileWrite: 'deny',
          shell: 'ask',
          network: 'deny',
          subagents: 'deny',
          reply: 'allow',
        },
      },
    });

    const suggestions: PermissionUpdate[] = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'allow' }], behavior: 'allow' }];
    const promise = canUseTool('Bash', { command: 'ls' }, { toolUseID: 'tu-ask-2', signal: new AbortController().signal, suggestions });

    const runtime = (service as unknown as { runtimes: Map<string, SessionRuntime> }).runtimes.get('s1')!;
    runtime.resolveApproval('tu-ask-2', { behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: suggestions });

    const result = await promise;
    assert.strictEqual(result.behavior, 'allow');
    if (result.behavior === 'allow') {
      assert.deepStrictEqual(result.updatedPermissions, suggestions);
    }
  });

  it('bot session ask policy: deny resolves with generic message', async () => {
    const canUseTool = await captureBotCanUseTool({
      wecomBotEnabled: true,
      wecomToolPermissions: {
        posture: 'custom',
        categoryDefaults: {
          fileRead: 'allow',
          fileWrite: 'deny',
          shell: 'ask',
          network: 'deny',
          subagents: 'deny',
          reply: 'allow',
        },
      },
    });

    const promise = canUseTool('Bash', { command: 'ls' }, { toolUseID: 'tu-ask-3', signal: new AbortController().signal });

    const runtime = (service as unknown as { runtimes: Map<string, SessionRuntime> }).runtimes.get('s1')!;
    runtime.resolveApproval('tu-ask-3', { behavior: 'deny', message: "I can't do that in this workspace." });

    const result = await promise;
    assert.strictEqual(result.behavior, 'deny');
    if (result.behavior === 'deny') {
      assert.ok(!result.message.toLowerCase().includes('shell'), 'denial message must not leak capability name');
    }
  });

  it('bot session ask policy: timeout denies with generic message', async () => {
    const canUseTool = await captureBotCanUseTool({
      wecomBotEnabled: true,
      wecomToolPermissions: {
        posture: 'custom',
        categoryDefaults: {
          fileRead: 'allow',
          fileWrite: 'deny',
          shell: 'ask',
          network: 'deny',
          subagents: 'deny',
          reply: 'allow',
        },
      },
    });

    const promise = canUseTool('Bash', { command: 'ls', timeout: 50 }, { toolUseID: 'tu-ask-4', signal: new AbortController().signal });

    const result = await promise;
    assert.strictEqual(result.behavior, 'deny');
    if (result.behavior === 'deny') {
      assert.ok(result.message.includes('timed out'), 'timeout should produce a timed-out message');
    }
  });

  it('bot session AskUserQuestion registers a pending question and resolves with answers', async () => {
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

    const promise = canUseTool('AskUserQuestion', {
      questions: [{ question: 'What is your favorite color?', options: [{ label: 'Red' }, { label: 'Blue' }] }],
    }, { toolUseID: 'tu-q-1', signal: new AbortController().signal });

    assert.ok(promise instanceof Promise, 'AskUserQuestion should return a Promise');

    const runtime = (service as unknown as { runtimes: Map<string, SessionRuntime> }).runtimes.get('s1')!;
    runtime.resolveApproval('tu-q-1', {
      behavior: 'allow',
      updatedInput: {
        questions: [{ question: 'What is your favorite color?', options: [{ label: 'Red' }, { label: 'Blue' }] }],
        answers: { 'What is your favorite color?': 'Red' },
      },
    });

    const result = await promise;
    assert.strictEqual(result.behavior, 'allow');
    if (result.behavior === 'allow') {
      assert.deepStrictEqual(
        (result.updatedInput as Record<string, unknown>).answers,
        { 'What is your favorite color?': 'Red' },
      );
    }
  });

  it('bot session: existing allow policy is unaffected', async () => {
    const canUseTool = await captureBotCanUseTool({
      wecomBotEnabled: true,
      wecomToolPermissions: {
        posture: 'safe',
        categoryDefaults: {
          fileRead: 'allow',
          fileWrite: 'deny',
          shell: 'allow',
          network: 'deny',
          subagents: 'deny',
          reply: 'allow',
        },
      },
    });

    const result = await canUseTool('Bash', { command: 'ls' }, { toolUseID: 'tu-allow-1', signal: new AbortController().signal });
    assert.strictEqual(result.behavior, 'allow');

    const runtime = (service as unknown as { runtimes: Map<string, SessionRuntime> }).runtimes.get('s1')!;
    assert.strictEqual(runtime.getStatus().pendingCount, 0, 'allow policy should not register a pending approval');
  });

  it('bot session: existing deny policy is unaffected', async () => {
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

    const result = await canUseTool('Bash', { command: 'ls' }, { toolUseID: 'tu-deny-1', signal: new AbortController().signal });
    assert.strictEqual(result.behavior, 'deny');

    const runtime = (service as unknown as { runtimes: Map<string, SessionRuntime> }).runtimes.get('s1')!;
    assert.strictEqual(runtime.getStatus().pendingCount, 0, 'deny policy should not register a pending approval');
  });

  it('admin bot session bypasses tool policy denials', async () => {
    const canUseTool = await captureBotCanUseTool(
      {
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
        wecomBotIsolation: {
          adminUserIds: ['user1'],
          defaultAllowedSkills: [],
          adminAllowedSkills: [],
        },
      },
      { mapping: 'user1' },
    );

    const result = await canUseTool('Bash', { command: 'ls' }, { toolUseID: 'tu-admin-tool-1', signal: new AbortController().signal });
    assert.strictEqual(result.behavior, 'allow');
  });

  it('admin bot session reads files in another user data folder', async () => {
    const canUseTool = await captureBotCanUseTool(
      {
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
        wecomBotIsolation: {
          adminUserIds: ['user1'],
          defaultAllowedSkills: [],
          adminAllowedSkills: [],
        },
      },
      { mapping: 'user1', knownUserDirNames: ['user2'] },
    );

    const result = await canUseTool('Read', { file_path: '/tmp/test/data/user2/secret.txt' });
    assert.strictEqual(result.behavior, 'allow');
  });

  it('admin bot session writes shared workspace files', async () => {
    const canUseTool = await captureBotCanUseTool(
      {
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
        wecomBotIsolation: {
          adminUserIds: ['user1'],
          defaultAllowedSkills: [],
          adminAllowedSkills: [],
        },
      },
      { mapping: 'user1' },
    );

    const result = await canUseTool('Write', { file_path: '/tmp/test/shared/config.json' });
    assert.strictEqual(result.behavior, 'allow');
  });

  it('admin bot session invokes an unlisted skill', async () => {
    const canUseTool = await captureBotCanUseTool(
      {
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
        wecomBotIsolation: {
          adminUserIds: ['user1'],
          defaultAllowedSkills: ['allowed-skill'],
          adminAllowedSkills: ['admin-skill'],
        },
      },
      { mapping: 'user1' },
    );

    const result = await canUseTool('Skill', { skill_name: 'unlisted-skill' });
    assert.strictEqual(result.behavior, 'allow');
  });

  it('admin bot session is still blocked outside the workspace', async () => {
    const canUseTool = await captureBotCanUseTool(
      {
        wecomBotEnabled: true,
        wecomToolPermissions: {
          posture: 'safe',
          categoryDefaults: {
            fileRead: 'allow',
            fileWrite: 'allow',
            shell: 'allow',
            network: 'allow',
            subagents: 'allow',
            reply: 'allow',
          },
        },
        wecomBotIsolation: {
          adminUserIds: ['user1'],
          defaultAllowedSkills: [],
          adminAllowedSkills: [],
        },
      },
      { mapping: 'user1' },
    );

    const result = await canUseTool('Read', { file_path: '/etc/passwd' });
    assert.strictEqual(result.behavior, 'deny');
  });

  it('non-admin bot session remains restricted when admins are configured', async () => {
    const canUseTool = await captureBotCanUseTool(
      {
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
        wecomBotIsolation: {
          adminUserIds: ['admin-user'],
          defaultAllowedSkills: [],
          adminAllowedSkills: [],
        },
      },
      { mapping: 'user1', knownUserDirNames: ['user2'] },
    );

    const bashResult = await canUseTool('Bash', { command: 'ls' });
    assert.strictEqual(bashResult.behavior, 'deny');

    const readResult = await canUseTool('Read', { file_path: '/tmp/test/data/user2/secret.txt' });
    assert.strictEqual(readResult.behavior, 'deny');

    const skillResult = await canUseTool('Skill', { skill_name: 'unlisted-skill' });
    assert.strictEqual(skillResult.behavior, 'deny');
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
});

describe('chat-service bot-level dynamic policy', { concurrency: false }, () => {
  let service: ChatService;
  const originalOpen = SessionRuntime.open;
  const tmpFolders: string[] = [];

  class MockSdkClient extends SdkClient {
    override async getSessionInfo(sessionId: string): Promise<SDKSessionInfo | undefined> {
      return {
        sessionId,
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

  function createMockRuntime(): SessionRuntime {
    return {
      isClosed: () => false,
      getStatus: () => ({ pendingCount: 0, isProcessing: false, workspaceId: 'ws-1' }),
      close: () => Promise.resolve(),
      subscribe: () => {},
      unsubscribe: () => {},
      pushMessage: () => {},
      resolveApproval: () => {},
      requestToolApproval: () => Promise.resolve({ behavior: 'allow' as const }),
      requestToolQuestion: () => Promise.resolve({ behavior: 'allow' as const }),
      interrupt: () => Promise.resolve(),
      addBotEventHandler: () => {},
      clearBotEventHandlers: () => {},
      removeBotEventHandler: () => {},
      setApprovalMode: () => {},
      getApprovalMode: () => 'manual' as const,
    } as unknown as SessionRuntime;
  }

  async function setupBotSession(
    role: 'normal' | 'admin' | 'owner',
    workspaceDenyGlobs: string[] = [],
  ): Promise<{ canUseTool: NonNullable<Options['canUseTool']>; folderPath: string; botId: string }> {
    workspaceStore.resetData();
    const folderPath = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-bot-policy-'));
    tmpFolders.push(folderPath);
    const workspace = await workspaceStore.create({
      name: 'Bot Policy Workspace',
      folderPath,
      settings: { sensitiveFileDenylist: workspaceDenyGlobs },
    });
    const provider = workspaceStore.createProvider({
      name: 'Test Provider',
      baseUrl: 'http://test',
      authToken: 'test',
      model: 'test-model',
      isDefault: true,
    });
    const bot = botService.createBot({
      name: 'Policy Bot',
      activeWorkspaceId: workspace.id,
      channelSettings: {
        wecom: { enabled: true, botId: 'bot-wecom', botSecret: 'secret' },
      },
      rolePolicy: {
        normalToolPolicy: SAFE_PRESET,
        skillAllowlist: ['allowed-skill'],
        bashWhitelist: ['ls'],
      },
    });
    const channelUserId = role === 'normal' ? 'user-1' : role === 'admin' ? 'admin-1' : 'owner-1';
    botService.addMember(bot.id, { channel: 'wecom', channelUserId, role });

    const encryptedUserId = `enc-${channelUserId}`;
    workspaceStore.setWecomUserMapping(encryptedUserId, channelUserId);
    workspaceStore.setWecomWorkspaceUser(workspace.id, encryptedUserId);
    const session = workspaceStore.createLocalSession(
      workspace.id,
      'Bot Session',
      undefined,
      provider.id,
      'wecom',
      undefined,
      bot.id,
    );
    workspaceStore.setWecomSession(workspace.id, encryptedUserId, session.id);

    let capturedOptions: Options | undefined;
    SessionRuntime.open = (...args: unknown[]) => {
      capturedOptions = args[3] as Options;
      return createMockRuntime();
    };

    await service.getOrCreateRuntime(session.id, workspace.id, true, undefined, channelUserId);
    assert.ok(capturedOptions?.canUseTool, 'canUseTool must be set for bot sessions');
    return { canUseTool: capturedOptions.canUseTool, folderPath, botId: bot.id };
  }

  beforeEach(() => {
    service = new TestChatService();
  });

  afterEach(async () => {
    await service.closeAllRuntimes();
    SessionRuntime.open = originalOpen;
    for (const folder of tmpFolders) {
      try {
        fs.rmSync(folder, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tmpFolders.length = 0;
  });

  it('Normal user can read inside their own data directory', async () => {
    const { canUseTool, folderPath } = await setupBotSession('normal');
    const result = await canUseTool('Read', { file_path: path.join(folderPath, 'data', 'user-1', 'x.txt') });
    assert.strictEqual(result.behavior, 'allow');
  });

  it('Normal user cannot write outside their own data directory', async () => {
    const { canUseTool, folderPath } = await setupBotSession('normal');
    const result = await canUseTool('Write', { file_path: path.join(folderPath, 'shared', 'x.txt') });
    assert.strictEqual(result.behavior, 'deny');
  });

  it('Normal user cannot read workspace denylisted files', async () => {
    const { canUseTool, folderPath, botId } = await setupBotSession('normal', ['**/*.secret']);
    const result = await canUseTool('Read', { file_path: path.join(folderPath, 'data', 'user-1', 'x.secret') });
    assert.strictEqual(result.behavior, 'deny');

    const logs = workspaceStore.listAuditLogs(botId);
    assert.ok(logs.some((l) =>
      l.eventType === 'file_access_denied' &&
      l.details.toolName === 'Read' &&
      typeof l.details.reason === 'string',
    ));
  });

  it('Admin user can read workspace denylisted files', async () => {
    const { canUseTool, folderPath } = await setupBotSession('admin', ['**/*.secret']);
    const result = await canUseTool('Read', { file_path: path.join(folderPath, 'data', 'admin-1', 'x.secret') });
    assert.strictEqual(result.behavior, 'allow');
  });

  it('Admin user can read another user data directory', async () => {
    const { canUseTool, folderPath } = await setupBotSession('admin');
    const result = await canUseTool('Read', { file_path: path.join(folderPath, 'data', 'other-user', 'secret.txt') });
    assert.strictEqual(result.behavior, 'allow');
  });

  it('Normal user can run whitelisted Bash commands', async () => {
    const { canUseTool } = await setupBotSession('normal');
    const result = await canUseTool('Bash', { command: 'ls -l' });
    assert.strictEqual(result.behavior, 'allow');
  });

  it('Normal user cannot run non-whitelisted Bash commands', async () => {
    const { canUseTool } = await setupBotSession('normal');
    const result = await canUseTool('Bash', { command: 'rm -rf /' });
    assert.strictEqual(result.behavior, 'deny');
  });

  it('Admin user can run any Bash command', async () => {
    const { canUseTool } = await setupBotSession('admin');
    const result = await canUseTool('Bash', { command: 'rm -rf /' });
    assert.strictEqual(result.behavior, 'allow');
  });

  it('Normal user cannot invoke skills outside the allowlist', async () => {
    const { canUseTool } = await setupBotSession('normal');
    const result = await canUseTool('Skill', { skill_name: 'disallowed-skill' });
    assert.strictEqual(result.behavior, 'deny');
  });

  it('Normal user can invoke allowlisted skills', async () => {
    const { canUseTool } = await setupBotSession('normal');
    const result = await canUseTool('Skill', { skill_name: 'allowed-skill' });
    assert.strictEqual(result.behavior, 'allow');
  });

  it('Admin user can invoke any skill', async () => {
    const { canUseTool } = await setupBotSession('admin');
    const result = await canUseTool('Skill', { skill_name: 'unlisted-skill' });
    assert.strictEqual(result.behavior, 'allow');
  });

  it('role changes are picked up dynamically without reopening the runtime', async () => {
    const { canUseTool, botId } = await setupBotSession('normal');
    const denied = await canUseTool('Bash', { command: 'cat /etc/passwd' });
    assert.strictEqual(denied.behavior, 'deny');

    botService.addMember(botId, { channel: 'wecom', channelUserId: 'owner-1', role: 'owner' });
    botService.setMemberRole(
      botId,
      'wecom',
      'user-1',
      'admin',
      { type: 'wecom', channel: 'wecom', channelUserId: 'owner-1' },
    );

    const allowed = await canUseTool('Bash', { command: 'cat /etc/passwd' });
    assert.strictEqual(allowed.behavior, 'allow');
  });
});

describe('chat-service buildSdkOptions persona injection', { concurrency: false }, () => {
  let service: ChatService;
  const originalOpen = SessionRuntime.open;
  const originalGet = workspaceStore.get.bind(workspaceStore);
  const originalGetLocalSession = workspaceStore.getLocalSession.bind(workspaceStore);
  const originalGetDefaultProvider = workspaceStore.getDefaultProvider.bind(workspaceStore);

  class MockSdkClient extends SdkClient {
    override async getSessionInfo(sessionId: string): Promise<SDKSessionInfo | undefined> {
      return {
        sessionId,
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

  function createMockRuntime(): SessionRuntime {
    let closed = false;
    return {
      isClosed: () => closed,
      getStatus: () => ({ pendingCount: 0, isProcessing: false, workspaceId: 'ws-1' }),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
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
    } as unknown as SessionRuntime;
  }

  beforeEach(() => {
    workspaceStore.resetData();
    service = new TestChatService();
  });

  afterEach(async () => {
    await service.closeAllRuntimes();
    SessionRuntime.open = originalOpen;
    workspaceStore.get = originalGet;
    workspaceStore.getLocalSession = originalGetLocalSession;
    workspaceStore.getDefaultProvider = originalGetDefaultProvider;
  });

  async function setupBotSession(config: {
    persona?: BotPersona;
    rolePersonas?: Partial<Record<BotRole, BotPersona>>;
    memberRole?: BotRole;
  } = {}) {
    const folderPath = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-persona-'));
    const workspace = await workspaceStore.create({
      name: 'Persona Workspace',
      folderPath,
    });
    const provider = workspaceStore.createProvider({
      name: `Test Provider ${crypto.randomUUID()}`,
      baseUrl: 'http://test',
      authToken: 'test',
      model: 'test-model',
      isDefault: false,
    });
    const bot = botService.createBot({
      name: 'Persona Bot',
      activeWorkspaceId: workspace.id,
      channelSettings: {
        wecom: { enabled: true, botId: 'wecom-bot', botSecret: 'secret' },
      },
      persona: config.persona,
      rolePersonas: config.rolePersonas,
    });

    const channelUserId = config.memberRole === 'normal' ? 'user-1' : config.memberRole === 'admin' ? 'admin-1' : 'owner-1';
    if (config.memberRole) {
      botService.addMember(bot.id, { channel: 'wecom', channelUserId, role: config.memberRole });
    }

    const encryptedUserId = `enc-${channelUserId}`;
    workspaceStore.setWecomUserMapping(encryptedUserId, channelUserId);
    workspaceStore.setWecomWorkspaceUser(workspace.id, encryptedUserId);

    const session = workspaceStore.createLocalSession(
      workspace.id,
      'Persona Session',
      undefined,
      provider.id,
      'wecom',
      undefined,
      bot.id,
    );
    workspaceStore.setWecomSession(workspace.id, encryptedUserId, session.id);

    let capturedOptions: Options | undefined;
    SessionRuntime.open = (...args: unknown[]) => {
      capturedOptions = args[3] as Options;
      return createMockRuntime();
    };

    await service.getOrCreateRuntime(session.id, workspace.id, true, undefined, channelUserId);
    assert.ok(capturedOptions, 'options must be captured');
    return { options: capturedOptions, bot, session, workspace, provider };
  }

  it('append persona sets preset-with-append systemPrompt', async () => {
    const { options } = await setupBotSession({
      persona: { prompt: 'You are an operations assistant.', mode: 'append' },
    });
    assert.deepStrictEqual(options.systemPrompt, {
      type: 'preset',
      preset: 'claude_code',
      append: 'You are an operations assistant.',
    });
  });

  it('replace persona sets prompt string systemPrompt', async () => {
    const { options } = await setupBotSession({
      persona: { prompt: 'You are a replacement persona.', mode: 'replace' },
    });
    assert.strictEqual(options.systemPrompt, 'You are a replacement persona.');
  });

  it('bot session with no persona leaves systemPrompt unset', async () => {
    const { options } = await setupBotSession();
    assert.strictEqual(options.systemPrompt, undefined);
  });

  it('GUI session does not inherit bot persona', async () => {
    const { workspace, bot, provider } = await setupBotSession({
      persona: { prompt: 'You are a bot persona.', mode: 'append' },
    });
    await service.closeAllRuntimes();

    const guiSession = workspaceStore.createLocalSession(
      workspace.id,
      'GUI Session',
      undefined,
      provider.id,
      'gui',
      undefined,
      bot.id,
    );

    let capturedOptions: Options | undefined;
    SessionRuntime.open = (...args: unknown[]) => {
      capturedOptions = args[3] as Options;
      return createMockRuntime();
    };

    await service.getOrCreateRuntime(guiSession.id, workspace.id);
    assert.ok(capturedOptions, 'options must be captured');
    assert.strictEqual(capturedOptions.systemPrompt, undefined);
  });

  it('persona changes take effect on the next newly created bot session', async () => {
    const { workspace, bot, provider } = await setupBotSession({
      persona: { prompt: 'Original persona.', mode: 'append' },
    });

    botService.updateBot(bot.id, { persona: { prompt: 'Updated persona.', mode: 'replace' } });

    const nextSession = workspaceStore.createLocalSession(
      workspace.id,
      'Next Persona Session',
      undefined,
      provider.id,
      'wecom',
      undefined,
      bot.id,
    );

    let capturedOptions: Options | undefined;
    SessionRuntime.open = (...args: unknown[]) => {
      capturedOptions = args[3] as Options;
      return createMockRuntime();
    };

    await service.getOrCreateRuntime(nextSession.id, workspace.id, true);
    assert.ok(capturedOptions, 'options must be captured');
    assert.strictEqual(capturedOptions.systemPrompt, 'Updated persona.');
  });

  it('owner member receives the owner role persona', async () => {
    const { options } = await setupBotSession({
      persona: { prompt: 'Default persona.', mode: 'append' },
      rolePersonas: {
        owner: { prompt: 'Owner persona.', mode: 'replace' },
      },
      memberRole: 'owner',
    });
    assert.strictEqual(options.systemPrompt, 'Owner persona.');
  });

  it('normal member receives the normal role persona', async () => {
    const { options } = await setupBotSession({
      persona: { prompt: 'Default persona.', mode: 'append' },
      rolePersonas: {
        normal: { prompt: 'Normal persona.', mode: 'replace' },
      },
      memberRole: 'normal',
    });
    assert.strictEqual(options.systemPrompt, 'Normal persona.');
  });

  it('non-member is treated as normal and receives the normal persona', async () => {
    const { options } = await setupBotSession({
      persona: { prompt: 'Default persona.', mode: 'append' },
      rolePersonas: {
        normal: { prompt: 'Normal fallback persona.', mode: 'replace' },
      },
    });
    assert.strictEqual(options.systemPrompt, 'Normal fallback persona.');
  });

  it('falls back to default persona when role persona is unset', async () => {
    const { options } = await setupBotSession({
      persona: { prompt: 'Default persona.', mode: 'replace' },
      rolePersonas: {
        normal: { prompt: 'Normal persona.', mode: 'append' },
      },
      memberRole: 'owner',
    });
    assert.strictEqual(options.systemPrompt, 'Default persona.');
  });

  it('uses role persona when default is unset', async () => {
    const { options } = await setupBotSession({
      rolePersonas: {
        admin: { prompt: 'Admin-only persona.', mode: 'replace' },
      },
      memberRole: 'admin',
    });
    assert.strictEqual(options.systemPrompt, 'Admin-only persona.');
  });

  it('owner role persona can use append mode', async () => {
    const { options } = await setupBotSession({
      rolePersonas: {
        owner: { prompt: 'Owner append.', mode: 'append' },
      },
      memberRole: 'owner',
    });
    assert.deepStrictEqual(options.systemPrompt, {
      type: 'preset',
      preset: 'claude_code',
      append: 'Owner append.',
    });
  });

  it('closeRuntimesForBot closes only runtimes for the target bot', async () => {
    const { session: sessionA } = await setupBotSession({
      persona: { prompt: 'Bot A.', mode: 'replace' },
    });

    const { bot: botB, session: sessionB } = await setupBotSession({
      persona: { prompt: 'Bot B.', mode: 'replace' },
    });

    const runtimeA = service.getRuntimeIfExists(sessionA.id);
    const runtimeB = service.getRuntimeIfExists(sessionB.id);
    assert.ok(runtimeA);
    assert.ok(runtimeB);
    assert.strictEqual(runtimeA?.isClosed(), false);
    assert.strictEqual(runtimeB?.isClosed(), false);

    await service.closeRuntimesForBot(botB.id);

    assert.strictEqual(runtimeA?.isClosed(), false);
    assert.strictEqual(runtimeB?.isClosed(), true);
  });
});

describe('chat-service subagent loop poller', { concurrency: false }, () => {
  let service: ChatService;
  const originalOpen = SessionRuntime.open;
  const originalGet = workspaceStore.get.bind(workspaceStore);
  const originalGetLocalSession = workspaceStore.getLocalSession.bind(workspaceStore);
  const originalGetDefaultProvider = workspaceStore.getDefaultProvider.bind(workspaceStore);
  const originalClearDraftFlag = workspaceStore.clearDraftFlag.bind(workspaceStore);

  function createMockSubagentMessages(toolName: string, input: unknown, count: number): SessionMessage[] {
    const messages: SessionMessage[] = [];
    for (let i = 0; i < count; i++) {
      messages.push({
        uuid: crypto.randomUUID(),
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: toolName, input, id: crypto.randomUUID() }],
        },
      } as SessionMessage);
    }
    return messages;
  }

  class LoopMockSdkClient extends SdkClient {
    listSubagentsCalls = 0;
    getSubagentMessagesCalls = 0;
    subagentMessages: SessionMessage[] = [];

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
      this.listSubagentsCalls += 1;
      return ['agent-1'];
    }
    override async getSessionMessages(): Promise<SessionMessage[]> {
      return [];
    }
    override async getSubagentMessages(): Promise<SessionMessage[]> {
      this.getSubagentMessagesCalls += 1;
      return this.subagentMessages;
    }
    override async renameSession(): Promise<void> {}
    override async forkSession(): Promise<{ sessionId: string }> {
      return { sessionId: 'fork-s1' };
    }
  }

  class TestChatService extends ChatService {
    readonly mockSdkClient: LoopMockSdkClient;
    constructor() {
      const client = new LoopMockSdkClient();
      super(client);
      this.mockSdkClient = client;
    }
    protected override async testClaudeBinary(): Promise<void> {}
  }

  function createMockRuntime(): SessionRuntime & {
    setSubagentLoopAlertCalls: unknown[];
    clearSubagentLoopAlertCalls: number;
    interruptCalls: number;
  } {
    const setSubagentLoopAlertCalls: unknown[] = [];
    let clearCount = 0;
    let interruptCount = 0;
    let alert: { agentId: string; toolName: string; fingerprint: string; count: number; detectedAt: number; guidanceSent: boolean } | undefined;
    let interruptFired = false;
    const mock = {
      isClosed: () => false,
      getStatus: () => ({ pendingCount: 0, isProcessing: false, workspaceId: 'ws-1' }),
      close: () => Promise.resolve(),
      subscribe: () => {},
      unsubscribe: () => {},
      pushMessage: () => {},
      resolveApproval: () => {},
      interrupt: () => {
        interruptCount += 1;
        return Promise.resolve();
      },
      addBotEventHandler: () => {},
      clearBotEventHandlers: () => {},
      removeBotEventHandler: () => {},
      setApprovalMode: () => {},
      getApprovalMode: () => 'manual' as const,
      setSubagentLoopAlert: (a: { agentId: string; toolName: string; fingerprint: string; count: number }) => {
        setSubagentLoopAlertCalls.push(a);
        alert = { ...a, detectedAt: Date.now(), guidanceSent: false };
        interruptFired = false;
      },
      clearSubagentLoopAlert: () => {
        clearCount += 1;
        alert = undefined;
        interruptFired = false;
      },
      getSubagentLoopAlert: () => alert,
      hasSubagentInterruptFired: () => interruptFired,
      markSubagentInterruptFired: () => {
        interruptFired = true;
      },
      setSubagentLoopAlertCalls,
      get clearSubagentLoopAlertCalls() {
        return clearCount;
      },
      get interruptCalls() {
        return interruptCount;
      },
    };
    return mock as unknown as SessionRuntime & {
      setSubagentLoopAlertCalls: unknown[];
      clearSubagentLoopAlertCalls: number;
      interruptCalls: number;
    };
  }

  function setupStoreMocks(settings: Record<string, unknown> = {}) {
    const workspace = createMockWorkspace('ws-1');
    workspace.settings = settings;
    workspaceStore.get = async () => workspace;
    workspaceStore.getLocalSession = () => createMockSession('s1');
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

  it('detects a looping subagent and alerts the runtime', async () => {
    setupStoreMocks({
      deadLoopDetection: {
        enabled: true,
        line2: { windowSize: 20, threshold: 5, pollIntervalMs: 1000, interruptTimeoutMs: 30000 },
      },
    });

    SessionRuntime.open = () => createMockRuntime();

    await service.getOrCreateRuntime('s1', 'ws-1');
    service.mockSdkClient.subagentMessages = createMockSubagentMessages('Read', { file_path: '/x/y.txt' }, 6);

    await (service as unknown as { pollSubagentLoops: () => Promise<void> }).pollSubagentLoops();

    const runtime = (service as unknown as { runtimes: Map<string, SessionRuntime> }).runtimes.get('s1') as unknown as {
      setSubagentLoopAlertCalls: unknown[];
      interruptCalls: number;
    };
    assert.strictEqual(service.mockSdkClient.listSubagentsCalls, 1);
    assert.strictEqual(service.mockSdkClient.getSubagentMessagesCalls, 1);
    assert.strictEqual(runtime.setSubagentLoopAlertCalls.length, 1);
    const alert = runtime.setSubagentLoopAlertCalls[0] as { agentId: string; toolName: string; count: number };
    assert.strictEqual(alert.agentId, 'agent-1');
    assert.strictEqual(alert.toolName, 'Read');
    assert.strictEqual(alert.count, 6);
    assert.strictEqual(runtime.interruptCalls, 0);
  });

  it('interrupts the runtime when the loop persists past the timeout', async () => {
    setupStoreMocks({
      deadLoopDetection: {
        enabled: true,
        line2: { windowSize: 20, threshold: 5, pollIntervalMs: 1000, interruptTimeoutMs: 0 },
      },
    });

    SessionRuntime.open = () => createMockRuntime();

    await service.getOrCreateRuntime('s1', 'ws-1');
    service.mockSdkClient.subagentMessages = createMockSubagentMessages('Read', { file_path: '/x/y.txt' }, 6);

    await (service as unknown as { pollSubagentLoops: () => Promise<void> }).pollSubagentLoops();

    const runtime = (service as unknown as { runtimes: Map<string, SessionRuntime> }).runtimes.get('s1') as unknown as {
      setSubagentLoopAlertCalls: unknown[];
      interruptCalls: number;
    };
    assert.strictEqual(runtime.setSubagentLoopAlertCalls.length, 1);
    assert.strictEqual(runtime.interruptCalls, 1);
  });

  it('clears the alert when the subagent stops looping', async () => {
    setupStoreMocks({
      deadLoopDetection: {
        enabled: true,
        line2: { windowSize: 20, threshold: 5, pollIntervalMs: 1000, interruptTimeoutMs: 30000 },
      },
    });

    SessionRuntime.open = () => createMockRuntime();

    await service.getOrCreateRuntime('s1', 'ws-1');
    service.mockSdkClient.subagentMessages = createMockSubagentMessages('Read', { file_path: '/x/y.txt' }, 6);
    await (service as unknown as { pollSubagentLoops: () => Promise<void> }).pollSubagentLoops();

    service.mockSdkClient.subagentMessages = createMockSubagentMessages('Read', { file_path: '/x/y.txt' }, 2);
    (service as unknown as { lastSubagentLoopPollBySession: Map<string, number> }).lastSubagentLoopPollBySession.delete('s1');
    await (service as unknown as { pollSubagentLoops: () => Promise<void> }).pollSubagentLoops();

    const runtime = (service as unknown as { runtimes: Map<string, SessionRuntime> }).runtimes.get('s1') as unknown as {
      setSubagentLoopAlertCalls: unknown[];
      clearSubagentLoopAlertCalls: number;
    };
    assert.strictEqual(runtime.setSubagentLoopAlertCalls.length, 1);
    assert.strictEqual(runtime.clearSubagentLoopAlertCalls, 1);
  });

  it('skips polling when dead-loop detection is disabled for the workspace', async () => {
    setupStoreMocks({
      deadLoopDetection: { enabled: false },
    });

    SessionRuntime.open = () => createMockRuntime();

    await service.getOrCreateRuntime('s1', 'ws-1');
    service.mockSdkClient.subagentMessages = createMockSubagentMessages('Read', { file_path: '/x/y.txt' }, 6);

    await (service as unknown as { pollSubagentLoops: () => Promise<void> }).pollSubagentLoops();

    assert.strictEqual(service.mockSdkClient.listSubagentsCalls, 0);
    assert.strictEqual(service.mockSdkClient.getSubagentMessagesCalls, 0);
  });
});