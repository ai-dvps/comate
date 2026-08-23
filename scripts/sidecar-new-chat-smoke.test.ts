import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';

import {
  buildSidecarEnv,
  resolveResourceDir,
  resolveSidecarBinaryPath,
  shutdownSidecar,
  spawnSidecar,
  type SidecarHandle,
} from '../electron/sidecar.js';

const logger = { info: () => {}, error: () => {} };

test('packaged sidecar creates a New Chat session from a prose prompt without crashing', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'comate-sidecar-new-chat-'));
  let handle: SidecarHandle | undefined;
  let port: number | undefined;
  try {
    const pathEnv = {
      isPackaged: false,
      resourcesPath: '',
      repoRoot: process.cwd(),
      platform: process.platform,
      arch: process.arch,
    };
    handle = spawnSidecar({
      binaryPath: resolveSidecarBinaryPath(pathEnv),
      env: buildSidecarEnv({ dataDir, resourceDir: resolveResourceDir(pathEnv) }),
      logger,
    });

    const ready = await handle.ready;
    port = ready.port;
    await assertNotReachableViaNonLoopback(port);
    const headers = {
      Authorization: `Bearer ${ready.desktopToken}`,
      'Content-Type': 'application/json',
    };
    const baseUrl = `http://127.0.0.1:${ready.port}`;

    const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'sidecar-smoke', folderPath: process.cwd() }),
    });
    assert.equal(workspaceResponse.status, 201);
    const workspaceBody = await workspaceResponse.json() as { workspace: { id: string } };

    // The title-derivation path must never touch Intl.Segmenter: the packaged
    // (@yao-pkg/pkg) runtime segfaults inside segment() for every granularity.
    // These cases pin the two shapes that reach the segmenter through
    // grapheme-aware width/slice helpers — non-ASCII text and text long enough
    // to truncate. An English sentence alone slips past both (ASCII fast path,
    // no truncation), which is how the packaged crash shipped once already.
    const cases: Array<{ prompt: string; expected: string }> = [
      { prompt: 'First sentence. Second sentence.', expected: 'First sentence' },
      { prompt: '今天星期几', expected: '今天星期几' },
      { prompt: '修复登录后的重定向循环。请检查路由守卫。', expected: '修复登录后的重定向循环' },
    ];
    for (const { prompt, expected } of cases) {
      const sessionResponse = await fetch(
        `${baseUrl}/api/workspaces/${workspaceBody.workspace.id}/sessions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ prompt, approvalMode: 'manual', backend: 'claude' }),
        },
      );
      assert.equal(sessionResponse.status, 201, `session creation failed for prompt ${JSON.stringify(prompt)}`);
      const session = await sessionResponse.json() as { name: string };
      assert.equal(session.name, expected);
    }

    const longPrompt = `New Chat ${'title-'.repeat(30)} truncation check`;
    const longResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspaceBody.workspace.id}/sessions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt: longPrompt, approvalMode: 'manual', backend: 'claude' }),
      },
    );
    assert.equal(longResponse.status, 201, 'session creation failed for a truncating prompt');
    const longSession = await longResponse.json() as { name: string };
    assert.ok(longSession.name.endsWith('…'), `expected a truncated title, got ${JSON.stringify(longSession.name)}`);
  } finally {
    if (handle) {
      await shutdownSidecar(handle, { port, graceMs: 100, logger });
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('packaged sidecar runs a real Codex turn through the production Provider route', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'comate-sidecar-codex-route-'));
  const providerCredential = `provider-${randomBytes(24).toString('base64url')}`;
  const recordedAuthorization: string[] = [];
  const recordedBodies: string[] = [];
  const upstream = createServer((req, res) => {
    recordedAuthorization.push(req.headers.authorization ?? '');
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.once('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      recordedBodies.push(body);
      writeCompletedChatResponse(res);
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');

  let handle: SidecarHandle | undefined;
  let port: number | undefined;
  const processOutput: string[] = [];
  try {
    const pathEnv = {
      isPackaged: false,
      resourcesPath: '',
      repoRoot: process.cwd(),
      platform: process.platform,
      arch: process.arch,
    };
    const resourceDir = resolveResourceDir(pathEnv);
    handle = spawnSidecar({
      binaryPath: resolveSidecarBinaryPath(pathEnv),
      env: {
        ...buildSidecarEnv({ dataDir, resourceDir }),
        COMATE_PROVIDER_ROUTE_ACCEPTANCE_UPSTREAM: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      },
      logger: {
        info: (message) => processOutput.push(message),
        error: (message) => processOutput.push(message),
      },
      debugStdout: true,
      onStdoutLine: (line) => processOutput.push(line),
    });
    const ready = await handle.ready;
    port = ready.port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = { Authorization: `Bearer ${ready.desktopToken}`, 'Content-Type': 'application/json' };
    const providerResponse = await fetch(`${baseUrl}/api/providers`, {
      method: 'POST', headers,
      body: JSON.stringify({
        name: 'Packaged routed Chat', authToken: providerCredential, skipHealthCheck: true, agent: 'codex',
        configuration: {
          schemaVersion: 1,
          endpoints: { openai: { enabled: true, baseUrl: 'https://acceptance.invalid/v1', format: 'openai-chat-completions' } },
          models: { codex: 'route-smoke-model' }, openCode: { protocol: 'openai' }, claude: {},
          codex: { promptCacheRouting: 'auto', thinking: 'supported', effortByModel: { 'route-smoke-model': ['high'] } },
          preset: { id: 'packaged-acceptance', version: 1 },
        },
      }),
    });
    assert.equal(providerResponse.status, 201, await providerResponse.clone().text());
    const provider = await providerResponse.json() as { provider: { id: string } };
    const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST', headers, body: JSON.stringify({ name: 'routed-codex', folderPath: process.cwd() }),
    });
    assert.equal(workspaceResponse.status, 201);
    const workspace = await workspaceResponse.json() as { workspace: { id: string } };
    const sessionResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.workspace.id}/sessions`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'Packaged routed Codex', backend: 'codex', providerId: provider.provider.id, codexModel: 'route-smoke-model', codexEffort: 'high' }),
    });
    assert.equal(sessionResponse.status, 201, await sessionResponse.clone().text());
    const session = await sessionResponse.json() as { id: string };

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await once(socket, 'open');
    try {
      await wsRequest(socket, 'subscribe-route', 'subscribe', { workspaceId: workspace.workspace.id, sessionId: session.id });
      const completed = waitForWsMessage(socket, (message) => {
        const data = message.type === 'event' && message.eventType === 'sse' ? message.data as { type?: string } : undefined;
        return data?.type === 'result';
      }, 20_000);
      await wsRequest(socket, 'send-route', 'sendMessage', {
        workspaceId: workspace.workspace.id, sessionId: session.id,
        clientTurnId: '550e8400-e29b-41d4-a716-446655440101', content: 'route-smoke Unicode 你好',
      });
      await completed;
      assert.ok(recordedBodies.some((body) => body.includes('route-smoke Unicode 你好')));

    } finally {
      socket.close();
    }
    assert.ok(recordedAuthorization.length >= 1, 'the real Codex turn should reach the production route');
    assert.ok(recordedAuthorization.every((value) => value === `Bearer ${providerCredential}`));
    assert.doesNotMatch(processOutput.join('\n'), new RegExp(providerCredential));
    assert.equal(await directoryMatches(dataDir, /cap_[A-Za-z0-9_-]{40,}/), false);
  } finally {
    if (handle) await shutdownSidecar(handle, { port, graceMs: 100, logger });
    upstream.close();
    await once(upstream, 'close').catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

function writeCompletedChatResponse(res: import('node:http').ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const delta of [
    { role: 'assistant', reasoning_content: 'Packaged reasoning.' },
    { content: 'route ' },
    { content: 'ok 你好' },
  ]) res.write(`data: ${JSON.stringify(chatChunk(delta))}\n\n`);
  res.write(`data: ${JSON.stringify({ ...chatChunk({}), choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } } })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function chatChunk(delta: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'chatcmpl_route_smoke', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
    model: 'route-smoke-model', choices: [{ index: 0, delta, finish_reason: delta.content ? null : null }],
  };
}

type SmokeWsMessage = { id?: string; ok?: boolean; error?: { message?: string }; type?: string; eventType?: string; data?: unknown };

function waitForWsMessage(socket: WebSocket, predicate: (message: SmokeWsMessage) => boolean, timeoutMs: number): Promise<SmokeWsMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', receive); reject(new Error('WebSocket smoke timed out')); }, timeoutMs);
    const receive = (raw: import('ws').RawData): void => {
      const message = JSON.parse(raw.toString()) as SmokeWsMessage;
      if (!predicate(message)) return;
      clearTimeout(timer); socket.off('message', receive); resolve(message);
    };
    socket.on('message', receive);
  });
}

async function wsRequest(socket: WebSocket, id: string, type: string, payload: Record<string, unknown>): Promise<void> {
  const response = waitForWsMessage(socket, (message) => message.id === id, 20_000);
  socket.send(JSON.stringify({ id, type, payload }));
  const result = await response;
  assert.equal(result.ok, true, result.error?.message);
}

async function directoryMatches(root: string, pattern: RegExp): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = join(root, entry.name);
    if (entry.isDirectory()) {
      if (await directoryMatches(target, pattern)) return true;
    } else if (pattern.test((await readFile(target)).toString('latin1'))) {
      return true;
    }
  }
  return false;
}

async function assertNotReachableViaNonLoopback(port: number): Promise<void> {
  const address = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .find((entry) => entry.family === 'IPv4' && !entry.internal)?.address;
  if (!address) return;
  await assert.rejects(
    fetch(`http://${address}:${port}/provider-route/not-a-route/responses`, {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.timeout(1_000),
    }),
  );
}
