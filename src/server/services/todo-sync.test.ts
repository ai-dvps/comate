import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../storage/sqlite-store.js';
import { todoSyncService } from './todo-sync.js';
import { connectPat, __setAdapterFactory, __reset } from './github-auth.js';
import type { GithubBackendAdapter, RemoteIssue, RemoteComment, ListChangedResult, CreateIssueInput, UpdateIssueInput, GithubRepo } from './github-types.js';

const SENTINEL = 'ghp_SENTINEL_SYNC_TOKEN';

/**
 * Mutable remote state. The fake adapter closes over this object, so a test can
 * mutate it (or reassign a method on `adapter`) between phases and the cached
 * adapter — which `getAdapter()` builds once — observes the change. This mirrors
 * the real remote drifting between syncs without rebuilding the adapter.
 */
interface FakeState {
  issues: Map<string, RemoteIssue>;
  issueList: Map<string, RemoteIssue[]>;
  comments: Map<string, RemoteComment[]>;
  deletedNumbers: Set<string>;
  throwOnListChanged: unknown;
}

function makeIssue(number: number, overrides: Partial<RemoteIssue> = {}): RemoteIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: null,
    state: 'open',
    assignee: null,
    labels: [],
    updatedAt: '2026-07-27T00:00:00.000Z',
    htmlUrl: `https://github.com/o/r/issues/${number}`,
    ...overrides,
  };
}

function emptyState(): FakeState {
  return { issues: new Map(), issueList: new Map(), comments: new Map(), deletedNumbers: new Set(), throwOnListChanged: null };
}

function makeFake(state: FakeState) {
  const calls = {
    create: [] as Array<{ repo: string; input: CreateIssueInput }>,
    update: [] as Array<{ repo: string; number: number; input: UpdateIssueInput }>,
    addComment: [] as Array<{ repo: string; number: number; body: string }>,
    fetchComments: [] as Array<{ repo: string; number: number }>,
    listChanged: [] as Array<{ repo: string; since: string | null; etag: string | null }>,
    getIssue: [] as Array<{ repo: string; number: number }>,
    listAccessibleRepos: 0,
  };
  let nextIssueNumber = 900;

  const adapter: GithubBackendAdapter = {
    async listAccessibleRepos(): Promise<GithubRepo[]> {
      calls.listAccessibleRepos++;
      return [];
    },
    async listChanged(repo: string, since: string | null, etag: string | null): Promise<ListChangedResult> {
      calls.listChanged.push({ repo, since, etag });
      if (state.throwOnListChanged) throw state.throwOnListChanged;
      const list = state.issueList.get(repo);
      if (list) {
        const latest = list.reduce((max, i) => (i.updatedAt > max ? i.updatedAt : max), '');
        return { issues: list, etag: `"${repo}-${list.length}"`, latestUpdatedAt: latest || null };
      }
      return { issues: [], etag: etag ?? `"${repo}-empty"`, latestUpdatedAt: null };
    },
    async getIssue(repo: string, number: number): Promise<RemoteIssue | null> {
      calls.getIssue.push({ repo, number });
      if (state.deletedNumbers.has(`${repo}#${number}`)) return null;
      const stored = state.issues.get(repo);
      return stored && stored.number === number ? stored : makeIssue(number);
    },
    async create(repo: string, input: CreateIssueInput): Promise<RemoteIssue> {
      const num = ++nextIssueNumber;
      const issue = makeIssue(num, { title: input.title, labels: input.labels ?? [], assignee: input.assignees?.[0] ?? null });
      calls.create.push({ repo, input });
      state.issues.set(repo, issue);
      return issue;
    },
    async update(repo: string, number: number, input: UpdateIssueInput): Promise<RemoteIssue> {
      calls.update.push({ repo, number, input });
      const existing = state.issues.get(repo);
      if (existing && existing.number === number) {
        const merged: RemoteIssue = {
          ...existing,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.state ? { state: input.state } : {}),
        };
        state.issues.set(repo, merged);
        return merged;
      }
      return makeIssue(number);
    },
    async fetchComments(repo: string, number: number): Promise<RemoteComment[]> {
      calls.fetchComments.push({ repo, number });
      return state.comments.get(`${repo}#${number}`) ?? [];
    },
    async addComment(repo: string, number: number, body: string): Promise<RemoteComment> {
      calls.addComment.push({ repo, number, body });
      const key = `${repo}#${number}`;
      const list = state.comments.get(key) ?? [];
      const c: RemoteComment = { id: list.length + 1000, author: 'you', body, createdAt: '2026-07-27T00:00:00.000Z', updatedAt: '2026-07-27T00:00:00.000Z' };
      list.push(c);
      state.comments.set(key, list);
      return c;
    },
  };
  return { adapter, calls, state };
}

