import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CodexAppServerManager } from './codex-app-server-manager.js';
import { CodexSessionService } from './codex-session-service.js';

describe('CodexSessionService history projection', () => {
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
