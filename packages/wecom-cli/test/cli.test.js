import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = new URL('../dist/index.js', import.meta.url).pathname;
const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

const TEST_TOKEN = 'test-session-token-0123456789abcdef';

function run(args, cwd, env) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      // Hermetic: ambient proxy env would reroute the CLI's transport (U12).
      http_proxy: undefined,
      https_proxy: undefined,
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      ALL_PROXY: undefined,
      all_proxy: undefined,
      // Hermetic: an ambient session token (e.g. a shell launched inside the
      // Comate app exports it) must not satisfy auth in "token unset" cases —
      // `delete` on the override object would let the parent value show
      // through the spread, so neutralize it here before per-test overrides.
      COMATE_SESSION_TOKEN: undefined,
      ...env,
    },
  });
  return result;
}

const MOCK_SERVER_SCRIPT = `
import { createServer } from 'node:http';
const status = parseInt(process.env.MOCK_STATUS || '200', 10);
const body = process.env.MOCK_BODY || '{}';
const expectedUrl = process.env.MOCK_EXPECTED_URL || '';
const expectedAuth = process.env.MOCK_EXPECTED_AUTH || '';
const expectedProxyAuth = process.env.MOCK_EXPECTED_PROXY_AUTH || '';
const server = createServer((req, res) => {
  if (expectedUrl && req.url !== expectedUrl) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('unexpected url: ' + req.url);
    return;
  }
  if (expectedAuth && req.headers.authorization !== expectedAuth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized', got: req.headers.authorization ?? null }));
    return;
  }
  if (expectedProxyAuth && req.headers['proxy-authorization'] !== expectedProxyAuth) {
    res.writeHead(407, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'proxy_auth_required', got: req.headers['proxy-authorization'] ?? null }));
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
});
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  console.log('URL:http://127.0.0.1:' + port);
});
`;

function startMockServer(env) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), 'wecom-mock-server-'));
    const scriptPath = join(dir, 'mock-server.js');
    writeFileSync(scriptPath, MOCK_SERVER_SCRIPT);
    const proc = spawn(process.execPath, [scriptPath], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, ...env },
    });
    let resolved = false;
    let stdoutBuffer = '';
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        reject(new Error('mock server startup timeout'));
      }
    }, 5000);
    proc.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const match = stdoutBuffer.match(/URL:(http:\/\/[^\s]+)/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({
          url: match[1],
          close: () =>
            new Promise((resolveClose) => {
              proc.kill();
              proc.on('exit', () => resolveClose());
            }),
        });
      }
    });
    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
    proc.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`mock server exited early with code ${code}`));
      }
    });
  });
}

/**
 * U12: the CLI context is passed explicitly via COMATE_WECOM_CONTEXT_FILE
 * (the legacy .claude/wecom-context.json upward-walk is gone). This helper
 * writes the per-session context into a `.runtime/` dir and returns the env
 * the session would inject.
 */
