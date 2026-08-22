import '../test-utils/test-env.js';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CodexAppServerManager } from './codex-app-server-manager.js';
import { CodexBackendDriver, codexThreadConfig, codexUserInput } from './codex-adapter.js';

class FakeClient extends EventEmitter {
  responses: Array<{ id: string | number; result?: unknown; error?: unknown }> = [];
  respond(id: string | number, result?: unknown, error?: unknown): void {
    this.responses.push({ id, result, error });
  }
}

describe('CodexBackendDriver interactions', () => {
  it('passes only credential-free stdio MCP configuration to Codex', () => {
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
      },
    });
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
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition was not met');
}