let fake: ReturnType<typeof makeFake>;
let workspaceId: string;

beforeEach(async () => {
  store.resetData();
  __reset();
  connectPat('ghp_test_token');
  fake = makeFake(emptyState());
  __setAdapterFactory(() => fake.adapter);
  const ws = await store.create({ name: 'WS', folderPath: '/tmp/ws-sync' });
  workspaceId = ws.id;
});

// ---------------------------------------------------------------------------
// Publish (F1 / AE4)
// ---------------------------------------------------------------------------
describe('publish (F1)', () => {
  it('creates the issue and records repo/issue number + baseline snapshot (AE4)', async () => {
    store.setWorkspaceGithubRepos(workspaceId, ['myorg/webapp']);
    const todo = store.createTodo(workspaceId, { text: 'Ship it' });
    const published = await todoSyncService.publish(todo.id);
    assert.equal(published.repoFullName, 'myorg/webapp');
    assert.equal(published.issueNumber, 901);
    assert.equal(published.origin, 'local');
    assert.ok(published.remoteSnapshot);
    assert.equal(fake.calls.create.length, 1);
    assert.equal(fake.calls.create[0].repo, 'myorg/webapp');
    assert.equal(fake.calls.create[0].input.title, 'Ship it');
  });

  it('rejects a non-local todo with 400', async () => {
    const todo = store.createTodo(workspaceId, { text: 'x' });
    store.updateTodo(todo.id, { origin: 'github', repoFullName: 'o/r', issueNumber: 1 });
    await assert.rejects(() => todoSyncService.publish(todo.id), (err: { status?: number }) => err.status === 400);
  });

  it('rejects when no target repo is resolvable with 400', async () => {
    const todo = store.createTodo(null, { text: 'no repo' });
    await assert.rejects(() => todoSyncService.publish(todo.id), (err: { status?: number }) => err.status === 400);
  });
});

// ---------------------------------------------------------------------------
// Pull (F2)
// ---------------------------------------------------------------------------
describe('pull (F2)', () => {
  it('creates a local replica with origin=github and mirrors state', async () => {
    fake.state.issues.set('myorg/webapp', makeIssue(5, { title: 'Remote bug', state: 'closed', assignee: 'alice', labels: ['bug'] }));
    fake.state.comments.set('myorg/webapp#5', [{ id: 1, author: 'bob', body: 'hi', createdAt: '2026-07-27T00:00:00.000Z', updatedAt: '2026-07-27T00:00:00.000Z' }]);

    const todo = await todoSyncService.pull('myorg/webapp', 5);
    assert.equal(todo.origin, 'github');
    assert.equal(todo.repoFullName, 'myorg/webapp');
    assert.equal(todo.issueNumber, 5);
    assert.equal(todo.status, 'done'); // closed → done
    assert.equal(todo.assignee, 'alice');
    assert.deepEqual(todo.labels, ['bug']);
    assert.equal(store.listTodoComments(todo.id).length, 1);
  });

  it('pull dedupe: re-pulling an already-linked issue returns the existing local todo', async () => {
    const todo = await todoSyncService.pull('myorg/webapp', 7);
    const again = await todoSyncService.pull('myorg/webapp', 7);
    assert.equal(again.id, todo.id);
  });

  it('pull 404s when the issue does not exist', async () => {
    fake.state.deletedNumbers.add('myorg/webapp#999');
    await assert.rejects(() => todoSyncService.pull('myorg/webapp', 999), (err: { status?: number }) => err.status === 404);
  });
});

