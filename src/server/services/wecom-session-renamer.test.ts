import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { WeComSessionRenamer } from './wecom-session-renamer.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import type { ChatSession } from '../models/session.js';

describe('WeComSessionRenamer', { concurrency: false }, () => {
  let renamer: WeComSessionRenamer;
  let originalGetWecomUserMapping: typeof workspaceStore.getWecomUserMapping;
  let originalListWecomSessionsByUser: typeof workspaceStore.listWecomSessionsByUser;
  let originalGetLocalSession: typeof workspaceStore.getLocalSession;
  let originalUpdateSession: typeof chatService.updateSession;
  const updatedSessions: Array<{ id: string; name: string; workspaceId: string }> = [];

  beforeEach(() => {
    renamer = new WeComSessionRenamer();
    originalGetWecomUserMapping = workspaceStore.getWecomUserMapping.bind(workspaceStore);
    originalListWecomSessionsByUser = workspaceStore.listWecomSessionsByUser.bind(workspaceStore);
    originalGetLocalSession = workspaceStore.getLocalSession.bind(workspaceStore);
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
    workspaceStore.getWecomUserMapping = originalGetWecomUserMapping;
    workspaceStore.listWecomSessionsByUser = originalListWecomSessionsByUser;
    workspaceStore.getLocalSession = originalGetLocalSession;
    chatService.updateSession = originalUpdateSession;
  });

  function mockMapping(encryptedUserId: string, plaintextUserId: string | null) {
    workspaceStore.getWecomUserMapping = () => plaintextUserId;
  }

  function mockSessions(mappings: Array<{ sessionId: string; createdAt: string }>, sessions: Record<string, ChatSession>) {
    workspaceStore.listWecomSessionsByUser = () => mappings;
    workspaceStore.getLocalSession = (id: string) => sessions[id] ?? null;
  }

  it('renames single session to "user session"', async () => {
    mockMapping('enc-1', 'john.doe');
    mockSessions(
      [{ sessionId: 'sess-1', createdAt: '2026-01-01T00:00:00.000Z' }],
      {
        'sess-1': {
          id: 'sess-1',
          workspaceId: 'ws-1',
          name: 'enc-1',
          source: 'wecom',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        } as ChatSession,
      },
    );

    await renamer.renameSessionsForUser('ws-1', 'enc-1');

    assert.strictEqual(updatedSessions.length, 1);
    assert.strictEqual(updatedSessions[0].name, 'john.doe session');
  });

  it('renames multiple sessions with sequential numbers', async () => {
    mockMapping('enc-1', 'john.doe');
    mockSessions(
      [
        { sessionId: 'sess-1', createdAt: '2026-01-01T00:00:00.000Z' },
        { sessionId: 'sess-2', createdAt: '2026-01-02T00:00:00.000Z' },
      ],
      {
        'sess-1': {
          id: 'sess-1',
          workspaceId: 'ws-1',
          name: 'enc-1',
          source: 'wecom',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        } as ChatSession,
        'sess-2': {
          id: 'sess-2',
          workspaceId: 'ws-1',
          name: 'enc-1',
          source: 'wecom',
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        } as ChatSession,
      },
    );

    await renamer.renameSessionsForUser('ws-1', 'enc-1');

    assert.strictEqual(updatedSessions.length, 2);
    assert.strictEqual(updatedSessions[0].name, 'john.doe session #1');
    assert.strictEqual(updatedSessions[1].name, 'john.doe session #2');
  });

  it('skips sessions with customTitle', async () => {
    mockMapping('enc-1', 'john.doe');
    mockSessions(
      [
        { sessionId: 'sess-1', createdAt: '2026-01-01T00:00:00.000Z' },
        { sessionId: 'sess-2', createdAt: '2026-01-02T00:00:00.000Z' },
      ],
      {
        'sess-1': {
          id: 'sess-1',
          workspaceId: 'ws-1',
          name: 'enc-1',
          source: 'wecom',
          customTitle: 'Project Alpha',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        } as ChatSession,
        'sess-2': {
          id: 'sess-2',
          workspaceId: 'ws-1',
          name: 'enc-1',
          source: 'wecom',
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        } as ChatSession,
      },
    );

    await renamer.renameSessionsForUser('ws-1', 'enc-1');

    assert.strictEqual(updatedSessions.length, 1);
    assert.strictEqual(updatedSessions[0].id, 'sess-2');
    assert.strictEqual(updatedSessions[0].name, 'john.doe session');
  });

  it('skips GUI sessions', async () => {
    mockMapping('enc-1', 'john.doe');
    mockSessions(
      [{ sessionId: 'sess-1', createdAt: '2026-01-01T00:00:00.000Z' }],
      {
        'sess-1': {
          id: 'sess-1',
          workspaceId: 'ws-1',
          name: 'enc-1',
          source: 'gui',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        } as ChatSession,
      },
    );

    await renamer.renameSessionsForUser('ws-1', 'enc-1');

    assert.strictEqual(updatedSessions.length, 0);
  });

  it('handles updateSession failure gracefully', async () => {
    mockMapping('enc-1', 'john.doe');
    mockSessions(
      [
        { sessionId: 'sess-1', createdAt: '2026-01-01T00:00:00.000Z' },
        { sessionId: 'sess-2', createdAt: '2026-01-02T00:00:00.000Z' },
      ],
      {
        'sess-1': {
          id: 'sess-1',
          workspaceId: 'ws-1',
          name: 'enc-1',
          source: 'wecom',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        } as ChatSession,
        'sess-2': {
          id: 'sess-2',
          workspaceId: 'ws-1',
          name: 'enc-1',
          source: 'wecom',
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        } as ChatSession,
      },
    );

    chatService.updateSession = async (id: string) => {
      if (id === 'sess-1') throw new Error('SDK rename failed');
      updatedSessions.push({ id, name: 'john.doe session', workspaceId: 'ws-1' });
      return null as unknown as ChatSession;
    };

    await renamer.renameSessionsForUser('ws-1', 'enc-1');

    assert.strictEqual(updatedSessions.length, 1);
    assert.strictEqual(updatedSessions[0].id, 'sess-2');
  });

  it('is a no-op when no mapping exists', async () => {
    mockMapping('enc-1', null);

    await renamer.renameSessionsForUser('ws-1', 'enc-1');

    assert.strictEqual(updatedSessions.length, 0);
  });

  it('is a no-op when no eligible sessions exist', async () => {
    mockMapping('enc-1', 'john.doe');
    mockSessions(
      [{ sessionId: 'sess-1', createdAt: '2026-01-01T00:00:00.000Z' }],
      {
        'sess-1': {
          id: 'sess-1',
          workspaceId: 'ws-1',
          name: 'enc-1',
          source: 'gui',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        } as ChatSession,
      },
    );

    await renamer.renameSessionsForUser('ws-1', 'enc-1');

    assert.strictEqual(updatedSessions.length, 0);
  });

  it('backfills existing sessions', async () => {
    const originalListForBackfill = workspaceStore.listWecomSessionsForBackfill.bind(workspaceStore);
    workspaceStore.listWecomSessionsForBackfill = () => [
      { workspaceId: 'ws-1', wecomUserId: 'enc-1', sessionId: 'sess-1', createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    mockMapping('enc-1', 'john.doe');
    workspaceStore.getLocalSession = (id: string) => {
      if (id === 'sess-1') {
        return {
          id: 'sess-1',
          workspaceId: 'ws-1',
          name: 'enc-1',
          source: 'wecom',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        } as ChatSession;
      }
      return null;
    };

    await renamer.backfillExistingSessions();

    workspaceStore.listWecomSessionsForBackfill = originalListForBackfill;

    assert.strictEqual(updatedSessions.length, 1);
    assert.strictEqual(updatedSessions[0].name, 'john.doe session');
  });
});