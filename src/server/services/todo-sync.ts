/**
 * On-demand, origin-anchored, field-class sync engine (R9/R10/R12, KTD8).
 *
 * The field-class policy lives here, in core, behind the backend-agnostic
 * {@link GithubBackendAdapter} contract — a second backend implements the same
 * adapter with no change here:
 *   - Discussion (comments): append-only, both directions; never conflicts.
 *   - Collaborative state (status/labels/assignee): accept remote, mirror locally.
 *   - Structural (title): origin-wins; both-sides-edited → conflict (R11), surfaced
 *     for U6 to resolve. The local todo model is title-only (`text` ↔ issue title);
 *     issue body is GitHub-side and not mirrored to a local field.
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
}

function parseSnapshot(json: string | null): Baseline | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<Baseline>;
    if (typeof parsed.title === 'string') return { title: parsed.title };
    return null;
  } catch {
    return null;
  }
}

function snapshotJson(title: string): string {
  return JSON.stringify({ title });
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
      body: null,
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
      remoteSnapshot: snapshotJson(issue.title),
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
    const created = store.createTodo(wsId, { text: issue.title });
    store.updateTodo(created.id, {
      origin: 'github',
      repoFullName: repo,
      issueNumber: issue.number,
      status: stateToLocalStatus(issue.state),
      assignee: issue.assignee,
      labels: issue.labels,
      remoteSnapshot: snapshotJson(issue.title),
      remoteUpdatedAt: issue.updatedAt,
      lastSyncedAt: new Date().toISOString(),
      originDeleted: false,
    });

    // Pull comments (append-only).
    try {
      const comments = await adapter.fetchComments(repo, issueNumber);
      for (const c of comments) store.upsertRemoteTodoComment(created.id, c.id, c.author, c.body, c.createdAt);
    } catch (err) {
      diagLogSync('pull', repo, err);
    }
    return store.getTodoById(created.id) ?? created;
  }

  // --- Conflict resolution (R11 / U6) --------------------------------------

  /**
   * Apply the user's accept-local/accept-remote choice for a structural-field
   * conflict, reset the baseline to the chosen value, and clear the conflict.
   * Convergence with the remote happens on the next reconcile (origin-wins push
   * or accept-remote mirror); no immediate network call is needed.
   */
  resolveConflict(todoId: string, field: 'title' | 'body', choice: 'local' | 'remote'): Todo {
    const conflict = store.getTodoConflicts(todoId).find((c) => c.field === field);
    if (!conflict) throw new SyncError('No such conflict', 404);
    const chosen = choice === 'local' ? conflict.localValue : conflict.remoteValue;
    // `title` maps to the local `text`; `body` has no local field in v1.
    if (field === 'title') {
      store.updateTodo(todoId, { text: chosen, remoteSnapshot: snapshotJson(chosen) });
    } else {
      store.updateTodo(todoId, { remoteSnapshot: snapshotJson(chosen) });
    }
    store.clearTodoConflict(todoId, field);
    const updated = store.getTodoById(todoId);
    if (!updated) throw new SyncError('Todo not found', 404);
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

    // 1. Push local-origin outward: unpushed comments + divergent title/status.
    for (const todo of store.getTodosByRepo(repo)) {
      if (todo.origin !== 'local' || todo.originDeleted || !todo.issueNumber) continue;
      for (const comment of store.listUnpushedTodoComments(todo.id)) {
        try {
          const remote = await adapter.addComment(repo, todo.issueNumber, comment.body);
          store.markTodoCommentPushed(comment.id, remote.id);
        } catch (err) {
          recordError(result, repo, err);
        }
      }
    }

    // 2. Apply remote changes to linked todos.
    for (const issue of changed.issues) {
      const todo = store.findTodoByRepoIssue(repo, issue.number);
      if (!todo) continue; // reconcile only touches linked todos; pull is explicit
      await this.applyRemoteIssue(adapter, repo, todo, issue, result);
    }

    // 3. Origin-side deletion detection (github-origin todos whose issue is gone).
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
    const localTitle = todo.text;
    const remoteTitle = issue.title;
    const baselineTitle = baseline?.title ?? null;
    const hasBaseline = baselineTitle !== null;
    const localTitleChanged = hasBaseline && localTitle !== baselineTitle;
    const remoteTitleChanged = hasBaseline && remoteTitle !== baselineTitle;
    let conflicted = false;

    if (hasBaseline && localTitleChanged && remoteTitleChanged) {
      // Both sides edited the title → conflict (R11). Leave the field unchanged.
      store.setTodoConflict(todo.id, 'title', localTitle, remoteTitle, baselineTitle);
      result.conflicts++;
      conflicted = true;
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

    // Advance baseline + remoteUpdatedAt + lastSyncedAt. On a title conflict,
    // keep the old title baseline so it stays detected until U6 resolves it.
    const newBaselineTitle = conflicted ? baselineTitle : todo.origin === 'local' ? localTitle : remoteTitle;
    store.updateTodo(todo.id, {
      remoteSnapshot: snapshotJson(newBaselineTitle ?? localTitle),
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
