/**
 * On-demand, origin-anchored, field-class sync engine (R9/R10/R12, KTD8).
 *
 * The field-class policy lives here, in core, behind the backend-agnostic
 * {@link GithubBackendAdapter} contract — a second backend implements the same
 * adapter with no change here:
 *   - Discussion (comments): append-only, both directions; never conflicts.
 *   - Collaborative state (status/labels/assignee): accept remote, mirror locally.
 *   - Structural (title/body): origin-wins; both-sides-edited → conflict (R11/R7),
 *     surfaced for U6 to resolve. The local `text` ↔ issue title and the local
 *     `content` ↔ issue body; both mirror bidirectionally under origin-wins.
 *
 * Origin-anchored: a local-origin todo is locally authoritative and pushes
 * outward; a github-origin todo is GitHub-authoritative and mirrors inward.
 * Sync is on-demand only (panel-open + manual refresh); a single-flight guard
 * makes overlapping triggers share one loop. Origin-side deletion is detected
 * and marked `origin_deleted`, never auto-deleted, so local comments survive.
 *
 * SECURITY (R13): every adapter error is funneled through {@link redactGithubError}
 * before it reaches the returned {@link SyncResult.errors} (which the route may
 * log or return) — no token/request header ever reaches the response.
 */
import { store } from '../storage/sqlite-store.js';
import { getAdapter } from './github-auth.js';
import { redactGithubError } from './github-types.js';
import type { GithubBackendAdapter, RemoteIssue } from './github-types.js';
import type { Todo } from '../models/todo.js';
import { diagLog } from '../utils/diag-logger.js';

/** A sync-layer error with an HTTP status for the route. */
export class SyncError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
  }
}

export interface SyncResult {
  upserted: number;
  pulled: number;
  conflicts: number;
  deletedDetected: number;
  /** Per-failure redacted messages (never a token/header — R13). */
  errors: Array<{ repo: string; message: string }>;
}

interface Baseline {
  title: string;
  body: string | null;
}

function parseSnapshot(json: string | null): Baseline | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<Baseline>;
    if (typeof parsed.title === 'string') {
      // `body` is optional in snapshots written before U3 (title-only); default null.
      const body = typeof parsed.body === 'string' ? parsed.body : null;
      return { title: parsed.title, body };
    }
    return null;
  } catch {
    return null;
  }
}

function snapshotJson(title: string, body: string | null): string {
  return JSON.stringify({ title, body });
}

/** GitHub open/closed ↔ local status. did-but-need-verify stays local-only. */
function stateToLocalStatus(state: 'open' | 'closed'): Todo['status'] {
  return state === 'closed' ? 'done' : 'pending';
}

async function requireAdapter(): Promise<GithubBackendAdapter> {
  const adapter = await getAdapter();
  if (!adapter) throw new SyncError('Not connected to GitHub', 400);
  return adapter;
}

/** The first repo associated with the todo's workspace (publish default target). */
function defaultRepoForTodo(todo: Todo): string | null {
  if (!todo.workspaceId) return null;
  const repos = store.getWorkspaceGithubRepos(todo.workspaceId);
  return repos[0] ?? null;
}

/** A workspace whose associated repos include `repo` (soft-link on pull). */
async function workspaceForRepo(repo: string): Promise<string | null> {
  const workspaces = await store.list();
  return workspaces.find((w) => store.getWorkspaceGithubRepos(w.id).includes(repo))?.id ?? null;
}

/** Repos in scope for reconcile: workspace-associated ∪ repos with linked todos (R17 scoping). */
async function scopedRepos(): Promise<string[]> {
  const workspaces = await store.list();
  const repos = new Set<string>();
  for (const ws of workspaces) {
    for (const r of store.getWorkspaceGithubRepos(ws.id)) repos.add(r);
  }
  for (const r of store.getLinkedRepos()) repos.add(r);
  return [...repos];
}

function recordError(result: SyncResult, repo: string, err: unknown): void {
  result.errors.push({ repo, message: redactGithubError(err).message });
}

class TodoSyncService {
  // --- Publish (local → issue) F1 ------------------------------------------

