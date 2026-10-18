import '../src/server/test-utils/test-env.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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
import { query, type SDKUserMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { resolveSdkBinary } from '../src/server/utils/resolve-sdk-binary.js';
import { PushableIterator } from '../src/server/services/pushable-iterator.js';
import { startManagedMcpHttpFixture } from './fixtures/managed-mcp-http-fixture.js';
import { McpOAuthService } from '../src/server/services/mcp-oauth-service.js';
import { ChatSseToResponses } from '../src/server/services/codex-chat-route/sse-transform.js';
import { transformResponsesRequest } from '../src/server/services/codex-chat-route/request-transform.js';
import { CodexBackendDriver, codexThreadConfig } from '../src/server/services/codex-adapter.js';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { CodexAppServerManager } from '../src/server/services/codex-app-server-manager.js';
import { McpSessionCoordinator } from '../src/server/services/mcp-session-coordinator.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

async function verify(transport: 'stdio' | 'http-public' | 'http' | 'sse' | 'oauth') {
console.log(`Verifying managed MCP transport: ${transport}`);
const store = new SqliteStore(':memory:');
const config = new McpConfigService(store);
const oauth = new McpOAuthService(config);
const remote = transport === 'stdio' ? undefined : await startManagedMcpHttpFixture({ oauth: transport === 'oauth' });
const workspace = await store.create({ name: 'managed-proof', folderPath: process.cwd() });
const fixture = remote ? { type: transport === 'sse' ? 'sse' as const : 'http' as const,
  url: `${remote.base}/${transport === 'sse' ? 'sse' : 'http'}`,
  ...(transport === 'oauth' ? { oauth: { clientId: 'fixture-client' } } : transport === 'http-public' ? {} : { headers: { Authorization: 'Bearer fixture-manual-secret' } }),
} : { type: 'stdio' as const, command: process.execPath,
  args: ['--import', path.resolve('node_modules/tsx/dist/loader.mjs'), path.resolve('scripts/fixtures/managed-mcp-fixture.ts')],
  env: { MCP_FIXTURE_TRACE: path.join(process.env.COMATE_DATA_DIR!, 'native-boundary.jsonl'), MCP_FIXTURE_VERSION: 'initial' } };
const firstRecord = await config.save({ scope: 'global', name: 'first', enabled: true, connection: fixture });
if (transport === 'oauth') {
  const operation = await oauth.start(firstRecord.id);
  assert.equal((await fetch(operation.authorizationUrl!)).status, 200);
  assert.equal(oauth.status(operation.id).state, 'authorized');
}
const gateway = new ManagedMcpGateway(config);
gateway.authProvider = record => oauth.provider(record);
const context = await gateway.register({ sessionId: 'native-proof', workspaceId: workspace.id,
  directory: process.cwd(), generation: 'proof', backend: 'codex' });
context.authorizeTool = async (_name, input) => input;
const app = express();
app.use('/mcp/managed', gateway.router(token => token === 'native-proof-token'));
app.use(express.json({ limit: '10mb' }));
const modelInventories: string[][] = [];
let callDelay = 0;
let callMessage = '';
let claudeReply = 0;
const verifyBoundaries = async (invoke: () => Promise<void>, refresh: (expected: Tool[]) => Promise<void>) => {
  if (transport !== 'stdio') return;
  const coordinator = new McpSessionCoordinator(config, gateway);
  context.refreshInventory = refresh;
  try {
    for (const action of ['modify', 'disable', 'delete'] as const) {
      const record = store.mcp.list('global').find(record => record.name === 'first')!;
      const message = `${context.backend}-${action}-old-call`;
      callDelay = 700; callMessage = message;
      const running = invoke();
      void running.catch(() => undefined);
      const deadline = Date.now() + 15_000;
      while (!context.leases.get(record.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(context.leases.get(record.id), 1, `${context.backend}: native long call did not dispatch`);
      let failRefresh = action === 'modify';
      context.refreshInventory = async expected => {
        if (failRefresh) { failRefresh = false; throw new Error('Controlled native inventory failure'); }
        await refresh(expected);
      };
      if (action === 'delete') await config.delete(record.id, record.revision);
      else await config.save({ id: record.id, expectedRevision: record.revision, scope: 'global', name: 'first', enabled: action !== 'disable',
        ...(action === 'modify' ? { connection: { ...fixture, env: { ...fixture.env, MCP_FIXTURE_VERSION: 'modified' } } } : {}) });
      assert.equal(coordinator.status(context.sessionId).find(status => status.name === 'first')?.state, 'pending');
      assert.equal(context.records.get(record.id)?.revision, record.revision);
      await running;
      callDelay = 0; callMessage = '';
      await coordinator.settled(context.sessionId);
      if (action === 'modify') {
        assert.equal(coordinator.status(context.sessionId).find(status => status.name === 'first')?.state, 'failed');
        coordinator.retry(context.sessionId);
        await coordinator.settled(context.sessionId);
      }
      assert.equal(coordinator.status(context.sessionId).find(status => status.name === 'first')?.state, 'applied');
      const events = (await readFile(fixture.env!.MCP_FIXTURE_TRACE, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(events.filter(event => event.message === message && event.stage === 'start').length, 1);
      assert.equal(events.filter(event => event.message === message && event.stage === 'done').length, 1);
      assert.equal(events.find(event => event.message === message)?.version, action === 'disable' ? 'modified' : 'initial');
      if (action !== 'modify') {
        assert.ok(!context.records.has(record.id));
        const latest = store.mcp.get(record.id);
        await config.save({ ...(latest ? { id: latest.id, expectedRevision: latest.revision } : {}), scope: 'global', name: 'first', enabled: true, connection: fixture });
        await coordinator.settled(context.sessionId);
        assert.equal(coordinator.status(context.sessionId).find(status => status.name === 'first')?.state, 'applied');
      }
      console.log(`${context.backend} native long-call ${action}, receipt and no replay: passed`);
    }
  } finally { callDelay = 0; callMessage = ''; coordinator.dispose(); context.refreshInventory = undefined; }
};
app.post('/v1/responses', (req, res) => {
  const converted = transformResponsesRequest({ ...req.body,
    tools: req.body.tools.filter((tool: { name?: string }) => tool.name === 'mcp__comate_managed'),
  }, { providerId: 'proof', credential: 'fixture', sessionId: context.sessionId });
  const offered = converted.body.tools as Array<{ function: { name: string } }>;
  const discover = offered.find(tool => tool.function.name.endsWith('__discover'))?.function.name;
  const invoke = offered.find(tool => tool.function.name.endsWith('__invoke'))?.function.name;
  assert.ok(discover && invoke);
  const items = converted.body.messages as Array<{ role?: string; content?: string }>;
  const lastUser = items.findLastIndex(item => item.role === 'user');
  const outputs = items.slice(lastUser + 1).filter(item => item.role === 'tool');
  if (outputs.length === 2) assert.ok(outputs[1].content?.includes(callMessage || 'codex-model-proof'), 'Codex model invocation did not reach the upstream tool');
  let toolCall: { name: string; arguments: string; id: string } | undefined;
  if (outputs.length === 0) toolCall = { name: discover, arguments: '{}', id: `discover_${Date.now()}` };
  else if (outputs.length === 1) {
    const output = outputs[0].content!;
    const result = JSON.parse(output.slice(output.search(/[[{]/), Math.max(output.lastIndexOf('}'), output.lastIndexOf(']')) + 1));
    const catalog = result.tools ? result : result.structuredContent ?? JSON.parse((Array.isArray(result) ? result : result.content)[0].text);
    modelInventories.push(catalog.tools.map((tool: { name: string }) => tool.name));
    const selected = catalog.tools.find((tool: Tool) => tool.description?.startsWith('first /')) ?? catalog.tools[0];
    toolCall = { name: invoke, arguments: JSON.stringify({ tool: selected.name, arguments: { message: callMessage || 'codex-model-proof', delay: callDelay } }), id: `invoke_${Date.now()}` };
  }
  const converter = new ChatSseToResponses({ responseId: `resp_${Date.now()}`, model: 'proof', toolNames: converted.toolNames });
  const delta = toolCall ? { tool_calls: [{ index: 0, id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }] }
    : { role: 'assistant', content: 'proof complete' };
  const chunk = { id: 'proof', model: 'proof', choices: [{ index: 0, delta, finish_reason: toolCall ? 'tool_calls' : 'stop' }] };
  res.setHeader('Content-Type', 'text/event-stream');
  for (const frame of converter.push(Buffer.from(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`))) res.write(frame);
  for (const frame of converter.finish()) res.write(frame);
  res.end();
});
app.post('/v1/chat/completions', (req, res) => {
  const tools = (req.body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name)
    .filter((name: string) => name.startsWith('comate-managed_'));
  if (tools.length) modelInventories.push(tools);
  const done = !tools.length || req.body.messages.at(-1)?.role === 'tool';
  if (tools.length && done) assert.ok(JSON.stringify(req.body.messages.at(-1)).includes(callMessage || 'opencode-native-proof'), 'OpenCode model invocation did not reach the upstream tool');
  const selected = (req.body.tools ?? []).find((tool: { function: { description?: string } }) => tool.function.description?.startsWith('first /'))?.function.name ?? tools[0];
  res.setHeader('Content-Type', 'text/event-stream');
  const delta = done ? { content: 'proof complete' } : { tool_calls: [{ index: 0, id: 'proof-call', type: 'function',
    function: { name: selected, arguments: JSON.stringify({ message: callMessage || 'opencode-native-proof', delay: callDelay }) } }] };
  res.write(`data: ${JSON.stringify({ id: 'proof', object: 'chat.completion.chunk', created: 1, model: 'proof', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: 'proof', object: 'chat.completion.chunk', created: 1, model: 'proof', choices: [{ index: 0, delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});
app.post('/v1/messages', (req, res) => {
  const tools = (req.body.tools ?? []).map((tool: { name: string }) => tool.name).filter((name: string) => name.startsWith('mcp__comate-managed__'));
  if (tools.length) modelInventories.push(tools);
  const last = req.body.messages.at(-1);
  const selected = (req.body.tools ?? []).find((tool: Tool) => tool.description?.startsWith('first /'))?.name ?? tools[0];
  const content = Array.isArray(last?.content) ? last.content as Array<{ type: string; text?: string }> : [];
  const lastTool = content.findLastIndex(block => block.type === 'tool_result');
  const lastPrompt = content.findLastIndex(block => block.type === 'text' && Boolean(block.text?.startsWith('Use the ')));
  const done = !tools.length || lastTool > lastPrompt;
  if (tools.length && done) assert.ok(JSON.stringify(last.content).includes(callMessage || 'claude-native-proof'), 'Claude model invocation did not reach the upstream tool');
  res.setHeader('Content-Type', 'text/event-stream');
  const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const reply = ++claudeReply;
  event('message_start', { message: { id: `msg_proof_${reply}`, type: 'message', role: 'assistant', content: [], model: 'claude-proof', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  event('content_block_start', { index: 0, content_block: done ? { type: 'text', text: '' } : { type: 'tool_use', id: `toolu_proof_${reply}`, name: selected, input: {} } });
  event('content_block_delta', { index: 0, delta: done ? { type: 'text_delta', text: 'proof complete' } : { type: 'input_json_delta', partial_json: JSON.stringify({ message: callMessage || 'claude-native-proof', delay: callDelay }) } });
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
  rpc.notify('initialized');
  const started = await rpc.request<{ thread: { id: string } }>('thread/start', {
    cwd: isolated, approvalPolicy: 'never', sandbox: 'read-only',
    modelProvider: 'proof', model: 'proof',
    config: { model_providers: { proof: { name: 'proof', wire_api: 'responses', base_url: `${base}/v1`, requires_openai_auth: false } },
      ...codexThreadConfig({ mcpServers: { 'comate-managed': { type: 'http', url } } } as Options) },
  });
  const threadId = started.thread.id;
  const codexPrompt = async () => {
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { rpc.off('notification', onNotification); reject(new Error('Codex proof turn timed out')); }, 15_000);
      const onNotification = (event: { method?: string; params?: { threadId?: string; turn?: { status?: string } } }) => {
        if (event.method !== 'turn/completed' || event.params?.threadId !== threadId) return;
        clearTimeout(timer); rpc.off('notification', onNotification);
        if (event.params?.turn?.status !== 'completed') reject(new Error('Codex proof turn failed'));
        else resolve();
      };
      rpc.on('notification', onNotification);
    });
    await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: callMessage || 'MCP inventory proof', text_elements: [] }] });
    await completed;
  };
  const list = async () => rpc.request<{ data: Array<{ name: string; tools: Record<string, { name: string }> }> }>('mcpServerStatus/list', { threadId });
  const first = await list();
  assert.deepEqual(Object.keys(first.data.find(item => item.name === 'comate-managed')!.tools).sort(), ['discover', 'invoke']);
  const discovered = await rpc.request<{ structuredContent: { tools: Array<{ name: string }> } }>('mcpServer/tool/call', { threadId, server: 'comate-managed', tool: 'discover', arguments: {} });
  const tool = discovered.structuredContent.tools[0].name;
  const called = await rpc.request('mcpServer/tool/call', { threadId, server: 'comate-managed', tool: 'invoke', arguments: { tool, arguments: { message: 'native-proof' } } });
  assert.ok(JSON.stringify(called).includes('native-proof'));
  await codexPrompt();
  assert.equal(modelInventories.at(-1)?.length, 1);
  const added = await config.save({ scope: 'global', name: 'second', enabled: true, connection: fixture });
  if (transport === 'oauth') {
    const operation = await oauth.start(added.id);
    assert.equal((await fetch(operation.authorizationUrl!)).status, 200);
  }
  context.records.set(added.id, store.mcp.get(added.id)!);
  await gateway.notify(context);
  await new Promise(resolve => setTimeout(resolve, 250));
  await codexPrompt();
  assert.equal(modelInventories.at(-1)?.length, 2);
  console.log('Codex model inventory addition: passed');
  console.log('Codex live discovery, model tool execution and addition: passed');
  const verifier = new CodexBackendDriver({ directory: isolated, backendSessionId: threadId, onBackendSessionId: () => {},
    manager: { request: rpc.request.bind(rpc) } as CodexAppServerManager });
  await verifier.verifyManagedMcpInventory((await gateway.listTools(context.sessionId)).map(tool => tool.name));
  await verifyBoundaries(codexPrompt, async expected => verifier.verifyManagedMcpInventory(expected.map(tool => tool.name)));
  const opencode = new OpencodeServerManager();
  context.backend = 'opencode';
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
    await config.save({ id: added.id, expectedRevision: store.mcp.get(added.id)!.revision,
      scope: 'global', name: 'second', enabled: false });
    context.records.delete(added.id);
    await gateway.notify(context);
    await new Promise(resolve => setTimeout(resolve, 150));
    await prompt();
    assert.equal(modelInventories.at(-1)?.length, 1);
    await gateway.confirmInventory(context.sessionId, await gateway.listTools(context.sessionId));
    console.log('OpenCode model inventory + real tool execution + removal: passed');
    await verifyBoundaries(prompt, async expected => {
      assert.equal((await (await opencodeFetch(instance, '/mcp')).json())['comate-managed'].status, 'connected');
      await gateway.confirmInventory(context.sessionId, expected);
    });
  } finally { await opencode.stopAll(); }
  const input = new PushableIterator<SDKUserMessage>();
  context.backend = 'claude';
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 60_000);
  const claude = query({ prompt: input, options: {
    abortController: abort, permissionMode: 'default',
    cwd: isolated, pathToClaudeCodeExecutable: resolveSdkBinary(), settingSources: [], strictMcpConfig: true,
    env: { ...process.env, HOME: isolated, CLAUDE_CONFIG_DIR: path.join(isolated, 'claude'),
      ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_AUTH_TOKEN: 'fixture-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_SKIP_MODEL_VALIDATION: '1' },
    model: 'claude-sonnet-4-6', mcpServers: { 'comate-managed': { type: 'http', url, headers: { Authorization: 'Bearer native-proof-token' } } },
    canUseTool: async (_name, args) => ({ behavior: 'allow', updatedInput: args }),
  } });
  const results = new PushableIterator<SDKResultMessage>();
  const resultMessages = results[Symbol.asyncIterator]();
  let pumpError: unknown;
  const pump = (async () => {
    try { for await (const message of claude) if (message.type === 'result') results.push(message); }
    catch (error) { pumpError = error; }
    finally { results.close(); }
  })();
  const claudePrompt = async () => {
    input.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'Use the first MCP service echo tool.' } });
    const next = await resultMessages.next();
    assert.ok(!next.done, String(pumpError ?? 'Claude proof ended before a result'));
    assert.ok(!next.value.is_error, JSON.stringify(next.value));
  };
  try {
    await claudePrompt();
    assert.equal(modelInventories.at(-1)?.length, 1);
    console.log('Claude model inventory + real tool execution: passed');
    await config.save({ id: added.id, expectedRevision: store.mcp.get(added.id)!.revision,
      scope: 'global', name: 'second', enabled: true });
    context.records.set(added.id, store.mcp.get(added.id)!);
    await gateway.notify(context);
    const changedDeadline = Date.now() + 15_000;
    let count = 0;
    while (Date.now() < changedDeadline) {
      count = (await claude.mcpServerStatus()).find(server => server.name === 'comate-managed')?.tools?.length ?? 0;
      if (count === 2) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(count, 2);
    await gateway.confirmInventory(context.sessionId, await gateway.listTools(context.sessionId));
    console.log('Claude live inventory addition: passed');
    await verifyBoundaries(claudePrompt, async expected => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const status = await claude.mcpServerStatus();
        if (status.find(server => server.name === 'comate-managed')?.tools?.length === expected.length) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await gateway.confirmInventory(context.sessionId, expected);
    });
  } finally { clearTimeout(deadline); input.close(); claude.close(); await pump; }
  const checkHistory = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await checkHistory(file);
      else {
        const bytes = await readFile(file);
        for (const secret of ['fixture-manual-secret', 'fixture-oauth-access-secret', 'fixture-oauth-refresh-secret']) {
          assert.ok(!bytes.includes(Buffer.from(secret)), `Upstream credential found in backend history: ${entry.name}`);
        }
      }
    }
  };
  await checkHistory(isolated);
  await checkHistory(process.env.COMATE_DATA_DIR!);
} finally {
  rpc.close();
  child.kill();
  if (child.exitCode === null) await once(child, 'exit');
  await gateway.close(context.sessionId);
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  oauth.dispose();
  await remote?.close();
  await rm(isolated, { force: true, recursive: true });
}
}

for (const transport of ['stdio', 'http-public', 'http', 'sse', 'oauth'] as const) await verify(transport);
