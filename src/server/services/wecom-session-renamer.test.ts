import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { WeComSessionRenamer } from './wecom-session-renamer.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import { botService } from './bot-service.js';
import type { ChatSession } from '../models/session.js';

describe('WeComSessionRenamer', { concurrency: false }, () => {
  let renamer: WeComSessionRenamer;
  let originalUpdateSession: typeof chatService.updateSession;
  const updatedSessions: Array<{ id: string; name: string; workspaceId: string }> = [];

  beforeEach(() => {
    workspaceStore.resetData();
    renamer = new WeComSessionRenamer();
    originalUpdateSession = chatService.updateSession.bind(chatService);
    updatedSessions.length = 0;

    chatService.updateSession = async (id: string, input: { name?: string }, workspaceId: string) => {
      if (input.name) {
        updatedSessions.push({ id, name: input.name, workspaceId });
      }
      return null as unknown as ChatSession;
    };
  });

  afterEach(() => {
    chatService.updateSession = originalUpdateSession;
  });

  function createWecomBot(workspaceId: string) {
    return botService.createBot({
      name: 'WeCom Bot',
      activeWorkspaceId: workspaceId,
      channelSettings: {
        wecom: { enabled: true, corpId: 'test-corp', corpSecret: 'test-secret', agentId: 'test-agent' },
      },
    });
  }

  function addWecomUser(botId: string, channelUserId: string, plaintextUserId?: string) {
    return botService.addMember(botId, {
      channelKey: 'wecom',
      channelUserId,
      plaintextUserId,
    });
  }

  async function createWecomSession(workspaceId: string, userId: string, customTitle?: string) {
    const session = await chatService.createSession({
      workspaceId,
      name: 'wecom session',
      source: 'wecom',
      customTitle,
    });
    workspaceStore.addUserSession(workspaceId, session.id, userId);
    workspaceStore.setActiveUserSession(userId, session.id);
    return session;
  }

  it('renames single session to "user session"', async () => {
    const bot = createWecomBot('ws-1');
    const user = addWecomUser(bot.id, 'enc-1', 'john.doe');
    await createWecomSession('ws-1', user.id);

    await renamer.renameSessionsForUser('ws-1', 'enc-1');

    assert.strictEqual(updatedSessions.length, 1);
    assert.strictEqual(updatedSessions[0].name, 'john.doe session');
  });

  it('renames multiple sessions with sequential numbers', async () => {
    const bot = createWecomBot('ws-1');
    const user = addWecomUser(bot.id, 'enc-1', 'john.doe');
    await createWecomSession('ws-1', user.id);
    await createWecomSession('ws-1', user.id);

    await renamer.renameSessionsForUser('ws-1', 'enc-1');

    assert.strictEqual(updatedSessions.length, 2);
    assert.strictEqual(updatedSessions[0].name, 'john.doe session #1');
    assert.strictEqual(updatedSessions[1].name, 'john.doe session #2');
  });

  it('skips sessions with customTitle', async () => {
    const bot = createWecomBot('ws-1');
    const user = addWecomUser(bot.id, 'enc-1', 'john.doe');
    await createWecomSession('ws-1', user.id, 'Project Alpha');
    await createWecomSession('ws-1', user.id);

    await renamer.renameSessionsForUser('ws-1', 'enc-1');

    assert.strictEqual(updatedSessions.length, 1);
    assert.strictEqual(updatedSessions[0].name, 'john.doe session');
  });

  it('skips GUI sessions', async () => {
    const bot = createWecomBot('ws-1');
    const user = addWecomUser(bot.id, 'enc-1', 'john.doe');
    const session = await chatService.createSession({ workspaceId: 'ws-1', name: 'gui session', source: 'gui' });
    workspaceStore.addUserSession('ws-1', session.id, user.id);
    workspaceStore.setActiveUserSession(user.id, session.id);

    await renamer.renameSessionsForUser('ws-1', 'enc-1');

    assert.strictEqual(updatedSessions.length, 0);
  });

  it('handles updateSession failure gracefully', async () => {
    const bot = createWecomBot('ws-1');
    const user = addWecomUser(bot.id, 'enc-1', 'john.doe');
    const session1 = await createWecomSession('ws-1', user.id);
    const session2 = await createWecomSession('ws-1', user.id);

    chatService.updateSession = async (id: string) => {
      if (id === session1.id) throw new Error('SDK rename failed');
      updatedSessions.push({ id, name: 'john.doe session', workspaceId: 'ws-1' });
      return null as unknown as ChatSession;
    };

    await renamer.renameSessionsForUser('ws-1', 'enc-1');

    assert.strictEqual(updatedSessions.length, 1);
    assert.strictEqual(updatedSessions[0].id, session2.id);
  });

  it('is a no-op when no mapping exists', async () => {
    const bot = createWecomBot('ws-1');
    addWecomUser(bot.id, 'enc-1');

    await renamer.renameSessionsForUser('ws-1', 'enc-1');

    assert.strictEqual(updatedSessions.length, 0);
  });

  it('is a no-op when no eligible sessions exist', async () => {
    const bot = createWecomBot('ws-1');
    const user = addWecomUser(bot.id, 'enc-1', 'john.doe');
    const session = await chatService.createSession({ workspaceId: 'ws-1', name: 'gui session', source: 'gui' });
    workspaceStore.addUserSession('ws-1', session.id, user.id);
    workspaceStore.setActiveUserSession(user.id, session.id);

    await renamer.renameSessionsForUser('ws-1', 'enc-1');

    assert.strictEqual(updatedSessions.length, 0);
  });

  it('backfills existing sessions', async () => {
    const workspace = await workspaceStore.create({ name: 'Test Workspace', folderPath: '/tmp/ws-1' });
    const bot = createWecomBot(workspace.id);
    const user = addWecomUser(bot.id, 'enc-1', 'john.doe');
    const session = await createWecomSession(workspace.id, user.id);

    await renamer.backfillExistingSessions();

    assert.strictEqual(updatedSessions.length, 1);
    assert.strictEqual(updatedSessions[0].name, 'john.doe session');
    assert.strictEqual(updatedSessions[0].id, session.id);
  });
});
