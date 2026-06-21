import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { WeComQueueWorker, formatProactiveDirective } from './wecom-queue-worker.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import type { SessionRuntime } from './session-runtime.js';
import type { WeComProactiveMessage } from '../models/wecom-proactive-message.js';
import type { Workspace } from '../models/workspace.js';

describe('WeComQueueWorker', { concurrency: false }, () => {
  let worker: WeComQueueWorker;
  let originalList: typeof workspaceStore.list;
  let originalListProactiveMessages: typeof workspaceStore.listProactiveMessages;
  let originalClaimNextPendingMessage: typeof workspaceStore.claimNextPendingMessage;
  let originalGetWecomUserMapping: typeof workspaceStore.getWecomUserMapping;
  let originalGetWecomSession: typeof workspaceStore.getWecomSession;
  let originalUpdateProactiveMessage: typeof workspaceStore.updateProactiveMessage;
  let originalGetRuntimeIfExists: typeof chatService.getRuntimeIfExists;
  let originalGetOrCreateRuntime: typeof chatService.getOrCreateRuntime;

  const mockMessages: WeComProactiveMessage[] = [];

  beforeEach(() => {
    worker = new WeComQueueWorker();
    originalList = workspaceStore.list.bind(workspaceStore);
    originalListProactiveMessages = workspaceStore.listProactiveMessages.bind(workspaceStore);
    originalClaimNextPendingMessage = workspaceStore.claimNextPendingMessage.bind(workspaceStore);
    originalGetWecomUserMapping = workspaceStore.getWecomUserMapping.bind(workspaceStore);
    originalGetWecomSession = workspaceStore.getWecomSession.bind(workspaceStore);
    originalUpdateProactiveMessage = workspaceStore.updateProactiveMessage.bind(workspaceStore);
    originalGetRuntimeIfExists = chatService.getRuntimeIfExists.bind(chatService);
    originalGetOrCreateRuntime = chatService.getOrCreateRuntime.bind(chatService);
    mockMessages.length = 0;
  });

  afterEach(async () => {
    await worker.shutdown();
    workspaceStore.list = originalList;
    workspaceStore.listProactiveMessages = originalListProactiveMessages;
    workspaceStore.claimNextPendingMessage = originalClaimNextPendingMessage;
    workspaceStore.getWecomUserMapping = originalGetWecomUserMapping;
    workspaceStore.getWecomSession = originalGetWecomSession;
    workspaceStore.updateProactiveMessage = originalUpdateProactiveMessage;
    chatService.getRuntimeIfExists = originalGetRuntimeIfExists;
    chatService.getOrCreateRuntime = originalGetOrCreateRuntime;
  });

  function createMockMessage(overrides: Partial<WeComProactiveMessage> = {}): WeComProactiveMessage {
    return {
      id: overrides.id ?? 'msg-1',
      workspaceId: overrides.workspaceId ?? 'ws-1',
      senderSessionId: overrides.senderSessionId ?? 'session-a',
      recipientEncryptedUserId: overrides.recipientEncryptedUserId ?? 'enc-b',
      recipientPlaintextUserId: overrides.recipientPlaintextUserId ?? 'plain-b',
      messageContent: overrides.messageContent ?? 'Hello B',
      status: overrides.status ?? 'pending',
      errorReason: overrides.errorReason ?? null,
      createdAt: overrides.createdAt ?? new Date().toISOString(),
      updatedAt: overrides.updatedAt ?? new Date().toISOString(),
      deliveredAt: overrides.deliveredAt ?? null,
      claimedAt: overrides.claimedAt ?? null,
      retryCount: overrides.retryCount ?? 0,
    };
  }

  function setupHappyPathMocks() {
    workspaceStore.list = async () => [{ id: 'ws-1' } as Workspace];
    workspaceStore.getWecomUserMapping = () => 'plain-b';
    workspaceStore.getWecomSession = () => 'session-b';
    workspaceStore.claimNextPendingMessage = () => {
      const msg = mockMessages.find((m) => m.status === 'pending');
      if (msg) {
        msg.status = 'delivering';
        msg.claimedAt = new Date().toISOString();
        return { ...msg };
      }
      return null;
    };
    workspaceStore.updateProactiveMessage = (id, input) => {
      const msg = mockMessages.find((m) => m.id === id);
      if (msg) {
        Object.assign(msg, input);
        return { ...msg };
      }
      return null;
    };
    workspaceStore.listProactiveMessages = () => [...mockMessages];

    const mockRuntime = {
      isProcessingTurn: () => false,
      cancelIdleClose: () => {},
      pushMessage: () => {},
    } as unknown as SessionRuntime;

    chatService.getRuntimeIfExists = () => undefined;
    chatService.getOrCreateRuntime = async () => mockRuntime;
  }

  it('dispatches pending message when recipient is idle and ID decrypted', async () => {
    setupHappyPathMocks();
    mockMessages.push(createMockMessage());

    const mockRuntime = {
      isProcessingTurn: () => false,
      cancelIdleClose: () => {},
      pushMessage: () => {},
    } as unknown as SessionRuntime;

    chatService.getOrCreateRuntime = async () => mockRuntime;

    // Manually trigger one poll cycle
    await (worker as unknown as { poll(): Promise<void> }).poll();

    // After dispatch, message should be in delivering state
    assert.strictEqual(mockMessages[0].status, 'delivering');
    assert.ok(mockMessages[0].claimedAt);
  });

  it('releases claim when recipient runtime is busy', async () => {
    workspaceStore.list = async () => [{ id: 'ws-1' } as Workspace];
    workspaceStore.getWecomUserMapping = () => 'plain-b';
    workspaceStore.getWecomSession = () => 'session-b';
    workspaceStore.claimNextPendingMessage = () => createMockMessage();
    workspaceStore.updateProactiveMessage = (id, input) => {
      const msg = mockMessages.find((m) => m.id === id);
      if (msg) {
        Object.assign(msg, input);
        return { ...msg };
      }
      return null;
    };
    workspaceStore.listProactiveMessages = () => [...mockMessages];

    const busyRuntime = {
      isProcessingTurn: () => true,
    } as unknown as SessionRuntime;
    chatService.getRuntimeIfExists = () => busyRuntime;

    mockMessages.push(createMockMessage());

    await (worker as unknown as { poll(): Promise<void> }).poll();

    // Should be released back to pending
    assert.strictEqual(mockMessages[0].status, 'pending');
    assert.strictEqual(mockMessages[0].claimedAt, null);
  });

  it('releases claim when user ID is not decrypted', async () => {
    workspaceStore.list = async () => [{ id: 'ws-1' } as Workspace];
    workspaceStore.getWecomUserMapping = () => null;
    workspaceStore.claimNextPendingMessage = () => createMockMessage();
    workspaceStore.updateProactiveMessage = (id, input) => {
      const msg = mockMessages.find((m) => m.id === id);
      if (msg) {
        Object.assign(msg, input);
        return { ...msg };
      }
      return null;
    };
    workspaceStore.listProactiveMessages = () => [...mockMessages];

    mockMessages.push(createMockMessage());

    await (worker as unknown as { poll(): Promise<void> }).poll();

    assert.strictEqual(mockMessages[0].status, 'pending');
    assert.strictEqual(mockMessages[0].claimedAt, null);
  });

  it('auto-fails messages pending over 12 hours', async () => {
    const oldTime = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    const staleMsg = createMockMessage({ createdAt: oldTime });
    mockMessages.push(staleMsg);

    workspaceStore.list = async () => [{ id: 'ws-1' } as Workspace];
    workspaceStore.listProactiveMessages = () => [...mockMessages];
    workspaceStore.updateProactiveMessage = (id, input) => {
      const msg = mockMessages.find((m) => m.id === id);
      if (msg) {
        Object.assign(msg, input);
        return { ...msg };
      }
      return null;
    };

    await (worker as unknown as { checkTimeouts(): Promise<void> }).checkTimeouts();

    assert.strictEqual(mockMessages[0].status, 'failed');
    assert.ok(mockMessages[0].errorReason?.includes('timeout'));
  });

  it('resets stale delivering messages to pending on startup', async () => {
    const staleClaimedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const staleMsg = createMockMessage({ status: 'delivering', claimedAt: staleClaimedAt });
    mockMessages.push(staleMsg);

    workspaceStore.list = async () => [{ id: 'ws-1' } as Workspace];
    workspaceStore.listProactiveMessages = () => [...mockMessages];
    workspaceStore.updateProactiveMessage = (id, input) => {
      const msg = mockMessages.find((m) => m.id === id);
      if (msg) {
        Object.assign(msg, input);
        return { ...msg };
      }
      return null;
    };

    await (worker as unknown as { reconcileStaleDelivering(): Promise<void> }).reconcileStaleDelivering();

    assert.strictEqual(mockMessages[0].status, 'pending');
    assert.strictEqual(mockMessages[0].claimedAt, null);
  });

  it('marks message failed when dispatch throws', async () => {
    workspaceStore.list = async () => [{ id: 'ws-1' } as Workspace];
    workspaceStore.getWecomUserMapping = () => 'plain-b';
    workspaceStore.getWecomSession = () => 'session-b';
    workspaceStore.claimNextPendingMessage = () => createMockMessage();
    workspaceStore.updateProactiveMessage = (id, input) => {
      const msg = mockMessages.find((m) => m.id === id);
      if (msg) {
        Object.assign(msg, input);
        return { ...msg };
      }
      return null;
    };
    workspaceStore.listProactiveMessages = () => [...mockMessages];

    chatService.getRuntimeIfExists = () => undefined;
    chatService.getOrCreateRuntime = async () => { throw new Error('runtime creation failed'); };

    mockMessages.push(createMockMessage());

    await (worker as unknown as { poll(): Promise<void> }).poll();

    assert.strictEqual(mockMessages[0].status, 'failed');
    assert.ok(mockMessages[0].errorReason?.includes('runtime creation failed'));
  });

  it('formatProactiveDirective returns natural-language prompt with recipient and message', () => {
    const msg = createMockMessage({
      recipientPlaintextUserId: 'user-b',
      messageContent: 'please upload the file',
    });
    const directive = formatProactiveDirective(msg);
    assert.ok(directive.includes('Send a WeCom message to user-b: please upload the file'));
    assert.ok(!directive.includes('[Proactive Send]'));
  });
});