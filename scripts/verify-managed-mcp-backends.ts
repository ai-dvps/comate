import '../src/server/test-utils/test-env.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';
import { SqliteStore } from '../src/server/storage/sqlite-store.js';
import { McpConfigService } from '../src/server/services/mcp-config-service.js';
import { ManagedMcpGateway, MANAGED_MCP_AUTH_ENV } from '../src/server/services/managed-mcp-gateway.js';
import { resolveCodexBinary } from '../src/server/utils/resolve-codex-binary.js';
import { CodexRpcClient } from '../src/server/services/codex-rpc-client.js';
import { OpencodeServerManager, opencodeFetch } from '../src/server/services/opencode-server-manager.js';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { resolveSdkBinary } from '../src/server/utils/resolve-sdk-binary.js';
import { PushableIterator } from '../src/server/services/pushable-iterator.js';

const store = new SqliteStore(':memory:');
const config = new McpConfigService(store);
const workspace = await store.create({ name: 'managed-proof', folderPath: process.cwd() });
const fixture = { type: 'stdio' as const, command: process.execPath,
  args: ['--import', path.resolve('node_modules/tsx/dist/loader.mjs'), path.resolve('scripts/fixtures/managed-mcp-fixture.ts')] };
await config.save({ scope: 'global', name: 'first', enabled: true, connection: fixture });
const gateway = new ManagedMcpGateway(config);
const context = await gateway.register({ sessionId: 'native-proof', workspaceId: workspace.id,
  directory: process.cwd(), generation: 'proof', backend: 'codex' });