function writeContext(cwd, serverUrl, workspaceId = 'w') {
  const runtimeDir = join(cwd, 'data', 'me', '.runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const contextPath = join(runtimeDir, 'wecom-context.json');
  writeFileSync(contextPath, JSON.stringify({ botId: 'b', serverUrl, workspaceId }));
  return { COMATE_WECOM_CONTEXT_FILE: contextPath, COMATE_SESSION_TOKEN: TEST_TOKEN };
}

/** Write ONLY the context file (no token) — for missing-token tests. */
function writeContextWithoutToken(cwd, serverUrl, workspaceId = 'w') {
  const env = writeContext(cwd, serverUrl, workspaceId);
  delete env.COMATE_SESSION_TOKEN;
  return env;
}

/** Plant a legacy-style context file; the new CLI must never read it. */
function plantLegacyContext(cwd, serverUrl = 'http://127.0.0.1:1', workspaceId = 'planted') {
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(
    join(cwd, '.claude/wecom-context.json'),
    JSON.stringify({ botId: 'planted-bot', serverUrl, workspaceId })
  );
}

describe('wecom cli', () => {
  describe('help', () => {
    it('shows help with bin name', () => {
      const result = run(['--help']);
      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes('$ wecom [COMMAND]'));
    });

    it('shows version from package.json', () => {
      const result = run(['--version']);
      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes(packageJson.version));
    });

    it('shows send help', () => {
      const result = run(['send', '--help']);
      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes('--to-user'));
      assert(result.stdout.includes('--message'));
      assert(result.stdout.includes('--session-id'));
      assert(result.stdout.includes('--msg-type'));
    });

    it('shows current-user help', () => {
      const result = run(['current-user', '--help']);
      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes('--session-id'));
    });

    it('lists current-user in top-level help', () => {
      const result = run(['--help']);
      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes('current-user'));
    });

    it('does not show old msg:send command', () => {
      const result = run(['--help']);
      assert.strictEqual(result.status, 0);
      assert(!result.stdout.includes('msg:send'));
    });

    it('does not show old queue:enqueue command', () => {
      const result = run(['--help']);
      assert.strictEqual(result.status, 0);
      assert(!result.stdout.includes('queue:enqueue'));
    });
  });

  describe('missing context (U12: env-var-only discovery)', () => {
    it('exits 2 for send when COMATE_WECOM_CONTEXT_FILE is unset', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const result = run(['send', '--to-user', 'u', '--message', 'm', '--session-id', 's'], tmpDir);
      assert.strictEqual(result.status, 2);
      assert(result.stderr.includes('COMATE_WECOM_CONTEXT_FILE'));
    });

    it('exits 2 for current-user when COMATE_WECOM_CONTEXT_FILE is unset', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const result = run(['current-user', '--session-id', 's'], tmpDir);
      assert.strictEqual(result.status, 2);
      assert(result.stderr.includes('COMATE_WECOM_CONTEXT_FILE'));
    });

    it('a planted .claude/wecom-context.json does NOT serve as context (upward walk removed)', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      plantLegacyContext(tmpDir);
      const result = run(['send', '--to-user', 'u', '--message', 'm', '--session-id', 's'], tmpDir);
      assert.strictEqual(result.status, 2);
      assert(result.stderr.includes('COMATE_WECOM_CONTEXT_FILE'));
    });

    it('a planted context in a PARENT dir does NOT serve as context either', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      plantLegacyContext(tmpDir);
      const nested = join(tmpDir, 'data', 'me');
      mkdirSync(nested, { recursive: true });
      const result = run(['current-user', '--session-id', 's'], nested);
      assert.strictEqual(result.status, 2);
      assert(result.stderr.includes('COMATE_WECOM_CONTEXT_FILE'));
    });

    it('the env-var context wins over a planted legacy file', async () => {
      const server = await startMockServer({
        MOCK_STATUS: '200',
        MOCK_BODY: JSON.stringify({ userId: 'env-user', lastSeenAt: null }),
        MOCK_EXPECTED_URL: '/api/workspaces/w/sessions/s/wecom-user',
        MOCK_EXPECTED_AUTH: `Bearer ${TEST_TOKEN}`,
      });
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      plantLegacyContext(tmpDir); // would point at a dead server if it won
      const env = writeContext(tmpDir, server.url);
      const result = run(['current-user', '--session-id', 's'], tmpDir, env);
      try {
        assert.strictEqual(result.status, 0);
        assert.strictEqual(result.stdout.trim(), 'env-user');
      } finally {
        await server.close();
      }
    });
  });

  describe('invalid context file', () => {
    it('exits 1 for send with malformed context', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const runtimeDir = join(tmpDir, '.runtime');
      mkdirSync(runtimeDir, { recursive: true });
      const contextPath = join(runtimeDir, 'wecom-context.json');
      writeFileSync(contextPath, '{}');
      const result = run(['send', '--to-user', 'u', '--message', 'm', '--session-id', 's'], tmpDir, {
        COMATE_WECOM_CONTEXT_FILE: contextPath,
      });
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('Invalid context file format'));
    });

    it('exits 1 for current-user with malformed context', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const runtimeDir = join(tmpDir, '.runtime');
      mkdirSync(runtimeDir, { recursive: true });
      const contextPath = join(runtimeDir, 'wecom-context.json');
      writeFileSync(contextPath, '{}');
      const result = run(['current-user', '--session-id', 's'], tmpDir, {
        COMATE_WECOM_CONTEXT_FILE: contextPath,
      });
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('Invalid context file format'));
    });

    it('exits 1 when the env-var path does not exist', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const result = run(['current-user', '--session-id', 's'], tmpDir, {
        COMATE_WECOM_CONTEXT_FILE: join(tmpDir, 'does-not-exist.json'),
      });
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('Failed to read context file'));
    });
  });

  describe('missing capability token (U12)', () => {
    it('exits 2 for send when COMATE_SESSION_TOKEN is unset', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const env = writeContextWithoutToken(tmpDir, 'http://127.0.0.1:1');
      const result = run(['send', '--to-user', 'u', '--message', 'm', '--session-id', 's'], tmpDir, env);
      assert.strictEqual(result.status, 2);
      assert(result.stderr.includes('COMATE_SESSION_TOKEN'));
    });

    it('exits 2 for current-user when COMATE_SESSION_TOKEN is unset', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const env = writeContextWithoutToken(tmpDir, 'http://127.0.0.1:1');
      const result = run(['current-user', '--session-id', 's'], tmpDir, env);
      assert.strictEqual(result.status, 2);
      assert(result.stderr.includes('COMATE_SESSION_TOKEN'));
    });

    it('exits 2 for a doc subcommand when COMATE_SESSION_TOKEN is unset', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const env = writeContextWithoutToken(tmpDir, 'http://127.0.0.1:1');
      const result = run(['doc:get-doc-content', '--docid', 'DOCID'], tmpDir, env);
      assert.strictEqual(result.status, 2);
      assert(result.stderr.includes('COMATE_SESSION_TOKEN'));
    });
  });

  describe('missing workspaceId', () => {
    it('exits 1 for send', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const runtimeDir = join(tmpDir, '.runtime');
      mkdirSync(runtimeDir, { recursive: true });
      const contextPath = join(runtimeDir, 'wecom-context.json');
      writeFileSync(contextPath, JSON.stringify({ botId: 'b', serverUrl: 'http://localhost' }));
      const result = run(['send', '--to-user', 'u', '--message', 'm', '--session-id', 's'], tmpDir, {
        COMATE_WECOM_CONTEXT_FILE: contextPath,
      });
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('missing workspaceId'));
    });

    it('exits 1 for current-user', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const runtimeDir = join(tmpDir, '.runtime');
      mkdirSync(runtimeDir, { recursive: true });
      const contextPath = join(runtimeDir, 'wecom-context.json');
      writeFileSync(contextPath, JSON.stringify({ botId: 'b', serverUrl: 'http://localhost' }));
      const result = run(['current-user', '--session-id', 's'], tmpDir, {
        COMATE_WECOM_CONTEXT_FILE: contextPath,
      });
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('missing workspaceId'));
    });
  });

  describe('missing required flags', () => {
    it('exits 1 for send without --to-user', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const env = writeContext(tmpDir, 'http://localhost');
      const result = run(['send', '--message', 'm', '--session-id', 's'], tmpDir, env);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('Missing required flag to-user'));
    });

    it('exits 1 for send without --message', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const env = writeContext(tmpDir, 'http://localhost');
      const result = run(['send', '--to-user', 'u', '--session-id', 's'], tmpDir, env);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('Missing required flag message'));
    });

    it('exits 1 for send without --session-id and no env var', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const env = writeContext(tmpDir, 'http://localhost');
      const result = run(['send', '--to-user', 'u', '--message', 'm'], tmpDir, env);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('Missing session ID'));
    });

    it('exits 1 for current-user without --session-id and no env var', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const env = writeContext(tmpDir, 'http://localhost');
      const result = run(['current-user'], tmpDir, env);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('Missing session ID'));
    });
  });

  describe('invalid --msg-type', () => {
    it('exits 1 for send with bad msg-type', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const env = writeContext(tmpDir, 'http://localhost');
      const result = run(['send', '--to-user', 'u', '--message', 'm', '--session-id', 's', '--msg-type', 'bad'], tmpDir, env);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('Expected --msg-type='));
    });
  });

  describe('current-user', () => {
    it('prints the user ID when the server returns 200 (and sends the Bearer token)', async () => {
      const server = await startMockServer({
        MOCK_STATUS: '200',
        MOCK_BODY: JSON.stringify({ userId: 'user1', lastSeenAt: null }),
        MOCK_EXPECTED_URL: '/api/workspaces/w/sessions/s/wecom-user',
        MOCK_EXPECTED_AUTH: `Bearer ${TEST_TOKEN}`,
      });
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const env = writeContext(tmpDir, server.url);
      const result = run(['current-user', '--session-id', 's'], tmpDir, env);
      try {
        assert.strictEqual(result.status, 0);
        assert.strictEqual(result.stdout.trim(), 'user1');
      } finally {
        await server.close();
      }
    });

    it('falls back to CLAUDE_SESSION_ID env var', async () => {
      const server = await startMockServer({
        MOCK_STATUS: '200',
        MOCK_BODY: JSON.stringify({ userId: 'user2', lastSeenAt: null }),
        MOCK_EXPECTED_URL: '/api/workspaces/w/sessions/env-session/wecom-user',
        MOCK_EXPECTED_AUTH: `Bearer ${TEST_TOKEN}`,
      });
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const env = { ...writeContext(tmpDir, server.url), CLAUDE_SESSION_ID: 'env-session' };
      const result = run(['current-user'], tmpDir, env);
      try {
        assert.strictEqual(result.status, 0);
        assert.strictEqual(result.stdout.trim(), 'user2');
      } finally {
        await server.close();
      }
    });

    it('exits 2 when the server returns 404', async () => {
      const server = await startMockServer({
        MOCK_STATUS: '404',
        MOCK_BODY: JSON.stringify({ error: 'unknown_session', message: 'Session not found' }),
        MOCK_EXPECTED_AUTH: `Bearer ${TEST_TOKEN}`,
      });
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const env = writeContext(tmpDir, server.url);
      const result = run(['current-user', '--session-id', 's'], tmpDir, env);
      try {
        assert.strictEqual(result.status, 2);
        assert(result.stderr.includes('Session not found'));
      } finally {
        await server.close();
      }
    });

    it('exits 3 when the server returns 500', async () => {
      const server = await startMockServer({
        MOCK_STATUS: '500',
        MOCK_BODY: JSON.stringify({ error: 'internal_error' }),
        MOCK_EXPECTED_AUTH: `Bearer ${TEST_TOKEN}`,
      });
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const env = writeContext(tmpDir, server.url);
      const result = run(['current-user', '--session-id', 's'], tmpDir, env);
      try {
        assert.strictEqual(result.status, 3);
        assert(result.stderr.includes('internal_error'));
      } finally {
        await server.close();
      }
    });

    it('exits 1 when the server returns invalid JSON', async () => {
      const server = await startMockServer({
        MOCK_STATUS: '200',
        MOCK_BODY: 'not-json',
        MOCK_EXPECTED_AUTH: `Bearer ${TEST_TOKEN}`,
      });
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const env = writeContext(tmpDir, server.url);
      const result = run(['current-user', '--session-id', 's'], tmpDir, env);
      try {
        assert.strictEqual(result.status, 1);
      } finally {
        await server.close();
      }
    });

    it('exits 1 when the server response is missing userId', async () => {
      const server = await startMockServer({
        MOCK_STATUS: '200',
        MOCK_BODY: JSON.stringify({ lastSeenAt: null }),
        MOCK_EXPECTED_AUTH: `Bearer ${TEST_TOKEN}`,
      });
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const env = writeContext(tmpDir, server.url);
      const result = run(['current-user', '--session-id', 's'], tmpDir, env);
      try {
        assert.strictEqual(result.status, 1);
      } finally {
        await server.close();
      }
    });
  });

  describe('send (U12 auth)', () => {
    it('sends the Bearer token and the sessionId body', async () => {
      const server = await startMockServer({
        MOCK_STATUS: '200',
        MOCK_BODY: JSON.stringify({ method: 'direct', sent: true }),
        MOCK_EXPECTED_URL: '/api/workspaces/w/wecom/send',
        MOCK_EXPECTED_AUTH: `Bearer ${TEST_TOKEN}`,
      });
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const env = writeContext(tmpDir, server.url);
      const result = run(['send', '--to-user', 'u', '--message', 'm', '--session-id', 's'], tmpDir, env);
      try {
        assert.strictEqual(result.status, 0);
        assert(result.stdout.includes('Message sent'));
      } finally {
        await server.close();
      }
    });

    it('surfaces the server 401 when the token is rejected', async () => {
      const server = await startMockServer({
        MOCK_STATUS: '200',
        MOCK_BODY: '{}',
        MOCK_EXPECTED_URL: '/api/workspaces/w/wecom/send',
        MOCK_EXPECTED_AUTH: 'Bearer some-other-token',
      });
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const env = writeContext(tmpDir, server.url);
      const result = run(['send', '--to-user', 'u', '--message', 'm', '--session-id', 's'], tmpDir, env);
      try {
        assert.strictEqual(result.status, 3);
        assert(result.stderr.includes('unauthorized'));
      } finally {
        await server.close();
      }
    });

    it('routes through the sandbox HTTP proxy when http_proxy is set (V10)', async () => {
      // The mock server plays the sandbox proxy: it must see the ABSOLUTE-URI
      // request form, the Proxy-Authorization from the proxy URL userinfo,
      // and the session Bearer token — the sidecar URL itself is never
      // dialed directly inside a sandbox.
      const server = await startMockServer({
        MOCK_STATUS: '200',
        MOCK_BODY: JSON.stringify({ userId: 'via-proxy' }),
        MOCK_EXPECTED_URL: 'http://127.0.0.1:59999/api/workspaces/w/sessions/s/wecom-user',
        MOCK_EXPECTED_AUTH: `Bearer ${TEST_TOKEN}`,
        MOCK_EXPECTED_PROXY_AUTH: 'Basic c3J0OnNlc3Npb24tcHJveHktc2VjcmV0',
      });
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      // The context points at a dead port; only the proxy path can succeed.
      const env = {
        ...writeContext(tmpDir, 'http://127.0.0.1:59999'),
        HTTP_PROXY: `http://srt:session-proxy-secret@${new URL(server.url).host}`,
      };
      const result = run(['current-user', '--session-id', 's'], tmpDir, env);
      try {
        assert.strictEqual(result.status, 0);
        assert.strictEqual(result.stdout.trim(), 'via-proxy');
      } finally {
        await server.close();
      }
    });
  });

  describe('doc topic', () => {
    describe('help', () => {
      it('doc topic help lists subcommands', () => {
        const result = run(['doc', '--help']);
        assert.strictEqual(result.status, 0);
        assert(result.stdout.includes('get-doc-content'));
        assert(result.stdout.includes('create-doc'));
        assert(result.stdout.includes('smartsheet-get-sheet'));
      });

      it('get-doc-content --help shows flags', () => {
        const result = run(['doc:get-doc-content', '--help']);
        assert.strictEqual(result.status, 0);
        assert(result.stdout.includes('--docid'));
        assert(result.stdout.includes('--url'));
        assert(result.stdout.includes('--type'));
        assert(result.stdout.includes('--json'));
      });

      it('smartsheet-get-records --help shows flags', () => {
        const result = run(['doc:smartsheet-get-records', '--help']);
        assert.strictEqual(result.status, 0);
        assert(result.stdout.includes('--docid'));
        assert(result.stdout.includes('--sheet-id'));
      });
    });

    describe('missing context', () => {
      it('exits 2 for doc subcommand when the env var is unset', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
        const result = run(['doc:get-doc-content', '--docid', 'DOCID'], tmpDir);
        assert.strictEqual(result.status, 2);
        assert(result.stderr.includes('COMATE_WECOM_CONTEXT_FILE'));
      });
    });

    describe('invalid context file', () => {
      it('exits 1 for doc subcommand with malformed context', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
        const runtimeDir = join(tmpDir, '.runtime');
        mkdirSync(runtimeDir, { recursive: true });
        const contextPath = join(runtimeDir, 'wecom-context.json');
        writeFileSync(contextPath, '{}');
        const result = run(['doc:get-doc-content', '--docid', 'DOCID'], tmpDir, {
          COMATE_WECOM_CONTEXT_FILE: contextPath,
        });
        assert.strictEqual(result.status, 1);
        assert(result.stderr.includes('Invalid context file format'));
      });
    });

    describe('missing workspaceId', () => {
      it('exits 1 for doc subcommand', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
        const runtimeDir = join(tmpDir, '.runtime');
        mkdirSync(runtimeDir, { recursive: true });
        const contextPath = join(runtimeDir, 'wecom-context.json');
        writeFileSync(contextPath, JSON.stringify({ botId: 'b', serverUrl: 'http://localhost' }));
        const result = run(['doc:get-doc-content', '--docid', 'DOCID'], tmpDir, {
          COMATE_WECOM_CONTEXT_FILE: contextPath,
        });
        assert.strictEqual(result.status, 1);
        assert(result.stderr.includes('missing workspaceId'));
      });
    });

    describe('missing required flags', () => {
      it('exits 1 for smartsheet-get-sheet without --docid', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
        const env = writeContext(tmpDir, 'http://localhost');
        const result = run(['doc:smartsheet-get-sheet'], tmpDir, env);
        assert.strictEqual(result.status, 1);
        assert(result.stderr.includes('Missing required flag docid'));
      });

      it('exits 1 for auto-file helper without --data', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
        const env = writeContext(tmpDir, 'http://localhost');
        const result = run([
          'doc:smartsheet-add-records-auto-file',
          '--docid', 'DOCID',
          '--sheet-id', 'SHEET',
        ], tmpDir, env);
        assert.strictEqual(result.status, 1);
        assert(result.stderr.includes('Missing required flag data'));
      });
    });

    describe('smartsheet-export-excel', () => {
      const EXPORT_URL = '/api/workspaces/w/wecom/smartsheet-export';

      it('--help shows flags', () => {
        const result = run(['doc:smartsheet-export-excel', '--help']);
        assert.strictEqual(result.status, 0);
        assert(result.stdout.includes('--docid'));
        assert(result.stdout.includes('--output'));
        assert(result.stdout.includes('--force'));
      });

      it('writes the workbook bytes and prints the absolute path (with Bearer auth)', async () => {
        const server = await startMockServer({
          MOCK_STATUS: '200',
          MOCK_BODY: 'XLSX-BYTES',
          MOCK_EXPECTED_URL: EXPORT_URL,
          MOCK_EXPECTED_AUTH: `Bearer ${TEST_TOKEN}`,
        });
        const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
        const env = writeContext(tmpDir, server.url);
        const result = run(
          ['doc:smartsheet-export-excel', '--docid', 'DOC1', '--output', 'out.xlsx'],
          tmpDir,
          env
        );
        try {
          assert.strictEqual(result.status, 0);
          assert(result.stdout.trim().endsWith('out.xlsx'));
          const outPath = join(tmpDir, 'out.xlsx');
          assert(existsSync(outPath));
          assert.strictEqual(readFileSync(outPath, 'utf-8'), 'XLSX-BYTES');
        } finally {
          await server.close();
        }
      });

      it('exits 1 and leaves the file untouched when it exists and --force is not given', async () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
        const env = writeContext(tmpDir, 'http://127.0.0.1:1');
        const outPath = join(tmpDir, 'out.xlsx');
        writeFileSync(outPath, 'ORIGINAL');
        // Non-TTY (spawnSync pipes), so the prompt branch is skipped and it errors out.
        const result = run(
          ['doc:smartsheet-export-excel', '--docid', 'DOC1', '--output', 'out.xlsx'],
          tmpDir,
          env
        );
        assert.strictEqual(result.status, 1);
        assert(result.stderr.includes('already exists'));
        assert.strictEqual(readFileSync(outPath, 'utf-8'), 'ORIGINAL');
      });

      it('overwrites an existing file when --force is given', async () => {
        const server = await startMockServer({
          MOCK_STATUS: '200',
          MOCK_BODY: 'NEW-BYTES',
          MOCK_EXPECTED_URL: EXPORT_URL,
          MOCK_EXPECTED_AUTH: `Bearer ${TEST_TOKEN}`,
        });
        const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
        const env = writeContext(tmpDir, server.url);
        const outPath = join(tmpDir, 'out.xlsx');
        writeFileSync(outPath, 'ORIGINAL');
        const result = run(
          ['doc:smartsheet-export-excel', '--docid', 'DOC1', '--output', 'out.xlsx', '--force'],
          tmpDir,
          env
        );
        try {
          assert.strictEqual(result.status, 0);
          assert.strictEqual(readFileSync(outPath, 'utf-8'), 'NEW-BYTES');
        } finally {
          await server.close();
        }
      });

      it('exits 3 and leaves no file when the server returns an error', async () => {
        const server = await startMockServer({
          MOCK_STATUS: '500',
          MOCK_BODY: JSON.stringify({ error: 'smartsheet_export_failed', message: 'mcp boom' }),
          MOCK_EXPECTED_URL: EXPORT_URL,
          MOCK_EXPECTED_AUTH: `Bearer ${TEST_TOKEN}`,
        });
        const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
        const env = writeContext(tmpDir, server.url);
        const result = run(
          ['doc:smartsheet-export-excel', '--docid', 'DOC1', '--output', 'out.xlsx'],
          tmpDir,
          env
        );
        try {
          assert.strictEqual(result.status, 3);
          assert(result.stderr.includes('mcp boom'));
          assert(!existsSync(join(tmpDir, 'out.xlsx')));
        } finally {
          await server.close();
        }
      });

      it('exits 1 when --docid is missing', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
        const env = writeContext(tmpDir, 'http://localhost');
        const result = run(
          ['doc:smartsheet-export-excel', '--output', 'out.xlsx'],
          tmpDir,
          env
        );
        assert.strictEqual(result.status, 1);
        assert(result.stderr.includes('Missing required flag docid'));
      });

      it('exits 1 when --output is missing', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
        const env = writeContext(tmpDir, 'http://localhost');
        const result = run(
          ['doc:smartsheet-export-excel', '--docid', 'DOC1'],
          tmpDir,
          env
        );
        assert.strictEqual(result.status, 1);
        assert(result.stderr.includes('Missing required flag output'));
      });
    });

    describe('--json override', () => {
      it('--json is accepted without required typed flags', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
        const env = writeContext(tmpDir, 'http://localhost');
        // --json provides the full body, so --docid is not required
        // This will hit the server (which isn't running) and exit 4 (network failure)
        const result = run([
          'doc:get-doc-content',
          '--json', '{"docid":"DOCID","type":2}',
        ], tmpDir, env);
        // Network failure → exit 4 since no server is listening
        assert.strictEqual(result.status, 4);
        assert(result.stderr.includes('Network error'));
      });
    });
  });
});
