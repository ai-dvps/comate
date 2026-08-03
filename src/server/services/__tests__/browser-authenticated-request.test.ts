import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { sharedContractFixtures, type BrokerRequest } from '@comate/api-contracts';
import {
  BrowserAuthenticatedRequestBroker,
  type BrowserBrokerAuditInput,
} from '../browser-authenticated-request.js';
import { BrowserAuthBindingVault } from '../browser-auth-binding.js';
import {
  BrowserDirectHttpClient,
  BrowserDirectHttpError,
  type DirectHttpTransportRequest,
} from '../browser-direct-http-client.js';
import { BrowserAuditService } from '../browser-audit.js';
import { SqliteStore } from '../../storage/sqlite-store.js';

const COOKIE_SECRET = 'broker-cookie-sentinel';
const BEARER_SECRET = 'broker-bearer-sentinel';
const RESPONSE_SECRET = 'response-secret-sentinel';

function request(method = 'GET'): BrokerRequest {
  return {
    ...structuredClone(sharedContractFixtures.brokerRequest),
    recipe: {
      ...structuredClone(sharedContractFixtures.brokerRequest.recipe),
      method,
      url: 'https://api.example.com/v1/quota',
      query: [{ name: 'account', value: '{{account}}' }],
      headers: { accept: 'application/json' },
      authBinding: 'authb_placeholder',
    },
  };
}

function harness(
  decisions: Array<'allow' | 'deny' | 'timeout' | 'cancel'> = [],
  options: { auditResults?: boolean[]; sourceOrigin?: string } = {},
) {
  const sent: DirectHttpTransportRequest[] = [];
  const audit: BrowserBrokerAuditInput[] = [];
  let approvalCalls = 0;
  const vault = new BrowserAuthBindingVault();
  const bindingId = vault.capture('task-1', {
    siteKey: 'example.com',
    sourceOrigin: options.sourceOrigin ?? 'https://api.example.com',
    sessionContext: { cookies: [{ name: 'sid', value: COOKIE_SECRET, domain: '.example.com', path: '/', secure: true }] },
    bearerToken: BEARER_SECRET,
  });
  const http = new BrowserDirectHttpClient({
    resolver: async () => [{ address: '93.184.216.34', family: 4 as const }],
    transport: {
      async request(input) {
        sent.push(input);
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json', 'set-cookie': `sid=${RESPONSE_SECRET}` },
          body: (async function* () { yield Buffer.from(JSON.stringify({ ok: true, echo: BEARER_SECRET })); })(),
          close() {},
        };
      },
    },
  });
  const broker = new BrowserAuthenticatedRequestBroker({
    httpClient: http,
    resolveAuth: (taskId, id, url) => vault.resolve(taskId, id, url),
    approvalRequester: async () => {
      approvalCalls += 1;
      return { behavior: decisions.shift() ?? 'allow' };
    },
    audit: { logBroker: (row) => { audit.push(row); return options.auditResults?.shift() ?? true; } },
  });
  return { broker, bindingId, sent, audit, approvalCalls: () => approvalCalls };
}

