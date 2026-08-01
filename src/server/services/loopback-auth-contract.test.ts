import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { createLoopbackAuthMiddleware, requireSessionAuth } from './security/loopback-auth.js';

/**
 * V10 loopback-auth contract (U12, KTD-28) — a REAL sandboxed CLI session
 * probing a REAL authenticated /api surface, driven through the U4 mock-API
 * harness pattern (scripted Anthropic API → real CLI permission pipeline →
 * sandboxed bash). Two servers participate:
 *
 *  1. The scripted mock Anthropic API (as in sdk-rule-contract.test.ts).
 *  2. An express app with the production loopback-auth middleware, an
 *     enrolled session route (wecom/send, wecom-user) and a non-enrolled
 *     route (files/content).
 *
 * Empirical findings pinned here (macOS seatbelt, sandbox ACTIVE):
 *  - The sandbox injects NO_PROXY=localhost,127.0.0.1,… and blocks direct
 *    outbound at the OS layer: a tokenless DIRECT curl to the sidecar never
 *    reaches the middleware (connection refused). Auth is the second wall —
 *    the sandbox network layer is the first.
 *  - Through the sandbox proxy (--noproxy '' forces proxy use), the HTTP
 *    matrix is exact: tokenless → 401, session token on the enrolled route
 *    → 200, session token off the enrolled set → 403.
 *  - The REAL bundled wecom CLI (node:http — learns the proxy from the
 *    sandbox env) completes an authenticated current-user round-trip
 *    end-to-end, proving COMATE_SESSION_TOKEN + COMATE_WECOM_CONTEXT_FILE
 *    are visible to the session's own sandboxed commands.
 *  - A planted .claude/wecom-context.json in the cwd does NOT redirect the
 *    CLI (upward-walk discovery is gone), and a provider secret stays swept
 *    from sandboxed commands (V7-style cross-check).
 *
 * Portability: failIfUnavailable=false. Where no sandbox engages, direct
 * curls reach the middleware (401 instead of connection-refused) — the
 * assertions accept exactly these two shapes and nothing else.
 */

// ---------------------------------------------------------------------------
// Scripted mock Anthropic API (same shape as sdk-rule-contract.test.ts)
// ---------------------------------------------------------------------------

type ScriptedTurn = { toolUse: { name: string; input: Record<string, unknown> } } | { text: string };

function toolUse(command: string): ScriptedTurn {
  return { toolUse: { name: 'Bash', input: { command } } };
}

const END_TURN: ScriptedTurn = { text: 'done' };

function sseForToolUse(id: string, name: string, input: Record<string, unknown>): string {
  const payload = JSON.stringify(input);
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'probe-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: payload } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ].join('');
}

function sseForText(text: string): string {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', model: 'probe-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ].join('');
}

