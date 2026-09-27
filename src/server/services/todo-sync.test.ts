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
      const issue = makeIssue(num, {
        title: input.title,
        body: input.body,
        labels: input.labels ?? [],
        assignee: input.assignees?.[0] ?? null,
      });
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
          ...(input.body !== undefined ? { body: input.body } : {}),
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

// ---------------------------------------------------------------------------
// Bidirectional body sync — content mirrors the GitHub issue body (U3 / KTD5)
// ---------------------------------------------------------------------------
describe('body sync (U3)', () => {
  it('pull writes the issue body into the local content field (R5, AE4)', async () => {
    fake.state.issues.set('myorg/webapp', makeIssue(31, { title: 'Remote title', body: '## Remote body' }));
    const todo = await todoSyncService.pull('myorg/webapp', 31);
    assert.equal(todo.text, 'Remote title');
    assert.equal(todo.content, '## Remote body');
    // baseline snapshot carries BOTH title and body
    const snap = JSON.parse(todo.remoteSnapshot!);
    assert.equal(snap.title, 'Remote title');
    assert.equal(snap.body, '## Remote body');
  });

  it('publish pushes todo.content as the issue body instead of null (R5, AE2)', async () => {
    store.setWorkspaceGithubRepos(workspaceId, ['myorg/webapp']);
    const todo = store.createTodo(workspaceId, { text: 'Ship it', content: '## Details' });
    const published = await todoSyncService.publish(todo.id);
    assert.equal(fake.calls.create.length, 1);
    assert.equal(fake.calls.create[0].input.title, 'Ship it');
    assert.equal(fake.calls.create[0].input.body, '## Details');
    // baseline snapshot records the body too
    assert.equal(JSON.parse(published.remoteSnapshot!).body, '## Details');
  });

  it('local-origin content edit pushes the body outward on reconcile (origin-wins, R5/R8)', async () => {
    store.setWorkspaceGithubRepos(workspaceId, ['myorg/webapp']);
    const local = store.createTodo(workspaceId, { text: 'Owner', content: 'orig body' });
    const published = await todoSyncService.publish(local.id); // baseline body = 'origbody'
    // local content drifts; remote (title+body) unchanged from baseline
    store.updateTodo(local.id, { content: 'new body' });
    fake.state.issueList.set(published.repoFullName!, [
      makeIssue(published.issueNumber!, { title: 'Owner', body: 'orig body' }),
    ]);
    await todoSyncService.reconcile();
    assert.ok(fake.calls.update.some((c) => c.input.body === 'new body'), 'new content not pushed outward as body');
    // local value preserved (origin-wins)
    assert.equal(store.getTodoById(local.id)!.content, 'new body');
  });

  it('both-sides-edited body is a conflict; local content is left unchanged (R7, AE3)', async () => {
    const todo = await todoSyncService.pull('myorg/webapp', 41); // baseline, body null
    // establish a non-null body baseline, then drift both sides independently
    store.updateTodo(todo.id, { remoteSnapshot: JSON.stringify({ title: 'Issue 41', body: 'base body' }) });
    store.updateTodo(todo.id, { content: 'local body' });
    fake.state.issueList.set('myorg/webapp', [makeIssue(41, { title: 'Issue 41', body: 'remote body' })]);
    const result = await todoSyncService.reconcile();
    assert.ok(result.conflicts >= 1);
    const bodyConflict = store.getTodoConflicts(todo.id).find((c) => c.field === 'body');
    assert.ok(bodyConflict, 'no body conflict surfaced');
    assert.equal(bodyConflict!.localValue, 'local body');
    assert.equal(bodyConflict!.remoteValue, 'remote body');
    assert.equal(bodyConflict!.baselineValue, 'base body');
    // local content NOT overwritten while the conflict is open
    assert.equal(store.getTodoById(todo.id)!.content, 'local body');
    // body baseline preserved (stays detected until resolved)
    assert.equal(JSON.parse(store.getTodoById(todo.id)!.remoteSnapshot!).body, 'base body');
  });

  it('resolveConflict(body, local) writes local content AND pushes body outward (R7)', async () => {
    const todo = store.createTodo(workspaceId, { text: 'T', content: 'local body' });
    store.updateTodo(todo.id, {
      origin: 'github',
      repoFullName: 'myorg/webapp',
      issueNumber: 51,
      remoteSnapshot: JSON.stringify({ title: 'T', body: 'base body' }),
    });
    store.setTodoConflict(todo.id, 'body', 'local body', 'remote body', 'base body');

    const resolved = await todoSyncService.resolveConflict(todo.id, 'body', 'local');
    assert.equal(resolved.content, 'local body');
    const snap = JSON.parse(resolved.remoteSnapshot!);
    assert.equal(snap.body, 'local body'); // body baseline reset to chosen
    assert.equal(snap.title, 'T'); // title baseline preserved (F1)
    assert.equal(store.getTodoConflicts(todo.id).length, 0);
    assert.ok(fake.calls.update.some((c) => c.input.body === 'local body'), 'chosen body not pushed outward');
  });

  it('resolveConflict(body, remote) writes the remote body into content and does not push (R7)', async () => {
    const todo = store.createTodo(workspaceId, { text: 'T', content: 'local body' });
    store.updateTodo(todo.id, {
      origin: 'github',
      repoFullName: 'myorg/webapp',
      issueNumber: 52,
      remoteSnapshot: JSON.stringify({ title: 'T', body: 'base body' }),
    });
    store.setTodoConflict(todo.id, 'body', 'local body', 'remote body', 'base body');

    const resolved = await todoSyncService.resolveConflict(todo.id, 'body', 'remote');
    assert.equal(resolved.content, 'remote body');
    const snap = JSON.parse(resolved.remoteSnapshot!);
    assert.equal(snap.body, 'remote body');
    assert.equal(snap.title, 'T'); // title baseline preserved (F1)
    assert.equal(store.getTodoConflicts(todo.id).length, 0);
    assert.ok(
      !fake.calls.update.some((c) => c.input.body === 'remote body'),
      'accept-remote must not push outward',
    );
  });

  it('title and body both push outward when both diverge for a local-origin todo (R8, no title regression)', async () => {
    store.setWorkspaceGithubRepos(workspaceId, ['myorg/webapp']);
    const local = store.createTodo(workspaceId, { text: 'Owner', content: 'orig body' });
    const published = await todoSyncService.publish(local.id);
    store.updateTodo(local.id, { text: 'Owner new', content: 'new body' });
    fake.state.issueList.set(published.repoFullName!, [
      makeIssue(published.issueNumber!, { title: 'Owner', body: 'orig body' }),
    ]);
    await todoSyncService.reconcile();
    assert.ok(fake.calls.update.some((c) => c.input.title === 'Owner new'), 'title not pushed');
    assert.ok(fake.calls.update.some((c) => c.input.body === 'new body'), 'body not pushed');
    const after = store.getTodoById(local.id)!;
    assert.equal(after.text, 'Owner new');
    assert.equal(after.content, 'new body');
  });

  it('null body and null content are handled without crashing (empty vs null)', async () => {
    const todo = await todoSyncService.pull('myorg/webapp', 61); // body null -> content null
    assert.equal(todo.content, null);
    fake.state.issueList.set('myorg/webapp', [makeIssue(61, { body: null })]);
    const result = await todoSyncService.reconcile(); // must not throw
    assert.ok(result.upserted >= 1);
    assert.equal(store.getTodoById(todo.id)!.content, null);
  });

  it('backfill: an existing github-origin todo with empty content receives the body on reconcile (R9, AE4)', async () => {
    // Simulate a pre-U3 github-origin todo: linked, title-only snapshot, empty content.
    const todo = store.createTodo(workspaceId, { text: 'Issue 71' });
    store.updateTodo(todo.id, {
      origin: 'github',
      repoFullName: 'myorg/webapp',
      issueNumber: 71,
      content: null,
      remoteSnapshot: JSON.stringify({ title: 'Issue 71' }), // pre-U3: no body in snapshot
    });
    fake.state.issueList.set('myorg/webapp', [makeIssue(71, { title: 'Issue 71', body: '## Backfilled body' })]);
    await todoSyncService.reconcile();
    assert.equal(store.getTodoById(todo.id)!.content, '## Backfilled body', 'content not backfilled from body');
  });

  it('F1: resolving a title conflict preserves a diverged body baseline', async () => {
    const todo = store.createTodo(workspaceId, { text: 'Local title', content: 'local body' });
    store.updateTodo(todo.id, {
      origin: 'github',
      repoFullName: 'myorg/webapp',
      issueNumber: 81,
      remoteSnapshot: JSON.stringify({ title: 'Base title', body: 'Base body' }),
    });
    // A title conflict is open AND body has diverged from its own baseline.
    store.setTodoConflict(todo.id, 'title', 'Local title', 'Remote title', 'Base title');
    const resolved = await todoSyncService.resolveConflict(todo.id, 'title', 'local');
    // title baseline advanced to the chosen value
    assert.equal(JSON.parse(resolved.remoteSnapshot!).title, 'Local title');
    // body baseline SURVIVES into the new snapshot -> next reconcile still detects body divergence
    assert.equal(JSON.parse(resolved.remoteSnapshot!).body, 'Base body');
  });

  it('F3: title converges but body diverges -> body conflict with NO title side-effect', async () => {
    const todo = await todoSyncService.pull('myorg/webapp', 91);
    store.updateTodo(todo.id, { remoteSnapshot: JSON.stringify({ title: 'Issue 91', body: 'base body' }) });
    store.updateTodo(todo.id, { content: 'local body' });
    // title converged on both sides; only body diverged
    fake.state.issueList.set('myorg/webapp', [makeIssue(91, { title: 'Issue 91', body: 'remote body' })]);
    await todoSyncService.reconcile();
    const conflicts = store.getTodoConflicts(todo.id);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].field, 'body');
    assert.ok(!conflicts.some((c) => c.field === 'title'), 'title surfaced a spurious conflict');
  });

  it('F3: title and body both diverge -> both conflicts surfaced independently', async () => {
    const todo = await todoSyncService.pull('myorg/webapp', 92);
    store.updateTodo(todo.id, { remoteSnapshot: JSON.stringify({ title: 'Issue 92', body: 'base body' }) });
    store.updateTodo(todo.id, { text: 'local title', content: 'local body' });
    fake.state.issueList.set('myorg/webapp', [
      makeIssue(92, { title: 'remote title', body: 'remote body' }),
    ]);
    await todoSyncService.reconcile();
    const fields = store
      .getTodoConflicts(todo.id)
      .map((c) => c.field)
      .sort();
    assert.deepEqual(fields, ['body', 'title']);
  });
});

