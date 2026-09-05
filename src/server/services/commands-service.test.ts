import '../test-utils/test-env.js';
import { afterEach, describe, it, mock } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import type { Workspace } from '../models/workspace.js';
import { store } from '../storage/sqlite-store.js';
import { CommandsService } from './commands-service.js';
import { watch, type FSWatcher } from 'chokidar';

const originalDefault = store.getDefaultProvider.bind(store);

afterEach(() => {
  store.getDefaultProvider = originalDefault;
});

const workspace: Workspace = {
  id: 'w1', name: 'w', description: '', folderPath: '/tmp/comate-command-resolver-test',
  settings: {}, skills: [], mcpServers: [], hooks: [], createdAt: '', updatedAt: '', lastOpenedAt: null,
};

describe('CommandsService Provider resolution', () => {
  it('forwards native watcher EMFILE errors instead of throwing an unhandled event', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'comate-native-watcher-'));
    await mkdir(path.join(folder, '.claude', 'commands'), { recursive: true });
    const nativeWatchers: fs.FSWatcher[] = [];
    const originalWatch = fs.watch;
    const watchMock = mock.method(fs, 'watch', (...args: unknown[]) => {
      const watcher = Reflect.apply(originalWatch, fs, args) as fs.FSWatcher;
      nativeWatchers.push(watcher);
      return watcher;
    });
    syncBuiltinESMExports();
    const service = new CommandsService({ fetchInitialization: async () => ({ commands: [] }) } as never);
    try {
      service.watchSkills(folder);
      for (let i = 0; i < 100 && nativeWatchers.length === 0; i++) await delay(10);
      assert.ok(nativeWatchers.length > 0, 'Expected a real native watcher');
      const error = Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' });
      assert.doesNotThrow(() => nativeWatchers[0].emit('error', error));
      assert.equal((service as unknown as { watchers: Map<string, FSWatcher> }).watchers.size, 0);
      assert.ok(nativeWatchers[0].listenerCount('error') > 0);
    } finally {
      await service.dispose();
      watchMock.mock.restore();
      syncBuiltinESMExports();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('absorbs late watcher errors after disposing the service', async () => {
    const service = new CommandsService({ fetchInitialization: async () => ({ commands: [] }) } as never);
    const watcher = watch([]);
    const watchers = (service as unknown as { watchers: Map<string, FSWatcher> }).watchers;
    watchers.set('test', watcher);
    await service.dispose();
    assert.equal(watcher.closed, true);
    assert.equal(watchers.size, 0);
    assert.doesNotThrow(() => watcher.emit('error', Object.assign(new Error('EMFILE'), { code: 'EMFILE' })));
    await service.dispose();
    assert.equal(watcher.listenerCount('error'), 1);
  });

  it('does not initialize Claude when the default Provider is unavailable', async () => {
    let calls = 0;
    const sdk = { fetchInitialization: async () => { calls += 1; return { commands: [] }; } };
    store.getDefaultProvider = () => ({
      id: 'p1', name: 'bad', baseUrl: '', authToken: 'secret', isDefault: true,
      createdAt: '', updatedAt: '', configuration: {
        schemaVersion: 1, endpoints: {}, models: { claudeCode: 'm' },
        openCode: { protocol: 'anthropic' }, claude: {}, codex: {},
      },
    });
    const service = new CommandsService(sdk as never);
    const result = await service.getCommands(workspace);
    await service.dispose();
    assert.equal(calls, 0);
    assert.equal(result.partial, true);
    assert.match(result.partialReason ?? '', /endpoint-missing/);
  });

  it('passes the same resolved endpoint, model, and both Claude credential variables', async () => {
    let captured: { env?: NodeJS.ProcessEnv; model?: string } | undefined;
    const sdk = { fetchInitialization: async (options: typeof captured) => {
      captured = options;
      return { commands: [], availableOutputStyles: [] };
    } };
    store.getDefaultProvider = () => ({
      id: 'p1', name: 'ok', baseUrl: 'legacy', authToken: 'secret', isDefault: true,
      createdAt: '', updatedAt: '', configuration: {
        schemaVersion: 1,
        endpoints: { anthropic: { enabled: true, baseUrl: 'https://anthropic.example' } },
        models: { claudeCode: 'claude-model' }, openCode: { protocol: 'anthropic' }, claude: {}, codex: {},
      },
    });
    const service = new CommandsService(sdk as never);
    await service.getCommands({ ...workspace, folderPath: '/tmp/comate-command-resolver-test-2' });
    await service.dispose();
    assert.equal(captured?.env?.ANTHROPIC_BASE_URL, 'https://anthropic.example');
    assert.equal(captured?.env?.ANTHROPIC_API_KEY, 'secret');
    assert.equal(captured?.env?.ANTHROPIC_AUTH_TOKEN, 'secret');
    assert.equal(captured?.model, 'claude-model');
  });

  it('drops cached discovery when Provider configuration changes', async () => {
    let model = 'model-a';
    const seen: string[] = [];
    const sdk = { fetchInitialization: async (options: { model?: string }) => {
      seen.push(options.model ?? 'none');
      return { commands: [] };
    } };
    store.getDefaultProvider = () => ({
      id: 'p1', name: 'ok', baseUrl: 'legacy', authToken: 'secret', isDefault: true,
      createdAt: '', updatedAt: '', configuration: {
        schemaVersion: 1,
        endpoints: { anthropic: { enabled: true, baseUrl: 'https://anthropic.example' } },
        models: { claudeCode: model }, openCode: { protocol: 'anthropic' }, claude: {}, codex: {},
      },
    });
    const service = new CommandsService(sdk as never);
    const target = { ...workspace, folderPath: '/tmp/comate-command-resolver-test-3' };
    await service.getCommands(target);
    model = 'model-b';
    service.invalidateProviderConfiguration();
    await service.getCommands(target);
    await service.dispose();
    assert.deepEqual(seen, ['model-a', 'model-b']);
  });
});