// ---------------------------------------------------------------------------
// Reconcile — field-class policy
// ---------------------------------------------------------------------------
describe('reconcile field-class policy', () => {
  it('a remote close mirrors local status to done (AE1)', async () => {
    const todo = await todoSyncService.pull('myorg/webapp', 11); // baseline, open
    assert.equal(todo.status, 'pending');
    fake.state.issueList.set('myorg/webapp', [makeIssue(11, { state: 'closed' })]);
    const result = await todoSyncService.reconcile();
    assert.equal(store.getTodoById(todo.id)!.status, 'done');
    assert.ok(result.upserted >= 1);
  });

  it('comments merge both ways: local comment pushed, remote comment pulled, neither lost (AE2)', async () => {
    store.setWorkspaceGithubRepos(workspaceId, ['myorg/webapp']);
    const local = store.createTodo(workspaceId, { text: 'Discuss' });
    const published = await todoSyncService.publish(local.id);
    const repo = published.repoFullName!;
    const num = published.issueNumber!;
    store.addLocalTodoComment(local.id, 'owner says hi', 'owner');

    fake.state.issueList.set(repo, [makeIssue(num, { title: 'Discuss' })]);
    fake.state.comments.set(`${repo}#${num}`, [{ id: 71, author: 'teammate', body: 'team says hi', createdAt: '2026-07-27T00:00:00.000Z', updatedAt: '2026-07-27T00:00:00.000Z' }]);
    await todoSyncService.reconcile();

    assert.ok(fake.calls.addComment.some((c) => c.body === 'owner says hi'), 'local comment not pushed');
    const bodies = store.listTodoComments(local.id).map((c) => c.body).sort();
    assert.deepEqual(bodies, ['owner says hi', 'team says hi']);
  });

  it('both-sides-edited title is a conflict; local title is left unchanged (AE3)', async () => {
    const todo = await todoSyncService.pull('myorg/webapp', 21); // baseline "Issue 21"
    store.updateTodo(todo.id, { text: 'Local edit' });
    fake.state.issueList.set('myorg/webapp', [makeIssue(21, { title: 'Remote edit' })]);
    const result = await todoSyncService.reconcile();
    assert.ok(result.conflicts >= 1);
    const conflicts = store.getTodoConflicts(todo.id);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].field, 'title');
    assert.equal(conflicts[0].localValue, 'Local edit');
    assert.equal(conflicts[0].remoteValue, 'Remote edit');
    assert.equal(store.getTodoById(todo.id)!.text, 'Local edit');
  });

  it('origin=github single-side title change mirrors remote inward', async () => {
    const todo = await todoSyncService.pull('myorg/webapp', 22);
    fake.state.issueList.set('myorg/webapp', [makeIssue(22, { title: 'Remote new title' })]);
    await todoSyncService.reconcile();
    assert.equal(store.getTodoById(todo.id)!.text, 'Remote new title');
  });

  it('origin=local single-side title divergence pushes local outward (origin-wins)', async () => {
    store.setWorkspaceGithubRepos(workspaceId, ['myorg/webapp']);
    const local = store.createTodo(workspaceId, { text: 'Owner title' });
    const published = await todoSyncService.publish(local.id);
    fake.state.issueList.set(published.repoFullName!, [makeIssue(published.issueNumber!, { title: 'Teammate rename' })]);
    await todoSyncService.reconcile();
    assert.equal(store.getTodoById(local.id)!.text, 'Owner title');
    assert.ok(fake.calls.update.some((c) => (c.input.title as string) === 'Owner title'), 'local title not pushed outward');
  });
});

// ---------------------------------------------------------------------------
// ETag short-circuit (R12)
// ---------------------------------------------------------------------------
describe('ETag short-circuit', () => {
  it('a 304 (no change) makes no per-issue fetches for an all-local repo', async () => {
    store.setWorkspaceGithubRepos(workspaceId, ['myorg/webapp']);
    const local = store.createTodo(workspaceId, { text: 'x' });
    await todoSyncService.publish(local.id); // establishes the cursor + cached adapter
    const callsBefore = fake.calls.listChanged.length;
    const lastEtag = fake.calls.listChanged[callsBefore - 1]?.etag ?? 'e1';
    // Override the cached adapter's listChanged to return a 304-style empty result.
    let listChangedCalled = false;
    fake.adapter.listChanged = async () => {
      listChangedCalled = true;
      return { issues: [], etag: lastEtag, latestUpdatedAt: null };
    };
    await todoSyncService.reconcile();
    assert.ok(listChangedCalled, 'listChanged was not called for the scoped repo');
    assert.equal(fake.calls.fetchComments.length, 0);
    assert.equal(fake.calls.getIssue.length, 0);
    void local;
  });
});

