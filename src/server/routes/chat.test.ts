import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService, ChatError } from '../services/chat-service.js';
import { botService } from '../services/bot-service.js';

function createMockRes() {
  return {
    statusCode: 200,
    jsonBody: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
    },
  };
}

describe('chat route Feishu user info', { concurrency: false }, () => {
  beforeEach(() => {
    workspaceStore.resetData();
  });

  async function importGetFeishuUserHandler() {
    const mod = await import('./chat.js');
    const router = mod.default;
    const layers = (router as unknown as { stack: Array<{ route?: { methods: Record<string, boolean>; path: string; stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }> } }> }).stack;
    for (const layer of layers) {
      if (layer.route?.path === '/sessions/:sessionId/feishu-user' && layer.route.methods.get) {
        return layer.route.stack[layer.route.stack.length - 1].handle;
      }
    }
    throw new Error('GET /sessions/:sessionId/feishu-user handler not found');
  }

  function createFeishuBot(workspaceId: string) {
    return botService.createBot({
      name: 'Feishu Bot',
      activeWorkspaceId: workspaceId,
      channelSettings: {
        feishu: { enabled: true, appId: 'test-app', appSecret: 'test-secret' },
      },
    });
  }

  it('returns Feishu user info for a bound session', async () => {
    const workspaceId = 'ws-1';
    const feishuUserId = 'ou_12345';
    const bot = createFeishuBot(workspaceId);
    const user = botService.addMember(bot.id, {
      channelKey: 'feishu',
      channelUserId: feishuUserId,
      plaintextUserId: 'Alice',
    });
    const session = await chatService.createSession({ workspaceId, name: 'feishu session', source: 'feishu' });
    workspaceStore.addUserSession(workspaceId, session.id, user.id);
    workspaceStore.setActiveUserSession(user.id, session.id);

    const handler = await importGetFeishuUserHandler();
    const res = createMockRes();
    await handler({ params: { id: workspaceId, sessionId: session.id } }, res);

    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { userId: string; name: string | null };
    assert.strictEqual(body.userId, 'Alice');
    assert.strictEqual(body.name, 'Alice');
  });

  it('returns 404 when the session has no Feishu owner', async () => {
    const workspaceId = 'ws-1';
    const session = await chatService.createSession({ workspaceId, name: 'gui session', source: 'gui' });

    const handler = await importGetFeishuUserHandler();
    const res = createMockRes();
    await handler({ params: { id: workspaceId, sessionId: session.id } }, res);

    assert.strictEqual(res.statusCode, 404);
  });

  it('falls back to open_id when no cached name exists', async () => {
    const workspaceId = 'ws-1';
    const feishuUserId = 'ou_67890';
    const bot = createFeishuBot(workspaceId);
    const user = botService.addMember(bot.id, {
      channelKey: 'feishu',
      channelUserId: feishuUserId,
    });
    const session = await chatService.createSession({ workspaceId, name: 'feishu session', source: 'feishu' });
    workspaceStore.addUserSession(workspaceId, session.id, user.id);
    workspaceStore.setActiveUserSession(user.id, session.id);

    const handler = await importGetFeishuUserHandler();
    const res = createMockRes();
    await handler({ params: { id: workspaceId, sessionId: session.id } }, res);

    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { userId: string; name: string | null };
    assert.strictEqual(body.userId, feishuUserId);
    assert.strictEqual(body.name, null);
  });
});

