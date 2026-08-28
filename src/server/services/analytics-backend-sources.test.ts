import '../test-utils/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChatSession } from '../models/session.js';
import type { Workspace } from '../models/workspace.js';
import {
  CodexAnalyticsSource,
  OpenCodeAnalyticsSource,
} from './analytics-backend-sources.js';
import type { CodexAppServerManager } from './codex-app-server-manager.js';
import type { OpencodeServerInstance, OpencodeServerManager } from './opencode-server-manager.js';

const workspace = {
  id: 'ws-1',
  name: 'Workspace',
  folderPath: '/workspace',
} as Workspace;

function session(backend: 'opencode' | 'codex', backendSessionId: string): ChatSession {
  return {
    id: `comate-${backend}`,
    workspaceId: workspace.id,
    name: backend,
    backend,
    backendSessionId,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T01:00:00.000Z',
  };
}

describe('analytics backend sources', () => {
  it('reads OpenCode history through one credential-free workspace server and stops it', async () => {
    const calls: string[] = [];
    const instance = {
      sessionKey: 'analytics:ws-1', directory: workspace.folderPath,
      proc: { exitCode: null }, baseUrl: 'http://127.0.0.1:1', authHeaders: {},
    } as unknown as OpencodeServerInstance;
    const manager = {
      async ensureServer(key: string, directory: string, options: { config: unknown }) {
        calls.push(`start:${key}:${directory}:${JSON.stringify(options.config)}`);
        return instance;
      },
      async stopServer(key: string) {
        calls.push(`stop:${key}`);
      },
    } as unknown as OpencodeServerManager;
    const fetchImpl = async (_instance: OpencodeServerInstance, path: string) => {
      calls.push(`fetch:${path}`);
      return new Response(JSON.stringify([{
        info: {
          id: 'assistant-1', role: 'assistant', modelID: 'glm-5', cost: 0.01,
          time: { created: 1_000, completed: 2_000 },
          tokens: { input: 10, output: 5, cache: { read: 2, write: 1 } },
        },
        parts: [],
      }]), { status: 200 });
    };
    const source = new OpenCodeAnalyticsSource(manager, fetchImpl as never);

    const rows = await source.extractWorkspace(workspace, [{
      session: session('opencode', 'ses-1'), fingerprint: 99,
    }], 123);

    assert.equal(rows[0]?.totalTokens, 18);
    assert.match(calls[0] ?? '', /^start:analytics:ws-1:[0-9a-f-]+:\/workspace:\{\}$/);
    assert.equal(calls[1], 'fetch:/session/ses-1/message');
    const serverKey = calls[0]?.split(':').slice(1, 4).join(':');
    assert.equal(calls[2], `stop:${serverKey}`);
  });

  it('isolates an OpenCode session failure and still stops the reader server', async () => {
    const calls: string[] = [];
    const instance = {
      sessionKey: 'analytics:ws-1', directory: workspace.folderPath,
      proc: { exitCode: null }, baseUrl: 'http://127.0.0.1:1', authHeaders: {},
    } as unknown as OpencodeServerInstance;
    const manager = {
      async ensureServer() { return instance; },
      async stopServer(key: string) { calls.push(`stop:${key}`); },
    } as unknown as OpencodeServerManager;
    const fetchImpl = async (_instance: OpencodeServerInstance, path: string) => {
      calls.push(path);
      if (path.includes('broken')) return new Response('', { status: 500 });
      return new Response(JSON.stringify([{
        info: {
          id: 'assistant-1', role: 'assistant', modelID: 'glm-5', cost: 0,
          time: { created: 1_000, completed: 2_000 },
          tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 0, write: 0 } },
        },
        parts: [],
      }]), { status: 200 });
    };
    const source = new OpenCodeAnalyticsSource(manager, fetchImpl as never);

    const rows = await source.extractWorkspace(workspace, [
      { session: session('opencode', 'broken'), fingerprint: 1 },
      { session: session('opencode', 'working'), fingerprint: 2 },
    ], 123);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.totalTokens, 17);
    assert.deepEqual(calls.slice(0, 2), [
      '/session/broken/message',
      '/session/working/message',
    ]);
    assert.match(calls[2] ?? '', /^stop:analytics:ws-1:/);
  });

  it('combines Codex thread history with thread-scoped account usage', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const manager = {
      async request(method: string, params: unknown) {
        calls.push({ method, params });
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'thread-1', createdAt: 1, updatedAt: 2,
              turns: [{
                id: 'turn-1', startedAt: 1, completedAt: 2, durationMs: 1_000,
                status: 'completed', error: null, itemsView: { type: 'full' }, items: [],
              }],
            },
          };
        }
        return {
          summary: {}, dailyUsageBuckets: null,
          threadUsage: {
            threadId: 'thread-1', estimatedUsageCreditsMicros: '0', estimatedUsageUsdMicros: '10000',
            groups: [{
              model: 'gpt-5.6', reasoningEffort: null, speed: null,
              estimatedUsageCreditsMicros: '0', netNewInputTokens: '20', cachedInputTokens: '5',
              inputTokens: '25', outputTokens: '10', totalTokens: '35',
            }],
          },
        };
      },
    } as unknown as CodexAppServerManager;
    const source = new CodexAnalyticsSource(manager);

    const rows = await source.extractWorkspace(workspace, [{
      session: session('codex', 'thread-1'), fingerprint: 88,
    }], 456);

    assert.equal(rows[0]?.totalTokens, 35);
    assert.equal(rows[0]?.estimatedCostUsd, 0.01);
    assert.deepEqual(calls, [
      { method: 'thread/read', params: { threadId: 'thread-1', includeTurns: true } },
      { method: 'account/usage/read', params: { threadId: 'thread-1' } },
    ]);
  });

  it('keeps Codex history activity when thread-scoped usage is unavailable', async () => {
    const manager = {
      async request(method: string) {
        if (method === 'account/usage/read') throw new Error('usage unavailable');
        return {
          thread: {
            id: 'thread-1', createdAt: 1, updatedAt: 2,
            turns: [{
              id: 'turn-1', startedAt: 1, completedAt: 2, durationMs: 1_000,
              status: 'completed', error: null, itemsView: { type: 'full' }, items: [],
            }],
          },
        };
      },
    } as unknown as CodexAppServerManager;
    const source = new CodexAnalyticsSource(manager);

    const rows = await source.extractWorkspace(workspace, [{
      session: session('codex', 'thread-1'), fingerprint: 88,
    }], 456);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.totalTokens, 0);
    assert.equal(rows[0]?.messageCount, 1);
    assert.equal(rows[0]?.durationMs, 1_000);
  });
});