// ---------------------------------------------------------------------------
// Repo scoping (R17)
// ---------------------------------------------------------------------------
describe('repo scoping (R17)', () => {
  it('reconcile only touches scoped repos and never listAccessibleRepos', async () => {
    store.setWorkspaceGithubRepos(workspaceId, ['a/1']);
    const other = await store.create({ name: 'WS2', folderPath: '/tmp/ws2' });
    store.setWorkspaceGithubRepos(other.id, ['b/2']);
    await todoSyncService.pull('c/3', 99); // a linked todo brings c/3 into scope

    const touched = new Set<string>();
    fake.adapter.listChanged = async (repo) => {
      touched.add(repo);
      return { issues: [], etag: `"${repo}"`, latestUpdatedAt: null };
    };
    await todoSyncService.reconcile();
    assert.ok(touched.has('a/1') && touched.has('b/2') && touched.has('c/3'), 'scoped repos not all touched');
    assert.equal(fake.calls.listAccessibleRepos, 0, 'reconcile must not call listAccessibleRepos');
  });
});

// ---------------------------------------------------------------------------
// Concurrent triggers — single-flight (R12)
// ---------------------------------------------------------------------------
describe('single-flight', () => {
  it('two concurrent reconcile() calls share one loop and push a comment exactly once', async () => {
    store.setWorkspaceGithubRepos(workspaceId, ['myorg/webapp']);
    const local = store.createTodo(workspaceId, { text: 'x' });
    const published = await todoSyncService.publish(local.id);
    store.addLocalTodoComment(local.id, 'dup?', 'owner');

    let resolveList!: (v: ListChangedResult) => void;
    const gate = new Promise<ListChangedResult>((res) => {
      resolveList = res;
    });
    fake.adapter.listChanged = async () => gate;
    let pushCount = 0;
    fake.adapter.addComment = async (_repo, _number, body) => {
      if (body === 'dup?') pushCount++;
      return { id: 1, author: 'you', body, createdAt: '2026-07-27T00:00:00.000Z', updatedAt: '2026-07-27T00:00:00.000Z' };
    };

    const p1 = todoSyncService.reconcile();
    const p2 = todoSyncService.reconcile();
    resolveList({ issues: [], etag: '"done"', latestUpdatedAt: null });
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, r2, 'concurrent calls did not share the in-flight result');
    assert.equal(pushCount, 1, 'comment pushed more than once (or not at all)');
    // published unused-var guard
    void published;
  });
});

