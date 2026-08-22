import '../test-utils/test-env.js';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CodexAppServerManager } from './codex-app-server-manager.js';
import { CodexBackendDriver } from './codex-adapter.js';

class FakeClient extends EventEmitter {
  responses: Array<{ id: string | number; result?: unknown; error?: unknown }> = [];
  respond(id: string | number, result?: unknown, error?: unknown): void {
    this.responses.push({ id, result, error });
  }
}

describe('CodexBackendDriver interactions', () => {
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
    const { query } = driver.createStreamingQuery(input());
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
    const { query } = driver.createStreamingQuery(input());
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
