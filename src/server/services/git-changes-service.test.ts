import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { store as workspaceStore, SqliteStore } from '../storage/sqlite-store.js';
import { writeFile, rm, mkdtemp } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import { GitChangesService } from './git-changes-service.js';
import type { WebSocket } from 'ws';
import type { GitStatusItem } from '../routes/git-changes.js';

const execFileAsync = promisify(execFile);

async function mkdtempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'comate-git-watcher-test-'));
}

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
}

function createMockSocket(): MockSocket {
  const messages: unknown[] = [];
  return {
    readyState: 1,
    messages,
    send(data: unknown) {
      messages.push(JSON.parse(data as string));
    },
  } as unknown as MockSocket;
}

interface MockSocket {
  readyState: number;
  messages: unknown[];
  send(data: unknown): void;
}

function createFakeStore(folderPath: string): SqliteStore {
  const fake = Object.create(SqliteStore.prototype) as SqliteStore;
  fake.get = async () => ({
    id: 'ws-1',
    name: 'test',
    folderPath,
    settings: {},
    skills: [],
    mcpServers: [],
    hooks: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastOpenedAt: null,
  });
  return fake;
}

describe('git-changes service', { concurrency: false }, () => {
  let tempDir: string;
  let service: GitChangesService;

  beforeEach(async () => {
    tempDir = await mkdtempDir();
    workspaceStore.resetData();
  });

  afterEach(async () => {
    if (service) {
      await service.dispose();
    }
    workspaceStore.resetData();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('broadcasts git_changes event when a file changes', async () => {
    await initGitRepo(tempDir);
    await writeFile(path.join(tempDir, 'file.txt'), 'initial');
    await execFileAsync('git', ['add', 'file.txt'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: tempDir });

    const statusItems: GitStatusItem[] = [
      { path: 'file.txt', indexStatus: ' ', workingTreeStatus: 'M' },
    ];
    let statusCalls = 0;
    const fakeStore = createFakeStore(tempDir);
    service = new GitChangesService(fakeStore, async () => {
      statusCalls++;
      return statusItems;
    });

    const socket = createMockSocket();
    await service.subscribe('ws-1', socket as unknown as WebSocket);

    // Wait for the initial refresh.
    await waitFor(() => socket.messages.length > 0, 3000);

    // Clear initial event.
    socket.messages.length = 0;
    statusCalls = 0;

    // Trigger a change.
    await writeFile(path.join(tempDir, 'file.txt'), 'changed');

    await waitFor(() => socket.messages.length > 0, 3000);

    assert.strictEqual(statusCalls, 1);
    const event = socket.messages[0] as {
      type: string;
      eventType: string;
      workspaceId: string;
      data: { type: string; items: GitStatusItem[] };
    };
    assert.strictEqual(event.type, 'event');
    assert.strictEqual(event.eventType, 'git_changes');
    assert.strictEqual(event.workspaceId, 'ws-1');
    assert.strictEqual(event.data.type, 'git_changes');
    assert.strictEqual(event.data.items.length, 1);
    assert.strictEqual(event.data.items[0].path, 'file.txt');
  });

  it('stops events after unsubscribing', async () => {
    await initGitRepo(tempDir);
    await writeFile(path.join(tempDir, 'file.txt'), 'initial');
    await execFileAsync('git', ['add', 'file.txt'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: tempDir });

    let statusCalls = 0;
    const fakeStore = createFakeStore(tempDir);
    service = new GitChangesService(fakeStore, async () => {
      statusCalls++;
      return [];
    });

    const socket = createMockSocket();
    await service.subscribe('ws-1', socket as unknown as WebSocket);
    await waitFor(() => socket.messages.length > 0, 3000);
    socket.messages.length = 0;
    statusCalls = 0;

    await service.unsubscribe('ws-1', socket as unknown as WebSocket);

    await writeFile(path.join(tempDir, 'file.txt'), 'changed');
    await sleep(500);

    assert.strictEqual(socket.messages.length, 0);
    assert.strictEqual(statusCalls, 0);
  });

  it('coalesces git status runs across multiple sockets', async () => {
    await initGitRepo(tempDir);
    await writeFile(path.join(tempDir, 'file.txt'), 'initial');
    await execFileAsync('git', ['add', 'file.txt'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: tempDir });

    let statusCalls = 0;
    const fakeStore = createFakeStore(tempDir);
    service = new GitChangesService(fakeStore, async () => {
      statusCalls++;
      await sleep(100);
      return [{ path: 'file.txt', indexStatus: ' ', workingTreeStatus: 'M' }];
    });

    const socketA = createMockSocket();
    const socketB = createMockSocket();

    // Subscribe both sockets concurrently while the first status run is in flight.
    await Promise.all([
      service.subscribe('ws-1', socketA as unknown as WebSocket),
      service.subscribe('ws-1', socketB as unknown as WebSocket),
    ]);

    await waitFor(() => socketA.messages.length > 0 && socketB.messages.length > 0, 3000);

    // Initial refresh should run only once and be delivered to both sockets.
    assert.strictEqual(statusCalls, 1);
    assert.strictEqual(socketA.messages.length, 1);
    assert.strictEqual(socketB.messages.length, 1);
  });

  it('emits watcher_unavailable for missing workspace', async () => {
    const fakeStore = Object.create(SqliteStore.prototype) as SqliteStore;
    fakeStore.get = async () => null;

    service = new GitChangesService(fakeStore, async () => []);
    const socket = createMockSocket();

    await service.subscribe('missing-ws', socket as unknown as WebSocket);

    assert.strictEqual(socket.messages.length, 1);
    const event = socket.messages[0] as {
      eventType: string;
      workspaceId: string;
      data: { type: string; reason: string };
    };
    assert.strictEqual(event.eventType, 'watcher_unavailable');
    assert.strictEqual(event.workspaceId, 'missing-ws');
    assert.strictEqual(event.data.type, 'watcher_unavailable');
  });

  it('dispose closes watchers and releases resources', async () => {
    await initGitRepo(tempDir);
    const fakeStore = createFakeStore(tempDir);
    service = new GitChangesService(fakeStore, async () => []);
    const socket = createMockSocket();

    await service.subscribe('ws-1', socket as unknown as WebSocket);
    await waitFor(() => socket.messages.length > 0, 3000);

    await service.dispose();

    // After dispose, a change should not produce further events.
    socket.messages.length = 0;
    await writeFile(path.join(tempDir, 'file.txt'), 'changed');
    await sleep(500);
    assert.strictEqual(socket.messages.length, 0);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timeout');
    }
    await sleep(50);
  }
}
