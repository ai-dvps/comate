import { describe, it, beforeEach, vi } from 'vitest';
import assert from 'node:assert';
import { useBotStore, type BotUser } from './bot-store';

function mockFetch(response: { status: number; body?: unknown }) {
  return vi.fn().mockResolvedValue(
    new Response(response.body !== undefined ? JSON.stringify(response.body) : undefined, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function makeMember(overrides?: Partial<BotUser>): BotUser {
  return {
    id: 'user-1',
    botId: 'bot-1',
    // channelId is the DB row id; channelKey is the human-readable channel.
    channelId: 'channel-db-uuid',
    channelKey: 'wecom',
    roleId: 'role-normal',
    channelUserId: 'u-1',
    plaintextUserId: null,
    displayName: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    roleKey: 'normal',
    resolutionStatus: 'pending',
    ...overrides,
  };
}

describe('useBotStore member mutations', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    useBotStore.setState({
      bots: [],
      membersByBotId: {
        'bot-1': [makeMember()],
      },
      channelStatusByBotId: {},
      isLoading: false,
      isSaving: false,
      migrationResult: null,
      error: null,
    });
  });

  it('setMemberRole updates local state when channelId differs from channelKey', async () => {
    global.fetch = mockFetch({ status: 204 });

    await useBotStore.getState().setMemberRole('bot-1', 'wecom', 'u-1', 'admin');

    const members = useBotStore.getState().membersByBotId['bot-1'];
    assert.strictEqual(members.length, 1);
    assert.strictEqual(members[0].roleKey, 'admin');
    assert.strictEqual(useBotStore.getState().error, null);
  });

  it('setMemberRole leaves other members unchanged', async () => {
    useBotStore.setState({
      membersByBotId: {
        'bot-1': [makeMember(), makeMember({ id: 'user-2', channelUserId: 'u-2', roleKey: 'normal' })],
      },
    });
    global.fetch = mockFetch({ status: 204 });

    await useBotStore.getState().setMemberRole('bot-1', 'wecom', 'u-1', 'admin');

    const members = useBotStore.getState().membersByBotId['bot-1'];
    assert.strictEqual(members.length, 2);
    assert.strictEqual(members.find((m) => m.channelUserId === 'u-1')?.roleKey, 'admin');
    assert.strictEqual(members.find((m) => m.channelUserId === 'u-2')?.roleKey, 'normal');
  });

  it('removeMember removes the right member when channelId differs from channelKey', async () => {
    global.fetch = mockFetch({ status: 204 });

    await useBotStore.getState().removeMember('bot-1', 'wecom', 'u-1');

    const members = useBotStore.getState().membersByBotId['bot-1'];
    assert.strictEqual(members.length, 0);
    assert.strictEqual(useBotStore.getState().error, null);
  });

  it('setMemberPlaintext updates local state when channelId differs from channelKey', async () => {
    const updated: BotUser = makeMember({ plaintextUserId: 'resolved-id', resolutionStatus: 'resolved' });
    global.fetch = mockFetch({ status: 200, body: { member: updated } });

    await useBotStore.getState().setMemberPlaintext('bot-1', 'wecom', 'u-1', 'resolved-id');

    const members = useBotStore.getState().membersByBotId['bot-1'];
    assert.strictEqual(members.length, 1);
    assert.strictEqual(members[0].plaintextUserId, 'resolved-id');
    assert.strictEqual(members[0].resolutionStatus, 'resolved');
    assert.strictEqual(useBotStore.getState().error, null);
  });
});

describe('useBotStore channel status', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    useBotStore.setState({
      bots: [],
      membersByBotId: {},
      channelStatusByBotId: {},
      isLoading: false,
      isSaving: false,
      migrationResult: null,
      error: null,
    });
  });

  it('fetchStatus stores per-channel statuses and errors', async () => {
    global.fetch = mockFetch({
      status: 200,
      body: { wecom: 'connected', feishu: 'error', errors: { feishu: 'Auth failed' } },
    });

    await useBotStore.getState().fetchStatus('bot-1');

    const status = useBotStore.getState().channelStatusByBotId['bot-1'];
    assert.strictEqual(status.wecom, 'connected');
    assert.strictEqual(status.feishu, 'error');
    assert.strictEqual(status.errors?.feishu, 'Auth failed');
  });

  it('reconnectChannel updates stored status on success', async () => {
    global.fetch = mockFetch({
      status: 200,
      body: { wecom: 'connected', feishu: 'not_configured' },
    });

    const result = await useBotStore.getState().reconnectChannel('bot-1', 'wecom');

    assert.strictEqual(result.ok, true);
    const status = useBotStore.getState().channelStatusByBotId['bot-1'];
    assert.strictEqual(status.wecom, 'connected');
  });

  it('reconnectChannel returns error and sets store error on failure', async () => {
    global.fetch = mockFetch({ status: 502, body: { error: 'Connection failed' } });

    const result = await useBotStore.getState().reconnectChannel('bot-1', 'wecom');

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'Connection failed');
    assert.strictEqual(useBotStore.getState().error, 'Connection failed');
  });
});
