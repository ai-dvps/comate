/**
 * Analytics orchestrator (see plan 2026-06-13-007, U2).
 *
 * Refreshes the per-session cache from disk and rolls up Global/Workspace
 * summaries. The cache is the system of record between refreshes; this
 * service re-extracts only stale sessions (transcript mtime changed or row
 * missing) and reads the rest from cache.
 *
 * Data flow:
 *   1. List workspaces via the sqlite store.
 *   2. For each workspace, call `sdkClient.listSessions({dir: folderPath})`
 *      to enumerate session ids + transcript mtimes. (This covers both
 *      regular and WeCom sessions — WeCom sessions live in the same
 *      `~/.claude/projects/<encoded-cwd>/` directory.)
 *   3. Compute stale sessions against the cache.
 *   4. Re-extract stale sessions by reading the JSONL directly.
 *   5. Roll up cache rows via the pure aggregation module.
 *
 * The SDK accessor is intentionally NOT used for extraction (probe during
 * planning confirmed it returns only the live post-compaction view, ~10.5%
 * coverage on a heavily-compacted session).
 */

import type { SDKSessionInfo, ListSessionsOptions } from '@anthropic-ai/claude-agent-sdk';

import { store } from '../storage/sqlite-store.js';
import type { Workspace } from '../models/workspace.js';
import {
  resolveTranscriptFile,
  statTranscript,
} from './analytics-transcript-path.js';
import { extractSessionAnalytics } from './analytics-transcript-reader.js';
import {
  rollupGlobal,
  rollupWorkspace,
  type GlobalStatsSummary,
  type WorkspaceRollupInput,
  type WorkspaceStatsSummary,
} from './analytics-aggregation.js';
import { SdkClient } from './sdk-client.js';

/**
 * Narrow SDK surface the service depends on, so tests can stub it without
 * constructing a real SdkClient (which spawns a Claude Code sidecar).
 */
export interface AnalyticsSdkLike {
  listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]>;
}

/**
 * Narrow store surface for testability. The production store satisfies this
 * via its `list`, `get`, and `getAnalyticsCache` members.
 */
export interface AnalyticsStoreLike {
  list(): Promise<Workspace[]>;
  get(id: string): Promise<Workspace | null>;
  getAnalyticsCache(): ReturnType<typeof store.getAnalyticsCache>;
}

export class AnalyticsService {
  private readonly sdk: AnalyticsSdkLike;
  private readonly storeImpl: AnalyticsStoreLike;

  constructor(sdk?: AnalyticsSdkLike, storeImpl?: AnalyticsStoreLike) {
    this.sdk = sdk ?? new SdkClient();
    this.storeImpl = storeImpl ?? store;
  }

  /**
   * Refresh every workspace's cache and return the global summary.
   */
  async getGlobalSummary(): Promise<GlobalStatsSummary> {
    const workspaces = await this.storeImpl.list();
    const bundles: WorkspaceRollupInput[] = [];
    for (const ws of workspaces) {
      await this.refreshWorkspace(ws);
      const rows = this.storeImpl.getAnalyticsCache().listByWorkspace(ws.id);
      bundles.push({
        ctx: { workspaceId: ws.id, workspaceName: ws.name },
        rows,
      });
    }
    return rollupGlobal(bundles);
  }

  /**
   * Refresh one workspace's cache and return its summary. Returns null when
   * the workspace id is unknown.
   */
  async getWorkspaceSummary(workspaceId: string): Promise<WorkspaceStatsSummary | null> {
    const ws = await this.storeImpl.get(workspaceId);
    if (!ws) return null;
    await this.refreshWorkspace(ws);
    const rows = this.storeImpl.getAnalyticsCache().listByWorkspace(ws.id);
    return rollupWorkspace(rows, { workspaceId: ws.id, workspaceName: ws.name });
  }

  /**
   * Re-extract stale sessions for one workspace into the cache. No-op when
   * listSessions fails (we keep whatever's in cache) or when there's nothing
   * stale. Errors per-session are logged and skipped so one bad transcript
   * doesn't poison the whole refresh.
   */
  private async refreshWorkspace(ws: Workspace): Promise<void> {
    let sessions: SDKSessionInfo[];
    try {
      sessions = await this.sdk.listSessions({ dir: ws.folderPath });
    } catch (err) {
      console.warn(
        `[AnalyticsService] listSessions failed for workspace ${ws.id} (${ws.folderPath}):`,
        err,
      );
      return;
    }
    if (sessions.length === 0) return;

    const cache = this.storeImpl.getAnalyticsCache();
    const staleIds = new Set(
      cache.staleSessionIds(
        sessions.map((s) => ({ sessionId: s.sessionId, mtime: s.lastModified })),
      ),
    );
    if (staleIds.size === 0) return;

    const extractedAt = Date.now();
    for (const session of sessions) {
      if (!staleIds.has(session.sessionId)) continue;
      const transcriptPath = resolveTranscriptFile(ws.folderPath, session.sessionId);
      if (!transcriptPath) continue;

      // The SDK may report a session whose JSONL is unreadable right now
      // (concurrent write, partial flush). Skip those without clobbering the
      // cache; they'll be retried on the next refresh.
      const stat = statTranscript(transcriptPath);
      if (!stat.exists) continue;

      const outcome = extractSessionAnalytics({
        sessionId: session.sessionId,
        workspaceId: ws.id,
        transcriptPath,
        transcriptMtime: session.lastModified,
        extractedAt,
      });
      if (outcome.row) {
        try {
          cache.upsert(outcome.row);
        } catch (err) {
          console.warn(
            `[AnalyticsService] upsert failed for session ${session.sessionId}:`,
            err,
          );
        }
      }
    }
  }
}

export const analyticsService = new AnalyticsService();