// ---------------------------------------------------------------------------
// Code-review defect fixes — null/empty body presence, value, and push semantics
// ---------------------------------------------------------------------------
describe('body sync defect fixes', () => {
  it('Defect 1: a present null-value body baseline still detects a body conflict (presence != value)', async () => {
    // github-origin todo synced from an issue whose body was null -> baseline
    // {title, body: null} where the body key is PRESENT but its value is null.
    const todo = store.createTodo(workspaceId, { text: 'Issue 101', content: null });
    store.updateTodo(todo.id, {
      origin: 'github',
      repoFullName: 'myorg/webapp',
      issueNumber: 101,
      remoteSnapshot: JSON.stringify({ title: 'Issue 101', body: null }),
    });
    // User edits local content AND the remote body changes — both sides edited.
    store.updateTodo(todo.id, { content: 'local edit' });
    fake.state.issueList.set('myorg/webapp', [makeIssue(101, { title: 'Issue 101', body: 'remote edit' })]);

    const result = await todoSyncService.reconcile();

    // BUG: bodyBaselineExists was derived from (baselineBody !== null) = false,
    // so the conflict was never detected and the mirror branch overwrote local.
    // FIX: presence tracked separately -> conflict surfaced, local preserved.
    assert.ok(result.conflicts >= 1, 'body conflict not surfaced for a null-value baseline');
    const bodyConflict = store.getTodoConflicts(todo.id).find((c) => c.field === 'body');
    assert.ok(bodyConflict, 'no body conflict recorded');
    assert.equal(bodyConflict!.localValue, 'local edit');
    assert.equal(bodyConflict!.remoteValue, 'remote edit');
    assert.equal(store.getTodoById(todo.id)!.content, 'local edit'); // not mirrored over
  });

  it('Defect 2: accept-local body conflict whose outward push fails is NOT cleared and re-surfaces next reconcile', async () => {
    const todo = store.createTodo(workspaceId, { text: 'T', content: 'local body' });
    store.updateTodo(todo.id, {
      origin: 'github',
      repoFullName: 'myorg/webapp',
      issueNumber: 201,
      remoteSnapshot: JSON.stringify({ title: 'T', body: 'base body' }),
    });
    store.setTodoConflict(todo.id, 'body', 'local body', 'remote body', 'base body');
    // The one-time accept-local outward push fails.
    fake.adapter.update = async () => {
      throw new Error('boom');
    };

    const resolved = await todoSyncService.resolveConflict(todo.id, 'body', 'local');

    // Conflict NOT cleared; baseline NOT advanced.
    const conflicts = store.getTodoConflicts(todo.id);
    assert.equal(conflicts.length, 1, 'conflict was cleared despite push failure');
    assert.equal(conflicts[0].field, 'body');
    assert.equal(resolved.content, 'local body'); // local choice preserved
    assert.equal(JSON.parse(store.getTodoById(todo.id)!.remoteSnapshot!).body, 'base body'); // baseline unchanged

    // Next reconcile (remote unchanged): conflict re-detected, local NOT overwritten.
    fake.adapter.update = async (repo: string, number: number, input: UpdateIssueInput) => {
      // restore a working update for the reconcile loop itself
      const existing = fake.state.issues.get(repo);
      if (existing && existing.number === number) {
        return { ...existing, ...(input.title !== undefined ? { title: input.title } : {}), ...(input.body !== undefined ? { body: input.body } : {}) };
      }
      return makeIssue(number);
    };
    fake.state.issueList.set('myorg/webapp', [makeIssue(201, { title: 'T', body: 'remote body' })]);
    const result = await todoSyncService.reconcile();
    assert.ok(result.conflicts >= 1, 'conflict was not re-surfaced after push failure');
    const after = store.getTodoById(todo.id)!;
    assert.equal(after.content, 'local body', 'local choice silently lost after push failure');
    assert.ok(store.getTodoConflicts(todo.id).some((c) => c.field === 'body'), 'body conflict missing after reconcile');
  });

  it('Defect 3: local-origin null content with a non-null remote body backfills inward and does NOT push {body:null}', async () => {
    store.setWorkspaceGithubRepos(workspaceId, ['myorg/webapp']);
    // Simulate a pre-U3 local-origin todo: linked, content null, title-only
    // snapshot (no body baseline). Someone wrote a body on the GitHub issue.
    const local = store.createTodo(workspaceId, { text: 'Owner', content: null });
    store.updateTodo(local.id, {
      origin: 'local',
      repoFullName: 'myorg/webapp',
      issueNumber: 301,
      remoteSnapshot: JSON.stringify({ title: 'Owner' }), // pre-U3: no body key
    });
    fake.state.issueList.set('myorg/webapp', [
      makeIssue(301, { title: 'Owner', body: '## GitHub-side body' }),
    ]);

    const updatesBefore = fake.calls.update.length;
    await todoSyncService.reconcile();

    // Content backfilled from the remote body...
    assert.equal(store.getTodoById(local.id)!.content, '## GitHub-side body');
    // ...and {body:null} was NOT pushed outward (GitHub body preserved).
    const bodyPushes = fake.calls.update
      .slice(updatesBefore)
      .filter((c) => c.input.body !== undefined);
    assert.equal(bodyPushes.length, 0, '{body:null} was pushed outward, clobbering the GitHub body');
  });

  it('Defect 4: empty-string content vs null body converges (no repeated outward pushes)', async () => {
    store.setWorkspaceGithubRepos(workspaceId, ['myorg/webapp']);
    const local = store.createTodo(workspaceId, { text: 'Owner', content: '' });
    const published = await todoSyncService.publish(local.id); // baseline body = ''
    // Remote body is null; local content is '' (canonically the same empty value).
    fake.state.issueList.set(published.repoFullName!, [
      makeIssue(published.issueNumber!, { title: 'Owner', body: null }),
    ]);

    const before1 = fake.calls.update.length;
    await todoSyncService.reconcile();
    const pushes1 = fake.calls.update.slice(before1).filter((c) => c.input.body !== undefined).length;

    // Second reconcile — a correct converge must NOT push body again.
    fake.state.issueList.set(published.repoFullName!, [
      makeIssue(published.issueNumber!, { title: 'Owner', body: null, updatedAt: '2026-07-28T00:00:00.000Z' }),
    ]);
    const before2 = fake.calls.update.length;
    await todoSyncService.reconcile();
    const pushes2 = fake.calls.update.slice(before2).filter((c) => c.input.body !== undefined).length;

    assert.equal(pushes2, 0, 'body re-pushed on 2nd reconcile (null/empty push loop)');
    assert.ok(pushes1 + pushes2 <= 1, `body pushed ${pushes1 + pushes2} times across two reconciles (must converge)`);
  });
});