describe('chat route approvals funnel (U8, KTD-15)', { concurrency: false }, () => {
  beforeEach(() => {
    workspaceStore.resetData();
  });

  async function importApprovalsHandler() {
    const mod = await import('./chat.js');
    const router = mod.default;
    const layers = (router as unknown as { stack: Array<{ route?: { methods: Record<string, boolean>; path: string; stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }> } }> }).stack;
    for (const layer of layers) {
      if (layer.route?.path === '/sessions/:sessionId/approvals/:requestId' && layer.route.methods.post) {
        return layer.route.stack[layer.route.stack.length - 1].handle;
      }
    }
    throw new Error('POST /sessions/:sessionId/approvals/:requestId handler not found');
  }

  // Shadow chatService methods with own properties for the duration of one
  // test; deleting them on restore un-shadows the prototype methods.
  function stubChatService(overrides: Record<string, unknown>): { restore: () => void } {
    const target = chatService as unknown as Record<string, unknown>;
    const keys = Object.keys(overrides);
    for (const key of keys) {
      target[key] = overrides[key];
    }
    return {
      restore: () => {
        for (const key of keys) {
          delete target[key];
        }
      },
    };
  }

  it('never spawns a runtime to resolve an approval — 404 when none exists', async () => {
    let createCalls = 0;
    const stub = stubChatService({
      getRuntimeIfExists: () => undefined,
      getOrCreateRuntime: () => {
        createCalls++;
        return Promise.reject(new Error('must not be called'));
      },
    });
    try {
      const handler = await importApprovalsHandler();
      const res = createMockRes();
      await handler(
        { params: { id: 'ws-1', sessionId: 'sess-gone', requestId: 'req-1' }, body: { behavior: 'allow' } },
        res,
      );

      assert.strictEqual(res.statusCode, 404);
      assert.deepStrictEqual(res.jsonBody, { error: 'No active approval for this session', code: 'APPROVAL_NOT_FOUND' });
      assert.strictEqual(createCalls, 0, 'getOrCreateRuntime must not be called');
    } finally {
      stub.restore();
    }
  });

  it('resolves through the existing runtime with desktop provenance', async () => {
    const resolveCalls: Array<{ requestId: string; result: unknown; provenance: unknown }> = [];
    const fakeRuntime = {
      getPendingCardState: () => ({ type: 'approval' as const, toolName: 'mcp__comate-browser__submit' }),
      resolveApproval: (requestId: string, result: unknown, provenance?: unknown) => {
        resolveCalls.push({ requestId, result, provenance });
        return true;
      },
    };
    const stub = stubChatService({
      getRuntimeIfExists: () => fakeRuntime,
    });
    try {
      const handler = await importApprovalsHandler();
      const res = createMockRes();
      await handler(
        { params: { id: 'ws-1', sessionId: 'sess-1', requestId: 'req-9' }, body: { behavior: 'allow' } },
        res,
      );

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.jsonBody, { ok: true });
      assert.strictEqual(resolveCalls.length, 1);
      assert.strictEqual(resolveCalls[0].requestId, 'req-9');
      assert.deepStrictEqual(resolveCalls[0].provenance, {
        source: 'desktop',
        approver: { type: 'user' },
      });
    } finally {
      stub.restore();
    }
  });

  it('resolves a multi-question AskUserQuestion with the pending server questions', async () => {
    const questions = [
      {
        question: 'Choose a color',
        options: [{ label: 'Red' }, { label: 'Blue' }],
        multiSelect: false,
      },
      {
        question: 'Choose environments',
        options: [{ label: 'Staging' }, { label: 'Production' }],
        multiSelect: true,
      },
    ];
    const answers = {
      'Choose a color': 'Blue',
      'Choose environments': 'Staging, Production',
    };
    const resolveCalls: Array<{ requestId: string; result: unknown; provenance: unknown }> = [];
    const fakeRuntime = {
      getPendingCardState: () => ({ type: 'question' as const, questions }),
      resolveApproval: (requestId: string, result: unknown, provenance?: unknown) => {
        resolveCalls.push({ requestId, result, provenance });
        return true;
      },
    };
    const stub = stubChatService({
      getRuntimeIfExists: () => fakeRuntime,
    });
    try {
      const handler = await importApprovalsHandler();
      const res = createMockRes();
      await handler(
        {
          params: { id: 'ws-1', sessionId: 'sess-1', requestId: 'req-question' },
          body: {
            behavior: 'allow',
            answers,
            questions: [{ question: 'untrusted client copy', options: [], multiSelect: false }],
          },
        },
        res,
      );

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.jsonBody, { ok: true });
      assert.deepStrictEqual(resolveCalls, [
        {
          requestId: 'req-question',
          result: {
            behavior: 'allow',
            updatedInput: { questions, answers },
          },
          provenance: {
            source: 'desktop',
            approver: { type: 'user' },
          },
        },
      ]);
    } finally {
      stub.restore();
    }
  });

  it('rejects malformed question answers without consuming the pending request', async () => {
    let resolveCalls = 0;
    const fakeRuntime = {
      getPendingCardState: () => ({
        type: 'question' as const,
        questions: [{ question: 'Choose one', options: [{ label: 'A' }], multiSelect: false }],
      }),
      resolveApproval: () => {
        resolveCalls++;
        return true;
      },
    };
    const stub = stubChatService({
      getRuntimeIfExists: () => fakeRuntime,
    });
    try {
      const handler = await importApprovalsHandler();
      const res = createMockRes();
      await handler(
        {
          params: { id: 'ws-1', sessionId: 'sess-1', requestId: 'req-question' },
          body: { behavior: 'allow', answers: null },
        },
        res,
      );

      assert.strictEqual(res.statusCode, 400);
      assert.deepStrictEqual(res.jsonBody, { error: 'answers must be an object for a question response' });
      assert.strictEqual(resolveCalls, 0);
    } finally {
      stub.restore();
    }
  });

  it('rejects non-string, missing, and unknown question answers', async () => {
    let resolveCalls = 0;
    const fakeRuntime = {
      getPendingCardState: () => ({
        type: 'question' as const,
        questions: [{ question: 'Choose one', options: [{ label: 'A' }], multiSelect: false }],
      }),
      resolveApproval: () => {
        resolveCalls++;
        return true;
      },
    };
    const stub = stubChatService({ getRuntimeIfExists: () => fakeRuntime });
    try {
      const handler = await importApprovalsHandler();
      for (const answers of [
        { 'Choose one': 1 },
        {},
        { 'Choose one': 'A', Extra: 'B' },
      ]) {
        const res = createMockRes();
        await handler(
          {
            params: { id: 'ws-1', sessionId: 'sess-1', requestId: 'req-question' },
            body: { behavior: 'allow', answers },
          },
          res,
        );
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(typeof res.jsonBody.error, 'string');
      }
      assert.strictEqual(resolveCalls, 0);
    } finally {
      stub.restore();
    }
  });

  it('rejects empty, out-of-option, and invalid single/multi-choice answers', async () => {
    let resolveCalls = 0;
    const questions = [
      { question: 'Choose one', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false },
      { question: 'Choose many', options: [{ label: 'X' }, { label: 'Y' }], multiSelect: true },
    ];
    const fakeRuntime = {
      getPendingCardState: () => ({ type: 'question' as const, questions }),
      resolveApproval: () => { resolveCalls++; return true; },
    };
    const stub = stubChatService({ getRuntimeIfExists: () => fakeRuntime });
    try {
      const handler = await importApprovalsHandler();
      for (const answers of [
        { 'Choose one': '', 'Choose many': 'X' },
        { 'Choose one': 'C', 'Choose many': 'X' },
        { 'Choose one': 'A, B', 'Choose many': 'X' },
        { 'Choose one': 'A', 'Choose many': 'X, Z' },
        { 'Choose one': 'A', 'Choose many': 'X, X' },
      ]) {
        const res = createMockRes();
        await handler({
          params: { id: 'ws-1', sessionId: 'sess-1', requestId: 'req-question' },
          body: { behavior: 'allow', answers },
        }, res);
        assert.strictEqual(res.statusCode, 400);
      }
      assert.strictEqual(resolveCalls, 0);
    } finally {
      stub.restore();
    }
  });

  it('deny resolutions carry the same desktop provenance', async () => {
    const resolveCalls: Array<{ result: unknown; provenance: unknown }> = [];
    const fakeRuntime = {
      getPendingCardState: () => ({ type: 'approval' as const, toolName: 'mcp__comate-browser__submit' }),
      resolveApproval: (_requestId: string, result: unknown, provenance?: unknown) => {
        resolveCalls.push({ result, provenance });
        return true;
      },
    };
    const stub = stubChatService({
      getRuntimeIfExists: () => fakeRuntime,
    });
    try {
      const handler = await importApprovalsHandler();
      const res = createMockRes();
      await handler(
        { params: { id: 'ws-1', sessionId: 'sess-1', requestId: 'req-10' }, body: { behavior: 'deny' } },
        res,
      );

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(resolveCalls[0].result, {
        behavior: 'deny',
        message: 'User denied this tool call.',
      });
      assert.deepStrictEqual(resolveCalls[0].provenance, {
        source: 'desktop',
        decision: 'deny',
        approver: { type: 'user' },
      });
    } finally {
      stub.restore();
    }
  });

  it('rejects an invalid behavior before touching any runtime', async () => {
    let lookupCalls = 0;
    const stub = stubChatService({
      getRuntimeIfExists: () => {
        lookupCalls++;
        return undefined;
      },
    });
    try {
      const handler = await importApprovalsHandler();
      const res = createMockRes();
      await handler(
        { params: { id: 'ws-1', sessionId: 'sess-1', requestId: 'req-1' }, body: { behavior: 'maybe' } },
        res,
      );

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(lookupCalls, 0);
    } finally {
      stub.restore();
    }
  });
});

