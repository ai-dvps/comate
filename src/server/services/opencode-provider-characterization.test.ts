import '../test-utils/test-env.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EffectiveProviderConfiguration } from './provider-resolver.js';
import { OpencodeBackendDriver } from './opencode-adapter.js';
import { opencodeServerManager } from './opencode-server-manager.js';

type Mode = 'direct-anthropic' | 'direct-openai-chat';
type Recording = { path: string; headers: IncomingMessage['headers']; body: Record<string, unknown> };

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 15_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function anthropicStream(res: ServerResponse, body: Record<string, unknown>): void {
  const tools = body.tools as Array<{ name?: string }> | undefined;
  const tool = tools?.find((entry) => entry.name)?.name ?? 'bash';
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg_characterization', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'recorded-text' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_characterization', name: tool, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

function openAiChatStream(res: ServerResponse, body: Record<string, unknown>): void {
  const tools = body.tools as Array<{ function?: { name?: string } }> | undefined;
  const tool = tools?.find((entry) => entry.function?.name)?.function?.name ?? 'bash';
  const chunks = [
    { id: 'chatcmpl_characterization', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { id: 'chatcmpl_characterization', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { content: 'recorded-text' }, finish_reason: null }] },
    { id: 'chatcmpl_characterization', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_characterization', type: 'function', function: { name: tool, arguments: '{}' } }] }, finish_reason: null }] },
    { id: 'chatcmpl_characterization', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end('data: [DONE]\n\n');
}

async function characterize(mode: Mode): Promise<{ recording: Recording; messages: SDKMessage[] }> {
  let resolveRecording!: (value: Recording) => void;
  const recorded = new Promise<Recording>((resolve) => { resolveRecording = resolve; });
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      resolveRecording({ path: req.url ?? '', headers: req.headers, body });
      if (mode === 'direct-anthropic') anthropicStream(res, body);
      else openAiChatStream(res, body);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');
  const sessionKey = `characterization-${mode}-${randomUUID()}`;
  const provider: Extract<EffectiveProviderConfiguration, { available: true }> = {
    available: true,
    providerId: `recording-${mode}`,
    agent: 'opencode',
    mode,
    model: 'characterization-model',
    credential: 'sentinel-characterization',
    baseUrl: `http://127.0.0.1:${address.port}`,
    supportedEfforts: [],
    speedSupported: false,
  };
  const driver = new OpencodeBackendDriver({
    directory: mkdtempSync(join(tmpdir(), 'comate-opencode-characterization-')),
    comateSessionId: sessionKey,
    provider,
    providerName: 'Recording Provider',
    env: process.env,
  });
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content: 'characterize transport' } } as SDKUserMessage;
    await new Promise<void>(() => undefined);
  }
  const options = {
    canUseTool: async () => ({ behavior: 'deny', message: 'characterization stop' }),
  } as unknown as Options;
  const { query, messages } = driver.createStreamingQuery(input(), options);
  const observed: SDKMessage[] = [];
  const consume = (async () => {
    for await (const message of messages) {
      observed.push(message);
      const serialized = JSON.stringify(observed);
      if (serialized.includes('recorded-text') && serialized.includes('tool_use')) return;
    }
  })();
  try {
    const recording = await withTimeout(recorded, `${mode} made no upstream request`);
    await withTimeout(consume, `${mode} stream/tool events were not mapped`);
    return { recording, messages: observed };
  } finally {
    query.close();
    await opencodeServerManager.stopServer(sessionKey);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}

describe('pinned OpenCode 1.18.4 Provider transport characterization', { concurrency: false }, () => {
  for (const mode of ['direct-anthropic', 'direct-openai-chat'] as const) {
    it(`records ${mode} path, auth, payload, streaming text, and tool events`, { timeout: 30_000 }, async () => {
      const { recording, messages } = await characterize(mode);
      assert.equal(recording.body.model, 'characterization-model');
      assert.equal(recording.body.stream, true);
      assert.ok(Array.isArray(recording.body.messages));
      assert.equal(
        recording.body.tools,
        undefined,
        `pinned minimal serve unexpectedly changed its tools field: ${JSON.stringify(recording.body.tools)}`,
      );
      if (mode === 'direct-anthropic') {
        assert.equal(recording.path, '/v1/messages');
        assert.equal(recording.headers['x-api-key'], 'sentinel-characterization');
      } else {
        assert.equal(recording.path, '/chat/completions');
        assert.equal(recording.headers.authorization, 'Bearer sentinel-characterization');
      }
      const serialized = JSON.stringify(messages);
      assert.match(serialized, /recorded-text/);
      assert.match(serialized, /tool_use/);
      assert.doesNotMatch(serialized, /sentinel-characterization/);
    });
  }
});
