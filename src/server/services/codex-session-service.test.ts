import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodexAppServerManager } from './codex-app-server-manager.js';
import { CodexSessionService } from './codex-session-service.js';

describe('CodexSessionService history projection', () => {
  it('reconstructs per-turn usage from the rollout path returned by app-server', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'comate-codex-rollout-'));
    const rolloutPath = join(dir, 'rollout.jsonl');
    await writeFile(rolloutPath, [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      { type: 'event_msg', payload: { type: 'token_count', info: {
        total_token_usage: { total_tokens: 100, input_tokens: 70, cached_input_tokens: 10,
          cache_write_input_tokens: 2, output_tokens: 30, reasoning_output_tokens: 3 },
        last_token_usage: { total_tokens: 30, input_tokens: 20, cached_input_tokens: 5,
          cache_write_input_tokens: 1, output_tokens: 10, reasoning_output_tokens: 3 },
      }}},
      { type: 'event_msg', payload: { type: 'token_count', info: {
        total_token_usage: { total_tokens: 125, input_tokens: 88, cached_input_tokens: 10,
          cache_write_input_tokens: 2, output_tokens: 37, reasoning_output_tokens: 3 },
        last_token_usage: { total_tokens: 25, input_tokens: 18, cached_input_tokens: 0,
          cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0 },
        model_context_window: 1000,
      }}},
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    try {
      const manager = { request: async () => ({ thread: {
        id: 'thread-1', path: rolloutPath, turns: [{ id: 'turn-1', items: [
          { type: 'agentMessage', id: 'agent-1', text: 'done', phase: null,
            memoryCitation: null, delivery: null },
        ] }],
      } }) } as unknown as CodexAppServerManager;

      const history = await new CodexSessionService(manager).loadMessagesWithContext('thread-1');
      const terminal = history.messages[0] as unknown as { tokenUsage?: unknown };
      assert.deepStrictEqual(terminal.tokenUsage, {
        quality: 'estimated', totalTokens: 55, inputTokens: 38, outputTokens: 17,
        cacheReadTokens: 5, cacheWriteTokens: 1, thinkingTokens: 3,
      });
      assert.deepStrictEqual(history.contextUsage, {
        totalTokens: 25, maxTokens: 1000, rawMaxTokens: 1000, percentage: 2.5,
        categories: [
          { name: 'input', tokens: 18 }, { name: 'cached input', tokens: 0 },
          { name: 'output', tokens: 7 }, { name: 'reasoning', tokens: 0 },
        ],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists only child threads of the requested Codex parent across pages', async () => {
    const requests: unknown[] = [];
    const manager = {
      request: async (_method: string, params: unknown) => {
        requests.push(params);
        const cursor = (params as { cursor?: string | null }).cursor;
        return cursor === null
          ? {
              data: [
                { id: 'child-1', parentThreadId: 'parent-1' },
                { id: 'other', parentThreadId: 'parent-2' },
              ],
              nextCursor: 'page-2',
            }
          : {
              data: [{ id: 'child-2', parentThreadId: 'parent-1' }],
              nextCursor: null,
            };
      },
    } as unknown as CodexAppServerManager;
    const service = new CodexSessionService(manager);

    const children = await service.listSubagents('parent-1', '/tmp/project');

    assert.deepStrictEqual(children.map((thread) => thread.id), ['child-1', 'child-2']);
    assert.deepStrictEqual(requests, [
      { cursor: null, limit: 100, cwd: '/tmp/project', useStateDbOnly: true },
      { cursor: 'page-2', limit: 100, cwd: '/tmp/project', useStateDbOnly: true },
    ]);
  });

  it('reconstructs text, reasoning, command, and result messages from Codex-owned history', async () => {
    const manager = {
      request: async () => ({
        thread: {
          id: 'thread-1',
          turns: [{
            id: 'turn-1',
            items: [
              { type: 'userMessage', id: 'user-1', clientId: null, content: [{ type: 'text', text: 'Run tests', text_elements: [] }] },
              { type: 'reasoning', id: 'reason-1', summary: ['Check the suite'], content: [] },
              {
                type: 'commandExecution',
                id: 'cmd-1',
                command: 'npm test',
                cwd: '/tmp/project',
                status: 'completed',
                aggregatedOutput: 'all green',
                exitCode: 0,
                commandActions: [],
                pluginId: null,
                scriptPath: null,
                processId: null,
                source: 'agent',
                durationMs: 100,
              },
              { type: 'agentMessage', id: 'agent-1', text: 'Tests pass', phase: null, memoryCitation: null, delivery: null },
            ],
          }],
        },
      }),
    } as unknown as CodexAppServerManager;
    const service = new CodexSessionService(manager);

    const messages = await service.loadMessages('thread-1');

    assert.strictEqual(messages.length, 5);
    assert.strictEqual(messages[0].type, 'user');
    assert.strictEqual(messages[1].type, 'assistant');
    assert.strictEqual(messages[2].type, 'assistant');
    assert.strictEqual(messages[3].type, 'user');
    assert.strictEqual(messages[4].type, 'assistant');
    const tool = messages[2] as unknown as { message: { content: Array<{ name: string; input: unknown }> } };
    assert.deepStrictEqual(tool.message.content[0], {
      type: 'tool_use',
      id: 'cmd-1',
      name: 'Bash',
      input: { command: 'npm test', cwd: '/tmp/project' },
    });
  });
});
