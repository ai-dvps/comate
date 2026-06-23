import '../test-utils/test-env.js';
// Ensure diagLog mirrors to console so this test can capture logged output.
process.env.COMATE_SIDECAR = '';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { FeishuUserResolver } from './feishu-user-resolver.js';
import type * as lark from '@larksuiteoapi/node-sdk';

function createFakeLarkClient(batchResult?: { users?: Array<{ user_id?: string; name?: string } > }): lark.Client {
  return {
    contact: {
      user: {
        basicBatch: async () => ({ data: batchResult }),
      },
    },
  } as unknown as lark.Client;
}

function createFailingLarkClient(error: Error): lark.Client {
  return {
    contact: {
      user: {
        basicBatch: async () => {
          throw error;
        },
      },
    },
  } as unknown as lark.Client;
}

describe('FeishuUserResolver', { concurrency: false }, () => {
  const resolver = new FeishuUserResolver();

  beforeEach(() => {
    workspaceStore.resetData();
  });

  async function createWorkspace(name: string) {
    return workspaceStore.create({ name, folderPath: `/tmp/${name}` });
  }

  it('does not call Feishu API when name is already cached', async () => {
    const ws = await createWorkspace('Resolver Cached');
    workspaceStore.setFeishuWorkspaceUser(ws.id, 'ou-alice');
    workspaceStore.setFeishuWorkspaceUserName(ws.id, 'ou-alice', 'Alice', 'alice-uid');

    let called = false;
    const client = {
      contact: { user: { basicBatch: async () => { called = true; return { data: { users: [] } }; } } },
    } as unknown as lark.Client;

    await resolver.resolveOnMessage(ws.id, 'ou-alice', client);

    assert.strictEqual(called, false);
  });

  it('resolves and caches name and user_id for uncached user', async () => {
    const ws = await createWorkspace('Resolver Resolve');
    workspaceStore.setFeishuWorkspaceUser(ws.id, 'ou-bob');

    const client = createFakeLarkClient({
      users: [{ user_id: 'bob-uid', open_id: 'ou-bob', name: 'Bob' }],
    });

    await resolver.resolveOnMessage(ws.id, 'ou-bob', client);

    const user = workspaceStore.getFeishuWorkspaceUser(ws.id, 'ou-bob');
    assert.ok(user);
    assert.strictEqual(user.name, 'Bob');
    assert.strictEqual(user.userId, 'bob-uid');
  });

  it('caches name when user_id is absent from response', async () => {
    const ws = await createWorkspace('Resolver Name Only');
    workspaceStore.setFeishuWorkspaceUser(ws.id, 'ou-carol');

    const client = createFakeLarkClient({ users: [{ name: 'Carol' }] });

    await resolver.resolveOnMessage(ws.id, 'ou-carol', client);

    const user = workspaceStore.getFeishuWorkspaceUser(ws.id, 'ou-carol');
    assert.ok(user);
    assert.strictEqual(user.name, 'Carol');
    assert.strictEqual(user.userId, null);
  });

  it('swallows Feishu API errors without throwing', async () => {
    const ws = await createWorkspace('Resolver Error');
    workspaceStore.setFeishuWorkspaceUser(ws.id, 'ou-dave');

    const client = createFailingLarkClient(new Error('scope error for ou_dave'));

    await assert.doesNotReject(async () => {
      await resolver.resolveOnMessage(ws.id, 'ou-dave', client);
    });

    const user = workspaceStore.getFeishuWorkspaceUser(ws.id, 'ou-dave');
    assert.ok(user);
    assert.strictEqual(user.name, null);
  });

  it('redacts open_id and credentials from logged errors', async () => {
    const ws = await createWorkspace('Resolver Redaction');
    workspaceStore.setFeishuWorkspaceUser(ws.id, 'ou-eve-secret');

    const client = createFailingLarkClient(
      new Error('request failed for ou_eve-secret with appId=secret-id appSecret=secret-key'),
    );

    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };

    try {
      await resolver.resolveOnMessage(ws.id, 'ou-eve-secret', client);
    } finally {
      console.log = originalLog;
    }

    const combined = logs.join('\n');
    assert.ok(combined.includes('[FeishuUserResolver] resolution failed:'));
    assert.ok(!combined.includes('ou-eve-secret'), 'logged error should not contain raw open_id');
    assert.ok(!combined.includes('secret-id'), 'logged error should not contain appId');
    assert.ok(!combined.includes('secret-key'), 'logged error should not contain appSecret');
    assert.ok(combined.includes('<open_id>'));
    assert.ok(combined.includes('appId=<redacted>'));
    assert.ok(combined.includes('appSecret=<redacted>'));
  });

  it('returns without throwing when larkClient is missing', async () => {
    const ws = await createWorkspace('Resolver No Client');
    workspaceStore.setFeishuWorkspaceUser(ws.id, 'ou-frank');

    await assert.doesNotReject(async () => {
      await resolver.resolveOnMessage(ws.id, 'ou-frank', undefined as unknown as lark.Client);
    });
  });
});
