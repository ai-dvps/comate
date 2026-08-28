import { randomUUID } from 'node:crypto';

import type { GetAccountTokenUsageResponse } from '../generated/codex-protocol/v2/GetAccountTokenUsageResponse.js';
import type { ThreadReadResponse } from '../generated/codex-protocol/v2/ThreadReadResponse.js';
import type { ChatSession } from '../models/session.js';
import type { Workspace } from '../models/workspace.js';
import type { SessionAnalyticsRow } from '../storage/analytics-cache.js';
import type { BackendId } from './agent-backends.js';
import { codexAppServerManager, type CodexAppServerManager } from './codex-app-server-manager.js';
import {
  extractCodexSessionAnalytics,
  extractOpenCodeSessionAnalytics,
} from './analytics-backend-readers.js';
import {
  opencodeFetch,
  opencodeServerManager,
  type OpencodeServerManager,
} from './opencode-server-manager.js';
import type { OpencodeRestMessage } from './opencode-transcript.js';

export type AnalyticsBackend = Exclude<BackendId, 'claude'>;

export interface AnalyticsBackendTarget {
  session: ChatSession;
  fingerprint: number;
}

export interface AnalyticsBackendSource {
  backend: AnalyticsBackend;
  extractWorkspace(
    workspace: Workspace,
    targets: readonly AnalyticsBackendTarget[],
    extractedAt: number,
  ): Promise<SessionAnalyticsRow[]>;
}

type OpenCodeFetch = typeof opencodeFetch;

export class OpenCodeAnalyticsSource implements AnalyticsBackendSource {
  readonly backend = 'opencode' as const;

  constructor(
    private readonly manager: OpencodeServerManager = opencodeServerManager,
    private readonly fetchImpl: OpenCodeFetch = opencodeFetch,
  ) {}

  async extractWorkspace(
    workspace: Workspace,
    targets: readonly AnalyticsBackendTarget[],
    extractedAt: number,
  ): Promise<SessionAnalyticsRow[]> {
    if (targets.length === 0) return [];
    // Each refresh owns its ephemeral reader server. Concurrent global and
    // workspace requests must not stop one another's process mid-fetch.
    const serverKey = `analytics:${workspace.id}:${randomUUID()}`;
    const instance = await this.manager.ensureServer(serverKey, workspace.folderPath, {
      // Reading persisted history does not need an inference provider. Keeping
      // this server credential-free also means opening Analytics never exposes
      // a session Provider secret to an extra process.
      config: {},
      env: process.env,
    });
    const rows: SessionAnalyticsRow[] = [];
    try {
      for (const target of targets) {
        const backendSessionId = target.session.backendSessionId;
        if (!backendSessionId) continue;
        try {
          const response = await this.fetchImpl(instance, `/session/${backendSessionId}/message`);
          if (!response.ok) {
            throw new Error(`OpenCode history returned HTTP ${response.status}`);
          }
          const messages = await response.json() as OpencodeRestMessage[];
          rows.push(extractOpenCodeSessionAnalytics({
            sessionId: target.session.id,
            workspaceId: workspace.id,
            fingerprint: target.fingerprint,
            extractedAt,
            messages,
          }));
        } catch (error) {
          console.warn(
            `[OpenCodeAnalyticsSource] failed to extract session ${target.session.id}:`,
            error,
          );
        }
      }
    } finally {
      await this.manager.stopServer(serverKey);
    }
    return rows;
  }
}

export class CodexAnalyticsSource implements AnalyticsBackendSource {
  readonly backend = 'codex' as const;

  constructor(private readonly manager: CodexAppServerManager = codexAppServerManager) {}

  async extractWorkspace(
    workspace: Workspace,
    targets: readonly AnalyticsBackendTarget[],
    extractedAt: number,
  ): Promise<SessionAnalyticsRow[]> {
    const rows: SessionAnalyticsRow[] = [];
    for (const target of targets) {
      const threadId = target.session.backendSessionId;
      if (!threadId) continue;
      try {
        const response = await this.manager.request<ThreadReadResponse>('thread/read', {
          threadId,
          includeTurns: true,
        });
        let usage: GetAccountTokenUsageResponse['threadUsage'] = null;
        try {
          const usageResponse = await this.manager.request<GetAccountTokenUsageResponse>(
            'account/usage/read',
            { threadId },
          );
          usage = usageResponse.threadUsage ?? null;
        } catch (error) {
          // Thread history is still valuable when account billing data is
          // unavailable (for example, some third-party Provider sessions).
          console.warn(
            `[CodexAnalyticsSource] usage unavailable for session ${target.session.id}:`,
            error,
          );
        }
        rows.push(extractCodexSessionAnalytics({
          sessionId: target.session.id,
          workspaceId: workspace.id,
          fingerprint: target.fingerprint,
          extractedAt,
          thread: response.thread,
          usage,
        }));
      } catch (error) {
        console.warn(
          `[CodexAnalyticsSource] failed to extract session ${target.session.id}:`,
          error,
        );
      }
    }
    return rows;
  }
}

export const analyticsBackendSources: readonly AnalyticsBackendSource[] = [
  new OpenCodeAnalyticsSource(),
  new CodexAnalyticsSource(),
];