  async publish(todoId: string, repo?: string): Promise<Todo> {
    const todo = store.getTodoById(todoId);
    if (!todo) throw new SyncError('Todo not found', 404);
    if (todo.origin !== 'local') throw new SyncError('Only locally-authored todos can be published', 400);
    if (todo.repoFullName && todo.issueNumber) throw new SyncError('Todo is already linked to an issue', 409);

    const adapter = await requireAdapter();
    const targetRepo = repo ?? todo.repoFullName ?? defaultRepoForTodo(todo);
    if (!targetRepo) {
      throw new SyncError('No target repository; associate a repo with the workspace or pass one explicitly', 400);
    }

    const issue = await adapter.create(targetRepo, {
      title: todo.text,
      body: todo.content ?? null,
      labels: todo.labels.length ? todo.labels : undefined,
      assignees: todo.assignee ? [todo.assignee] : undefined,
    });

    // Push any local comments collected before publishing (append-only, R10).
    for (const comment of store.listUnpushedTodoComments(todoId)) {
      try {
        const remote = await adapter.addComment(targetRepo, issue.number, comment.body);
        store.markTodoCommentPushed(comment.id, remote.id);
      } catch (err) {
        // Leave the comment unpushed; the next sync retries. Don't fail the publish.
        diagLogSync('publish', targetRepo, err);
      }
    }

    const updated = store.updateTodo(todoId, {
      repoFullName: targetRepo,
      issueNumber: issue.number,
      remoteSnapshot: snapshotJson(issue.title, issue.body ?? null),
      remoteUpdatedAt: issue.updatedAt,
      lastSyncedAt: new Date().toISOString(),
      assignee: issue.assignee,
      labels: issue.labels,
      originDeleted: false,
    });
    return updated ?? todo;
  }

  // --- Pull (issue → local) F2 ---------------------------------------------

  async pull(repo: string, issueNumber: number, workspaceId?: string | null): Promise<Todo> {
    // Dedupe: re-pulling an already-linked issue returns the existing local todo.
    const existing = store.findTodoByRepoIssue(repo, issueNumber);
    if (existing) return existing;

    const adapter = await requireAdapter();
    const issue = await adapter.getIssue(repo, issueNumber);
    if (!issue) throw new SyncError('Issue not found', 404);

    const wsId = workspaceId ?? (await workspaceForRepo(repo));
    // createTodo + the repo/issue update run in one transaction so a UNIQUE
    // (repo, issue) violation from a concurrent pull rolls back the partial row
    // instead of orphaning a duplicate local todo.
    let createdId: string;
    try {
      createdId = store.runInTransaction(() => {
        const c = store.createTodo(wsId, { text: issue.title, content: issue.body ?? null });
        store.updateTodo(c.id, {
          origin: 'github',
          repoFullName: repo,
          issueNumber: issue.number,
          status: stateToLocalStatus(issue.state),
          assignee: issue.assignee,
          labels: issue.labels,
          remoteSnapshot: snapshotJson(issue.title, issue.body ?? null),
          remoteUpdatedAt: issue.updatedAt,
          lastSyncedAt: new Date().toISOString(),
          originDeleted: false,
        });
        return c.id;
      });
    } catch (err) {
      // A concurrent pull won the race — return its row.
      const winner = store.findTodoByRepoIssue(repo, issueNumber);
      if (winner) return winner;
      throw err;
    }

    // Pull comments (append-only).
    try {
      const comments = await adapter.fetchComments(repo, issueNumber);
      for (const c of comments) store.upsertRemoteTodoComment(createdId, c.id, c.author, c.body, c.createdAt);
    } catch (err) {
      diagLogSync('pull', repo, err);
    }
    return store.getTodoById(createdId) ?? store.createTodo(wsId, { text: issue.title, content: issue.body ?? null });
  }

  // --- Conflict resolution (R11 / U6) --------------------------------------

  /**
   * Apply the user's accept-local/accept-remote choice for a structural-field
   * conflict, reset the baseline to the chosen value, and clear the conflict.
   * accept-local propagates the chosen value outward (a one-time origin override)
   * so the next reconcile does not revert it — otherwise origin-wins would mirror
   * the remote back over the user's local choice for a github-origin todo.
   */
  async resolveConflict(todoId: string, field: 'title' | 'body', choice: 'local' | 'remote'): Promise<Todo> {
    const conflict = store.getTodoConflicts(todoId).find((c) => c.field === field);
    if (!conflict) throw new SyncError('No such conflict', 404);
    const chosen = choice === 'local' ? conflict.localValue : conflict.remoteValue;

    // F1: preserve BOTH field baselines. parseSnapshot the CURRENT remoteSnapshot
    // and rewrite only the resolved field, so resolving a title conflict does not
    // drop the body baseline (which would silence body conflict detection on the
    // next reconcile) — and vice versa.
    const current = parseSnapshot(store.getTodoById(todoId)?.remoteSnapshot ?? null);
    const nextTitle = field === 'title' ? chosen : current?.title ?? '';
    const nextBody = field === 'body' ? chosen : current?.body ?? null;

    // `title` maps to the local `text`; `body` maps to the local `content`.
    if (field === 'title') {
      store.updateTodo(todoId, { text: chosen, remoteSnapshot: snapshotJson(nextTitle, nextBody) });
    } else {
      store.updateTodo(todoId, { content: chosen, remoteSnapshot: snapshotJson(nextTitle, nextBody) });
    }
    store.clearTodoConflict(todoId, field);
    const updated = store.getTodoById(todoId);
    if (!updated) throw new SyncError('Todo not found', 404);

    // accept-local is a one-time origin override: push the chosen value outward
    // so the next reconcile (origin-wins/mirror) does not revert the user's
    // choice. Fires for both structural fields now (title AND body).
    if (choice === 'local' && updated.repoFullName && updated.issueNumber) {
      try {
        const adapter = await getAdapter();
        if (adapter) {
          const patch = field === 'title' ? { title: chosen } : { body: chosen };
          await adapter.update(updated.repoFullName, updated.issueNumber, patch);
        }
      } catch (err) {
        diagLog('[todo-sync] conflict resolve push failed: ' + redactGithubError(err).message);
      }
    }
    return updated;
  }

