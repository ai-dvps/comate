import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { store } from '../storage/sqlite-store.js';
import router from './github.js';
import {
  startDeviceFlow,
  pollDeviceFlow,
  connectPat,
  disconnect,
  getConnectionStatus,
  getAdapter,
  getValidToken,
  shutdown,
  __setFetch,
  __setAdapterFactory,
  __setNow,
  __setTokenTimeout,
  __reset,
} from '../services/github-auth.js';
import { createOctokitAdapter } from '../services/github-client.js';
import { getLogsDir } from '../utils/log-cleanup.js';
import type { GithubBackendAdapter } from '../services/github-types.js';

process.env.COMATE_GITHUB_CLIENT_ID = 'iv1.test_client_id';

// --- route handler extraction (scheduled-tasks.test.ts precedent) -----------
type Handler = (req: unknown, res: unknown) => Promise<void> | void;

function extractHandlers(): Record<string, Record<string, Handler>> {
  const layers = (router as unknown as {
    stack: Array<{
      route?: { methods: Record<string, boolean>; path: string; stack: Array<{ handle: Handler }> };
    }>;
  }).stack;
  const handlers: Record<string, Record<string, Handler>> = {};
  for (const layer of layers) {
    if (!layer.route) continue;
    const path = layer.route.path;
    if (!handlers[path]) handlers[path] = {};
    for (const method of Object.keys(layer.route.methods)) {
      handlers[path][method] = layer.route.stack[0].handle;
    }
  }
  return handlers;
}

const handlers = extractHandlers();

function createMockRes(): {
  statusCode: number;
  jsonBody: unknown;
  status(code: number): unknown;
  json(body: unknown): void;
} {
  const res = {
    statusCode: 200,
    jsonBody: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
    },
  };
  return res;
}

async function call(
  method: string,
  path: string,
  req: { params?: unknown; body?: unknown },
): Promise<{ statusCode: number; jsonBody: unknown }> {
  const handler = handlers[path]?.[method];
  assert.ok(handler, `no handler for ${method} ${path}`);
  const res = createMockRes();
  await handler({ params: req.params ?? {}, body: req.body ?? {} }, res);
  return { statusCode: res.statusCode, jsonBody: res.jsonBody };
}

// --- fetch mocking ----------------------------------------------------------
type FetchCall = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, text: async () => text } as unknown as Response;
}

/** Builds a fetch that serves `responses` in order, recording every call. */
function recorderFetch(responses: Array<(call: FetchCall) => Response>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetch = ((url: string, init: RequestInit) => {
    const record: FetchCall = { url, init };
    calls.push(record);
    const responder = responses[Math.min(i, responses.length - 1)];
    i++;
    return Promise.resolve(responder(record));
  }) as unknown as typeof fetch;
  return { fetch, calls };
}

function throwingFetch(err: unknown): typeof fetch {
  return (() => Promise.reject(err)) as unknown as typeof fetch;
}

const ACCESS = 'ghp_REAL_ACCESS_TOKEN_abc123';
const REFRESH = 'ghr_REAL_REFRESH_TOKEN_xyz789';
const ACCESS_SENTINEL = 'ghp_SENTINEL_ACCESS_LEAK';
const REFRESH_SENTINEL = 'ghr_SENTINEL_REFRESH_LEAK';

function deviceCodeBody() {
  return {
    device_code: 'dev_code_123',
    user_code: 'ABCD-WXYZ',
    verification_uri: 'https://github.com/login/device',
    verification_uri_complete: 'https://github.com/login/device?user_code=ABCD-WXYZ',
    expires_in: 900,
    interval: 5,
  };
}

function accessTokenBody(expiresIn = 28800) {
  return {
    access_token: ACCESS,
    token_type: 'bearer',
    scope: 'repo',
    expires_in: expiresIn,
    refresh_token: REFRESH,
    refresh_token_expires_in: 15897600,
  };
}

/** A sentinel-bearing octokit-shaped error that leaks the token everywhere. */
function sentinelError(): unknown {
  return {
    name: 'RequestError',
    message: 'GET https://api.github.com/repos/o/r/issues?token=' + ACCESS_SENTINEL + ' failed',
    status: 500,
    request: {
      method: 'GET',
      url: 'https://api.github.com/repos/o/r/issues',
      headers: { authorization: 'Bearer ' + ACCESS_SENTINEL },
    },
    response: { status: 500, data: { message: 'boom', access_token: ACCESS_SENTINEL, refresh_token: REFRESH_SENTINEL } },
  };
}

let workspaceId: string;

