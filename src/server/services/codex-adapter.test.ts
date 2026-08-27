import '../test-utils/test-env.js';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CodexAppServerManager } from './codex-app-server-manager.js';
import { CodexRpcError } from './codex-rpc-client.js';
import { CodexBackendDriver, codexThreadConfig, codexUserInput } from './codex-adapter.js';

class FakeClient extends EventEmitter {
  responses: Array<{ id: string | number; result?: unknown; error?: unknown }> = [];
  respond(id: string | number, result?: unknown, error?: unknown): void {
    this.responses.push({ id, result, error });
  }
}

describe('CodexBackendDriver interactions', () => {
  it('applies native model, effort, and speed to the thread and each turn', async () => {
    const client = new FakeClient();
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const manager = {
      ensureClient: async () => client,
      request: async (method: string, params?: Record<string, unknown>) => {
        requests.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') return { turn: { id: 'turn-1' } };
        return {};
      },
    } as unknown as CodexAppServerManager;
    const driver = new CodexBackendDriver({
      directory: '/tmp/project',
      model: 'gpt-5.6-codex',
      effort: 'high',
      serviceTier: 'fast',
      onBackendSessionId: () => undefined,
      manager,
    });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        uuid: 'message-settings',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'hello' },
      } as SDKUserMessage;
    }

    driver.createStreamingQuery(input(), {} as Options);
    await waitFor(() => requests.some((request) => request.method === 'turn/start'));

    assert.deepStrictEqual(requests[0], {
      method: 'thread/start',
      params: {
        cwd: '/tmp/project',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        config: { model_reasoning_effort: 'high' },
        model: 'gpt-5.6-codex',
        serviceTier: 'fast',
      },
    });
    assert.deepStrictEqual(requests[1], {
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        clientUserMessageId: 'message-settings',
        input: [{ type: 'text', text: 'hello', text_elements: [] }],
        model: 'gpt-5.6-codex',
        effort: 'high',
        serviceTier: 'fast',
      },
    });
  });

  it('ends the stream and rejects admission when app-server startup fails', async () => {
    const manager = {
      ensureClient: async () => { throw new Error('app-server unavailable'); },
    } as unknown as CodexAppServerManager;
    const driver = new CodexBackendDriver({
      directory: '/tmp/project',
      onBackendSessionId: () => undefined,
      manager,
    });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        uuid: 'message-startup-failure',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'hello' },
      } as SDKUserMessage;
    }

    const admission = driver.prepareAdmission('message-startup-failure');
    const { messages } = driver.createStreamingQuery(input(), {} as Options);

    await assert.rejects(admission, /app-server unavailable/);
    const result = await messages.next();
    assert.strictEqual(result.done, false);
    assert.match(JSON.stringify(result.value), /app-server unavailable/);
    assert.strictEqual((await messages.next()).done, true);
  });

  it('settles admission only after Codex accepts turn/start', async () => {
    const client = new FakeClient();
    let acceptTurn!: () => void;
    const turnAccepted = new Promise<void>((resolve) => { acceptTurn = resolve; });
    const manager = {
      ensureClient: async () => client,
      request: async (method: string) => {
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') {
          await turnAccepted;
          return { turn: { id: 'turn-1' } };
        }
        return {};
      },
    } as unknown as CodexAppServerManager;
    const driver = new CodexBackendDriver({
      directory: '/tmp/project',
      onBackendSessionId: () => undefined,
      manager,
    });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        uuid: 'message-admission',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'hello' },
      } as SDKUserMessage;
    }

    let admitted = false;
    const admission = driver.prepareAdmission('message-admission').then(() => { admitted = true; });
    driver.createStreamingQuery(input(), {} as Options);
    await waitFor(() => client.listenerCount('notification') === 1);
    assert.strictEqual(admitted, false);
    acceptTurn();
    await admission;
    assert.strictEqual(admitted, true);
  });

  it('rejects admission when Codex rejects turn/start', async () => {
    const client = new FakeClient();
    const manager = {
      ensureClient: async () => client,
      request: async (method: string) => {
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') throw new Error('turn rejected');
        return {};
      },
    } as unknown as CodexAppServerManager;
    const driver = new CodexBackendDriver({
      directory: '/tmp/project',
      onBackendSessionId: () => undefined,
      manager,
    });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        uuid: 'message-rejected',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'hello' },
      } as SDKUserMessage;
    }

    const admission = driver.prepareAdmission('message-rejected');
    driver.createStreamingQuery(input(), {} as Options);
    await assert.rejects(admission, /turn rejected/);
  });

  it('passes stdio command metadata without copying MCP credential fields', () => {
    const options = {
      mcpServers: {
        project: {
          type: 'stdio',
          command: '/usr/bin/project-mcp',
          args: ['serve'],
          env: { PROJECT_TOKEN: 'top-secret' },
        },
        browser: {
          type: 'http',
          url: 'http://127.0.0.1/mcp',
          headers: { Authorization: 'Bearer browser-secret' },
        },
      },
    } as unknown as Options;

    const config = codexThreadConfig(options);
    assert.deepStrictEqual(config, {
      mcp_servers: {
        project: { command: '/usr/bin/project-mcp', args: ['serve'] },
      },
    });
    assert.doesNotMatch(JSON.stringify(config), /top-secret|browser-secret|Authorization|PROJECT_TOKEN/);
  });

  it('reapplies an in-memory enterprise provider when resuming a Codex thread', async () => {
    const client = new FakeClient();
    const requests: Array<{ method: string; params?: unknown }> = [];
    const manager = {
      ensureClient: async () => client,
      request: async (method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === 'turn/start') return { turn: { id: 'turn-1' } };
        return {};
      },
    } as unknown as CodexAppServerManager;
    const driver = new CodexBackendDriver({
      directory: '/tmp/project',
      backendSessionId: 'thread-existing',
      model: 'enterprise-model',
      provider: {
        name: 'Enterprise',
        baseUrl: 'https://llm.example.com/v1',
        bearerToken: 'enterprise-secret',
      },
      onBackendSessionId: () => undefined,
      manager,
    });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        uuid: 'message-1',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'hello' },
      } as SDKUserMessage;
    }

    driver.createStreamingQuery(input(), {} as Options);
    await waitFor(() => requests.some((request) => request.method === 'turn/start'));

    assert.deepStrictEqual(requests[0], {
      method: 'thread/resume',
      params: {
        threadId: 'thread-existing',
        cwd: '/tmp/project',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        config: codexThreadConfig({} as Options, {
          name: 'Enterprise',
          baseUrl: 'https://llm.example.com/v1',
          bearerToken: 'enterprise-secret',
        }),
        modelProvider: 'comate-enterprise',
        model: 'enterprise-model',
      },
    });
  });

  it('clears a persisted provider override when resuming with the native Codex account', async () => {
    const client = new FakeClient();
    const requests: Array<{ method: string; params?: unknown }> = [];
    const manager = {
      ensureClient: async () => client,
      request: async (method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === 'turn/start') return { turn: { id: 'turn-1' } };
        return {};
      },
    } as unknown as CodexAppServerManager;
    const driver = new CodexBackendDriver({
      directory: '/tmp/project',
      backendSessionId: 'thread-existing',
      model: 'gpt-5.6-codex',
      onBackendSessionId: () => undefined,
      manager,
    });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        uuid: 'message-native',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'hello' },
      } as SDKUserMessage;
    }

    driver.createStreamingQuery(input(), {} as Options);
    await waitFor(() => requests.some((request) => request.method === 'turn/start'));

    assert.deepStrictEqual(requests[0], {
      method: 'thread/resume',
      params: {
        threadId: 'thread-existing',
        cwd: '/tmp/project',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        config: {},
        modelProvider: null,
        model: 'gpt-5.6-codex',
      },
    });
  });

  it('replaces a persisted Codex thread whose rollout is missing', async () => {
    const client = new FakeClient();
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const persistedThreadIds: string[] = [];
    const manager = {
      ensureClient: async () => client,
      request: async (method: string, params?: Record<string, unknown>) => {
        requests.push({ method, params });
        if (method === 'thread/resume') {
          throw new CodexRpcError(-32600, 'no rollout found for thread id thread-missing');
        }
        if (method === 'thread/start') return { thread: { id: 'thread-replacement' } };
        if (method === 'turn/start') return { turn: { id: 'turn-1' } };
        return {};
      },
    } as unknown as CodexAppServerManager;
    const driver = new CodexBackendDriver({
      directory: '/tmp/project',
      backendSessionId: 'thread-missing',
      onBackendSessionId: (threadId) => persistedThreadIds.push(threadId),
      manager,
    });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        uuid: 'message-recovery',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'hello' },
      } as SDKUserMessage;
    }

    driver.createStreamingQuery(input(), {} as Options);
    await waitFor(() => requests.some((request) => request.method === 'turn/start'));

    assert.deepStrictEqual(requests.map((request) => request.method), [
      'thread/resume',
      'thread/start',
      'turn/start',
    ]);
    assert.strictEqual(requests[2]?.params?.threadId, 'thread-replacement');
    assert.deepStrictEqual(persistedThreadIds, ['thread-replacement']);
  });

  it('does not replace a Codex thread for other resume failures', async () => {
    const client = new FakeClient();
    const requests: string[] = [];
    const manager = {
      ensureClient: async () => client,
      request: async (method: string) => {
        requests.push(method);
        if (method === 'thread/resume') throw new CodexRpcError(-32600, 'permission denied');
        return {};
      },
    } as unknown as CodexAppServerManager;
    const driver = new CodexBackendDriver({
      directory: '/tmp/project',
      backendSessionId: 'thread-existing',
      onBackendSessionId: () => assert.fail('resume failure must not replace the thread'),
      manager,
    });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        uuid: 'message-resume-failure',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'hello' },
      } as SDKUserMessage;
    }

    const admission = driver.prepareAdmission('message-resume-failure');
    const { messages } = driver.createStreamingQuery(input(), {} as Options);

    await assert.rejects(admission, /permission denied/);
    assert.deepStrictEqual(requests, ['thread/resume']);
    assert.match(JSON.stringify((await messages.next()).value), /permission denied/);
  });

  it('surfaces a failed completed turn as an error result', async () => {
    const client = new FakeClient();
    const manager = {
      ensureClient: async () => client,
      request: async (method: string) => {
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') return { turn: { id: 'turn-1' } };
        return {};
      },
    } as unknown as CodexAppServerManager;
    const driver = new CodexBackendDriver({
      directory: '/tmp/project',
      onBackendSessionId: () => undefined,
      manager,
    });
    let releaseInput!: () => void;
    const hold = new Promise<void>((resolve) => { releaseInput = resolve; });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        uuid: 'message-failed',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'hello' },
      } as SDKUserMessage;
      await hold;
    }

    const { query, messages } = driver.createStreamingQuery(input(), {} as Options);
    await waitFor(() => client.listenerCount('notification') === 1);
    client.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'failed',
          error: { message: '401 Unauthorized' },
        },
      },
    });

    const result = await messages.next();
    assert.strictEqual(result.done, false);
    assert.strictEqual((result.value as SDKMessage & { is_error?: boolean }).is_error, true);
    assert.match(JSON.stringify(result.value), /401 Unauthorized/);
    releaseInput();
    query.close();
  });

  it('uses an explicit in-memory Responses provider override', () => {
    assert.deepStrictEqual(codexThreadConfig({} as Options, {
      name: 'Enterprise OpenAI',
      baseUrl: 'https://llm.example.com/v1',
      bearerToken: 'enterprise-secret',
    }), {
      model_providers: {
        'comate-enterprise': {
          name: 'Enterprise OpenAI',
          base_url: 'https://llm.example.com/v1',
          wire_api: 'responses',
          requires_openai_auth: false,
          experimental_bearer_token: 'enterprise-secret',
        },
      },
    });
  });

  it('projects the active Codex model profile into thread config', () => {
    assert.deepStrictEqual(codexThreadConfig({} as Options, {
      name: 'Profiled OpenAI',
      baseUrl: 'https://llm.example.com/v1',
      bearerToken: 'enterprise-secret',
      modelProfile: {
        contextWindow: 1_048_576,
        autoCompactTokenLimit: 900_000,
        reasoningSummary: 'none',
        supportsReasoningSummaries: true,
        verbosity: 'low',
      },
    }), {
      model_context_window: 1_048_576,
      model_auto_compact_token_limit: 900_000,
      model_reasoning_summary: 'none',
      model_supports_reasoning_summaries: true,
      model_verbosity: 'low',
      model_providers: {
        'comate-enterprise': {
          name: 'Profiled OpenAI',
          base_url: 'https://llm.example.com/v1',
          wire_api: 'responses',
          requires_openai_auth: false,
          experimental_bearer_token: 'enterprise-secret',
        },
      },
    });
  });

  it('can pass only an opaque route capability to Codex', () => {
    const config = codexThreadConfig({} as Options, {
      name: 'Comate route',
      baseUrl: 'http://127.0.0.1:43210/codex-route/opaque-id',
      bearerToken: 'opaque-route-bearer',
      disableHostedTools: true,
    });
    assert.match(JSON.stringify(config), /opaque-route-bearer/);
    assert.doesNotMatch(JSON.stringify(config), /provider-secret/);
    assert.deepStrictEqual(config, {
      web_search: 'disabled',
      model_providers: {
        'comate-enterprise': {
          name: 'Comate route',
          base_url: 'http://127.0.0.1:43210/codex-route/opaque-id',
          wire_api: 'responses',
          requires_openai_auth: false,
          experimental_bearer_token: 'opaque-route-bearer',
        },
      },
    });
  });

  it('redacts an enterprise bearer from app-server failures', async () => {
    const client = new FakeClient();
    const manager = {
      ensureClient: async () => client,
      request: async () => { throw new Error('provider rejected enterprise-secret'); },
    } as unknown as CodexAppServerManager;
    const driver = new CodexBackendDriver({
      directory: '/tmp/project',
      provider: {
        name: 'Enterprise',
        baseUrl: 'https://llm.example.com/v1',
        bearerToken: 'enterprise-secret',
      },
      onBackendSessionId: () => undefined,
      manager,
    });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      // The failure occurs before a turn is admitted.
      yield* [] as SDKUserMessage[];
    }

    const { messages } = driver.createStreamingQuery(input(), {} as Options);
    const result = await messages.next();

    assert.strictEqual(result.done, false);
    assert.doesNotMatch(JSON.stringify(result.value), /enterprise-secret/);
    assert.match(JSON.stringify(result.value), /\[REDACTED\]/);
  });

  it('starts Codex with shared approval policy, workspace sandbox, and safe MCP overrides', async () => {
    const client = new FakeClient();
    const requests: Array<{ method: string; params?: unknown }> = [];
    const manager = {
      ensureClient: async () => client,
      request: async (method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') return { turn: { id: 'turn-1' } };
        return {};
      },
    } as unknown as CodexAppServerManager;
    const driver = new CodexBackendDriver({
      directory: '/tmp/project',
      model: 'gpt-5.6-codex',
      onBackendSessionId: () => undefined,
      manager,
    });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        uuid: 'message-1',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'hello' },
      } as SDKUserMessage;
    }

    driver.createStreamingQuery(input(), {
      mcpServers: { project: { command: '/usr/bin/project-mcp', args: ['serve'] } },
    } as Options);
    await waitFor(() => requests.some((request) => request.method === 'turn/start'));

    assert.deepStrictEqual(requests[0], {
      method: 'thread/start',
      params: {
        cwd: '/tmp/project',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        config: {
          mcp_servers: {
            project: { command: '/usr/bin/project-mcp', args: ['serve'] },
          },
        },
        model: 'gpt-5.6-codex',
      },
    });
    const turnStart = requests.find((request) => request.method === 'turn/start');
    assert.ok(turnStart);
    assert.strictEqual((turnStart.params as { model?: string }).model, 'gpt-5.6-codex');
  });

  it('preserves ordered text and image input for app-server', () => {
    assert.deepStrictEqual(codexUserInput([
      { type: 'text', text: 'What is shown?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
    ]), [
      { type: 'text', text: 'What is shown?', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,AQID' },
    ]);
  });

  it('converts a selected slash Skill into native Codex Skill input', () => {
    assert.deepStrictEqual(codexUserInput('/review inspect this change', [{
      name: 'review',
      description: 'Review changes',
      path: '/tmp/project/.codex/skills/review/SKILL.md',
    }]), [
      {
        type: 'text',
        text: '$review inspect this change',
        text_elements: [],
      },
      {
        type: 'skill',
        name: 'review',
        path: '/tmp/project/.codex/skills/review/SKILL.md',
      },
    ]);
  });

  it('loads native Skill metadata before starting a slash Skill turn', async () => {
    const client = new FakeClient();
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const manager = {
      ensureClient: async () => client,
      registerSkillRoots: async () => undefined,
      listSkills: async () => [{
        name: 'review',
        description: 'Review changes',
        path: '/tmp/project/.codex/skills/review/SKILL.md',
      }],
      request: async (method: string, params?: Record<string, unknown>) => {
        requests.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') return { turn: { id: 'turn-1' } };
        return {};
      },
    } as unknown as CodexAppServerManager;
    const driver = new CodexBackendDriver({
      directory: '/tmp/project',
      onBackendSessionId: () => undefined,
      manager,
    });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        uuid: 'message-skill',
        parent_tool_use_id: null,
        message: { role: 'user', content: '/review inspect this change' },
      } as SDKUserMessage;
    }

    driver.createStreamingQuery(input(), {} as Options);
    await waitFor(() => requests.some((request) => request.method === 'turn/start'));

    const turnStart = requests.find((request) => request.method === 'turn/start');
    assert.deepStrictEqual(turnStart?.params?.input, [
      { type: 'text', text: '$review inspect this change', text_elements: [] },
      {
        type: 'skill',
        name: 'review',
        path: '/tmp/project/.codex/skills/review/SKILL.md',
      },
    ]);
  });

  it('routes command approval through the shared tool policy', async () => {
    const client = new FakeClient();
    const manager = {
      ensureClient: async () => client,
      request: async (method: string) => {
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') return { turn: { id: 'turn-1' } };
        return {};
      },
    } as unknown as CodexAppServerManager;
    const driver = new CodexBackendDriver({
      directory: '/tmp/project',
      onBackendSessionId: () => undefined,
      manager,
    });
    let received: unknown;
    driver.bindToolRequestHandler(async (request) => {
      received = request;
      return { behavior: 'allow', updatedInput: request.input };
    });
    let releaseInput!: () => void;
    const hold = new Promise<void>((resolve) => { releaseInput = resolve; });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        uuid: 'message-1',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'run tests' },
      } as SDKUserMessage;
      await hold;
    }
    const { query } = driver.createStreamingQuery(input(), {} as Options);
    await waitFor(() => client.listenerCount('request') === 1);

    client.emit('request', {
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-1',
        command: 'npm test',
        cwd: '/tmp/project',
      },
    });
    await waitFor(() => client.responses.length === 1);

    assert.deepStrictEqual(received, {
      requestId: '7',
      toolUseId: 'cmd-1',
      toolName: 'Bash',
      input: { command: 'npm test', cwd: '/tmp/project' },
      title: undefined,
    });
    assert.deepStrictEqual(client.responses[0], {
      id: 7,
      result: { decision: 'accept' },
      error: undefined,
    });
    releaseInput();
    query.close();
  });

  it('translates Codex user-input questions and answers', async () => {
    const client = new FakeClient();
    const manager = {
      ensureClient: async () => client,
      request: async (method: string) => {
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') return { turn: { id: 'turn-1' } };
        return {};
      },
    } as unknown as CodexAppServerManager;
    const driver = new CodexBackendDriver({
      directory: '/tmp/project',
      onBackendSessionId: () => undefined,
      manager,
    });
    let received: unknown;
    driver.bindToolRequestHandler(async (request) => {
      received = request;
      return {
        behavior: 'allow',
        updatedInput: {
          ...request.input,
          answers: { 'Pick one': 'A' },
        },
      };
    });
    let releaseInput!: () => void;
    const hold = new Promise<void>((resolve) => { releaseInput = resolve; });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        uuid: 'message-1',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'ask me' },
      } as SDKUserMessage;
      await hold;
    }
    const { query } = driver.createStreamingQuery(input(), {} as Options);
    await waitFor(() => client.listenerCount('request') === 1);

    client.emit('request', {
      id: 8,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'question-1',
        questions: [{
          id: 'q1',
          header: 'Choice',
          question: 'Pick one',
          options: [{ label: 'A', description: 'First option' }],
        }],
      },
    });
    await waitFor(() => client.responses.length === 1);

    assert.deepStrictEqual(received, {
      requestId: '8',
      toolUseId: 'question-1',
      toolName: 'AskUserQuestion',
      input: {
        questions: [{
          id: 'q1',
          question: 'Pick one',
          header: 'Choice',
          options: [{ label: 'A', description: 'First option' }],
          multiSelect: false,
        }],
      },
    });
    assert.deepStrictEqual(client.responses[0].result, {
      answers: { q1: { answers: ['A'] } },
    });
    releaseInput();
    query.close();
  });

  it('reports Codex token usage through the shared context surface', async () => {
    const client = new FakeClient();
    const manager = {
      ensureClient: async () => client,
      request: async (method: string) => {
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') return { turn: { id: 'turn-1' } };
        return {};
      },
    } as unknown as CodexAppServerManager;
    const driver = new CodexBackendDriver({
      directory: '/tmp/project',
      model: 'gpt-codex',
      onBackendSessionId: () => undefined,
      manager,
    });
    let releaseInput!: () => void;
    const hold = new Promise<void>((resolve) => { releaseInput = resolve; });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        uuid: 'message-1',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'hello' },
      } as SDKUserMessage;
      await hold;
    }
    const { query } = driver.createStreamingQuery(input(), {} as Options);
    await waitFor(() => client.listenerCount('notification') === 1);

    client.emit('notification', {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: {
            totalTokens: 120,
            inputTokens: 80,
            cachedInputTokens: 20,
            cacheWriteInputTokens: 0,
            outputTokens: 30,
            reasoningOutputTokens: 10,
          },
          last: {
            totalTokens: 60,
            inputTokens: 40,
            cachedInputTokens: 10,
            cacheWriteInputTokens: 0,
            outputTokens: 15,
            reasoningOutputTokens: 5,
          },
          modelContextWindow: 1_000,
        },
      },
    });
    const usage = await query.getContextUsage();

    assert.strictEqual(usage.totalTokens, 60);
    assert.strictEqual(usage.maxTokens, 1_000);
    assert.strictEqual(usage.percentage, 6);
    assert.strictEqual(usage.model, 'gpt-codex');
    assert.deepStrictEqual(usage.categories.map((category) => [category.name, category.tokens]), [
      ['input', 40],
      ['cached input', 10],
      ['output', 15],
      ['reasoning', 5],
    ]);
    releaseInput();
    query.close();
  });

  it('settles a Codex turn from monotonic token snapshot deltas', async () => {
    const client = new FakeClient();
    const manager = {
      ensureClient: async () => client,
      request: async (method: string) => {
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') return { turn: { id: 'turn-1' } };
        return {};
      },
    } as unknown as CodexAppServerManager;
    const driver = new CodexBackendDriver({
      directory: '/tmp/project', onBackendSessionId: () => undefined, manager,
    });
    let releaseInput!: () => void;
    const hold = new Promise<void>((resolve) => { releaseInput = resolve; });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield { type: 'user', uuid: 'message-1', parent_tool_use_id: null,
        message: { role: 'user', content: 'hello' } } as SDKUserMessage;
      await hold;
    }
    const { query, messages } = driver.createStreamingQuery(input(), {} as Options);
    await waitFor(() => client.listenerCount('notification') === 1);

    const snapshot = (totalTokens: number, inputTokens: number, outputTokens: number) => ({
      total: { totalTokens, inputTokens, cachedInputTokens: 10,
        cacheWriteInputTokens: 2, outputTokens, reasoningOutputTokens: 3 },
      last: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5,
        cacheWriteInputTokens: 1, outputTokens: 10, reasoningOutputTokens: 3 },
      modelContextWindow: 1_000,
    });
    client.emit('notification', { method: 'thread/tokenUsage/updated', params: {
      threadId: 'thread-1', turnId: 'turn-1', tokenUsage: snapshot(100, 70, 30),
    }});
    client.emit('notification', { method: 'thread/tokenUsage/updated', params: {
      threadId: 'thread-1', turnId: 'turn-1', tokenUsage: snapshot(125, 88, 37),
    }});
    client.emit('notification', { method: 'turn/completed', params: {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' },
    }});

    const result = await messages.next();
    assert.strictEqual(result.done, false);
    assert.deepStrictEqual((result.value as unknown as { tokenUsage?: unknown }).tokenUsage, {
      quality: 'estimated', totalTokens: 55, inputTokens: 38, outputTokens: 17,
      cacheReadTokens: 5, cacheWriteTokens: 1, thinkingTokens: 3,
    });
    releaseInput();
    query.close();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition was not met');
}
