import '../test-utils/test-env.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { brokerRequestSchema, sharedContractFixtures, type BrokerResult } from '@comate/api-contracts';
import apiBrokerRoutes from './api-broker.js';
import { browserApiBrokerService } from '../services/browser-api-broker-service.js';
import { SessionCapabilityService } from '../services/session-capability-service.js';
import { createLoopbackAuthMiddleware } from '../services/security/loopback-auth.js';
import { SqliteStore } from '../storage/sqlite-store.js';

describe('POST /api/broker/request', () => {
  let capabilities: SessionCapabilityService;
  let server: http.Server;
  let baseUrl: string;
  let originalExecute: typeof browserApiBrokerService.execute;
  let captured: { context: Record<string, unknown>; request: unknown } | undefined;

  beforeEach(async () => {
    captured = undefined;
    capabilities = new SessionCapabilityService(new SqliteStore(':memory:'), { skipBootInvalidation: true });
    const app = express();
    app.use(express.json());
    app.use(createLoopbackAuthMiddleware({
      resolveSessionToken: (token) => capabilities.resolveForAudience(token, 'wecom-cli'),
      resolveApiBrokerToken: (token) => capabilities.resolveForAudience(token, 'api-broker'),
      getDesktopToken: () => 'desktop-token',
    }));
    app.use('/api/broker/request', apiBrokerRoutes);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    originalExecute = browserApiBrokerService.execute;
    browserApiBrokerService.execute = async (context, body): Promise<BrokerResult> => {
      captured = { context, request: body };
      return structuredClone(sharedContractFixtures.brokerSuccess);
    };
  });

  afterEach(async () => {
    browserApiBrokerService.execute = originalExecute;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const taskToken = (runtimeGeneration = 'generation-7') => capabilities.mintForSession({
    sessionId: 'task-1', workspaceId: 'workspace-1', botId: null,
    kind: 'task', audiences: ['browser-mcp', 'api-broker'], runtimeGeneration,
  }).token;

  const post = (token: string | undefined, body: unknown) => fetch(`${baseUrl}/api/broker/request`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  it('derives task/workspace/generation only from the api-broker capability', async () => {
    const response = await post(taskToken(), sharedContractFixtures.brokerRequest);
    assert.equal(response.status, 200);
    assert.equal(captured?.context.taskId, 'task-1');
    assert.equal(captured?.context.workspaceId, 'workspace-1');
    assert.equal(captured?.context.grantScope, 'generation-7');
    assert.deepEqual(captured?.request, sharedContractFixtures.brokerRequest);

    const forged = { ...sharedContractFixtures.brokerRequest, sessionId: 'forged', workspaceId: 'forged' };
    assert.equal(brokerRequestSchema.safeParse(forged).success, false, 'shared strict schema rejects self-asserted identity');
  });

  it('rejects WeCom, desktop, missing, and revoked credentials', async () => {
    const wecom = capabilities.mintForSession({
      sessionId: 'task-1', workspaceId: 'workspace-1', botId: 'bot-1',
      kind: 'wecom', audiences: ['wecom-cli'], runtimeGeneration: 'wecom-generation',
    }).token;
    assert.equal((await post(wecom, {})).status, 401);
    assert.equal((await post('desktop-token', {})).status, 403);
    assert.equal((await post(undefined, {})).status, 401);
    const revoked = taskToken();
    capabilities.revokeKind('task-1', 'task');
    assert.equal((await post(revoked, {})).status, 401);
    assert.equal(captured, undefined);
  });

  it('aborts broker execution when the client socket closes', async () => {
    let aborted = false;
    browserApiBrokerService.execute = (context) => new Promise<BrokerResult>((resolve) => {
      context.signal?.addEventListener('abort', () => {
        aborted = true;
        resolve({
          version: 1, ok: false, code: 'authorization_cancelled',
          message: 'cancelled', recovery: 'retry', retryable: false,
        });
      }, { once: true });
    });
    const target = new URL(`${baseUrl}/api/broker/request`);
    const token = taskToken();
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    request.once('error', () => undefined);
    request.end(JSON.stringify(sharedContractFixtures.brokerRequest));
    await new Promise((resolve) => setTimeout(resolve, 20));
    request.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(aborted, true);
  });

  it('returns a bounded JSON error when broker execution rejects', async () => {
    browserApiBrokerService.execute = async () => {
      throw new Error('sensitive-internal-failure');
    };
    const response = await post(taskToken(), sharedContractFixtures.brokerRequest);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: 'broker_failed',
      message: 'Broker request failed.',
    });
  });
});
