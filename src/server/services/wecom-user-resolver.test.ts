import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { botService } from './bot-service.js';
import { wecomUserResolver } from './wecom-user-resolver.js';

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

describe('WeComUserIdResolver flushWorkspaceNow', { concurrency: false }, () => {
  const resolverQueue = (wecomUserResolver as unknown as { queue: Map<string, Set<string>> }).queue;
  const resolverRetryMeta = (wecomUserResolver as unknown as { retryMeta: Map<string, Map<string, unknown>> }).retryMeta;

  beforeEach(async () => {
    workspaceStore.resetData();
    resolverQueue.clear();
    resolverRetryMeta.clear();
  });

  async function createWorkspace(withCredentials: boolean) {
    return workspaceStore.create({
      name: 'ws',
      folderPath: '/tmp/ws',
      settings: withCredentials
        ? { wecomCorpId: 'CORP', wecomCorpSecret: 'SECRET' }
        : {},
    });
  }

  function createWecomBot(workspaceId: string) {
    return botService.createBot({
      name: 'WeCom Bot',
      activeWorkspaceId: workspaceId,
      channelSettings: {
        wecom: {
          enabled: true,
          botId: 'wecom-bot',
          botSecret: 'wecom-secret',
        },
      },
    });
  }

  it('resolves queued IDs and stores mappings', async () => {
    const ws = await createWorkspace(true);
    const bot = createWecomBot(ws.id);
    global.fetch = mockFetchForBatch({ E1: 'U1', E2: 'U2' });

    await wecomUserResolver.resolveOnMessage(ws.id, 'E1');
    await wecomUserResolver.resolveOnMessage(ws.id, 'E2');

    const result = await wecomUserResolver.flushWorkspaceNow(ws.id);

    assert.deepStrictEqual(result, { resolved: 2, failed: 0 });
    assert.strictEqual(resolverQueue.size, 0);

    const users = workspaceStore.listBotUsers(bot.id);
    const resolved = users.filter((u) => u.plaintextUserId);
    assert.strictEqual(resolved.length, 2);
    assert.ok(resolved.some((u) => u.channelUserId === 'E1' && u.plaintextUserId === 'U1'));
    assert.ok(resolved.some((u) => u.channelUserId === 'E2' && u.plaintextUserId === 'U2'));
  });

  it('returns zero counts and clears the queue when workspace has no credentials', async () => {
    const ws = await createWorkspace(false);
    createWecomBot(ws.id);
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    };

    await wecomUserResolver.resolveOnMessage(ws.id, 'E1');

    const result = await wecomUserResolver.flushWorkspaceNow(ws.id);

    assert.deepStrictEqual(result, { resolved: 0, failed: 0 });
    assert.strictEqual(resolverQueue.size, 0);
    assert.strictEqual(fetchCalled, false);
  });

  it('returns zero counts without calling the API when the queue is empty', async () => {
    const ws = await createWorkspace(true);
    createWecomBot(ws.id);
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    };

    const result = await wecomUserResolver.flushWorkspaceNow(ws.id);

    assert.deepStrictEqual(result, { resolved: 0, failed: 0 });
    assert.strictEqual(fetchCalled, false);
  });

  it('short-circuits when mapping is already resolved', async () => {
    const ws = await createWorkspace(true);
    createWecomBot(ws.id);
    global.fetch = mockFetchForBatch({ E1: 'U1' });

    await wecomUserResolver.resolveOnMessage(ws.id, 'E1');
    await wecomUserResolver.flushWorkspaceNow(ws.id);

    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    };

    await wecomUserResolver.resolveOnMessage(ws.id, 'E1');
    const result = await wecomUserResolver.flushWorkspaceNow(ws.id);

    assert.deepStrictEqual(result, { resolved: 0, failed: 0 });
    assert.strictEqual(fetchCalled, false);
  });

  it('tracks workspace user without resolving', async () => {
    const ws = await createWorkspace(true);
    const bot = createWecomBot(ws.id);
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    };

    wecomUserResolver.trackWorkspaceUser(ws.id, 'E1');

    const users = workspaceStore.listBotUsers(bot.id);
    assert.ok(users.some((u) => u.channelUserId === 'E1'));
    assert.strictEqual(fetchCalled, false);
  });
});