  // --- Reconcile (on-demand, single-flight) F3 -----------------------------

  async reconcile(): Promise<SyncResult> {
    if (inFlight) return inFlight;
    inFlight = this.doReconcile().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  private async doReconcile(): Promise<SyncResult> {
    const adapter = await requireAdapter();
    const result: SyncResult = { upserted: 0, pulled: 0, conflicts: 0, deletedDetected: 0, errors: [] };

    for (const repo of await scopedRepos()) {
      try {
        await this.reconcileRepo(adapter, repo, result);
      } catch (err) {
        recordError(result, repo, err);
      }
    }
    return result;
  }

  private async reconcileRepo(adapter: GithubBackendAdapter, repo: string, result: SyncResult): Promise<void> {
    const cursor = store.getRepoSyncState(repo);
    const changed = await adapter.listChanged(repo, cursor?.repoLastUpdatedAt ?? null, cursor?.etag ?? null);
    const seenNumbers = new Set(changed.issues.map((i) => i.number));

    // 1. Push outward: unpushed local comments on any linked todo (comments are
    //    append-only both ways regardless of origin — R10).
    for (const todo of store.getTodosByRepo(repo)) {
      if (todo.originDeleted || !todo.issueNumber) continue;
      for (const comment of store.listUnpushedTodoComments(todo.id)) {
        try {
          const remote = await adapter.addComment(repo, todo.issueNumber, comment.body);
          store.markTodoCommentPushed(comment.id, remote.id);
        } catch (err) {
          recordError(result, repo, err);
        }
      }
    }

    // 2. Apply remote changes to linked todos (per-issue isolation: one store
    //    error never aborts the rest of the repo's issues).
    for (const issue of changed.issues) {
      const todo = store.findTodoByRepoIssue(repo, issue.number);
      if (!todo) continue; // reconcile only touches linked todos; pull is explicit
      try {
        await this.applyRemoteIssue(adapter, repo, todo, issue, result);
      } catch (err) {
        recordError(result, repo, err);
      }
    }

    // 3. Origin-side deletion detection — only when GitHub reported changes. A
    //    304 means nothing changed, so skip the per-todo getIssue fan-out that
    //    would otherwise burn the rate budget on every panel-open.
    if (!changed.notModified) {
      for (const todo of store.getTodosByRepo(repo)) {
        if (todo.origin !== 'github' || todo.originDeleted || !todo.issueNumber) continue;
        if (seenNumbers.has(todo.issueNumber)) continue; // present in the changed set → exists
        try {
          const found = await adapter.getIssue(repo, todo.issueNumber);
          if (!found) {
            store.updateTodo(todo.id, { originDeleted: true });
            result.deletedDetected++;
          }
        } catch (err) {
          recordError(result, repo, err);
        }
      }
    }

    // 4. Advance the per-repo cursor (ETag + since). Subtract ~1s for edge safety.
    if (changed.latestUpdatedAt) {
      const since = new Date(Date.parse(changed.latestUpdatedAt) - 1000).toISOString();
      store.setRepoSyncState(repo, { repoLastUpdatedAt: since, etag: changed.etag ?? cursor?.etag ?? null });
    } else if (changed.etag && changed.etag !== cursor?.etag) {
      store.setRepoSyncState(repo, { repoLastUpdatedAt: cursor?.repoLastUpdatedAt ?? null, etag: changed.etag });
    }
  }

  private async applyRemoteIssue(
    adapter: GithubBackendAdapter,
    repo: string,
    todo: Todo,
    issue: RemoteIssue,
    result: SyncResult,
  ): Promise<void> {
    const baseline = parseSnapshot(todo.remoteSnapshot);

    // --- Title (structural: origin-wins; both-sides-edited → conflict) ---
    const localTitle = todo.text;
    const remoteTitle = issue.title;
    const baselineTitle = baseline?.title ?? null;
    const titleBaselineExists = baselineTitle !== null;
    const localTitleChanged = titleBaselineExists && localTitle !== baselineTitle;
    const remoteTitleChanged = titleBaselineExists && remoteTitle !== baselineTitle;
    let titleConflicted = false;

    if (titleBaselineExists && localTitleChanged && remoteTitleChanged && localTitle !== remoteTitle) {
      // Both sides edited the title to different values → conflict (R11). Leave
      // the field unchanged. (If both converged to the same value, no conflict —
      // fall through to the origin-wins branch, which no-ops and advances the baseline.)
      store.setTodoConflict(todo.id, 'title', localTitle, remoteTitle, baselineTitle);
      result.conflicts++;
      titleConflicted = true;
    } else if (todo.origin === 'local') {
      // Origin-wins: push the local title outward when the replica diverged.
      if (remoteTitle !== localTitle) {
        try {
          await adapter.update(repo, issue.number, { title: localTitle });
        } catch (err) {
          recordError(result, repo, err);
        }
      }
    } else {
      // origin=github: mirror the remote title inward.
      if (remoteTitle !== localTitle) {
        store.updateTodo(todo.id, { text: remoteTitle });
      }
    }

    // --- Body (structural: mirrors the title logic; content ↔ issue body) ---
    // F3: an INDEPENDENT if-else chain — title and body can each conflict/push/
    // mirror on their own, tracked by separate booleans and advanced independently.
    const localContent = todo.content ?? null;
    const remoteBody = issue.body ?? null;
    const baselineBody = baseline?.body ?? null;
    const bodyBaselineExists = baselineBody !== null;
    const localContentChanged = bodyBaselineExists && localContent !== baselineBody;
    const remoteBodyChanged = bodyBaselineExists && remoteBody !== baselineBody;
    let bodyConflicted = false;

    if (bodyBaselineExists && localContentChanged && remoteBodyChanged && localContent !== remoteBody) {
      // Both sides edited the body to different values → conflict (R7). The local
      // conflict model stores strings, so coerce null → '' for local/remote values.
      store.setTodoConflict(todo.id, 'body', localContent ?? '', remoteBody ?? '', baselineBody);
      result.conflicts++;
      bodyConflicted = true;
    } else if (todo.origin === 'local') {
      // Origin-wins: push the local content outward as the issue body.
      if (remoteBody !== localContent) {
        try {
          await adapter.update(repo, issue.number, { body: localContent });
        } catch (err) {
          recordError(result, repo, err);
        }
      }
    } else {
      // origin=github: mirror the remote body inward into content. This is also
      // the backfill path (R9) for an existing todo whose content is empty/null.
      if (remoteBody !== localContent) {
        store.updateTodo(todo.id, { content: remoteBody });
      }
    }

    // Collaborative state: accept remote, mirror locally (newest wins).
    store.updateTodo(todo.id, {
      status: stateToLocalStatus(issue.state),
      labels: issue.labels,
      assignee: issue.assignee,
    });

    // Comments: append-only pull (deduped by remote id).
    try {
      const comments = await adapter.fetchComments(repo, issue.number);
      for (const c of comments) store.upsertRemoteTodoComment(todo.id, c.id, c.author, c.body, c.createdAt);
    } catch (err) {
      recordError(result, repo, err);
    }

    // Advance baseline + remoteUpdatedAt + lastSyncedAt. Each field advances
    // independently (F3): a field under conflict keeps its old baseline so it
    // stays detected until U6 resolves it; a non-conflicted field advances to the
    // origin-side value (local-origin → local value, github-origin → remote value).
    const prevTitle = baselineTitle ?? localTitle;
    const prevBody = baselineBody ?? (todo.origin === 'local' ? localContent : remoteBody);
    const newBaselineTitle = titleConflicted ? prevTitle : todo.origin === 'local' ? localTitle : remoteTitle;
    const newBaselineBody = bodyConflicted ? prevBody : todo.origin === 'local' ? localContent : remoteBody;
    store.updateTodo(todo.id, {
      remoteSnapshot: snapshotJson(newBaselineTitle ?? localTitle, newBaselineBody),
      remoteUpdatedAt: issue.updatedAt,
      lastSyncedAt: new Date().toISOString(),
      originDeleted: false,
    });
    result.upserted++;
  }
}

let inFlight: Promise<SyncResult> | null = null;

/** Diagnostic log helper — always redacts (R13). */
function diagLogSync(op: string, repo: string, err: unknown): void {
  diagLog(`[todo-sync] ${op} ${repo}:`, redactGithubError(err).message);
}

export const todoSyncService = new TodoSyncService();
