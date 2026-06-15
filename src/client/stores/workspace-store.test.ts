import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { useWorkspaceStore, type Workspace } from './workspace-store';
import { useFilesStore } from './files-store';
import { useAnalyticsStore } from './analytics-store';
import { useCommandsStore } from './commands-store';
import { useWeComQueueStore } from './wecom-queue-store';

describe('useWorkspaceStore', () => {
  const ws1: Workspace = {
    id: 'ws-1',
    name: 'Workspace One',
    description: '',
    folderPath: '/tmp/ws1',
    settings: {},
    skills: [],
    mcpServers: [],
    hooks: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  const ws2: Workspace = {
    id: 'ws-2',
    name: 'Workspace Two',
    description: '',
    folderPath: '/tmp/ws2',
    settings: {},
    skills: [],
    mcpServers: [],
    hooks: [],
    createdAt: '2024-01-02T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
  };

  function resetStores() {
    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      openWorkspaceIds: [],
      isLoading: false,
      error: null,
    });
    useFilesStore.setState({
      resultsByWorkspace: {},
      loadingByWorkspace: {},
      errorByWorkspace: {},
      truncatedByWorkspace: {},
    });
    useAnalyticsStore.setState({
      globalSummary: null,
      workspaceSummaries: {},
      activeWorkspaceId: null,
      isLoadingGlobal: false,
      isLoadingWorkspace: false,
      globalError: null,
      workspaceError: null,
      globalFetchedAt: null,
    });
    useCommandsStore.setState({
      commandsByWorkspace: {},
      loadingByWorkspace: {},
      errorByWorkspace: {},
    });
    useWeComQueueStore.setState({
      entriesByWorkspace: {},
      isLoading: {},
      error: {},
      statusFilter: null,
    });
  }

  beforeEach(() => {
    resetStores();
  });

  function mockFetch(status: number, body?: unknown) {
    return async () =>
      new Response(body !== undefined ? JSON.stringify(body) : undefined, {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
  }

  it('deleteWorkspace removes the workspace and falls back when active workspace is deleted', async () => {
    const originalFetch = global.fetch;
    global.fetch = mockFetch(204) as typeof global.fetch;

    useWorkspaceStore.setState({
      workspaces: [ws1, ws2],
      activeWorkspaceId: ws1.id,
      openWorkspaceIds: [ws1.id, ws2.id],
    });

    await useWorkspaceStore.getState().deleteWorkspace(ws1.id);

    const state = useWorkspaceStore.getState();
    assert.deepStrictEqual(state.workspaces, [ws2]);
    assert.strictEqual(state.activeWorkspaceId, ws2.id);
    assert.deepStrictEqual(state.openWorkspaceIds, [ws2.id]);
    assert.strictEqual(state.error, null);

    global.fetch = originalFetch;
  });

  it('deleteWorkspace closes non-active open tab without changing active workspace', async () => {
    const originalFetch = global.fetch;
    global.fetch = mockFetch(204) as typeof global.fetch;

    useWorkspaceStore.setState({
      workspaces: [ws1, ws2],
      activeWorkspaceId: ws2.id,
      openWorkspaceIds: [ws1.id, ws2.id],
    });

    await useWorkspaceStore.getState().deleteWorkspace(ws1.id);

    const state = useWorkspaceStore.getState();
    assert.deepStrictEqual(state.workspaces, [ws2]);
    assert.strictEqual(state.activeWorkspaceId, ws2.id);
    assert.deepStrictEqual(state.openWorkspaceIds, [ws2.id]);

    global.fetch = originalFetch;
  });

  it('deleteWorkspace sets activeWorkspaceId to null when deleting the last workspace', async () => {
    const originalFetch = global.fetch;
    global.fetch = mockFetch(204) as typeof global.fetch;

    useWorkspaceStore.setState({
      workspaces: [ws1],
      activeWorkspaceId: ws1.id,
      openWorkspaceIds: [ws1.id],
    });

    await useWorkspaceStore.getState().deleteWorkspace(ws1.id);

    const state = useWorkspaceStore.getState();
    assert.deepStrictEqual(state.workspaces, []);
    assert.strictEqual(state.activeWorkspaceId, null);
    assert.deepStrictEqual(state.openWorkspaceIds, []);

    global.fetch = originalFetch;
  });

  it('deleteWorkspace sets error and leaves workspaces unchanged on 404', async () => {
    const originalFetch = global.fetch;
    global.fetch = mockFetch(404, { error: 'Workspace not found' }) as typeof global.fetch;

    useWorkspaceStore.setState({
      workspaces: [ws1, ws2],
      activeWorkspaceId: ws1.id,
      openWorkspaceIds: [ws1.id, ws2.id],
    });

    await useWorkspaceStore.getState().deleteWorkspace(ws1.id);

    const state = useWorkspaceStore.getState();
    assert.deepStrictEqual(state.workspaces, [ws1, ws2]);
    assert.strictEqual(state.activeWorkspaceId, ws1.id);
    assert.deepStrictEqual(state.openWorkspaceIds, [ws1.id, ws2.id]);
    assert.ok(state.error?.includes('Workspace not found'));

    global.fetch = originalFetch;
  });

  it('deleteWorkspace cleans up related store state', async () => {
    const originalFetch = global.fetch;
    global.fetch = mockFetch(204) as typeof global.fetch;

    useWorkspaceStore.setState({
      workspaces: [ws1, ws2],
      activeWorkspaceId: ws1.id,
      openWorkspaceIds: [ws1.id, ws2.id],
    });

    useFilesStore.setState({
      resultsByWorkspace: { [ws1.id]: [{ path: '/tmp/f.txt' }], [ws2.id]: [{ path: '/tmp/ws2.txt' }] },
      loadingByWorkspace: {},
      errorByWorkspace: {},
      truncatedByWorkspace: {},
    });
    useAnalyticsStore.setState({
      workspaceSummaries: {
        [ws1.id]: {} as ReturnType<typeof useAnalyticsStore.getState>['workspaceSummaries'][string],
        [ws2.id]: {} as ReturnType<typeof useAnalyticsStore.getState>['workspaceSummaries'][string],
      },
    });
    useCommandsStore.setState({
      commandsByWorkspace: {
        [ws1.id]: { commands: [], partial: false },
        [ws2.id]: { commands: [], partial: false },
      },
    });
    useWeComQueueStore.setState({
      entriesByWorkspace: { [ws1.id]: [], [ws2.id]: [] },
    });

    await useWorkspaceStore.getState().deleteWorkspace(ws1.id);

    assert.strictEqual(useFilesStore.getState().resultsByWorkspace[ws1.id], undefined);
    assert.strictEqual(useAnalyticsStore.getState().workspaceSummaries[ws1.id], undefined);
    assert.strictEqual(useCommandsStore.getState().commandsByWorkspace[ws1.id], undefined);
    assert.strictEqual(useWeComQueueStore.getState().entriesByWorkspace[ws1.id], undefined);

    assert.deepStrictEqual(useFilesStore.getState().resultsByWorkspace[ws2.id], [{ path: '/tmp/ws2.txt' }]);
    assert.ok(useAnalyticsStore.getState().workspaceSummaries[ws2.id]);
    assert.ok(useCommandsStore.getState().commandsByWorkspace[ws2.id]);
    assert.deepStrictEqual(useWeComQueueStore.getState().entriesByWorkspace[ws2.id], []);

    global.fetch = originalFetch;
  });
});
