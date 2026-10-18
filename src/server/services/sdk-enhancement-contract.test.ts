import '../test-utils/test-env.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { resolveSdkBinary } from '../utils/resolve-sdk-binary.js';

it('native Claude summary diagnostics avoid model and per-category token-count requests', { timeout: 30000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'comate-sdk-context-'));
  const workspace = path.join(home, 'workspace');
  await mkdir(workspace);
  const inferenceRequests: string[] = [];
  const server = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url?.includes('/messages')) inferenceRequests.push(request.url);
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const input: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
  };
  const session = query({ prompt: input, options: {
    cwd: workspace,
    pathToClaudeCodeExecutable: resolveSdkBinary(),
    model: 'fixture-model',
    permissionMode: 'default',
    settingSources: [],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      ANTHROPIC_API_KEY: 'fixture-not-a-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
    },
  } });
  try {
    await session.initializationResult();
    const usage = await session.getContextUsage({ detail: 'summary' });
    assert.ok(Number.isFinite(usage.totalTokens));
    assert.ok(usage.maxTokens > 0);
    assert.ok(usage.categories.length > 0);
    assert.ok(usage.categories.every(category => ['used', 'free', 'buffer', 'deferred'].includes(category.kind)));
    assert.deepEqual(inferenceRequests, []);
  } finally {
    session.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
