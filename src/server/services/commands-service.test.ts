import '../test-utils/test-env.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Workspace } from '../models/workspace.js';
import { store } from '../storage/sqlite-store.js';
import { CommandsService } from './commands-service.js';

const originalDefault = store.getDefaultProvider.bind(store);

afterEach(() => {
  store.getDefaultProvider = originalDefault;
});

const workspace: Workspace = {
  id: 'w1', name: 'w', description: '', folderPath: '/tmp/comate-command-resolver-test',
  settings: {}, skills: [], mcpServers: [], hooks: [], createdAt: '', updatedAt: '', lastOpenedAt: null,
};

describe('CommandsService Provider resolution', () => {
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