async function startMockAnthropic(turns: ScriptedTurn[]): Promise<{ url: string; close: () => Promise<void> }> {
  const script = [...turns, END_TURN];
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url?.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      if (req.method === 'POST' && req.url?.startsWith('/v1/messages')) {
        if (body.includes('Write the title in the predominant language')) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.end(sseForText('Probe Session'));
          return;
        }
        const step = script[Math.min(requestCount, script.length - 1)];
        requestCount += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end('toolUse' in step ? sseForToolUse(`toolu_${requestCount}`, step.toolUse.name, step.toolUse.input) : sseForText(step.text));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Authenticated probe app (production middleware, probe routes)
// ---------------------------------------------------------------------------

const PROBE_SESSION_TOKEN = 'probe-session-token-0123456789abcdef0123456789abcdef';

async function startProbeApi(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(
    createLoopbackAuthMiddleware({
      getDesktopToken: () => 'probe-desktop-token',
      resolveSessionToken: (token) =>
        token === PROBE_SESSION_TOKEN
          ? { sessionId: 'sess-1', workspaceId: 'ws-1', botId: 'bot-1' }
          : null,
    }),
  );
  app.post('/api/workspaces/:workspaceId/wecom/send', (req, res) => {
    const auth = requireSessionAuth(req, res);
    if (!auth) return;
    res.json({ ok: true, sessionId: auth.sessionId });
  });
  app.get('/api/workspaces/:id/sessions/:sessionId/wecom-user', (_req, res) => {
    res.json({ userId: 'alice' });
  });
  app.get('/api/workspaces/:id/files/content', (_req, res) => {
    res.json({ ok: true });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

const CLI_DIST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/wecom-cli/dist/index.js',
);

interface CommandResult {
  command: string;
  snippet: string;
}

describe('loopback-auth contract (V10: real sandboxed CLI vs authenticated /api)', { concurrency: false }, () => {
  it('tokenless loopback fails; session token passes the enrolled set; the bundled CLI works end-to-end', { timeout: 240000 }, async () => {
    assert.ok(fs.existsSync(CLI_DIST), `wecom CLI must be built first (packages/wecom-cli): ${CLI_DIST}`);
    const api = await startProbeApi();
    const base = api.url;
    const results: CommandResult[] = [];

    const commands: Array<{ command: string; expect: (snippet: string) => boolean; why: string }> = [
      {
        // Direct, tokenless: sandbox-blocked (000/exit 7) or middleware 401.
        command: `curl -s -o /dev/null -w '%{http_code}' -X POST ${base}/api/workspaces/ws-1/wecom/send`,
        expect: (s) => s === '401' || s.includes('000'),
        why: 'tokenless loopback must fail (sandbox wall or 401)',
      },
      {
        // Through the sandbox proxy, tokenless → deterministic 401.
        command: `curl -s -o /dev/null -w '%{http_code}' --noproxy '' -X POST ${base}/api/workspaces/ws-1/wecom/send`,
        expect: (s) => s === '401',
        why: 'tokenless through the proxy must be rejected by the middleware',
      },
      {
        // Through the proxy with the session token, enrolled route → 200.
        command: `curl -s -o /dev/null -w '%{http_code}' --noproxy '' -X POST -H "Authorization: Bearer $COMATE_SESSION_TOKEN" ${base}/api/workspaces/ws-1/wecom/send`,
        expect: (s) => s === '200',
        why: 'session token must pass the enrolled route',
      },
      {
        // Session token OFF the enrolled set → 403.
        command: `curl -s -o /dev/null -w '%{http_code}' --noproxy '' -H "Authorization: Bearer $COMATE_SESSION_TOKEN" ${base}/api/workspaces/ws-1/files/content`,
        expect: (s) => s === '403',
        why: 'session token outside the enrolled set must be rejected',
      },
      {
        // The REAL bundled CLI: env-var context + token + sandbox proxy →
        // authenticated current-user round-trip.
        command: `node ${JSON.stringify(CLI_DIST)} current-user --session-id sess-1`,
        expect: (s) => s.trim() === 'alice',
        why: 'the bundled CLI must complete an authenticated round-trip inside the sandbox',
      },
      {
        // Planted legacy context: with the env var removed, the CLI must NOT
        // discover the planted .claude/wecom-context.json (upward walk gone).
        command: `env -u COMATE_WECOM_CONTEXT_FILE node ${JSON.stringify(CLI_DIST)} current-user --session-id sess-1; echo "exit:$?"`,
        expect: (s) => s.includes('exit:2'),
        why: 'a planted .claude/wecom-context.json must not redirect the CLI',
      },
      {
        // Token env visible to the session's own sandboxed commands.
        command: `printenv COMATE_SESSION_TOKEN | wc -c`,
        expect: (s) => s.trim() === String(PROBE_SESSION_TOKEN.length + 1),
        why: 'the session token must stay visible inside its own sandbox',
      },
      {
        // Provider secret swept (V7-style cross-check).
        command: `printenv ANTHROPIC_API_KEY | wc -c`,
        expect: (s) => s.trim() === '0',
        why: 'provider secrets must be swept from sandboxed commands',
      },
    ];

    const anthropic = await startMockAnthropic(commands.map((c) => toolUse(c.command)));

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loopback-auth-contract-'));
    const cwd = path.join(root, 'ws');
    const home = path.join(root, 'home');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(home, { recursive: true });

    // Per-session context file (as chat-service writes it) + a PLANTED legacy
    // file that must lose.
    const runtimeDir = path.join(cwd, 'data', 'me', '.runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const contextPath = path.join(runtimeDir, 'wecom-context.json');
    fs.writeFileSync(contextPath, JSON.stringify({ workspaceId: 'ws-1', botId: 'bot-1', serverUrl: base }));
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.claude', 'wecom-context.json'),
      JSON.stringify({ workspaceId: 'planted', botId: 'planted', serverUrl: 'http://127.0.0.1:1' }),
    );

    const queryOptions: Options = {
      model: 'probe-model',
      cwd,
      settingSources: [],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        ANTHROPIC_API_KEY: 'sk-ant-contract-probe-000000000000000000000',
        ANTHROPIC_BASE_URL: anthropic.url,
        COMATE_SESSION_TOKEN: PROBE_SESSION_TOKEN,
        COMATE_WECOM_CONTEXT_FILE: contextPath,
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
        NO_COLOR: '1',
      },
      sandbox: {
        enabled: true,
        // Degrade-tolerant (same posture as U4): hosts without a sandbox
        // still exercise the middleware; the env assertions are meaningful
        // wherever the sandbox engages.
        failIfUnavailable: false,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: true,
        network: { allowedDomains: ['127.0.0.1', 'localhost'], strictAllowlist: true },
        credentials: { envVars: [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }] },
      },
      canUseTool: async () => ({ behavior: 'allow' as const, updatedInput: {} }),
    };

    const q = query({ prompt: 'run the probe commands', options: queryOptions });
    try {
      let pendingCommand: string | null = null;
      for await (const msg of q) {
        if (msg.type === 'assistant') {
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'tool_use') {
              pendingCommand = typeof (block.input as Record<string, unknown>).command === 'string'
                ? (block.input as Record<string, string>).command
                : null;
            }
          }
        } else if (msg.type === 'user') {
          const content = msg.message?.content;
          for (const block of Array.isArray(content) ? content : []) {
            if (block.type === 'tool_result' && pendingCommand) {
              const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
              results.push({ command: pendingCommand, snippet: (text ?? '').trim().slice(0, 300) });
              pendingCommand = null;
            }
          }
        }
      }
    } finally {
      try {
        q.close();
      } catch {
        // already torn down
      }
      await anthropic.close();
      await api.close();
      fs.rmSync(root, { recursive: true, force: true });
    }

    for (const { command, expect, why } of commands) {
      const result = results.find((r) => r.command === command);
      assert.ok(result, `missing result for: ${command}; got=${JSON.stringify(results)}`);
      assert.ok(
        expect(result.snippet),
        `${why}\ncommand: ${command}\nunexpected output: ${JSON.stringify(result.snippet)}`,
      );
    }
  });
});