beforeEach(async () => {
  store.resetData();
  __reset();
  __setFetch(globalThis.fetch);
  __setAdapterFactory(createOctokitAdapter);
  __setNow(() => Date.now());
  process.env.COMATE_GITHUB_CLIENT_ID = 'iv1.test_client_id';
  const ws = await store.create({ name: 'WS', folderPath: '/tmp/ws-gh' });
  workspaceId = ws.id;
});

afterEach(() => {
  __reset();
});

// ===========================================================================
// Connection status + encrypted-at-rest storage (R13/R18/KTD3)
// ===========================================================================
describe('PAT connection + encrypted storage', () => {
  it('stores the token encrypted at rest — plaintext never reaches the DB row or file', () => {
    connectPat(ACCESS);
    const stored = store.getGithubConnection();
    assert.ok(stored, 'connection row missing');
    assert.ok(!stored.includes(ACCESS), 'plaintext access token stored in DB row');
    // The DB file itself must not contain the plaintext token.
    const dbPath = store.getDbPath?.() ?? join(process.env.COMATE_DATA_DIR ?? '', 'data.db');
    if (existsSync(dbPath)) {
      const dbBytes = readFileSync(dbPath, 'utf8');
      assert.ok(!dbBytes.includes(ACCESS), 'plaintext token found in data.db file');
    }
  });

  it('connection status returns tokenType + expiresAt and NO token field (R18)', async () => {
    connectPat(ACCESS);
    const res = await call('get', '/connection', {});
    assert.equal(res.statusCode, 200);
    const conn = (res.jsonBody as { connection: Record<string, unknown> }).connection;
    assert.equal(conn.connected, true);
    assert.equal(conn.tokenType, 'pat');
    assert.equal(conn.expiresAt, null);
    assert.equal(conn.login, null);
    const serialized = JSON.stringify(conn);
    assert.ok(!serialized.includes(ACCESS), 'token leaked into connection status');
    assert.ok(!('accessToken' in conn) && !('refreshToken' in conn) && !('token' in conn), 'token field present');
  });

  it('rejects an empty PAT with 400', async () => {
    const res = await call('post', '/connect/pat', { body: { token: '   ' } });
    assert.equal(res.statusCode, 400);
  });
});

