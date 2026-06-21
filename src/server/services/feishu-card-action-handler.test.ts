import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { FeishuCardActionHandler, type CardActionPayload } from './feishu-card-action-handler.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import type { Workspace } from '../models/workspace.js';

describe('FeishuCardActionHandler', { concurrency: false }, () => {
  let handler: FeishuCardActionHandler;
  const originalGet = workspaceStore.get.bind(workspaceStore);
  const originalGetOwner = workspaceStore.getFeishuSessionOwner.bind(workspaceStore);
  const originalGetActiveSession = workspaceStore.getFeishuActiveSession.bind(workspaceStore);
  const originalSetActiveSession = workspaceStore.setFeishuActiveSession.bind(workspaceStore);
  const originalAddUserSession = workspaceStore.addFeishuUserSession.bind(workspaceStore);
  const originalGetRuntime = chatService.getRuntimeIfExists.bind(chatService);
  const originalCreateSession = chatService.createSession.bind(chatService);

  afterEach(() => {
    workspaceStore.get = originalGet;
    workspaceStore.getFeishuSessionOwner = originalGetOwner;
    workspaceStore.getFeishuActiveSession = originalGetActiveSession;
    workspaceStore.setFeishuActiveSession = originalSetActiveSession;
    workspaceStore.addFeishuUserSession = originalAddUserSession;
    chatService.getRuntimeIfExists = originalGetRuntime;
    chatService.createSession = originalCreateSession;
  });

  function makeWorkspace(overrides?: Partial<Workspace>): Workspace {
    return {
      id: 'ws-1',
      name: 'Test',
      folderPath: '/tmp/test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settings: {
        feishuAdminUserIds: ['admin-1'],
      },
      ...overrides,
    } as Workspace;
  }

  beforeEach(() => {
    handler = new FeishuCardActionHandler();
  });

  it('rejects rapid repeated actions via rate limit', async () => {
    workspaceStore.get = async () => makeWorkspace();

    const payload: CardActionPayload = { action: 'select_workspace', workspaceId: 'ws-1' };
    const first = await handler.handle('admin-1', payload);
    const second = await handler.handle('admin-1', payload);

    assert.strictEqual((first as { toast: { type: string } }).toast.type, 'success');
    assert.strictEqual((second as { toast: { type: string } }).toast.type, 'error');
  });

  it('select_workspace requires admin permission', async () => {
    workspaceStore.get = async () => makeWorkspace();

    const payload: CardActionPayload = { action: 'select_workspace', workspaceId: 'ws-1' };
    const result = await handler.handle('user-1', payload);
    assert.strictEqual((result as { toast: { content: string } }).toast.content, '你没有权限切换工作空间。');
  });

  it('select_session checks ownership and updates active session', async () => {
    workspaceStore.get = async () => makeWorkspace();
    workspaceStore.getFeishuSessionOwner = () => 'user-1';
    let activeSessionId: string | null = null;
    workspaceStore.setFeishuActiveSession = (_ws, _user, sessionId) => {
      activeSessionId = sessionId;
    };

    const payload: CardActionPayload = {
      action: 'select_session',
      workspaceId: 'ws-1',
      sessionId: 'session-1',
    };
    const result = await handler.handle('user-1', payload);

    assert.strictEqual(activeSessionId, 'session-1');
    assert.strictEqual((result as { toast: { type: string } }).toast.type, 'success');
  });

  it('create_session creates a Feishu session and activates it', async () => {
    workspaceStore.get = async () => makeWorkspace();
    chatService.createSession = async (input) => ({
      id: 'session-new',
      workspaceId: input.workspaceId,
      name: input.name ?? 'Session',
      source: input.source,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    let added: { workspaceId: string; openId: string; sessionId: string } | null = null;
    workspaceStore.addFeishuUserSession = (ws, openId, sessionId) => {
      added = { workspaceId: ws, openId, sessionId };
    };
    let activeSessionId: string | null = null;
    workspaceStore.setFeishuActiveSession = (_ws, _user, sessionId) => {
      activeSessionId = sessionId;
    };

    const payload: CardActionPayload = { action: 'create_session', workspaceId: 'ws-1' };
    const result = await handler.handle('user-1', payload);

    assert.strictEqual(added?.sessionId, 'session-new');
    assert.strictEqual(activeSessionId, 'session-new');
    assert.ok((result as { toast: { content: string } }).toast.content.includes('Feishu Session'));
  });

  it('approval resolves allow/deny on the runtime for the owner', async () => {
    workspaceStore.get = async () => makeWorkspace();
    workspaceStore.getFeishuSessionOwner = () => 'user-1';

    let resolvedRequestId: string | null = null;
    let resolvedResult: unknown = null;
    chatService.getRuntimeIfExists = () => ({
      resolveApproval: (requestId: string, result: unknown) => {
        resolvedRequestId = requestId;
        resolvedResult = result;
      },
    }) as ReturnType<typeof chatService.getRuntimeIfExists>;

    const payload: CardActionPayload = {
      action: 'approval',
      workspaceId: 'ws-1',
      sessionId: 'session-1',
      requestId: 'req-1',
      behavior: 'allow',
    };
    const result = await handler.handle('user-1', payload);

    assert.strictEqual(resolvedRequestId, 'req-1');
    assert.strictEqual((resolvedResult as { behavior: string }).behavior, 'allow');
    assert.strictEqual((result as { toast: { content: string } }).toast.content, '已允许。');
  });

  it('question single-select resolves immediately', async () => {
    workspaceStore.get = async () => makeWorkspace();
    workspaceStore.getFeishuSessionOwner = () => 'user-1';

    let resolvedInput: unknown = null;
    chatService.getRuntimeIfExists = () => ({
      resolveApproval: (_requestId: string, result: unknown) => {
        resolvedInput = result;
      },
    }) as ReturnType<typeof chatService.getRuntimeIfExists>;

    handler.registerQuestion('req-1', [
      { question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false },
    ]);

    const payload: CardActionPayload = {
      action: 'question',
      workspaceId: 'ws-1',
      sessionId: 'session-1',
      requestId: 'req-1',
      questionIndex: 0,
      answer: 'A',
      multiSelect: false,
    };
    const result = await handler.handle('user-1', payload);

    assert.strictEqual((resolvedInput as { updatedInput: { answers: string[] } }).updatedInput.answers[0], 'A');
    assert.strictEqual((result as { toast: { content: string } }).toast.content, '已提交。');
  });
});