describe('chat route interrupt (clear-all)', { concurrency: false }, () => {
  beforeEach(() => {
    workspaceStore.resetData();
  });

  async function importInterruptHandler() {
    const mod = await import('./chat.js');
    const router = mod.default;
    const layers = (router as unknown as { stack: Array<{ route?: { methods: Record<string, boolean>; path: string; stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }> } }> }).stack;
    for (const layer of layers) {
      if (layer.route?.path === '/sessions/:sessionId/interrupt' && layer.route.methods.post) {
        return layer.route.stack[layer.route.stack.length - 1].handle;
      }
    }
    throw new Error('POST /sessions/:sessionId/interrupt handler not found');
  }

  // Shadow chatService methods with own properties for the duration of one
  // test; deleting them on restore un-shadows the prototype methods.
  function stubChatService(overrides: Record<string, unknown>): { restore: () => void } {
    const target = chatService as unknown as Record<string, unknown>;
    const keys = Object.keys(overrides);
    for (const key of keys) {
      target[key] = overrides[key];
    }
    return {
      restore: () => {
        for (const key of keys) {
          delete target[key];
        }
      },
    };
  }

  it('returns 200 ok and never spawns a runtime when none exists', async () => {
    let createCalls = 0;
    const stub = stubChatService({
      getRuntimeIfExists: () => undefined,
      getOrCreateRuntime: () => {
        createCalls++;
        return Promise.reject(new Error('must not be called'));
      },
    });
    try {
      const handler = await importInterruptHandler();
      const res = createMockRes();
      await handler({ params: { id: 'ws-1', sessionId: 'sess-gone' } }, res);

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.jsonBody, { ok: true });
      assert.strictEqual(createCalls, 0, 'getOrCreateRuntime must not be called');
    } finally {
      stub.restore();
    }
    assert.strictEqual(
      chatService.getRuntimeIfExists('sess-gone'),
      undefined,
      'no runtime created for a stale stop',
    );
  });

  it('invokes stopAll on the existing runtime', async () => {
    let stopAllCalls = 0;
    const fakeRuntime = {
      stopAll: async () => {
        stopAllCalls++;
      },
    };
    const stub = stubChatService({
      getRuntimeIfExists: () => fakeRuntime,
    });
    try {
      const handler = await importInterruptHandler();
      const res = createMockRes();
      await handler({ params: { id: 'ws-1', sessionId: 'sess-1' } }, res);

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.jsonBody, { ok: true });
      assert.strictEqual(stopAllCalls, 1, 'stopAll invoked exactly once');
    } finally {
      stub.restore();
    }
  });

  it('maps a ChatError from stopAll to its status and code', async () => {
    const fakeRuntime = {
      stopAll: async () => {
        throw new ChatError('Session not found', 'SESSION_NOT_FOUND', 404);
      },
    };
    const stub = stubChatService({
      getRuntimeIfExists: () => fakeRuntime,
    });
    try {
      const handler = await importInterruptHandler();
      const res = createMockRes();
      await handler({ params: { id: 'ws-1', sessionId: 'sess-1' } }, res);

      assert.strictEqual(res.statusCode, 404);
      assert.deepStrictEqual(res.jsonBody, {
        error: 'Session not found',
        code: 'SESSION_NOT_FOUND',
      });
    } finally {
      stub.restore();
    }
  });

  it('falls back to 500 for unexpected errors', async () => {
    const fakeRuntime = {
      stopAll: async () => {
        throw new Error('disk gone');
      },
    };
    const stub = stubChatService({
      getRuntimeIfExists: () => fakeRuntime,
    });
    try {
      const handler = await importInterruptHandler();
      const res = createMockRes();
      await handler({ params: { id: 'ws-1', sessionId: 'sess-1' } }, res);

      assert.strictEqual(res.statusCode, 500);
      assert.deepStrictEqual(res.jsonBody, { error: 'Failed to interrupt' });
    } finally {
      stub.restore();
    }
  });
});

