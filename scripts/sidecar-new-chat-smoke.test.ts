import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildSidecarEnv,
  resolveResourceDir,
  resolveSidecarBinaryPath,
  shutdownSidecar,
  spawnSidecar,
  type SidecarHandle,
} from '../electron/sidecar.js';
import { verifyCodexRouteContexts } from './verify-codex-app-server.js';
import { codexVendorTriple } from '../src/server/utils/resolve-codex-binary.js';

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

test('packaged sidecar exposes an authenticated streaming route to real Codex contexts', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'comate-sidecar-codex-route-'));
  const routeId = randomBytes(18).toString('base64url');
  const routeBearer = `route-${randomBytes(24).toString('base64url')}`;
  const providerCredential = `provider-${randomBytes(24).toString('base64url')}`;
  const recordedAuthorization: string[] = [];
  const recordedBodies: string[] = [];
  let cancelledUpstreams = 0;
  const upstream = createServer((req, res) => {
    recordedAuthorization.push(req.headers.authorization ?? '');
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.once('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      recordedBodies.push(body);
      if (body.includes('route-smoke cancel')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`event: response.created\ndata: ${JSON.stringify({
          type: 'response.created',
          response: {
            id: 'resp_route_cancel', object: 'response', created_at: Math.floor(Date.now() / 1000),
            status: 'in_progress', error: null, incomplete_details: null, instructions: null,
            max_output_tokens: null, model: 'route-smoke-model', output: [], parallel_tool_calls: true,
            previous_response_id: null, reasoning: { effort: null, summary: null }, store: false,
            temperature: null, text: { format: { type: 'text' }, verbosity: 'medium' },
            tool_choice: 'auto', tools: [], top_p: null, truncation: 'disabled', usage: null,
            user: null, metadata: {},
          },
        })}\n\n`);
        const timer = setTimeout(() => res.end(), 30_000);
        timer.unref();
        res.once('close', () => {
          clearTimeout(timer);
          cancelledUpstreams += 1;
        });
        return;
      }
      writeCompletedResponse(res);
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
    const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const codexBinary = join(resourceDir, 'codex-runtime', 'vendor', codexVendorTriple(process.platform, process.arch), 'bin', binaryName);
    handle = spawnSidecar({
      binaryPath: resolveSidecarBinaryPath(pathEnv),
      env: {
        ...buildSidecarEnv({ dataDir, resourceDir }),
        COMATE_CODEX_ROUTE_SPIKE: JSON.stringify({
          routeId,
          routeBearer,
          upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
          providerBearer: providerCredential,
        }),
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

    await verifyCodexRouteContexts({
      binary: codexBinary,
      routeBaseUrl: `http://127.0.0.1:${port}/codex-route/${routeId}`,
      routeBearer,
      providerCredential,
    });
    const cancellationDeadline = Date.now() + 2_000;
    while (cancelledUpstreams < 3 && Date.now() < cancellationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(
      recordedAuthorization.length >= 6,
      `each context should complete and cancel through the route (received ${recordedAuthorization.length})`,
    );
    assert.ok(recordedAuthorization.every((value) => value === `Bearer ${providerCredential}`));
    assert.ok(
      cancelledUpstreams >= 3,
      `each context should cancel its upstream request (received ${cancelledUpstreams}; cancel bodies ${recordedBodies.filter((body) => body.includes('route-smoke cancel')).length})`,
    );
    assert.doesNotMatch(processOutput.join('\n'), new RegExp(`${routeBearer}|${providerCredential}`));
    assert.equal(await directoryContains(dataDir, routeBearer), false);
    assert.equal(await directoryContains(dataDir, providerCredential), false);
  } finally {
    if (handle) await shutdownSidecar(handle, { port, graceMs: 100, logger });
    upstream.close();
    await once(upstream, 'close').catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

function writeCompletedResponse(res: import('node:http').ServerResponse): void {
  const response = {
    id: 'resp_route_smoke',
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: 'route-smoke-model',
    output: [{
      id: 'msg_route_smoke',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', annotations: [], logprobs: [], text: 'route ok' }],
    }],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: 'text' }, verbosity: 'medium' },
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    truncation: 'disabled',
    usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 },
    user: null,
    metadata: {},
  };
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...response.output[0], status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: 'msg_route_smoke', output_index: 0, content_index: 0, part: { type: 'output_text', annotations: [], logprobs: [], text: '' } },
    { type: 'response.output_text.delta', item_id: 'msg_route_smoke', output_index: 0, content_index: 0, delta: 'route ok', logprobs: [] },
    { type: 'response.output_text.done', item_id: 'msg_route_smoke', output_index: 0, content_index: 0, text: 'route ok', logprobs: [] },
    { type: 'response.content_part.done', item_id: 'msg_route_smoke', output_index: 0, content_index: 0, part: response.output[0].content[0] },
    { type: 'response.output_item.done', output_index: 0, item: response.output[0] },
    { type: 'response.completed', response },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

async function directoryContains(root: string, needle: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = join(root, entry.name);
    if (entry.isDirectory()) {
      if (await directoryContains(target, needle)) return true;
    } else if ((await readFile(target)).includes(Buffer.from(needle))) {
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
    fetch(`http://${address}:${port}/codex-route/not-a-route/responses`, {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.timeout(1_000),
    }),
  );
}
