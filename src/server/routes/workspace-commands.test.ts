import '../test-utils/test-env.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import commandRouter from './workspace-commands.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { commandsService } from '../services/commands-service.js';
import { chatService } from '../services/chat-service.js';

function routeHandler() {
  const layer = (commandRouter as unknown as {
    stack: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }>;
      };
    }>;
  }).stack.find((entry) => entry.route?.path === '/' && entry.route.methods.get);
  return layer?.route?.stack[0].handle;
}

function mockResponse() {
  return {
    statusCode: 200,
    jsonBody: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.jsonBody = body; },
  };
}

const originalWorkspaceGet = workspaceStore.get.bind(workspaceStore);
const originalLocalSessionGet = workspaceStore.getLocalSession.bind(workspaceStore);
const originalGetCommands = commandsService.getCommands.bind(commandsService);
const originalGetSessionBackendCommands = chatService.getSessionBackendCommands.bind(chatService);

afterEach(() => {
  workspaceStore.get = originalWorkspaceGet;
  workspaceStore.getLocalSession = originalLocalSessionGet;
  commandsService.getCommands = originalGetCommands;
  chatService.getSessionBackendCommands = originalGetSessionBackendCommands;
});

describe('workspace command discovery', () => {
  it('does not initialize Claude discovery for a new OpenCode chat', async () => {
    const handler = routeHandler();
    assert.ok(handler);
    workspaceStore.get = async () => ({ id: 'workspace-1' }) as never;
    commandsService.getCommands = async () => {
      throw new Error('Claude discovery should not run');
    };
    const res = mockResponse();

    await handler({
      params: { id: 'workspace-1' },
      query: { backend: 'opencode' },
    }, res);

    assert.deepEqual(res.jsonBody, { commands: [], partial: false });
  });

  it('loads commands from the active OpenCode session runtime', async () => {
    const handler = routeHandler();
    assert.ok(handler);
    workspaceStore.get = async () => ({ id: 'workspace-1' }) as never;
    workspaceStore.getLocalSession = () => ({ backend: 'opencode' }) as never;
    chatService.getSessionBackendCommands = async (sessionId) => [{
      name: sessionId,
      description: 'runtime command',
    }];
    const res = mockResponse();

    await handler({
      params: { id: 'workspace-1' },
      query: { sessionId: 'session-1', backend: 'opencode' },
    }, res);

    assert.deepEqual(res.jsonBody, {
      commands: [{ name: 'session-1', description: 'runtime command' }],
      partial: false,
    });
  });
});
