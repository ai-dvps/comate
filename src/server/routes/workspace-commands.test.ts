import '../test-utils/test-env.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import commandRouter from './workspace-commands.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { commandsService } from '../services/commands-service.js';
import { chatService } from '../services/chat-service.js';
import { codexAppServerManager } from '../services/codex-app-server-manager.js';

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
const originalListSkills = codexAppServerManager.listSkills.bind(codexAppServerManager);
const tempDirs: string[] = [];

afterEach(async () => {
  workspaceStore.get = originalWorkspaceGet;
  workspaceStore.getLocalSession = originalLocalSessionGet;
  commandsService.getCommands = originalGetCommands;
  chatService.getSessionBackendCommands = originalGetSessionBackendCommands;
  codexAppServerManager.listSkills = originalListSkills;
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('workspace command discovery', () => {
  it('loads project skills without initializing Claude discovery for a new OpenCode chat', async () => {
    const handler = routeHandler();
    assert.ok(handler);
    const workspace = await mkdtemp(join(tmpdir(), 'comate-opencode-new-chat-'));
    tempDirs.push(workspace);
    const skillDirectory = join(workspace, '.agents/skills/project-review');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, 'SKILL.md'), [
      '---',
      'name: project-review',
      'description: Review this project',
      'argument-hint: "[path]"',
      '---',
      '',
    ].join('\n'));
    workspaceStore.get = async () => ({ id: 'workspace-1', folderPath: workspace }) as never;
    commandsService.getCommands = async () => {
      throw new Error('Claude discovery should not run');
    };
    const res = mockResponse();

    await handler({
      params: { id: 'workspace-1' },
      query: { backend: 'opencode' },
    }, res);

    assert.equal((res.jsonBody as { partial: boolean }).partial, false);
    assert.deepEqual(
      (res.jsonBody as { commands: Array<{ name: string; description: string; argumentHint?: string }> })
        .commands.find((command) => command.name === 'project-review'),
      {
        name: 'project-review',
        description: 'Review this project',
        argumentHint: '[path]',
        aliases: undefined,
      },
    );
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

  it('loads skills from Codex before a new chat has a session', async () => {
    const handler = routeHandler();
    assert.ok(handler);
    workspaceStore.get = async () => ({
      id: 'workspace-1',
      folderPath: '/workspace',
    }) as never;
    codexAppServerManager.listSkills = async (cwd) => [{
      name: `skill-for-${cwd}`,
      description: 'Codex skill',
      path: '/workspace/.codex/skills/new-chat/SKILL.md',
    }];
    const res = mockResponse();

    await handler({
      params: { id: 'workspace-1' },
      query: { backend: 'codex' },
    }, res);

    assert.deepEqual(res.jsonBody, {
      commands: [{ name: 'skill-for-/workspace', description: 'Codex skill' }],
      partial: false,
    });
  });

  it('loads skills from Codex rather than the OpenCode runtime for an existing session', async () => {
    const handler = routeHandler();
    assert.ok(handler);
    workspaceStore.get = async () => ({
      id: 'workspace-1',
      folderPath: '/workspace',
    }) as never;
    workspaceStore.getLocalSession = () => ({ backend: 'codex' }) as never;
    chatService.getSessionBackendCommands = async () => {
      throw new Error('Codex discovery should not query the OpenCode runtime');
    };
    codexAppServerManager.listSkills = async () => [{
      name: 'existing-session-skill',
      description: 'Codex skill',
      path: '/workspace/.codex/skills/existing/SKILL.md',
    }];
    const res = mockResponse();

    await handler({
      params: { id: 'workspace-1' },
      query: { sessionId: 'session-1', backend: 'codex' },
    }, res);

    assert.deepEqual(res.jsonBody, {
      commands: [{ name: 'existing-session-skill', description: 'Codex skill' }],
      partial: false,
    });
  });
});