describe('BrowserAuthenticatedRequestBroker', () => {
  it('GET bypasses approval, attaches per-hop native auth, drops Set-Cookie, and sanitizes response', async () => {
    const h = harness();
    const input = request();
    input.recipe.authBinding = h.bindingId;
    input.recipe.headers.authorization = 'Bearer caller-controlled';
    const result = await h.broker.execute({ taskId: 'task-1', workspaceId: 'ws-1' }, input);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(h.approvalCalls(), 0);
    assert.equal(h.sent[0].headers.cookie, `sid=${COOKIE_SECRET}`);
    assert.equal(h.sent[0].headers.authorization, `Bearer ${BEARER_SECRET}`);
    if (result.ok) {
      assert.equal('set-cookie' in result.headers, false);
      assert.equal(JSON.stringify(result).includes(RESPONSE_SECRET), false, JSON.stringify(result));
      assert.equal(JSON.stringify(result).includes(BEARER_SECRET), false, JSON.stringify(result));
    }
    assert.equal(JSON.stringify(h.audit).includes('/v1/quota'), false);
    assert.equal(JSON.stringify(h.audit).includes(COOKIE_SECRET), false);
  });

  it('POST approval establishes only an exact internal-fingerprint task grant', async () => {
    const h = harness(['allow', 'allow']);
    const input = request('POST');
    input.validateNonMutating = true;
    input.recipe.authBinding = h.bindingId;
    const first = await h.broker.execute({ taskId: 'task-1', workspaceId: 'ws-1' }, input);
    const callerFingerprintChanged = structuredClone(input);
    callerFingerprintChanged.recipe.operationFingerprint = `sha256:${'b'.repeat(64)}`;
    const second = await h.broker.execute({ taskId: 'task-1', workspaceId: 'ws-1' }, callerFingerprintChanged);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(h.approvalCalls(), 1);
    const changed = structuredClone(input);
    changed.variables.account = 'changed';
    await h.broker.execute({ taskId: 'task-1', workspaceId: 'ws-1' }, changed);
    assert.equal(h.approvalCalls(), 2);
    h.broker.revokeBinding('task-1', h.bindingId);
    await h.broker.execute({ taskId: 'task-1', workspaceId: 'ws-1' }, input);
    assert.equal(h.approvalCalls(), 3);
  });

  it('does not reuse an exact-operation grant after runtime generation rotation', async () => {
    const h = harness(['allow', 'allow']);
    const input = request('POST');
    input.validateNonMutating = true;
    input.recipe.authBinding = h.bindingId;

    const first = await h.broker.execute({
      taskId: 'task-1', workspaceId: 'ws-1', grantScope: 'runtime-generation-1',
    }, input);
    const afterRotation = await h.broker.execute({
      taskId: 'task-1', workspaceId: 'ws-1', grantScope: 'runtime-generation-2',
    }, input);

    assert.equal(first.ok, true);
    assert.equal(afterRotation.ok, true);
    assert.equal(h.approvalCalls(), 2, 'rotated runtime must authorize again');
  });

  it('does not turn an ordinary approved mutation into a reusable grant', async () => {
    const h = harness(['allow', 'allow']);
    const input = request('POST');
    input.recipe.authBinding = h.bindingId;
    assert.equal((await h.broker.execute({ taskId: 'task-1', workspaceId: 'ws-1' }, input)).ok, true);
    assert.equal((await h.broker.execute({ taskId: 'task-1', workspaceId: 'ws-1' }, input)).ok, true);
    assert.equal(h.approvalCalls(), 2);
  });

  it('revokeTask cancels an in-flight approval wait before dispatch', async () => {
    const vault = new BrowserAuthBindingVault();
    const bindingId = vault.capture('task-1', {
      siteKey: 'example.com', sourceOrigin: 'https://api.example.com',
      sessionContext: { cookies: [{ name: 'sid', value: COOKIE_SECRET, domain: '.example.com', secure: true }] },
    });
    let dispatches = 0;
    const broker = new BrowserAuthenticatedRequestBroker({
      resolveAuth: (taskId, id, url) => vault.resolve(taskId, id, url),
      approvalRequester: ({ signal }) => new Promise((resolve) => {
        signal?.addEventListener('abort', () => resolve({ behavior: 'cancel' }), { once: true });
      }),
      httpClient: { request: async () => {
        dispatches += 1;
        throw new Error('must not dispatch');
      } },
      audit: { logBroker: () => true },
    });
    const input = request('POST');
    input.recipe.authBinding = bindingId;

    const pending = broker.execute({ taskId: 'task-1', workspaceId: 'ws-1' }, input);
    await Promise.resolve();
    broker.revokeTask('task-1');
    const result = await pending;

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'authorization_cancelled');
    assert.equal(dispatches, 0);
  });

  it('revokeTask aborts an in-flight direct HTTP execution', async () => {
    const vault = new BrowserAuthBindingVault();
    const bindingId = vault.capture('task-1', {
      siteKey: 'example.com', sourceOrigin: 'https://api.example.com',
      sessionContext: { cookies: [{ name: 'sid', value: COOKIE_SECRET, domain: '.example.com', secure: true }] },
    });
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const broker = new BrowserAuthenticatedRequestBroker({
      resolveAuth: (taskId, id, url) => vault.resolve(taskId, id, url),
      httpClient: { request: (input) => new Promise((_, reject) => {
        requestStarted();
        input.signal?.addEventListener('abort', () => {
          reject(new BrowserDirectHttpError('request_aborted', 'task closed'));
        }, { once: true });
      }) },
      audit: { logBroker: () => true },
    });
    const input = request();
    input.recipe.authBinding = bindingId;

    const pending = broker.execute({ taskId: 'task-1', workspaceId: 'ws-1' }, input);
    await started;
    broker.revokeTask('task-1');
    const result = await pending;

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'authorization_cancelled');
  });

  it('returns typed denial, timeout, and cancellation without dispatch', async () => {
    for (const [decision, expected] of [
      ['deny', 'authorization_denied'],
      ['timeout', 'authorization_expired'],
      ['cancel', 'authorization_cancelled'],
    ] as const) {
      const h = harness([decision]);
      const input = request('POST');
      input.recipe.authBinding = h.bindingId;
      const result = await h.broker.execute({ taskId: 'task-1', workspaceId: 'ws-1' }, input);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, expected);
      assert.equal(h.sent.length, 0);
    }
  });

  it('fails closed before dispatch when intent audit fails and withholds a dispatched response on terminal audit failure', async () => {
    const before = harness([], { auditResults: [false] });
    const input = request();
    input.recipe.authBinding = before.bindingId;
    const rejected = await before.broker.execute({ taskId: 'task-1', workspaceId: 'ws-1' }, input);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.code, 'audit_unavailable');
      assert.equal(rejected.outcomeUnknownAfterDispatch, undefined);
    }
    assert.equal(before.sent.length, 0);

    const after = harness([], { auditResults: [true, false] });
    const afterInput = request();
    afterInput.recipe.authBinding = after.bindingId;
    const withheld = await after.broker.execute({ taskId: 'task-1', workspaceId: 'ws-1' }, afterInput);
    assert.equal(withheld.ok, false);
    if (!withheld.ok) {
      assert.equal(withheld.code, 'audit_unavailable');
      assert.equal(withheld.outcomeUnknownAfterDispatch, true);
    }
    assert.equal(after.sent.length, 1);
  });

  it('uses cookies across the authorized site but keeps bearer exact-origin', async () => {
    const h = harness([], { sourceOrigin: 'https://app.example.com' });
    const input = request();
    input.recipe.authBinding = h.bindingId;
    const result = await h.broker.execute({ taskId: 'task-1', workspaceId: 'ws-1' }, input);
    assert.equal(result.ok, true);
    assert.equal(h.sent[0].headers.cookie, `sid=${COOKIE_SECRET}`);
    assert.equal(h.sent[0].headers.authorization, undefined);
  });

  it('does not resolve or attach auth for an off-domain redirect hop', async () => {
    const vault = new BrowserAuthBindingVault();
    const bindingId = vault.capture('task-1', {
      siteKey: 'example.com', sourceOrigin: 'https://api.example.com',
      sessionContext: { cookies: [{ name: 'sid', value: COOKIE_SECRET, domain: '.example.com', secure: true }] },
      bearerToken: BEARER_SECRET,
    });
    let transportCalls = 0;
    let authResolutions = 0;
    const broker = new BrowserAuthenticatedRequestBroker({
      httpClient: new BrowserDirectHttpClient({
        resolver: async () => [{ address: '93.184.216.34', family: 4 as const }],
        transport: {
          async request() {
            transportCalls += 1;
            return {
              statusCode: 302,
              headers: { location: 'https://evil.test/steal' },
              body: (async function* () {})(),
              close() {},
            };
          },
        },
      }),
      resolveAuth: (taskId, id, url) => {
        authResolutions += 1;
        return vault.resolve(taskId, id, url);
      },
      audit: { logBroker: () => true },
    });
    const input = request();
    input.recipe.authBinding = bindingId;
    const result = await broker.execute({ taskId: 'task-1', workspaceId: 'ws-1' }, input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'destination_not_allowed');
    assert.equal(transportCalls, 1);
    assert.equal(authResolutions, 1, 'redirect is rejected before the per-hop auth hook');
  });

  it('substitutes only declared path variables with segment-safe encoding', async () => {
    const h = harness();
    const input = request();
    input.recipe.authBinding = h.bindingId;
    input.recipe.url = 'https://api.example.com/v1/{{item}}';
    input.recipe.variables.push({ name: 'item', location: 'path', required: true });
    input.variables.item = 'folder/child';
    const result = await h.broker.execute({ taskId: 'task-1', workspaceId: 'ws-1' }, input);
    assert.equal(result.ok, true);
    assert.match(h.sent[0].path, /^\/v1\/folder%2Fchild\?/);
  });

  it('persists broker audit rows in a correlated positive shape only', () => {
    const store = new SqliteStore(':memory:');
    const audit = new BrowserAuditService(store);
    const sentinel = '/secret/path?token=do-not-store';
    audit.logBroker({
      workspaceId: 'ws-1', sessionId: 'task-1', phase: 'intent',
      correlationId: 'broker_safeCorrelation', method: 'GET', siteKey: 'example.com',
      approval: 'not_required', outcome: 'ok',
    });
    audit.logBroker({
      workspaceId: 'ws-1', sessionId: 'task-1', phase: 'terminal',
      correlationId: 'broker_safeCorrelation', method: 'GET', siteKey: 'example.com',
      approval: 'not_required', outcome: 'ok', status: 200,
    });
    const rows = store.listBrowserAudit('ws-1');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.category === 'broker' && row.siteKey === 'example.com'));
    assert.equal(JSON.stringify(rows).includes(sentinel), false);
    assert.ok(rows.every((row) => row.detail?.includes('broker_safeCorrelation')));
  });

  it('keeps generated skill, Python, and CLI fixtures credential-free', () => {
    const fixtureDir = path.join(import.meta.dirname, 'fixtures', 'browser-api-discovery');
    const generated = ['generated-skill.md', 'quota.py', 'quota.cli.txt']
      .map((name) => readFileSync(path.join(fixtureDir, name), 'utf8'))
      .join('\n');
    for (const sentinel of [COOKIE_SECRET, BEARER_SECRET, RESPONSE_SECRET, 'ANTHROPIC_AUTH_TOKEN']) {
      assert.equal(generated.includes(sentinel), false, `${sentinel} leaked into a generated artifact`);
    }
    assert.match(generated, /authenticatedRequest/);
    assert.match(generated, /comate api request --stdin --json/);
  });
});