describe('chat route background task stop', { concurrency: false }, () => {
  beforeEach(() => {
    workspaceStore.resetData();
  });

  async function importTaskStopHandler() {
    const mod = await import('./chat.js');
    const router = mod.default;
    const layers = (router as unknown as { stack: Array<{ route?: { methods: Record<string, boolean>; path: string; stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }> } }> }).stack;
    for (const layer of layers) {
      if (layer.route?.path === '/sessions/:sessionId/tasks/:taskId/stop' && layer.route.methods.post) {
        return layer.route.stack[layer.route.stack.length - 1].handle;
      }
    }
    throw new Error('POST /sessions/:sessionId/tasks/:taskId/stop handler not found');
  }

  function stubRuntime(runtime: unknown): () => void {
    const target = chatService as unknown as Record<string, unknown>;
    target.getRuntimeIfExists = () => runtime;
    return () => {
      delete target.getRuntimeIfExists;
    };
  }

  it('stops only the requested task on a Claude runtime', async () => {
    const calls: string[] = [];
    const restore = stubRuntime({
      getStatus: () => ({ workspaceId: 'ws-1' }),
      getBackendId: () => 'claude',
      stopBackgroundTask: async (taskId: string) => {
        calls.push(taskId);
        return true;
      },
    });
    try {
      const handler = await importTaskStopHandler();
      const res = createMockRes();
      await handler({ params: { id: 'ws-1', sessionId: 'sess-1', taskId: 'task-2' } }, res);

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.jsonBody, { ok: true, stopped: true });
      assert.deepStrictEqual(calls, ['task-2']);
    } finally {
      restore();
    }
  });

  it('returns an idempotent success when the runtime is gone', async () => {
    const restore = stubRuntime(undefined);
    try {
      const handler = await importTaskStopHandler();
      const res = createMockRes();
      await handler({ params: { id: 'ws-1', sessionId: 'sess-gone', taskId: 'task-1' } }, res);

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.jsonBody, { ok: true, stopped: false });
    } finally {
      restore();
    }
  });

  it('rejects individual task stopping for non-Claude runtimes', async () => {
    const restore = stubRuntime({
      getStatus: () => ({ workspaceId: 'ws-1' }),
      getBackendId: () => 'opencode',
      stopBackgroundTask: async () => true,
    });
    try {
      const handler = await importTaskStopHandler();
      const res = createMockRes();
      await handler({ params: { id: 'ws-1', sessionId: 'sess-1', taskId: 'task-1' } }, res);

      assert.strictEqual(res.statusCode, 409);
      assert.deepStrictEqual(res.jsonBody, {
        error: 'Individual background task stopping is only supported for Claude Code sessions',
        code: 'TASK_STOP_UNSUPPORTED',
      });
    } finally {
      restore();
    }
  });

  it('does not stop a runtime through a different workspace path', async () => {
    let stopCalls = 0;
    const restore = stubRuntime({
      getStatus: () => ({ workspaceId: 'ws-2' }),
      getBackendId: () => 'claude',
      stopBackgroundTask: async () => {
        stopCalls++;
        return true;
      },
    });
    try {
      const handler = await importTaskStopHandler();
      const res = createMockRes();
      await handler({ params: { id: 'ws-1', sessionId: 'sess-1', taskId: 'task-1' } }, res);

      assert.strictEqual(res.statusCode, 404);
      assert.deepStrictEqual(res.jsonBody, { error: 'Session not found' });
      assert.strictEqual(stopCalls, 0);
    } finally {
      restore();
    }
  });

  it('returns 500 when the SDK task stop fails', async () => {
    const restore = stubRuntime({
      getStatus: () => ({ workspaceId: 'ws-1' }),
      getBackendId: () => 'claude',
      stopBackgroundTask: async () => {
        throw new Error('control request failed');
      },
    });
    try {
      const handler = await importTaskStopHandler();
      const res = createMockRes();
      await handler({ params: { id: 'ws-1', sessionId: 'sess-1', taskId: 'task-1' } }, res);

      assert.strictEqual(res.statusCode, 500);
      assert.deepStrictEqual(res.jsonBody, { error: 'Failed to stop background task' });
    } finally {
      restore();
    }
  });
});