context.authorizeTool = async (_name, input) => input;
const app = express();
app.use('/mcp/managed', gateway.router(token => token === 'native-proof-token'));
app.use(express.json({ limit: '10mb' }));
const modelInventories: string[][] = [];
app.post('/v1/chat/completions', (req, res) => {
  const tools = (req.body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name)
    .filter((name: string) => name.startsWith('comate-managed_'));
  modelInventories.push(tools);
  const done = req.body.messages.at(-1)?.role === 'tool';
  res.setHeader('Content-Type', 'text/event-stream');
  const delta = done ? { content: 'proof complete' } : { tool_calls: [{ index: 0, id: 'proof-call', type: 'function',
    function: { name: tools[0], arguments: JSON.stringify({ message: 'opencode-native-proof' }) } }] };
  res.write(`data: ${JSON.stringify({ id: 'proof', object: 'chat.completion.chunk', created: 1, model: 'proof', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: 'proof', object: 'chat.completion.chunk', created: 1, model: 'proof', choices: [{ index: 0, delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});
app.post('/v1/messages', (req, res) => {
  const tools = (req.body.tools ?? []).map((tool: { name: string }) => tool.name).filter((name: string) => name.startsWith('mcp__comate-managed__'));
  modelInventories.push(tools);
  const last = req.body.messages.at(-1);
  const done = last?.content?.some?.((content: { type: string }) => content.type === 'tool_result');
  res.setHeader('Content-Type', 'text/event-stream');
  const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', { message: { id: 'msg_proof', type: 'message', role: 'assistant', content: [], model: 'claude-proof', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  event('content_block_start', { index: 0, content_block: done ? { type: 'text', text: '' } : { type: 'tool_use', id: 'toolu_proof', name: tools[0], input: {} } });
  event('content_block_delta', { index: 0, delta: done ? { type: 'text_delta', text: 'proof complete' } : { type: 'input_json_delta', partial_json: JSON.stringify({ message: 'claude-native-proof' }) } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: done ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } });
  event('message_stop', {});
  res.end();
});
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp/managed/native-proof`;
const base = new URL(url).origin;
const isolated = await mkdtemp(path.join(tmpdir(), 'comate-mcp-native-'));
const child = spawn(resolveCodexBinary()!, ['app-server'], { env: { ...process.env, CODEX_HOME: isolated,
  [MANAGED_MCP_AUTH_ENV]: 'Bearer native-proof-token' }, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.resume();
const rpc = new CodexRpcClient(child.stdout, child.stdin);
try {
  await rpc.request('initialize', { clientInfo: { name: 'managed-proof', version: '1' }, capabilities: { experimentalApi: true } });
  const started = await rpc.request<{ thread: { id: string } }>('thread/start', {
    cwd: isolated, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
    config: { mcp_servers: { 'comate-managed': { url, env_http_headers: { Authorization: MANAGED_MCP_AUTH_ENV } } } },
  });
  const threadId = started.thread.id;
  const list = async () => rpc.request<{ data: Array<{ name: string; tools: Record<string, { name: string }> }> }>('mcpServerStatus/list', { threadId });
  const first = await list();
  console.log('Codex initial tool counts:', first.data.map(item => [item.name, Object.keys(item.tools).length]));
  const tool = Object.values(first.data.find(item => item.name === 'comate-managed')!.tools)[0].name;
  const called = await rpc.request('mcpServer/tool/call', { threadId, server: 'comate-managed', tool, arguments: { message: 'native-proof' } });
  assert.ok(JSON.stringify(called).includes('native-proof'));
  const added = await config.save({ scope: 'global', name: 'second', enabled: true, connection: fixture });
  context.records.set(added.id, store.mcp.get(added.id)!);
  await gateway.notify(context);
  await new Promise(resolve => setTimeout(resolve, 250));
  console.log('Codex after notification:', (await list()).data.map(item => [item.name, Object.keys(item.tools).length]));
  await rpc.request('config/mcpServer/reload', undefined);
  console.log('Codex after reload:', (await list()).data.map(item => [item.name, Object.keys(item.tools).length]));
  const opencode = new OpencodeServerManager();
  try {
    const instance = await opencode.ensureServer('managed-proof', isolated, {
      env: { ...process.env, HOME: isolated, [MANAGED_MCP_AUTH_ENV]: 'Bearer native-proof-token' },
      config: { mcp: { 'comate-managed': { type: 'remote', url, oauth: false,
        headers: { Authorization: `{env:${MANAGED_MCP_AUTH_ENV}}` } } },
        permission: 'allow', model: 'proof/proof',
        provider: { proof: { npm: '@ai-sdk/openai-compatible', name: 'proof', options: { baseURL: `${base}/v1`, apiKey: 'fixture' }, models: { proof: { name: 'proof' } } } },
      },
    });
    console.log('OpenCode status:', await (await opencodeFetch(instance, '/mcp')).json());
    const session = await (await opencodeFetch(instance, '/session', { method: 'POST', body: '{}' })).json();
    const prompt = async () => {
      const response = await opencodeFetch(instance, `/session/${session.id}/message`, {
        method: 'POST', body: JSON.stringify({ model: { providerID: 'proof', modelID: 'proof' }, parts: [{ type: 'text', text: 'Use the MCP echo tool.' }] }),
      });
      assert.equal(response.status, 200);
      assert.ok(JSON.stringify(await response.json()).includes('proof complete'));
    };
    await prompt();
    assert.equal(modelInventories.at(-1)?.length, 2);
    context.records.delete(added.id);
    await gateway.notify(context);
    await new Promise(resolve => setTimeout(resolve, 150));
    await prompt();
    assert.equal(modelInventories.at(-1)?.length, 1);
    console.log('OpenCode model inventory + real tool execution + removal: passed');
  } finally { await opencode.stopAll(); }
  const input = new PushableIterator<SDKUserMessage>();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 20_000);
  const claude = query({ prompt: input, options: {
    abortController: abort,
    stderr: text => process.stderr.write(text.slice(0, 500)),
    cwd: isolated, pathToClaudeCodeExecutable: resolveSdkBinary(), settingSources: [], strictMcpConfig: true,
    env: { ...process.env, HOME: isolated, CLAUDE_CONFIG_DIR: path.join(isolated, 'claude'),
      ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_AUTH_TOKEN: 'fixture-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_SKIP_MODEL_VALIDATION: '1' },
    model: 'claude-sonnet-4-6', mcpServers: { 'comate-managed': { type: 'http', url, headers: { Authorization: 'Bearer native-proof-token' } } },
    canUseTool: async (_name, args) => ({ behavior: 'allow', updatedInput: args }),
  } });
  try {
    input.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'Use the MCP echo tool.' } });
    const messages = claude[Symbol.asyncIterator]();
    let completed = false;
    while (!abort.signal.aborted) {
      const next = await messages.next();
      assert.ok(!next.done);
      if (next.value.type === 'result') { assert.ok(!next.value.is_error, JSON.stringify(next.value)); completed = true; break; }
    }
    assert.ok(completed);
    assert.equal(modelInventories.at(-1)?.length, 1);
    console.log('Claude model inventory + real tool execution: passed');
    context.records.set(added.id, store.mcp.get(added.id)!);
    await gateway.notify(context);
    await new Promise(resolve => setTimeout(resolve, 150));
    const status = await claude.mcpServerStatus();
    assert.equal(status.find(server => server.name === 'comate-managed')?.tools?.length, 2);
    console.log('Claude live inventory addition: passed');
  } finally { clearTimeout(deadline); input.close(); claude.close(); }
} finally {
  rpc.close();
  child.kill();
  if (child.exitCode === null) await once(child, 'exit');
  await gateway.close(context.sessionId);
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  await rm(isolated, { force: true, recursive: true });
}
