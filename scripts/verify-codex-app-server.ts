import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexRpcClient } from '../src/server/services/codex-rpc-client.js';
import { resolveCodexBinary } from '../src/server/utils/resolve-codex-binary.js';

export type CodexRouteContext = 'ordinary' | 'bot' | 'scheduled';

export interface CodexRouteVerificationOptions {
  binary: string;
  routeBaseUrl: string;
  routeBearer: string;
  providerCredential: string;
  model?: string;
  contexts?: readonly CodexRouteContext[];
}

export async function verifyCodexRouteContexts(options: CodexRouteVerificationOptions): Promise<void> {
  for (const context of options.contexts ?? ['ordinary', 'bot', 'scheduled']) {
    const captured: string[] = [];
    const { child, isolatedHome } = spawnAppServer(options.binary, captured);
    const client = new CodexRpcClient(child.stdout, child.stdin);
    try {
      await client.request('initialize', {
        clientInfo: { name: 'comate-route-verifier', title: 'Comate route verifier', version: '0.4.2' },
        capabilities: null,
      }, 10_000);
      const started = await client.request<{ thread: { id: string } }>('thread/start', {
        model: options.model ?? 'route-smoke-model',
        modelProvider: 'comate-route',
        cwd: process.cwd(),
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        threadSource: `comate-${context}`,
        config: {
          model_providers: {
            'comate-route': {
              name: 'Comate authenticated route',
              base_url: options.routeBaseUrl,
              wire_api: 'responses',
              requires_openai_auth: false,
              experimental_bearer_token: options.routeBearer,
            },
          },
        },
      }, 10_000);

      const streamed = waitForNotification(client, 'item/agentMessage/delta', 15_000);
      const completed = waitForNotification(client, 'turn/completed', 15_000);
      await client.request('turn/start', {
        threadId: started.thread.id,
        clientUserMessageId: `${context}-complete`,
        input: [{ type: 'text', text: `route-smoke complete ${context}`, text_elements: [] }],
      }, 10_000);
      await streamed;
      const completedTurn = await completed as { turn?: { status?: string; error?: unknown } };
      assert.equal(completedTurn.turn?.status, 'completed', JSON.stringify(completedTurn.turn?.error));

      const cancelled = waitForNotification(client, 'turn/completed', 15_000);
      const running = await client.request<{ turn: { id: string } }>('turn/start', {
        threadId: started.thread.id,
        clientUserMessageId: `${context}-cancel`,
        input: [{ type: 'text', text: `route-smoke cancel ${context}`, text_elements: [] }],
      }, 10_000);
      // turn/start acknowledges admission before the background HTTP request
      // is guaranteed to have reached the route. Give the real app-server a
      // bounded dispatch window so the cancellation assertion exercises an
      // in-flight routed request rather than a pre-dispatch turn.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await client.request('turn/interrupt', { threadId: started.thread.id, turnId: running.turn.id }, 10_000);
      const cancelledTurn = await cancelled as { turn?: { status?: string } };
      assert.equal(cancelledTurn.turn?.status, 'interrupted');
    } finally {
      client.close();
      if (child.exitCode === null) child.kill('SIGTERM');
      if (child.exitCode === null) await once(child, 'exit').catch(() => undefined);
      const output = captured.join('');
      assert.doesNotMatch(output, new RegExp(escapeRegExp(options.routeBearer)));
      assert.doesNotMatch(output, new RegExp(escapeRegExp(options.providerCredential)));
      assert.equal(await directoryContains(isolatedHome, options.routeBearer), false);
      assert.equal(await directoryContains(isolatedHome, options.providerCredential), false);
      await rm(isolatedHome, { recursive: true, force: true });
    }
  }
}

function spawnAppServer(binary: string, captured: string[]): {
  child: ChildProcessWithoutNullStreams;
  isolatedHome: string;
} {
  const isolatedHome = mkdtempSync(path.join(tmpdir(), 'comate-codex-route-home-'));
  const child = spawn(binary, ['app-server'], {
    env: { ...process.env, CODEX_HOME: isolatedHome },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk: Buffer) => captured.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => captured.push(chunk.toString()));
  return { child, isolatedHome };
}

function waitForNotification(client: CodexRpcClient, method: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.off('notification', onNotification);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    const onNotification = (message: { method?: string; params?: unknown }): void => {
      if (message.method !== method) return;
      clearTimeout(timeout);
      client.off('notification', onNotification);
      resolve(message.params);
    };
    client.on('notification', onNotification);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function directoryContains(root: string, needle: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (await directoryContains(target, needle)) return true;
    } else if ((await readFile(target)).includes(Buffer.from(needle))) {
      return true;
    }
  }
  return false;
}

async function verifyBasicAppServer(): Promise<void> {
  const binary = resolveCodexBinary();
  assert.ok(binary, 'pinned Codex binary missing');
  const { child, isolatedHome } = spawnAppServer(binary, []);
  const client = new CodexRpcClient(child.stdout, child.stdin);
  try {
    await client.request('initialize', {
      clientInfo: { name: 'comate', title: 'Comate', version: '0.4.2' },
      capabilities: null,
    }, 10_000);
    const listed = await client.request<{ data?: unknown[] }>('thread/list', { limit: 1, useStateDbOnly: true });
    assert.ok(Array.isArray(listed.data));
    console.log('Codex app-server initialize + thread/list smoke passed');
  } finally {
    client.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    await rm(isolatedHome, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await verifyBasicAppServer();
}