// ---------------------------------------------------------------------------
// Origin-side deletion (state-diagram transition)
// ---------------------------------------------------------------------------
describe('origin-side deletion', () => {
  it('a deleted github-origin issue is marked origin_deleted, not auto-deleted, local comments preserved', async () => {
    fake.state.issues.set('myorg/webapp', makeIssue(50));
    const todo = await todoSyncService.pull('myorg/webapp', 50);
    store.addLocalTodoComment(todo.id, 'local note', 'owner');
    // Issue deleted remotely: absent from listChanged, getIssue → null.
    fake.state.issueList.set('myorg/webapp', []);
    fake.state.deletedNumbers.add('myorg/webapp#50');
    const result = await todoSyncService.reconcile();
    assert.ok(result.deletedDetected >= 1);
    const after = store.getTodoById(todo.id);
    assert.ok(after, 'todo was auto-deleted');
    assert.equal(after!.originDeleted, true);
    assert.equal(store.listTodoComments(todo.id).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Conflict resolution (R11 / U6)
// ---------------------------------------------------------------------------
describe('resolveConflict (R11)', () => {
  it('accept-local keeps the local value, resets the baseline, and clears the conflict', async () => {
    const todo = store.createTodo(workspaceId, { text: 'Local title' });
    store.updateTodo(todo.id, { remoteSnapshot: JSON.stringify({ title: 'Baseline' }) });
    store.setTodoConflict(todo.id, 'title', 'Local title', 'Remote title', 'Baseline');

    const resolved = await todoSyncService.resolveConflict(todo.id, 'title', 'local');
    assert.equal(resolved.text, 'Local title');
    assert.equal(JSON.parse(resolved.remoteSnapshot!).title, 'Local title');
    assert.equal(store.getTodoConflicts(todo.id).length, 0);
  });

  it('accept-remote takes the remote value, resets the baseline, and clears the conflict', async () => {
    const todo = store.createTodo(workspaceId, { text: 'Local title' });
    store.updateTodo(todo.id, { remoteSnapshot: JSON.stringify({ title: 'Baseline' }) });
    store.setTodoConflict(todo.id, 'title', 'Local title', 'Remote title', 'Baseline');

    const resolved = await todoSyncService.resolveConflict(todo.id, 'title', 'remote');
    assert.equal(resolved.text, 'Remote title');
    assert.equal(JSON.parse(resolved.remoteSnapshot!).title, 'Remote title');
    assert.equal(store.getTodoConflicts(todo.id).length, 0);
  });

  it('resolving a non-existent conflict 404s', async () => {
    const todo = store.createTodo(workspaceId, { text: 'x' });
    await assert.rejects(() => todoSyncService.resolveConflict(todo.id, 'title', 'local'), (err: { status?: number }) => err.status === 404);
  });
});

// ---------------------------------------------------------------------------
// Sync error redaction (R13)
// ---------------------------------------------------------------------------
describe('sync error redaction (R13)', () => {
  it('per-issue octokit failures in the result are redacted — no token reaches the response', async () => {
    store.setWorkspaceGithubRepos(workspaceId, ['myorg/webapp']);
    const local = store.createTodo(workspaceId, { text: 'x' });
    await todoSyncService.publish(local.id);
    fake.state.throwOnListChanged = {
      message: 'GET https://api.github.com/repos/o/r/issues?token=' + SENTINEL,
      status: 500,
      request: { method: 'GET', url: 'https://api.github.com/repos/o/r/issues', headers: { authorization: 'Bearer ' + SENTINEL } },
      response: { status: 500, data: { access_token: SENTINEL } },
    };
    const result = await todoSyncService.reconcile();
    assert.ok(result.errors.length >= 1);
    const serialized = JSON.stringify(result.errors);
    assert.ok(!serialized.includes(SENTINEL), 'sentinel token leaked into sync result errors: ' + serialized);
    void local;
  });

  it('per-issue adapter failures (update/addComment/fetchComments) are redacted — no token reaches the response', async () => {
    store.setWorkspaceGithubRepos(workspaceId, ['myorg/webapp']);
    const local = store.createTodo(workspaceId, { text: 'Owner title' });
    const published = await todoSyncService.publish(local.id);
    store.addLocalTodoComment(local.id, 'unpushed comment', 'owner');
    // A changed issue drives applyRemoteIssue (update + fetchComments) and the
    // unpushed-comment push (addComment) — all three per-issue catch sites.
    fake.state.issueList.set(published.repoFullName!, [makeIssue(published.issueNumber!, { title: 'Teammate rename' })]);
    const sentinel = {
      message: 'token=' + SENTINEL,
      status: 500,
      request: { method: 'POST', url: 'https://api.github.com/repos/o/r/issues', headers: { authorization: 'Bearer ' + SENTINEL } },
      response: { status: 500, data: { access_token: SENTINEL } },
    };
    fake.adapter.update = async () => {
      throw sentinel;
    };
    fake.adapter.addComment = async () => {
      throw sentinel;
    };
    fake.adapter.fetchComments = async () => {
      throw sentinel;
    };
    const result = await todoSyncService.reconcile();
    assert.ok(result.errors.length >= 1, 'no per-issue errors recorded');
    const serialized = JSON.stringify(result.errors);
    assert.ok(!serialized.includes(SENTINEL), 'sentinel leaked from a per-issue catch site: ' + serialized);
  });
});