// ===========================================================================
// Device Flow — request payloads, polling ordering, verification URI verbatim
// ===========================================================================
describe('Device Flow (KTD1)', () => {
  it('start echoes verification_uri verbatim and posts client_id+scope to the device-code URL', async () => {
    const { fetch, calls } = recorderFetch([() => jsonResponse(deviceCodeBody(), 200)]);
    __setFetch(fetch);
    const res = await call('post', '/device-flow/start', {});
    assert.equal(res.statusCode, 201);
    const body = res.jsonBody as { verificationUri: string; userCode: string; verificationUriComplete: string };
    assert.equal(body.verificationUri, 'https://github.com/login/device');
    assert.equal(body.verificationUriComplete, 'https://github.com/login/device?user_code=ABCD-WXYZ');
    assert.equal(body.userCode, 'ABCD-WXYZ');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://github.com/login/device/code');
    const payload = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    assert.equal(payload.client_id, 'iv1.test_client_id');
    assert.equal(payload.scope, 'repo');
  });

  it('polling ordering: pending → slow_down (interval bumped) → success; grant_type + device_code posted each time', async () => {
    const responses = [
      () => jsonResponse(deviceCodeBody(), 200), // start
      () => jsonResponse({ error: 'authorization_pending' }, 200), // poll 1
      () => jsonResponse({ error: 'slow_down' }, 200), // poll 2
      () => jsonResponse(accessTokenBody(), 200), // poll 3 → success
    ];
    const { fetch, calls } = recorderFetch(responses);
    __setFetch(fetch);

    await startDeviceFlow();
    const r1 = await pollDeviceFlow();
    assert.equal(r1.status, 'pending');
    const r2 = await pollDeviceFlow();
    assert.equal(r2.status, 'slow_down');
    const r3 = await pollDeviceFlow();
    assert.equal(r3.status, 'success');

    // start hit device/code; the three polls hit the token URL with the device grant.
    assert.equal(calls[0].url, 'https://github.com/login/device/code');
    const pollCalls = calls.slice(1);
    assert.equal(pollCalls.length, 3);
    for (const c of pollCalls) {
      assert.equal(c.url, 'https://github.com/login/oauth/access_token');
      const p = JSON.parse(String(c.init.body)) as Record<string, unknown>;
      assert.equal(p.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
      assert.equal(p.device_code, 'dev_code_123');
      assert.equal(p.client_id, 'iv1.test_client_id');
    }
    // Success persisted a device-flow connection with the refresh token.
    assert.equal(getConnectionStatus().tokenType, 'device-flow');
  });

  it('terminal errors clear the in-flight handle (expired / access_denied)', async () => {
    const { fetch } = recorderFetch([
      () => jsonResponse(deviceCodeBody(), 200),
      () => jsonResponse({ error: 'expired_token' }, 200),
      () => jsonResponse({ error: 'access_denied' }, 200),
    ]);
    __setFetch(fetch);
    await startDeviceFlow();
    const expired = await pollDeviceFlow();
    assert.equal(expired.status, 'expired');
    // handle cleared → next poll is a 400 (no flow in progress), not an upstream call
    const res = await call('post', '/device-flow/poll', {});
    assert.equal(res.statusCode, 400);
  });

  it('a hanging device-flow poll times out instead of hanging (no token leaked)', async () => {
    __setTokenTimeout(50); // shrink so the test does not wait 15s
    const startFetch = recorderFetch([() => jsonResponse(deviceCodeBody(), 200)]);
    __setFetch(startFetch.fetch);
    await startDeviceFlow();
    // Hanging fetch that honors the abort signal (like real fetch): it never
    // resolves on its own, but rejects when fetchWithTimeout aborts it. If the
    // timeout did not fire, this test hangs.
    __setFetch(
      ((_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(new Error('aborted'));
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch,
    );
    const res = await call('post', '/device-flow/poll', {});
    assert.equal(res.statusCode, 500);
    assert.ok(!JSON.stringify(res.jsonBody).includes('Bearer'));
  });
});

// ===========================================================================
// Token refresh on expiry
// ===========================================================================
describe('token refresh on expiry', () => {
  it('refreshes an expiring device-flow token via grant_type=refresh_token and persists the new bundle', async () => {
    const { fetch, calls } = recorderFetch([
      () => jsonResponse(deviceCodeBody(), 200), // start
      () => jsonResponse(accessTokenBody(30), 200), // success — expires in 30s (inside the 60s margin)
      () => jsonResponse({ ...accessTokenBody(28800), access_token: 'ghp_NEW_ACCESS_TOKEN' }, 200), // refresh
    ]);
    __setFetch(fetch);
    await startDeviceFlow();
    await pollDeviceFlow(); // success

    const token = await getValidToken();
    assert.equal(token, 'ghp_NEW_ACCESS_TOKEN');
    // The refresh call carried grant_type=refresh_token and the refresh_token.
    const refreshCall = calls[calls.length - 1];
    const p = JSON.parse(String(refreshCall.init.body)) as Record<string, unknown>;
    assert.equal(p.grant_type, 'refresh_token');
    assert.equal(p.refresh_token, REFRESH);
  });

  it('PAT tokens are returned without refresh (no expiry known)', async () => {
    connectPat(ACCESS);
    assert.equal(await getValidToken(), ACCESS);
  });
});

// ===========================================================================
// Accessible repos + private flag (R8/R17)
// ===========================================================================
describe('GET /repos', () => {
  it('returns repo full names and preserves per-repo private (R17)', async () => {
    connectPat(ACCESS);
    const fake: GithubBackendAdapter = {
      listAccessibleRepos: async () => [
        { fullName: 'myorg/webapp', private: false, defaultBranch: 'main' },
        { fullName: 'myorg/secret', private: true, defaultBranch: 'main' },
      ],
      listChanged: async () => ({ issues: [], etag: null, latestUpdatedAt: null }),
      getIssue: async () => null,
      create: async () => ({} as never),
      update: async () => ({} as never),
      fetchComments: async () => [],
      addComment: async () => ({} as never),
    };
    __setAdapterFactory(() => fake);
    const res = await call('get', '/repos', {});
    assert.equal(res.statusCode, 200);
    const repos = (res.jsonBody as { repos: Array<{ fullName: string; private: boolean }> }).repos;
    assert.deepEqual(
      repos.map((r) => [r.fullName, r.private]),
      [
        ['myorg/webapp', false],
        ['myorg/secret', true],
      ],
    );
  });

  it('returns 400 when not connected', async () => {
    const res = await call('get', '/repos', {});
    assert.equal(res.statusCode, 400);
  });
});

// ===========================================================================
// Workspace repo association CRUD (KTD5/R8)
// ===========================================================================
describe('workspace repo association', () => {
  it('PUT replaces the list (deduped) and GET reads it back; 404 for unknown workspace', async () => {
    const put = await call('put', '/workspaces/:workspaceId/repos', {
      params: { workspaceId },
      body: { repos: ['myorg/webapp', 'myorg/webapp', 'myorg/other'] },
    });
    assert.equal(put.statusCode, 200);
    assert.deepEqual((put.jsonBody as { repos: string[] }).repos, ['myorg/webapp', 'myorg/other']);

    const get = await call('get', '/workspaces/:workspaceId/repos', { params: { workspaceId } });
    assert.deepEqual((get.jsonBody as { repos: string[] }).repos, ['myorg/webapp', 'myorg/other']);

    // The association lives on WorkspaceSettings.githubRepoFullNames.
    assert.deepEqual(store.getWorkspaceGithubRepos(workspaceId), ['myorg/webapp', 'myorg/other']);

    const missing = await call('put', '/workspaces/:workspaceId/repos', {
      params: { workspaceId: 'no-such-ws' },
      body: { repos: ['a/b'] },
    });
    assert.equal(missing.statusCode, 404);
  });

  it('PUT tolerates a missing/non-array repos body', async () => {
    const res = await call('put', '/workspaces/:workspaceId/repos', { params: { workspaceId }, body: {} });
    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.jsonBody as { repos: string[] }).repos, []);
  });
});

// ===========================================================================
// Disconnect + best-effort revocation (R18)
// ===========================================================================
describe('disconnect + revocation (R18)', () => {
  it('PAT disconnect surfaces a manual-revoke deep link and clears local state', async () => {
    connectPat(ACCESS);
    const { fetch, calls } = recorderFetch([() => jsonResponse({}, 200)]);
    __setFetch(fetch);
    const res = await call('post', '/disconnect', {});
    assert.equal(res.statusCode, 200);
    const body = res.jsonBody as { deepLink?: string; connection: { connected: boolean } };
    assert.equal(body.deepLink, 'https://github.com/settings/tokens');
    assert.equal(body.connection.connected, false);
    assert.equal(store.getGithubConnection(), null);
    // PAT path never attempts a server-side revocation call.
    assert.equal(calls.length, 0);
  });

  it('device-flow disconnect best-effort calls the App revocation endpoint and does NOT block local deletion on failure', async () => {
    // Complete a device-flow connection first.
    const setup = recorderFetch([
      () => jsonResponse(deviceCodeBody(), 200),
      () => jsonResponse(accessTokenBody(), 200),
    ]);
    __setFetch(setup.fetch);
    await startDeviceFlow();
    await pollDeviceFlow();

    // Now disconnect: the DELETE revocation throws — local state must still clear.
    const revokeCalls: FetchCall[] = [];
    __setFetch(((url: string, init: RequestInit) => {
      revokeCalls.push({ url, init });
      return Promise.reject(new Error('revocation endpoint down'));
    }) as unknown as typeof fetch);

    const res = await call('post', '/disconnect', {});
    assert.equal(res.statusCode, 200);
    const body = res.jsonBody as { deepLink?: string; connection: { connected: boolean } };
    assert.ok(body.deepLink?.startsWith('https://github.com/settings/connections/applications/'));
    assert.equal(body.connection.connected, false);
    assert.equal(store.getGithubConnection(), null);
    // The App token revocation endpoint was attempted (DELETE /applications/{id}/token).
    const revoke = revokeCalls.find((c) => c.url.includes('/applications/iv1.test_client_id/token'));
    assert.ok(revoke, 'App revocation endpoint was not called');
    assert.equal(revoke!.init.method, 'DELETE');
  });
});

// ===========================================================================
// In-memory token holder lifetime (R13/KTD3)
// ===========================================================================
describe('in-memory token holder lifetime', () => {
  it('shutdown() clears the cached adapter so it is rebuilt on next use', async () => {
    connectPat(ACCESS);
    let builds = 0;
    __setAdapterFactory(() => {
      builds++;
      return ({
        listAccessibleRepos: async () => [],
        listChanged: async () => ({ issues: [], etag: null, latestUpdatedAt: null }),
        getIssue: async () => null,
        create: async () => ({} as never),
        update: async () => ({} as never),
        fetchComments: async () => [],
        addComment: async () => ({} as never),
      } as GithubBackendAdapter);
    });
    await getAdapter(); // builds = 1 (cached)
    await getAdapter(); // still 1 (cached)
    shutdown();
    await getAdapter(); // rebuilt → builds = 2
    assert.equal(builds, 2);
  });
});

// ===========================================================================
// SECURITY: no sentinel in sse-diag.log (under COMATE_SIDECAR=1) or any response
// ===========================================================================
describe('R13 sentinel leakage', () => {
  let prevSidecar: string | undefined;

  beforeEach(() => {
    prevSidecar = process.env.COMATE_SIDECAR;
    process.env.COMATE_SIDECAR = '1';
  });
  afterEach(() => {
    if (prevSidecar === undefined) delete process.env.COMATE_SIDECAR;
    else process.env.COMATE_SIDECAR = prevSidecar;
  });

  function newLogLines(before: number): string {
    const p = join(getLogsDir(), 'sse-diag.log');
    if (!existsSync(p)) return '';
    return readFileSync(p, 'utf8').slice(before);
  }

  it('never writes the sentinel (access or refresh token) to sse-diag.log', async () => {
    const logPath = join(getLogsDir(), 'sse-diag.log');
    const before = existsSync(logPath) ? statSync(logPath).size : 0;

    // Drive every catch site with a sentinel-bearing octokit error.
    __setFetch(throwingFetch(sentinelError()));

    // 1) route error paths funnel through handleGithubError → diagLog(redacted).
    await call('post', '/device-flow/start', {}).catch(() => {}); // startDeviceFlow throws sentinel
    // For poll + repos, set up a valid flow / connection first so the sentinel
    // is the thing thrown (not a "no flow"/"not connected" guard).
    const setup = recorderFetch([() => jsonResponse(deviceCodeBody(), 200)]);
    __setFetch(setup.fetch);
    await startDeviceFlow();
    __setFetch(throwingFetch(sentinelError()));
    await call('post', '/device-flow/poll', {}).catch(() => {});

    connectPat(ACCESS);
    __setAdapterFactory(() => {
      throw sentinelError();
    });
    await call('get', '/repos', {}).catch(() => {});

    // 2) refreshTokenGrant catches + logs redacted.
    const refreshSetup = recorderFetch([
      () => jsonResponse(deviceCodeBody(), 200),
      () => jsonResponse(accessTokenBody(1), 200), // expires immediately
    ]);
    __setFetch(refreshSetup.fetch);
    __setAdapterFactory(createOctokitAdapter);
    await startDeviceFlow();
    await pollDeviceFlow(); // connect with an expiring token
    __setFetch(throwingFetch(sentinelError()));
    await getValidToken().catch(() => {});

    // 3) revoke (disconnect) catches + logs redacted.
    await disconnect().catch(() => {});

    const written = newLogLines(before);
    // The redaction is only proven if the catch sites actually wrote log lines —
    // an empty `written` would make the absence assertions pass vacuously.
    assert.ok(written.length > 0, 'no log lines written — redaction path not exercised');
    assert.ok(written.includes('[github]'), 'expected a redacted [github] log marker to prove catch sites fired');
    assert.ok(!written.includes(ACCESS_SENTINEL), 'access sentinel leaked to sse-diag.log:\n' + written);
    assert.ok(!written.includes(REFRESH_SENTINEL), 'refresh sentinel leaked to sse-diag.log:\n' + written);
    assert.ok(!written.includes('Bearer ' + ACCESS_SENTINEL), 'Bearer header leaked to sse-diag.log');
  });

  it('never returns the sentinel in any response body across the routes (4xx/5xx)', async () => {
    __setFetch(throwingFetch(sentinelError()));
    // start path: throws sentinel → 500 redacted
    const startRes = await call('post', '/device-flow/start', {});
    assert.ok(!JSON.stringify(startRes.jsonBody).includes(ACCESS_SENTINEL));

    // poll path: needs an in-flight flow so the sentinel (not a guard) is thrown
    const setup = recorderFetch([() => jsonResponse(deviceCodeBody(), 200)]);
    __setFetch(setup.fetch);
    await startDeviceFlow();
    __setFetch(throwingFetch(sentinelError()));
    const pollRes = await call('post', '/device-flow/poll', {});
    assert.ok(!JSON.stringify(pollRes.jsonBody).includes(ACCESS_SENTINEL));

    // repos path: adapter throws sentinel → 500 redacted
    connectPat(ACCESS);
    __setAdapterFactory(() => {
      throw sentinelError();
    });
    const reposRes = await call('get', '/repos', {});
    assert.equal(reposRes.statusCode, 500);
    assert.ok(!JSON.stringify(reposRes.jsonBody).includes(ACCESS_SENTINEL));
    assert.ok(!JSON.stringify(reposRes.jsonBody).includes(REFRESH_SENTINEL));
  });
});
