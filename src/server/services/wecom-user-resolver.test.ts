import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { wecomUserResolver } from './wecom-user-resolver.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import type { Workspace } from '../models/workspace.js';

describe('WeComUserIdResolver flushWorkspaceNow', { concurrency: false }, () => {
  let originalGet: typeof workspaceStore.get;
  let originalGetMapping: typeof workspaceStore.getWecomUserMapping;
  let originalSetMapping: typeof workspaceStore.setWecomUserMapping;
  let originalFetch: typeof global.fetch;

  const resolverQueue = (wecomUserResolver as unknown as { queue: Map<string, Set<string>> }).queue;
  const resolverRetryMeta = (wecomUserResolver as unknown as { retryMeta: Map<string, Map<string, unknown>> }).retryMeta;

  beforeEach(() => {
    originalGet = workspaceStore.get.bind(workspaceStore);
    originalGetMapping = workspaceStore.getWecomUserMapping.bind(workspaceStore);
    originalSetMapping = workspaceStore.setWecomUserMapping.bind(workspaceStore);
    originalFetch = global.fetch;

    resolverQueue.clear();
    resolverRetryMeta.clear();
  });

  afterEach(() => {
    workspaceStore.get = originalGet;
    workspaceStore.getWecomUserMapping = originalGetMapping;
    workspaceStore.setWecomUserMapping = originalSetMapping;
    global.fetch = originalFetch;

    resolverQueue.clear();
    resolverRetryMeta.clear();
  });

  function stubWorkspace(withCredentials: boolean): void {
    workspaceStore.get = async () =>
      ({
        id: 'ws-1',
        settings: {
          wecomCorpId: withCredentials ? 'CORP' : undefined,
          wecomCorpSecret: withCredentials ? 'SECRET' : undefined,
        },
      } as Workspace);
  }

  function mockFetchForBatch(mappings: Record<string, string>): typeof global.fetch {
    return async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/gettoken')) {
        return {
          ok: true,
          json: async () => ({ errcode: 0, access_token: 'tok', expires_in: 7200 }),
        } as Response;
      }

      if (url.includes('/openuserid_to_userid')) {
        let body: { open_userid_list?: string[] } = {};
        const rawBody = input instanceof Request ? await input.text() : init?.body;
        if (typeof rawBody === 'string' && rawBody.length > 0) {
          body = JSON.parse(rawBody) as typeof body;
        }
        const ids = body.open_userid_list ?? [];
        const useridList = ids
          .filter((id) => mappings[id] !== undefined)
          .map((id) => ({ open_userid: id, userid: mappings[id] }));
        return {
          ok: true,
          json: async () => ({ errcode: 0, userid_list: useridList, invalid_open_userid_list: [] }),
        } as Response;
      }

      return { ok: false, status: 404, json: async () => ({}) } as Response;
    };
  }

  it('resolves queued IDs and stores mappings', async () => {
    stubWorkspace(true);
    workspaceStore.getWecomUserMapping = () => null;
    const stored: Array<[string, string]> = [];
    workspaceStore.setWecomUserMapping = (encryptedUserId: string, plaintextUserId: string) => {
      stored.push([encryptedUserId, plaintextUserId]);
    };
    global.fetch = mockFetchForBatch({ E1: 'U1', E2: 'U2' });

    await wecomUserResolver.resolveOnMessage('ws-1', 'E1');
    await wecomUserResolver.resolveOnMessage('ws-1', 'E2');

    const result = await wecomUserResolver.flushWorkspaceNow('ws-1');

    assert.deepStrictEqual(result, { resolved: 2, failed: 0 });
    assert.strictEqual(stored.length, 2);
    assert.ok(stored.some(([e, p]) => e === 'E1' && p === 'U1'));
    assert.ok(stored.some(([e, p]) => e === 'E2' && p === 'U2'));
    assert.strictEqual(resolverQueue.size, 0);
  });

  it('returns zero counts and clears the queue when workspace has no credentials', async () => {
    stubWorkspace(false);
    workspaceStore.getWecomUserMapping = () => null;
    workspaceStore.setWecomUserMapping = () => {
      throw new Error('setWecomUserMapping should not be called');
    };
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    };

    await wecomUserResolver.resolveOnMessage('ws-1', 'E1');

    const result = await wecomUserResolver.flushWorkspaceNow('ws-1');

    assert.deepStrictEqual(result, { resolved: 0, failed: 0 });
    assert.strictEqual(resolverQueue.size, 0);
    assert.strictEqual(fetchCalled, false);
  });

  it('returns zero counts without calling the API when the queue is empty', async () => {
    stubWorkspace(true);
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    };

    const result = await wecomUserResolver.flushWorkspaceNow('ws-1');

    assert.deepStrictEqual(result, { resolved: 0, failed: 0 });
    assert.strictEqual(fetchCalled, false);
  });
});
