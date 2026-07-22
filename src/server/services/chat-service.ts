import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import type { Query, SDKMessage, SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatSession, CreateSessionInput, UpdateSessionInput } from '../models/session.js';
import type { Workspace } from '../models/workspace.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import type { ChatMessage, SubagentState, TaskItem, SseEvent, WorkflowState } from '../types/message.js';
import { normalizeSessionMessage, scanSdkMessagesForTasks } from './message-normalizer.js';
import { SdkClient } from './sdk-client.js';
import { SessionRuntime } from './session-runtime.js';
import { reconstructSubagentState } from './subagent-loader.js';
import { resolveTranscriptDir } from './analytics-transcript-path.js';
import { listWorkflowAgentIds, listWorkflowRunIds, loadWorkflowState } from './workflow-loader.js';
import { resolveSdkBinary } from '../utils/resolve-sdk-binary.js';
import { resolveWecomCliPath } from '../utils/resolve-wecom-cli.js';
import { sidecarLog } from '../utils/sidecar-logger.js';
import { diagLog } from '../utils/diag-logger.js';
import { normalizeWindowsPath } from '../utils/normalize-windows-path.js';
import { loadClaudeSettings } from '../utils/claude-settings.js';
import { buildClaudeEnv, prependEnvPath, getPathEnvKey } from '../utils/sdk-env.js';
import { pluginSettingsService } from './plugin-settings-service.js';
import { evaluateToolPermission, getToolPermissionDenialReason, resolveEffectivePolicy } from './tool-permission-policy.js';
import { createPathPolicyContext, validateToolInput } from './bot-path-policy.js';
import { evaluateSkill } from './bot-skill-policy.js';
import { botService } from './bot-service.js';
import { botAuditLogger } from './bot-audit-logger.js';
import { evaluateBotToolPermission, evaluateBotSkill, isBashCommandAllowed, isOwnerOrAdmin } from './bot-policy.js';
import type { BotRolePolicy } from '../models/bot.js';
import { SAFE_PRESET } from './tool-permission-policy.js';
import type { Provider } from '../models/provider.js';
import {
  BROWSER_MCP_SERVER_KEY,
  BROWSER_STREAM_CLOSE_TIMEOUT_MS,
  createBrowserMcpServer,
  type BrowserApprovalRequester,
} from './browser-mcp.js';
import { isBrowserToolName } from './browser-tool-names.js';

import { browserControlService } from './browser-control.js';

const FILE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit']);
const IDENTITY_SENSITIVE_TOOLS = new Set([...FILE_TOOLS, 'Bash', 'Skill']);

function sanitizeBotEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('WECOM_')) continue;
    if (/^(AWS_|GOOGLE_|AZURE_|OPENAI_)/i.test(key)) continue;
    if (/^CLAUDE_(API_KEY|AUTH)/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Browser tools never run in bot sessions (U4, KTD-4 ③): the browser MCP
 * server is not injected for bot sessions at all, so this explicit deny is
 * the second line of defense (covers spoofed/legacy tool names) and must
 * precede the 'unknown' fall-through in the canUseTool closures. It applies
 * to admins too — the admin bypass is void for the browser category. The
 * message is generic: naming the capability would let an attacker probe the
 * policy surface. Returns null for non-browser tools.
 */
function denyBrowserToolInBotSession(
  sessionId: string,
  toolName: string,
  toolUseID: string | undefined,
): { behavior: 'deny'; message: string } | null {
  if (!isBrowserToolName(toolName)) return null;
  diagLog(
    `[ChatService.botDeny] session=${sessionId} tool=${toolName} toolUseId=${toolUseID ?? 'none'} reason=browser-tool-bot-session`,
  );
  return {
    behavior: 'deny',
    message: "I can't do that in this workspace.",
  };
}

export interface MessageStream {
  messages: AsyncGenerator<SDKMessage>;
  rawQuery: Query;
  wasDraft: boolean;
}

type RuntimeContext = {
  workspaceId: string;
  isBotSession?: boolean;
  botUserId?: string;
};

let RUNTIME_IDLE_GRACE_PERIOD_MS = 10 * 60 * 1000; // 10 minutes

export function __setIdleGracePeriodForTesting(ms: number): void {
  RUNTIME_IDLE_GRACE_PERIOD_MS = ms;
}

export function __restoreIdleGracePeriod(): void {
  RUNTIME_IDLE_GRACE_PERIOD_MS = 10 * 60 * 1000;
}

let REBUILD_POLL_INTERVAL_MS = 500;

export function __setRebuildPollIntervalForTesting(ms: number): void {
  REBUILD_POLL_INTERVAL_MS = ms;
}

export function __restoreRebuildPollInterval(): void {
  REBUILD_POLL_INTERVAL_MS = 500;
}

let SESSION_VERIFY_TIMEOUT_MS = 10000;

export function __setSessionVerifyTimeoutForTesting(ms: number): void {
  SESSION_VERIFY_TIMEOUT_MS = ms;
}

export function __restoreSessionVerifyTimeout(): void {
  SESSION_VERIFY_TIMEOUT_MS = 10000;
}

class SessionVerifyTimeoutError extends Error {
  constructor() {
    super('SDK getSessionInfo timeout');
  }
}

export class ChatService {
  private sdkClient: SdkClient;
  private runtimes = new Map<string, SessionRuntime>();
  private creatingRuntimes = new Map<string, Promise<SessionRuntime>>();
  private idleTimeouts = new Map<string, NodeJS.Timeout>();
  private runtimeContexts = new Map<string, RuntimeContext>();
  private pendingRebuilds = new Map<string, RuntimeContext>();
  private rebuildPollers = new Map<string, NodeJS.Timeout>();
  private onRuntimeClose?: (sessionId: string) => void;
  private historyTimestampBases = new Map<string, number>();
  /**
   * Chained PRE-close listeners (KTD-5): the single-slot onRuntimeClose stays
   * with the WS server; services that must react to a runtime close (the
   * browser handoff controller) subscribe here instead of overwriting it.
   * Fired BEFORE runtime.close() so a listener can mark its own state before
   * close() resolves the session's pending cards with its generic deny.
   */
  private readonly runtimeClosingListeners = new Set<(sessionId: string) => void>();
  readonly serverNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  constructor(sdkClient?: SdkClient) {
    this.sdkClient = sdkClient ?? new SdkClient();
    // Wire the browser handoff controller's runtime channel (U5, KTD-6): the
    // controller resolves/timeouts the session's live browser card through
    // whatever runtime currently owns the session (lazy lookup — the runtime
    // may be rebuilt while the browser lives on, KTD-5; a missing runtime
    // no-ops, which the crash path relies on).
    browserControlService.configureRuntimeChannel({
      resolveApprovalCard: (sessionId, requestId, result, message) => {
        const runtime = this.getRuntimeIfExists(sessionId);
        if (!runtime) return;
        runtime.resolveApproval(
          requestId,
          result === 'allow'
            ? { behavior: 'allow' }
            : { behavior: 'deny', message: message ?? 'The browser handoff was ended.' },
        );
      },
      timeoutApprovalCard: (sessionId, requestId) => {
        this.getRuntimeIfExists(sessionId)?.timeoutDenyApproval(requestId);
      },
    });
    this.addOnRuntimeClosing((sessionId) => {
      browserControlService.handleRuntimeClosing(sessionId);
    });
  }

  /**
   * Handler-level approval channel for the browser MCP tools (U3, KTD-4 ②).
   * The submit tool calls this from INSIDE its handler — a workspace's
   * `.claude/settings.json` `permissions.allow` can short-circuit the SDK's
   * canUseTool evaluation, so the confirmation round-trip must not depend on
   * the interception layer. Lazy runtime lookup is deliberate: the runtime
   * may be rebuilt while the browser session lives on (KTD-5), and the lookup
   * rebinds to whatever runtime currently owns the session. Fails closed when
   * no runtime is live (the tool handler only runs during a runtime turn, so
   * this is a defensive path).
   */
  private readonly browserApprovalRequester: BrowserApprovalRequester = async (
    sessionId,
    request,
  ) => {
    const runtime = this.getRuntimeIfExists(sessionId);
    if (!runtime) {
      return {
        behavior: 'deny' as const,
        message: 'No live runtime is available for the browser approval round-trip.',
      };
    }
    const requestId = request.requestId ?? `browser-${randomUUID()}`;
    const result = await runtime.requestToolApproval(
      requestId,
      request.toolName,
      requestId,
      request.payload,
      {
        title: request.title,
        ...(request.description !== undefined && { description: request.description }),
        ...(request.signal !== undefined && { signal: request.signal }),
      },
    );
    return result.behavior === 'allow'
      ? { behavior: 'allow' as const }
      : { behavior: 'deny' as const, message: result.message };
  };

  setOnRuntimeClose(callback: (sessionId: string) => void): void {
    this.onRuntimeClose = callback;
  }

  /**
   * Chained pre-close listener subscription (KTD-5): complements the WS
   * server's single-slot onRuntimeClose — listeners run BEFORE runtime.close()
   * in closeRuntime. Returns an unsubscribe function.
   */
  addOnRuntimeClosing(listener: (sessionId: string) => void): () => void {
    this.runtimeClosingListeners.add(listener);
    return () => {
      this.runtimeClosingListeners.delete(listener);
    };
  }

  getActiveSessionCount(): number {
    return this.runtimes.size;
  }

  /** Diagnostic: test-run the Claude binary in the workspace cwd to capture stderr. */
  protected async testClaudeBinary(claudePath: string | undefined, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
    if (!claudePath) {
      sidecarLog('[ChatService.testClaudeBinary] no binary path, skipping test');
      return;
    }
    sidecarLog(`[ChatService.testClaudeBinary] testing binary: ${claudePath} in cwd: ${cwd}`);
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true;
        return true;
      };
      const proc = spawn(claudePath, ['--version'], { cwd, env });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d) => { stdout += String(d); });
      proc.stderr?.on('data', (d) => { stderr += String(d); });
      const timeout = setTimeout(() => {
        if (!finish()) return;
        sidecarLog('[ChatService.testClaudeBinary] timeout after 10s');
        proc.kill();
        resolve();
      }, 10000);
      proc.on('close', (code) => {
        if (!finish()) return;
        clearTimeout(timeout);
        sidecarLog(`[ChatService.testClaudeBinary] exit code=${code} stdout=${stdout.trim()} stderr=${stderr.trim()}`);
        resolve();
      });
      proc.on('error', (err) => {
        if (!finish()) return;
        clearTimeout(timeout);
        sidecarLog(`[ChatService.testClaudeBinary] spawn error: ${err.message}`);
        resolve();
      });
    });
  }

  // Session management

  async listSessions(workspaceId: string, options: { archiveThresholdDays?: number } = {}): Promise<ChatSession[]> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      throw new ChatError('Workspace not found', 'WORKSPACE_NOT_FOUND', 404);
    }

    // Discover SDK sessions for this workspace directory and sync into local DB
    try {
      const sessions = await this.sdkClient.listSessions({ dir: workspace.folderPath });
      for (const sdkSession of sessions) {
        const session = this.mapSdkSessionInfo(sdkSession, workspaceId);
        workspaceStore.syncSdkSession(session);
      }
    } catch (err) {
      console.error('Failed to list SDK sessions:', err);
      // Continue with local sessions even if SDK listing fails
    }

    // Load merged sessions from local DB (drafts + synced SDK sessions)
    const allSessions = workspaceStore.listLocalSessions(workspaceId);

    // Identify bot sessions from the unified user_sessions / bot_users tables.
    const botSessions = workspaceStore.listBotSessionsForWorkspace(workspaceId);
    for (const session of allSessions) {
      const botSession = botSessions.find((m) => m.sessionId === session.id);
      if (botSession) {
        session.source = botSession.channelKey;
      }
    }

    // Auto-archive stale non-WIP sessions when a threshold is provided
    const thresholdDays = options.archiveThresholdDays;
    if (typeof thresholdDays === 'number' && thresholdDays > 0) {
      const thresholdMs = thresholdDays * 86400_000;
      const now = Date.now();
      for (const session of allSessions) {
        if (session.isArchived || session.isWip) continue;
        const lastActive = session.lastModified ?? Date.parse(session.updatedAt);
        if (typeof lastActive !== 'number' || isNaN(lastActive)) continue;
        if (now - lastActive > thresholdMs) {
          workspaceStore.updateLocalSession(session.id, { isArchived: true });
          session.isArchived = true;
        }
      }
    }

    return allSessions;
  }

  async createSession(input: CreateSessionInput): Promise<ChatSession> {
    return workspaceStore.createLocalSession(
      input.workspaceId,
      input.name,
      input.approvalMode,
      input.providerId,
      input.source,
      input.customTitle,
      input.botId,
    );
  }

  async getSession(id: string, workspaceId: string): Promise<ChatSession | null> {
    // Try SDK first for freshest data
    const workspace = await workspaceStore.get(workspaceId);
    if (workspace) {
      try {
        const sdkSession = await this.sdkClient.getSessionInfo(id, { dir: workspace.folderPath });
        if (sdkSession) {
          const session = this.mapSdkSessionInfo(sdkSession, workspaceId);
          // Preserve providerId and local-only booleans from local DB — the SDK doesn't know about them
          const localSession = workspaceStore.getLocalSession(id);
          session.providerId = localSession?.providerId;
          session.isWip = localSession?.isWip;
          session.isArchived = localSession?.isArchived;
          session.approvalMode = localSession?.approvalMode;
          session.fastMode = localSession?.fastMode;
          session.botId = localSession?.botId;
          session.source = localSession?.source;
          workspaceStore.syncSdkSession(session);
          return session;
        }
      } catch {
        // Ignore SDK errors, fall back to local DB
      }
    }

    // Fall back to local DB
    return workspaceStore.getLocalSession(id);
  }

  async updateSession(id: string, input: UpdateSessionInput, workspaceId: string): Promise<ChatSession | null> {
    // Persist isWip to DB (applies to both drafts and SDK sessions)
    if (input.isWip !== undefined) {
      workspaceStore.setSessionMetadata(id, input.isWip);
    }

    // Persist isArchived to DB (applies to both drafts and SDK sessions)
    if (input.isArchived !== undefined) {
      workspaceStore.updateLocalSession(id, { isArchived: input.isArchived });
    }

    // Check local DB for current provider before update
    const localSession = workspaceStore.getLocalSession(id);
    const previousProviderId = localSession?.providerId;

    if (localSession && localSession.isDraft) {
      const draftInput: Parameters<typeof workspaceStore.updateLocalSession>[1] = {};
      if (input.name !== undefined) draftInput.name = input.name;
      if (input.providerId !== undefined) draftInput.providerId = input.providerId;
      if (input.isArchived !== undefined) draftInput.isArchived = input.isArchived;
      if (input.fastMode !== undefined) draftInput.fastMode = input.fastMode;
      const updated = workspaceStore.updateLocalSession(id, draftInput);

      // Schedule rebuild if provider changed so next message creates a fresh runtime
      if (input.providerId !== undefined && input.providerId !== previousProviderId) {
        const runtime = this.getRuntimeIfExists(id);
        if (runtime) {
          sidecarLog(`[ChatService] scheduling rebuild for runtime ${id} due to provider change`);
          this.scheduleRuntimeRebuild(id, this.runtimeContexts.get(id));
        }
      }

      return updated;
    }

    // Otherwise rename the SDK session
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      throw new ChatError('Workspace not found', 'WORKSPACE_NOT_FOUND', 404);
    }

    if (input.name) {
      await this.sdkClient.renameSession(id, input.name, { dir: workspace.folderPath });
    }

    // Also update local DB for providerId and isArchived changes on non-draft sessions
    const localUpdates: Parameters<typeof workspaceStore.updateLocalSession>[1] = {};
    if (input.providerId !== undefined) localUpdates.providerId = input.providerId;
    if (input.isArchived !== undefined) localUpdates.isArchived = input.isArchived;
    if (input.fastMode !== undefined) localUpdates.fastMode = input.fastMode;
    if (Object.keys(localUpdates).length > 0) {
      workspaceStore.updateLocalSession(id, localUpdates);
    }

    // Close runtime if provider changed so next message creates a fresh one
    if (input.providerId !== undefined && input.providerId !== previousProviderId) {
      const runtime = this.getRuntimeIfExists(id);
      if (runtime) {
        sidecarLog(`[ChatService] closing runtime ${id} due to provider change`);
        this.closeRuntime(id).catch((err) => {
          console.error(`Failed to close runtime ${id} during provider switch:`, err);
        });
      }
    }

    // Return updated session info
    const sdkSession = await this.sdkClient.getSessionInfo(id, { dir: workspace.folderPath });
    if (sdkSession) {
      const session = this.mapSdkSessionInfo(sdkSession, workspaceId);
      workspaceStore.syncSdkSession(session);
      const localSession = workspaceStore.getLocalSession(id);
      session.isWip = localSession?.isWip;
      session.isArchived = localSession?.isArchived;
      session.approvalMode = localSession?.approvalMode;
      session.fastMode = localSession?.fastMode;
      session.providerId = localSession?.providerId;
      return session;
    }
    return workspaceStore.getLocalSession(id);
  }

  async deleteSession(id: string, workspaceId: string): Promise<boolean> {
    const localSession = workspaceStore.getLocalSession(id);
    if (localSession && localSession.isDraft) {
      return workspaceStore.deleteLocalSession(id);
    }

    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      throw new ChatError('Workspace not found', 'WORKSPACE_NOT_FOUND', 404);
    }

    try {
      // Import deleteSession from SDK
      const { deleteSession } = await import('@anthropic-ai/claude-agent-sdk');
      await deleteSession(id, { dir: workspace.folderPath });
    } catch (err) {
      console.error('Failed to delete SDK session:', err);
      // Still delete from local DB even if SDK deletion fails
    }

    return workspaceStore.deleteLocalSession(id);
  }

  async forkSession(id: string, workspaceId: string): Promise<{ sessionId: string }> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      throw new ChatError('Workspace not found', 'WORKSPACE_NOT_FOUND', 404);
    }

    const result = await this.sdkClient.forkSession(id, { dir: normalizeWindowsPath(workspace.folderPath) });
    return result;
  }

  async clearDraftFlag(id: string): Promise<boolean> {
    return workspaceStore.clearDraftFlag(id);
  }

  // Message history loading

  async loadWorkflowsForSession(sessionId: string, workspaceId: string): Promise<WorkflowState[]> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      return [];
    }

    const runIds = await listWorkflowRunIds(workspace.folderPath, sessionId);
    const workflows: WorkflowState[] = [];
    for (const runId of runIds) {
      const state = await loadWorkflowState({
        folderPath: workspace.folderPath,
        sessionId,
        runId,
      });
      if (state) {
        workflows.push(state);
      }
    }
    return workflows;
  }

  async loadSubagentsForSession(
    sessionId: string,
    workspaceId: string,
    mainSdkMessages: SessionMessage[] = [],
  ): Promise<SubagentState[]> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      return [];
    }

    const dir = normalizeWindowsPath(workspace.folderPath);
    let agentIds: string[] = [];
    try {
      agentIds = await this.sdkClient.listSubagents(sessionId, { dir });
    } catch (err) {
      console.error(`Failed to list subagents for ${sessionId}:`, err);
      return [];
    }

    if (agentIds.length === 0) {
      return [];
    }

    // Workflow subagents live under subagents/workflows/<runId>/ and are loaded
    // by workflow-loader with synthetic parentToolUseIds. Skip them here so they
    // are not treated as orphaned top-level subagents.
    const workflowAgentIds = await listWorkflowAgentIds(workspace.folderPath, sessionId);
    const filteredAgentIds = agentIds.filter((id) => !workflowAgentIds.has(id));
    const parentToolUseIdByAgentId = new Map<string, string>();
    const descriptionByToolUseId = new Map<string, string>();
    const toolUseIndexByToolUseId = new Map<string, number>();
    const toolResultIndexByToolUseId = new Map<string, number>();
    const now = Date.now();

    // Pre-scan the main transcript for Agent tool_use blocks to learn the
    // parent toolUseId, the human-readable description, and the message index
    // so we can approximate startTime when the SDK omits timestamps.
    for (const [msgIdx, msg] of mainSdkMessages.entries()) {
      if (msg.type !== 'assistant') continue;
      const raw = msg.message as { content?: unknown } | undefined;
      const content = raw?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const typed = block as { type?: unknown; name?: unknown; id?: unknown; input?: unknown };
        if (typed.type === 'tool_use' && typed.name === 'Agent') {
          const toolUseId = typeof typed.id === 'string' ? typed.id : '';
          const input = typed.input as Record<string, unknown> | undefined;
          const desc = typeof input?.description === 'string' ? input.description : '';
          if (toolUseId) {
            descriptionByToolUseId.set(toolUseId, desc);
            toolUseIndexByToolUseId.set(toolUseId, msgIdx);
          }
        }
      }
    }

    // Try the SDK's subagent meta file for the parent toolUseId mapping.
    const transcriptDir = resolveTranscriptDir(workspace.folderPath);
    for (const agentId of filteredAgentIds) {
      if (parentToolUseIdByAgentId.has(agentId)) continue;
      const metaPath = transcriptDir
        ? path.join(transcriptDir, sessionId, 'subagents', `agent-${agentId}.meta.json`)
        : null;
      if (metaPath && existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
            toolUseId?: unknown;
            description?: unknown;
          };
          if (typeof meta.toolUseId === 'string') {
            parentToolUseIdByAgentId.set(agentId, meta.toolUseId);
            if (typeof meta.description === 'string' && meta.description) {
              descriptionByToolUseId.set(meta.toolUseId, meta.description);
            }
          }
        } catch (err) {
          console.error(`Failed to parse subagent meta for ${agentId}:`, err);
        }
      }
    }

    // Fallback: scan main transcript tool_result blocks that mention the agentId.
    for (const agentId of filteredAgentIds) {
      if (parentToolUseIdByAgentId.has(agentId)) continue;
      for (const [msgIdx, msg] of mainSdkMessages.entries()) {
        if (msg.type !== 'user') continue;
        const raw = msg.message as { content?: unknown } | undefined;
        const content = raw?.content;
        const haystack = JSON.stringify(content ?? '');
        if (!haystack.includes(agentId)) continue;
        const arr = Array.isArray(content) ? content : [];
        for (const block of arr) {
          if (!block || typeof block !== 'object') continue;
          const typed = block as { type?: unknown; tool_use_id?: unknown };
          if (typed.type === 'tool_result') {
            const toolUseId = typeof typed.tool_use_id === 'string' ? typed.tool_use_id : '';
            if (toolUseId) {
              parentToolUseIdByAgentId.set(agentId, toolUseId);
              toolResultIndexByToolUseId.set(toolUseId, msgIdx);
              const toolUseResult = (msg as Record<string, unknown>).toolUseResult as
                | Record<string, unknown>
                | undefined;
              if (typeof toolUseResult?.description === 'string') {
                descriptionByToolUseId.set(toolUseId, toolUseResult.description);
              }
            }
          }
        }
        break;
      }
    }

    // Capture tool_result indexes for subagents that were mapped via meta or the
    // first scan, so completed subagents can get an approximate endTime.
    for (const [msgIdx, msg] of mainSdkMessages.entries()) {
      if (msg.type !== 'user') continue;
      const raw = msg.message as { content?: unknown } | undefined;
      const content = raw?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const typed = block as { type?: unknown; tool_use_id?: unknown };
        if (typed.type === 'tool_result' && typeof typed.tool_use_id === 'string') {
          toolResultIndexByToolUseId.set(typed.tool_use_id, msgIdx);
        }
      }
    }

    const subagents: SubagentState[] = [];
    for (const agentId of filteredAgentIds) {
      const parentToolUseId = parentToolUseIdByAgentId.get(agentId);
      if (!parentToolUseId) {
        console.warn(`Could not map subagent ${agentId} to a parent toolUseId`);
        continue;
      }

      try {
        const subMessages = await this.sdkClient.getSubagentMessages(sessionId, agentId, { dir });
        const description = descriptionByToolUseId.get(parentToolUseId) || `Agent ${agentId}`;
        const toolUseIdx = toolUseIndexByToolUseId.get(parentToolUseId);
        const toolResultIdx = toolResultIndexByToolUseId.get(parentToolUseId);
        const fallbackStartTime =
          toolUseIdx !== undefined
            ? now - (mainSdkMessages.length - toolUseIdx) * 1000
            : undefined;
        const fallbackEndTime =
          toolResultIdx !== undefined
            ? now - (mainSdkMessages.length - toolResultIdx) * 1000
            : undefined;
        const reconstructed = reconstructSubagentState(parentToolUseId, subMessages, description, {
          fallbackStartTime,
          fallbackEndTime,
        });
        if (reconstructed) {
          subagents.push(reconstructed);
        }
      } catch (err) {
        console.error(`Failed to load subagent ${agentId} for ${sessionId}:`, err);
      }
    }

    return subagents;
  }

  async loadMessages(
    sessionId: string,
    workspaceId: string,
  ): Promise<{ messages: ChatMessage[]; tasks: TaskItem[]; subagents: SubagentState[]; workflows: WorkflowState[]; total: number }> {
    const startedAt = Date.now();
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      throw new ChatError('Workspace not found', 'WORKSPACE_NOT_FOUND', 404);
    }

    const options: import('@anthropic-ai/claude-agent-sdk').GetSessionMessagesOptions = {
      dir: normalizeWindowsPath(workspace.folderPath),
    };
    const sdkLoadStartedAt = Date.now();
    const sdkMessages = await this.sdkClient.getSessionMessages(sessionId, options);
    const sdkLoadMs = Date.now() - sdkLoadStartedAt;

    // If we successfully loaded messages from SDK, the session is real — sync it
    if (sdkMessages.length > 0) {
      try {
        const sdkSession = await this.sdkClient.getSessionInfo(sessionId, { dir: workspace.folderPath });
        if (sdkSession) {
          const session = this.mapSdkSessionInfo(sdkSession, workspaceId);
          workspaceStore.syncSdkSession(session);
        }
      } catch {
        // Ignore sync errors
      }
    }

    const normalizeStartedAt = Date.now();
    const normalized: ChatMessage[] = [];
    const timestampBase = this.historyTimestampBases.get(sessionId) ??
      Date.now() - sdkMessages.length * 1000;
    this.historyTimestampBases.set(sessionId, timestampBase);
    sdkMessages.forEach((msg: SessionMessage, index: number) => {
      const chatMessage = normalizeSessionMessage(msg);
      if (chatMessage) {
        // Approximate ordering by index — SDK does not surface a per-message
        // timestamp on the historical read path. U7 verifies ordering matches
        // the JSONL transcript order.
        chatMessage.timestamp = timestampBase + index * 1000;
        normalized.push(chatMessage);
      }
    });
    const normalizeMs = Date.now() - normalizeStartedAt;
    const total = normalized.length;
    const derivedStateStartedAt = Date.now();
    const tasks = scanSdkMessagesForTasks(sdkMessages);
    const subagents = await this.loadSubagentsForSession(sessionId, workspaceId, sdkMessages);
    const workflows = await this.loadWorkflowsForSession(sessionId, workspaceId);
    diagLog('[chat-history] complete load', {
      sessionId,
      workspaceId,
      sdkMessageCount: sdkMessages.length,
      normalizedMessageCount: total,
      sdkLoadMs,
      normalizeMs,
      derivedStateMs: Date.now() - derivedStateStartedAt,
      totalMs: Date.now() - startedAt,
    });
    return { messages: normalized, tasks, subagents, workflows, total };
  }

  async loadMessagesAfter(
    sessionId: string,
    workspaceId: string,
    afterMessageId?: string,
  ): Promise<{ messages: ChatMessage[]; tasks: TaskItem[]; subagents: SubagentState[]; workflows: WorkflowState[] }> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      throw new ChatError('Workspace not found', 'WORKSPACE_NOT_FOUND', 404);
    }

    const options: import('@anthropic-ai/claude-agent-sdk').GetSessionMessagesOptions = {
      dir: normalizeWindowsPath(workspace.folderPath),
    };

    const sdkMessages = await this.sdkClient.getSessionMessages(sessionId, options);

    let sliceStart = 0;
    if (afterMessageId) {
      const idx = sdkMessages.findIndex((msg: SessionMessage) => msg.uuid === afterMessageId);
      if (idx >= 0) {
        sliceStart = idx + 1;
      }
    }

    const sliced = sdkMessages.slice(sliceStart);

    const normalized: ChatMessage[] = [];
    const timestampBase = this.historyTimestampBases.get(sessionId) ??
      Date.now() - sdkMessages.length * 1000;
    this.historyTimestampBases.set(sessionId, timestampBase);
    sliced.forEach((msg: SessionMessage, index: number) => {
      const chatMessage = normalizeSessionMessage(msg);
      if (chatMessage) {
        chatMessage.timestamp = timestampBase + (sliceStart + index) * 1000;
        normalized.push(chatMessage);
      }
    });
    const tasks = scanSdkMessagesForTasks(sliced);
    const subagents = await this.loadSubagentsForSession(sessionId, workspaceId, sdkMessages);
    const workflows = await this.loadWorkflowsForSession(sessionId, workspaceId);
    return { messages: normalized, tasks, subagents, workflows };
  }

  // Session runtime management

  async getOrCreateRuntime(
    sessionId: string,
    workspaceId: string,
    isBotSession?: boolean,
    botEventHandler?: (id: number, event: import('../types/message.js').SseEvent) => void,
    botUserId?: string,
  ): Promise<SessionRuntime> {
    const runtimeContext: RuntimeContext = { workspaceId, isBotSession, botUserId };
    const existing = this.runtimes.get(sessionId);
    if (existing && !existing.isClosed()) {
      this.cancelIdleClose(sessionId);
      if (botEventHandler) {
        existing.clearBotEventHandlers();
        existing.addBotEventHandler(botEventHandler);
      }
      this.runtimeContexts.set(sessionId, runtimeContext);
      sidecarLog(`[ChatService] reusing existing runtime ${sessionId}`);
      return existing;
    }
    if (existing) {
      // Clean up a dead runtime
      this.runtimes.delete(sessionId);
    }

    const pending = this.creatingRuntimes.get(sessionId);
    if (pending) {
      diagLog(`[ChatService] awaiting pending runtime creation ${sessionId}`);
      const runtime = await pending;
      if (botEventHandler) {
        runtime.clearBotEventHandlers();
        runtime.addBotEventHandler(botEventHandler);
      }
      this.runtimeContexts.set(sessionId, runtimeContext);
      return runtime;
    }

    const promise = (async () => {
      const startedAt = Date.now();
      diagLog(`[ChatService] creating runtime ${sessionId} workspaceId=${workspaceId} isBotSession=${!!isBotSession}`);

      const workspace = await workspaceStore.get(workspaceId);
      if (!workspace) {
        throw new ChatError('Workspace not found', 'WORKSPACE_NOT_FOUND', 404);
      }

      const session = await this.getSession(sessionId, workspaceId);
      if (!session) {
        throw new ChatError('Session not found', 'SESSION_NOT_FOUND', 404);
      }
      diagLog(`[ChatService] runtime ${sessionId} session loaded elapsed=${Date.now() - startedAt}ms isDraft=${!!session.isDraft}`);

      // Verify non-draft sessions actually exist in SDK before resuming.
      // If the SDK has lost track of the session, fall back to sessionId mode
      // so the conversation can be recreated rather than failing with
      // "No conversation found with session ID".
      if (!session.isDraft) {
        try {
          const verifyStart = Date.now();
          diagLog(`[ChatService] runtime ${sessionId} verifying session in SDK`);
          let verifyTimeout: ReturnType<typeof setTimeout> | undefined;
          const sdkSession = await Promise.race([
            this.sdkClient
              .getSessionInfo(sessionId, { dir: workspace.folderPath })
              .finally(() => {
                if (verifyTimeout) clearTimeout(verifyTimeout);
              }),
            new Promise<never>((_, reject) => {
              verifyTimeout = setTimeout(
                () => reject(new SessionVerifyTimeoutError()),
                SESSION_VERIFY_TIMEOUT_MS,
              );
            }),
          ]);
          diagLog(`[ChatService] runtime ${sessionId} getSessionInfo elapsed=${Date.now() - verifyStart}ms found=${!!sdkSession}`);
          if (!sdkSession) {
            sidecarLog(`[ChatService] Session ${sessionId} not found in SDK, falling back to draft mode`);
            workspaceStore.setSessionDraft(sessionId, true);
            session.isDraft = true;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sidecarLog(`[ChatService] Failed to verify session ${sessionId} in SDK: ${message}`);
          // Only treat a hang as fatal. Other SDK errors are transient; fall
          // through and let the runtime start attempt fail later with a clearer
          // error instead of blocking the subscribe request forever.
          if (err instanceof SessionVerifyTimeoutError) {
            throw new ChatError(
              `Failed to verify session with Claude Code: ${message}`,
              'SESSION_VERIFY_FAILED',
              500,
            );
          }
        }
      }

      const optionsStart = Date.now();
      const provider = session.providerId
        ? workspaceStore.getProvider(session.providerId)
        : workspaceStore.getDefaultProvider();

      if (!provider) {
        throw new ChatError(
          'No LLM provider configured. Add a provider in Settings.',
          'PROVIDER_NOT_FOUND',
          500,
        );
      }

      const options = this.buildSdkOptions(workspace, session, isBotSession, botUserId, provider);
      diagLog(`[ChatService] runtime ${sessionId} buildSdkOptions elapsed=${Date.now() - optionsStart}ms pathToClaudeCodeExecutable=${options.pathToClaudeCodeExecutable || 'undefined'}`);

      const testStart = Date.now();
      await this.testClaudeBinary(options.pathToClaudeCodeExecutable, normalizeWindowsPath(workspace.folderPath), options.env || process.env);
      diagLog(`[ChatService] runtime ${sessionId} testClaudeBinary elapsed=${Date.now() - testStart}ms`);

      diagLog(`[ChatService] runtime ${sessionId} calling SessionRuntime.open`);
      const openStart = Date.now();
      const runtime = SessionRuntime.open(
        sessionId,
        workspaceId,
        this.serverNonce,
        options,
        this.sdkClient,
        botEventHandler,
        () => this.cancelIdleClose(sessionId),
        () => {},
        () => this.scheduleIdleClose(sessionId),
        provider,
      );
      diagLog(`[ChatService] runtime ${sessionId} SessionRuntime.open elapsed=${Date.now() - openStart}ms`);
      this.runtimes.set(sessionId, runtime);
      this.runtimeContexts.set(sessionId, runtimeContext);
      this.scheduleIdleClose(sessionId);

      // Set initial approval mode from session data
      if (!isBotSession && session.approvalMode) {
        runtime.setApprovalMode(session.approvalMode);
      }

      return runtime;
    })();

    this.creatingRuntimes.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      this.creatingRuntimes.delete(sessionId);
    }
  }

  async closeRuntime(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    this.clearPendingRebuild(sessionId);
    this.runtimeContexts.delete(sessionId);
    this.cancelIdleClose(sessionId);
    this.runtimes.delete(sessionId);
    sidecarLog(`[ChatService] closing runtime ${sessionId}`);
    // Pre-close chained listeners (KTD-5): run BEFORE close() resolves the
    // session's pending cards, so listeners can classify their own pendings
    // (the browser handoff controller marks its cards runtime_closed here).
    for (const listener of this.runtimeClosingListeners) {
      try {
        listener(sessionId);
      } catch (err) {
        diagLog(`[ChatService] runtime-closing listener threw for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await runtime.close();
    this.onRuntimeClose?.(sessionId);
  }

  getRuntimeIfExists(sessionId: string): SessionRuntime | undefined {
    const runtime = this.runtimes.get(sessionId);
    if (runtime && !runtime.isClosed()) return runtime;
    return undefined;
  }

  scheduleRuntimeRebuild(sessionId: string, context?: RuntimeContext): void {
    const runtime = this.getRuntimeIfExists(sessionId);
    if (!runtime) return;
    const ctx = context ?? this.runtimeContexts.get(sessionId);
    if (!ctx) return;

    this.pendingRebuilds.set(sessionId, ctx);
    if (runtime.isProcessingTurn()) {
      this.startRebuildPoller(sessionId);
      return;
    }
    this.performRebuild(sessionId, ctx);
  }

  scheduleRebuildsForBot(botId: string): void {
    let count = 0;
    for (const [sessionId, context] of this.runtimeContexts.entries()) {
      try {
        const session = workspaceStore.getLocalSession(sessionId);
        if (session && session.botId === botId) {
          this.scheduleRuntimeRebuild(sessionId, context);
          count++;
        }
      } catch {
        // ignore stale sessions
      }
    }
    if (count > 0) {
      sidecarLog(`[ChatService] scheduled ${count} runtime rebuilds for bot ${botId}`);
    }
  }

  scheduleRebuildsForProvider(providerId: string): void {
    let count = 0;
    for (const [sessionId, context] of this.runtimeContexts.entries()) {
      try {
        const session = workspaceStore.getLocalSession(sessionId);
        if (session && session.providerId === providerId) {
          this.scheduleRuntimeRebuild(sessionId, context);
          count++;
        }
      } catch {
        // ignore stale sessions
      }
    }
    if (count > 0) {
      sidecarLog(`[ChatService] scheduled ${count} runtime rebuilds for provider ${providerId}`);
    }
  }

  scheduleRebuildsForWorkspaceLegacyPolicy(workspaceId: string): void {
    let count = 0;
    for (const [sessionId, context] of this.runtimeContexts.entries()) {
      if (context.workspaceId !== workspaceId || !context.isBotSession) continue;
      try {
        const session = workspaceStore.getLocalSession(sessionId);
        if (session && !session.botId) {
          this.scheduleRuntimeRebuild(sessionId, context);
          count++;
        }
      } catch {
        // ignore stale sessions
      }
    }
    if (count > 0) {
      sidecarLog(`[ChatService] scheduled ${count} legacy-policy runtime rebuilds for workspace ${workspaceId}`);
    }
  }

  private startRebuildPoller(sessionId: string): void {
    if (this.rebuildPollers.has(sessionId)) return;
    const interval = setInterval(() => {
      const runtime = this.getRuntimeIfExists(sessionId);
      if (!runtime || runtime.isClosed() || !runtime.isProcessingTurn()) {
        const ctx = this.pendingRebuilds.get(sessionId);
        if (ctx && runtime && !runtime.isClosed()) {
          this.performRebuild(sessionId, ctx);
        } else {
          this.clearPendingRebuild(sessionId);
        }
      }
    }, REBUILD_POLL_INTERVAL_MS);
    this.rebuildPollers.set(sessionId, interval);
  }

  private async performRebuild(sessionId: string, context: RuntimeContext): Promise<void> {
    this.clearPendingRebuild(sessionId);
    try {
      sidecarLog(`[ChatService] rebuilding runtime ${sessionId}`);
      await this.closeRuntime(sessionId);
    } catch (err) {
      sidecarLog(
        `[ChatService] failed to close runtime ${sessionId} during rebuild: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      await this.getOrCreateRuntime(sessionId, context.workspaceId, context.isBotSession, undefined, context.botUserId);
    } catch (err) {
      sidecarLog(
        `[ChatService] failed to pre-create runtime ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private clearPendingRebuild(sessionId: string): void {
    this.pendingRebuilds.delete(sessionId);
    const poller = this.rebuildPollers.get(sessionId);
    if (poller) {
      clearInterval(poller);
      this.rebuildPollers.delete(sessionId);
    }
  }

  private scheduleIdleClose(sessionId: string): void {
    this.cancelIdleClose(sessionId);
    const timeout = setTimeout(() => {
      // Hold the runtime open while the session is processing: an in-flight
      // turn, a pending approval, or running background tasks. Without this
      // guard a silent in-flight turn is reclaimed before it completes, which
      // would break the WeCom long-reply safeguard for long-pending-approval
      // turns.
      const runtime = this.getRuntimeIfExists(sessionId);
      if (runtime?.isProcessingTurn()) {
        sidecarLog(`[ChatService] idle close deferred for ${sessionId}: session still processing`);
        this.scheduleIdleClose(sessionId);
        return;
      }
      sidecarLog(`[ChatService] idle close fired for ${sessionId}`);
      this.closeRuntime(sessionId).catch((err) => {
        console.error(`Failed to idle-close runtime ${sessionId}:`, err);
      });
    }, RUNTIME_IDLE_GRACE_PERIOD_MS);
    this.idleTimeouts.set(sessionId, timeout);
    sidecarLog(`[ChatService] idle close scheduled for ${sessionId} (${RUNTIME_IDLE_GRACE_PERIOD_MS}ms)`);
  }

  private cancelIdleClose(sessionId: string): void {
    const timeout = this.idleTimeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.idleTimeouts.delete(sessionId);
      sidecarLog(`[ChatService] idle close cancelled for ${sessionId}`);
    }
  }

  async closeAllRuntimes(): Promise<void> {
    const entries = Array.from(this.runtimes.entries());
    if (entries.length === 0) return;
    sidecarLog(`[ChatService] closing ${entries.length} runtimes on shutdown`);
    for (const [sessionId] of entries) {
      this.cancelIdleClose(sessionId);
    }
    await Promise.all(
      entries.map(async ([sessionId, runtime]) => {
        try {
          await runtime.close();
        } catch (err) {
          console.error(`Failed to close runtime ${sessionId} during shutdown:`, err);
        }
      }),
    );
    this.runtimes.clear();
    this.idleTimeouts.clear();
  }

  /**
   * Close all cached runtimes belonging to a workspace. Called when the workspace
   * is deleted so that idle bot runtimes do not keep answering inbound messages
   * against a workspace whose settings row is gone.
   */
  async closeRuntimesForWorkspace(workspaceId: string): Promise<void> {
    const targets: string[] = [];
    for (const [sessionId, runtime] of this.runtimes.entries()) {
      try {
        if (runtime.getStatus().workspaceId === workspaceId) {
          targets.push(sessionId);
        }
      } catch {
        // ignore — getStatus can throw on closed runtimes; not relevant here
      }
    }
    if (targets.length === 0) return;
    sidecarLog(`[ChatService] closing ${targets.length} runtimes for deleted workspace ${workspaceId}`);
    await Promise.all(
      targets.map((sessionId) =>
        this.closeRuntime(sessionId).catch((err) => {
          console.error(`Failed to close runtime ${sessionId} during workspace deletion:`, err);
        }),
      ),
    );
  }

  /**
   * Close all cached runtimes that belong to a specific Bot. Called when the
   * bot's persona, member roles, or role policy change so the next user turn
   * recreates the runtime with the updated configuration.
   */
  async closeRuntimesForBot(botId: string): Promise<void> {
    const targets: string[] = [];
    for (const sessionId of this.runtimes.keys()) {
      try {
        const session = workspaceStore.getLocalSession(sessionId);
        if (session && session.botId === botId) {
          targets.push(sessionId);
        }
      } catch {
        // ignore — getLocalSession can fail for stale sessions
      }
    }
    if (targets.length === 0) return;
    sidecarLog(`[ChatService] closing ${targets.length} runtimes for bot ${botId}`);
    await Promise.all(
      targets.map((sessionId) =>
        this.closeRuntime(sessionId).catch((err) => {
          console.error(`Failed to close runtime ${sessionId} during bot invalidation:`, err);
        }),
      ),
    );
  }

  async pushMessage(
    sessionId: string,
    workspaceId: string,
    message: string,
    isBotSession?: boolean,
    botEventHandler?: (id: number, event: SseEvent) => void,
    botUserId?: string,
  ): Promise<void> {
    const runtime = await this.getOrCreateRuntime(sessionId, workspaceId, isBotSession, botEventHandler, botUserId);

    // Promote a draft session to a real SDK session on first message. The SDK
    // creates the persistent session when this message is pushed, so clear the
    // draft flag now so future renames go through sdkClient.renameSession instead
    // of only updating the local SQLite row.
    const localSession = workspaceStore.getLocalSession(sessionId);
    if (localSession?.isDraft) {
      workspaceStore.clearDraftFlag(sessionId);
    }

    runtime.pushMessage(message);
  }

  getSessionsStatus(workspaceId: string): Record<string, { pendingCount: number; isProcessing: boolean }> {
    const statuses: Record<string, { pendingCount: number; isProcessing: boolean }> = {};
    for (const [sessionId, runtime] of this.runtimes) {
      const status = runtime.getStatus();
      if (status.workspaceId === workspaceId) {
        statuses[sessionId] = {
          pendingCount: status.pendingCount,
          isProcessing: status.isProcessing,
        };
      }
    }
    return statuses;
  }

  // Legacy message streaming (preserved during migration; removed after U5)

  async sendMessage(sessionId: string, message: string): Promise<MessageStream> {
    const workspace = await this.findWorkspaceForSession(sessionId);
    if (!workspace) {
      throw new ChatError('Workspace not found for session', 'WORKSPACE_NOT_FOUND', 404);
    }

    const session = await this.getSession(sessionId, workspace.id);
    if (!session) {
      throw new ChatError('Session not found', 'SESSION_NOT_FOUND', 404);
    }

    const options = this.buildSdkOptions(workspace, session);
    await this.testClaudeBinary(options.pathToClaudeCodeExecutable, workspace.folderPath, options.env || process.env);
    const { query, messages: rawMessages } = this.sdkClient.createQuery(message, options);

    const messages = this.wrapStream(rawMessages);

    return { messages, rawQuery: query, wasDraft: !!session.isDraft };
  }

  private async findWorkspaceForSession(sessionId: string): Promise<Workspace | null> {
    // Check local DB first
    const localSession = workspaceStore.getLocalSession(sessionId);
    if (localSession) {
      return workspaceStore.get(localSession.workspaceId);
    }

    // Search all workspaces for SDK session
    const workspaces = await workspaceStore.list();
    for (const ws of workspaces) {
      try {
        const info = await this.sdkClient.getSessionInfo(sessionId, { dir: normalizeWindowsPath(ws.folderPath) });
        if (info) return ws;
      } catch {
        // Continue searching
      }
    }

    return null;
  }

  private isCommandOnPath(command: string): boolean {
    if (path.isAbsolute(command)) {
      return existsSync(command);
    }
    const pathEnv = process.env.PATH || '';
    const pathDirs = pathEnv.split(process.platform === 'win32' ? ';' : ':');
    const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const dir of pathDirs) {
      for (const ext of extensions) {
        const fullPath = path.join(dir, command + ext);
        if (existsSync(fullPath)) {
          return true;
        }
      }
    }
    return false;
  }

  private loadPluginMcpServers(
    workspacePath: string,
  ): Record<string, import('@anthropic-ai/claude-agent-sdk').McpServerConfig> {
    const result: Record<string, import('@anthropic-ai/claude-agent-sdk').McpServerConfig> = {};

    try {
      // Get enabled plugins from all three scopes
      // Order matters: local takes precedence over project over user
      const userPlugins = pluginSettingsService.getInstalledPlugins('user');
      const projectPlugins = pluginSettingsService.getInstalledPlugins('project', workspacePath);
      const localPlugins = pluginSettingsService.getInstalledPlugins('local', workspacePath);
      const enabledPlugins = [
        ...localPlugins.filter((p) => p.enabled),
        ...projectPlugins.filter((p) => p.enabled),
        ...userPlugins.filter((p) => p.enabled),
      ];
      const seenPlugins = new Set<string>();

      for (const plugin of enabledPlugins) {
        if (seenPlugins.has(plugin.id)) continue;
        seenPlugins.add(plugin.id);

        const cachePath = pluginSettingsService.resolvePluginCachePath(plugin.id);
        const mcpPath = path.join(cachePath, '.mcp.json');
        const altMcpPath = path.join(cachePath, '.claude-plugin', '.mcp.json');

        for (const mcpFile of [mcpPath, altMcpPath]) {
          if (!existsSync(mcpFile)) continue;

          try {
            const content = readFileSync(mcpFile, 'utf-8');
            const parsed = JSON.parse(content) as Record<string, unknown>;
            const servers = parsed.mcpServers as Record<
              string,
              { type?: string; command: string; args?: string[]; env?: Record<string, string> }
            >;

            if (!servers || typeof servers !== 'object') continue;

            for (const [name, config] of Object.entries(servers)) {
              if (!config || typeof config !== 'object') continue;
              if (!config.command) continue;

              // Resolve ${CLAUDE_PLUGIN_ROOT} placeholder
              const resolvedCommand = config.command.replace(
                /\$\{CLAUDE_PLUGIN_ROOT\}/g,
                cachePath,
              );
              const resolvedArgs = (config.args || []).map((arg) =>
                arg.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, cachePath),
              );
              const resolvedEnv: Record<string, string> = {};
              if (config.env) {
                for (const [key, value] of Object.entries(config.env)) {
                  resolvedEnv[key] = value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, cachePath);
                }
              }

              // Validate that the command binary exists (absolute path or on PATH)
              const binaryExists = this.isCommandOnPath(resolvedCommand);
              if (!binaryExists) {
                sidecarLog(`[ChatService] MCP server binary not found for plugin ${plugin.id}: ${resolvedCommand}`);
                continue;
              }

              result[name] = {
                type: (config.type as 'stdio') || 'stdio',
                command: resolvedCommand,
                args: resolvedArgs,
                ...(Object.keys(resolvedEnv).length > 0 ? { env: resolvedEnv } : {}),
              };
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            sidecarLog(`[ChatService] Failed to parse .mcp.json for plugin ${plugin.id}: ${message}`);
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sidecarLog(`[ChatService] Plugin MCP discovery failed: ${message}`);
    }

    return result;
  }

  private getWecomBotUserForSession(sessionId: string): import('../models/bot-user.js').BotUser | null {
    for (const userId of workspaceStore.getSessionUsers(sessionId)) {
      const botUser = workspaceStore.getBotUser(userId);
      if (!botUser) continue;
      const channel = workspaceStore.getBotChannel(botUser.channelId);
      if (channel?.channelKey === 'wecom') {
        return botUser;
      }
    }
    return null;
  }

  private buildSdkOptions(
    workspace: Workspace,
    session: ChatSession,
    isBotSession?: boolean,
    botUserId?: string,
    provider?: Provider,
  ): import('@anthropic-ai/claude-agent-sdk').Options {
    const claudeSettings = loadClaudeSettings();
    let { env } = buildClaudeEnv(claudeSettings);

    // Resolve active provider: session -> default, when not already provided.
    const resolvedProvider = provider ?? (session.providerId
      ? workspaceStore.getProvider(session.providerId)
      : workspaceStore.getDefaultProvider());

    if (!resolvedProvider) {
      throw new ChatError(
        'No LLM provider configured. Add a provider in Settings.',
        'PROVIDER_NOT_FOUND',
        500,
      );
    }

    // Build flag-settings env so provider credentials survive upstream
    // settings reloads (applyConfigEnvironmentVariables overwrites process.env).
    const settingsEnv: Record<string, string> = {};
    settingsEnv.ANTHROPIC_BASE_URL = resolvedProvider.baseUrl;
    settingsEnv.ANTHROPIC_API_KEY = resolvedProvider.authToken;
    settingsEnv.ANTHROPIC_AUTH_TOKEN = resolvedProvider.authToken;
    if (resolvedProvider.model) {
      settingsEnv.ANTHROPIC_MODEL = resolvedProvider.model;
    }
    if (resolvedProvider.defaultOpusModel) {
      settingsEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = resolvedProvider.defaultOpusModel;
    }
    if (resolvedProvider.defaultSonnetModel) {
      settingsEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = resolvedProvider.defaultSonnetModel;
    }
    if (resolvedProvider.defaultHaikuModel) {
      settingsEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = resolvedProvider.defaultHaikuModel;
    }
    if (resolvedProvider.subagentModel) {
      settingsEnv.CLAUDE_CODE_SUBAGENT_MODEL = resolvedProvider.subagentModel;
    }
    if (resolvedProvider.effortLevel) {
      settingsEnv.CLAUDE_CODE_EFFORT_LEVEL = resolvedProvider.effortLevel;
    }
    if (resolvedProvider.customEnvVars) {
      for (const [key, value] of Object.entries(resolvedProvider.customEnvVars)) {
        settingsEnv[key] = value;
      }
    }

    // Diagnostic: log Windows home-dir env vars
    sidecarLog(`[ChatService.buildSdkOptions] USERPROFILE=${process.env.USERPROFILE}`);
    sidecarLog(`[ChatService.buildSdkOptions] HOME=${process.env.HOME}`);
    sidecarLog(`[ChatService.buildSdkOptions] HOMEDRIVE=${process.env.HOMEDRIVE}`);
    sidecarLog(`[ChatService.buildSdkOptions] HOMEPATH=${process.env.HOMEPATH}`);
    sidecarLog(`[ChatService.buildSdkOptions] homedir=${homedir()}`);
    sidecarLog(`[ChatService.buildSdkOptions] CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR}`);
    sidecarLog(`[ChatService.buildSdkOptions] CLAUDE_SECURESTORAGE_CONFIG_DIR=${env.CLAUDE_SECURESTORAGE_CONFIG_DIR}`);

    // Log provider env vars passed via flag settings for diagnostics
    for (const key of Object.keys(settingsEnv)) {
      sidecarLog(`[ChatService.buildSdkOptions] settings.env.${key}=<set>`);
    }

    const wecomCliPath = resolveWecomCliPath();
    if (wecomCliPath) {
      const cliDir = path.dirname(wecomCliPath);
      prependEnvPath(env, cliDir);
      env.WECOM_CLI_PATH = wecomCliPath;
      sidecarLog(`[ChatService.buildSdkOptions] injected wecom CLI dir into PATH: ${cliDir}`);
      sidecarLog(`[ChatService.buildSdkOptions] set WECOM_CLI_PATH=${wecomCliPath}`);
    }

    const pathKey = getPathEnvKey(env);
    sidecarLog(`[ChatService.buildSdkOptions] enriched PATH=${env[pathKey]}`);

    const mcpServers: Record<string, import('@anthropic-ai/claude-agent-sdk').McpServerConfig> = {};
    for (const mcp of workspace.mcpServers) {
      mcpServers[mcp.name] = {
        type: 'stdio',
        command: mcp.command,
        args: mcp.args,
      };
    }

    // Merge plugin MCP servers (workspace-defined servers override plugin-defined)
    try {
      const pluginMcpServers = this.loadPluginMcpServers(workspace.folderPath);
      for (const [name, config] of Object.entries(pluginMcpServers)) {
        if (!mcpServers[name]) {
          mcpServers[name] = config;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sidecarLog(`[ChatService.buildSdkOptions] Plugin MCP merge failed: ${message}`);
    }

    // Embedded browser MCP server (U3, KTD-3): GUI sessions only — bot
    // sessions never get the browser tool surface (KTD-4 ③: the injection
    // condition itself is the first line of bot defense). The instance is
    // keyed by sessionId; the browser process outlives it via browserService.
    if (!isBotSession) {
      mcpServers[BROWSER_MCP_SERVER_KEY] = createBrowserMcpServer({
        sessionId: session.id,
        workspaceId: workspace.id,
        approvalRequester: this.browserApprovalRequester,
      });
      // Submit/handoff handler approval round-trips can wait on a human far
      // past the 60s SDK default — per-session env, never process-global.
      env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = BROWSER_STREAM_CLOSE_TIMEOUT_MS;
    }

    const claudePath = resolveSdkBinary();
    const normalizedCwd = normalizeWindowsPath(workspace.folderPath);
    sidecarLog(`[ChatService.buildSdkOptions] pathToClaudeCodeExecutable=${claudePath}`);
    sidecarLog(`[ChatService.buildSdkOptions] cwd=${normalizedCwd} (raw=${workspace.folderPath})`);
    sidecarLog(`[ChatService.buildSdkOptions] provider=${resolvedProvider.name} model=${resolvedProvider.model || 'default'}`);
    sidecarLog(`[ChatService.buildSdkOptions] sessionId=${session.id} isDraft=${!!session.isDraft}`);
    sidecarLog(`[ChatService.buildSdkOptions] platform=${process.platform} arch=${process.arch}`);

    const providerSupportsFastMode = resolvedProvider.supportsFastMode !== false;
    const fastMode = session.fastMode === true && providerSupportsFastMode;
    sidecarLog(`[ChatService.buildSdkOptions] fastMode=${fastMode}`);

    const options: import('@anthropic-ai/claude-agent-sdk').Options = {
      cwd: normalizedCwd,
      env,
      settings: { env: settingsEnv, fastMode },
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
      model: resolvedProvider.model || undefined,
      includePartialMessages: false,
      pathToClaudeCodeExecutable: claudePath,
      stderr: (data) => {
        const trimmed = data.trim();
        if (trimmed) sidecarLog(`[ChatService.claude.stderr] ${trimmed}`);
      },
    };

    if (isBotSession) {
      // Sanitize the child process environment for bot sessions: remove WeCom
      // and non-Anthropic cloud credentials. Anthropic provider keys are kept
      // because the SDK child needs them to call the API.
      env = sanitizeBotEnv(env);

      // buildSdkOptions() already constructed an options object with the
      // original env reference, but sanitizeBotEnv() returns a new object above.
      // Ensure the returned options point to the sanitized env.
      options.env = env;

      // Resolve the canonical channel identity for this session.
      const channel = session.source === 'wecom' || session.source === 'feishu' ? session.source : undefined;
      let channelUserId: string | undefined;
      if (channel === 'wecom') {
        const wecomBotUser = this.getWecomBotUserForSession(session.id);
        channelUserId = wecomBotUser?.plaintextUserId ?? wecomBotUser?.channelUserId;
      } else if (channel === 'feishu') {
        channelUserId = botUserId;
      }

      let pathContext: import('./bot-path-policy.js').PathPolicyContext | undefined;

      if (session.botId) {
        // Dynamic bot-level policy: role is resolved at call time so membership
        // and role changes take effect on the next tool use without restarting
        // the runtime. See plan KTD3.
        const bot = botService.getBot(session.botId);
        if (bot) {
          // Inject the Bot persona into the SDK system prompt for WeCom/Feishu
          // sessions. GUI sessions never reach this branch because isBotSession
          // is false. Changes apply to the next newly created runtime.
          const roleForPersona: import('../models/bot.js').BotRoleKey | undefined = channel && channelUserId
            ? botService.getMemberRole(bot.id, channel, channelUserId) ?? 'normal'
            : undefined;
          const persona = roleForPersona
            ? botService.getRolePersona(bot.id, roleForPersona) ?? bot.persona
            : bot.persona;
          if (persona) {
            if (persona.mode === 'append') {
              options.systemPrompt = {
                type: 'preset',
                preset: 'claude_code',
                append: persona.prompt,
              };
            } else {
              options.systemPrompt = persona.prompt;
            }
          }

          const isAdminOrOwnerForContext = channel && channelUserId
            ? isOwnerOrAdmin(botService.getMemberRole(bot.id, channel, channelUserId))
            : false;

          const knownUserDirNames: string[] = [];
          if (channel === 'wecom') {
            for (const u of botService.listChannelUsersForWorkspace(workspace.id, 'wecom')) {
              knownUserDirNames.push(u.plaintextUserId ?? u.channelUserId);
            }
          } else if (channel === 'feishu') {
            for (const u of botService.listChannelUsersForWorkspace(workspace.id, 'feishu')) {
              knownUserDirNames.push(u.plaintextUserId ?? u.channelUserId);
            }
          }

          const userDirName = channelUserId ?? 'anonymous';
          pathContext = createPathPolicyContext(
            workspace,
            userDirName,
            knownUserDirNames,
            isAdminOrOwnerForContext,
            workspace.settings.sensitiveFileDenylist ?? [],
          );

          options.canUseTool = async (
            toolName: string,
            input: Record<string, unknown>,
            sdkOptions: {
              signal: AbortSignal;
              suggestions?: import('@anthropic-ai/claude-agent-sdk').PermissionUpdate[];
              title?: string;
              description?: string;
              toolUseID: string;
              decisionReasonType?: string;
            },
          ) => {
            // Browser tools never run in bot sessions — this deny must precede
            // the 'unknown' fall-through below (see denyBrowserToolInBotSession).
            const browserDeny = denyBrowserToolInBotSession(session.id, toolName, sdkOptions?.toolUseID);
            if (browserDeny) return browserDeny;

            // Resolve role dynamically on every tool use so membership/role changes
            // take effect without restarting the runtime.
            const role = channel && channelUserId
              ? botService.getMemberRole(bot.id, channel, channelUserId)
              : null;
            const rolePolicy = botService.getRolePolicy(bot.id);
            const decision = evaluateBotToolPermission(rolePolicy?.normalToolPolicy ?? SAFE_PRESET, role, toolName);
            // 'unknown' = tool not in any category (MCP, Skill, future SDK built-in
            // without a category fit). Fall through to today's allow-all behavior
            // per R10. The brainstorm explicitly defers MCP and Skills gating.
            // Identity failure = fail closed on file/Bash/Skill tools.
            if (!channelUserId && IDENTITY_SENSITIVE_TOOLS.has(toolName)) {
              diagLog(
                `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=missing-identity`,
              );
              return {
                behavior: 'deny' as const,
                message: "I can't do that in this workspace.",
              };
            }

            // Bash whitelist overrides the Shell category for Normal users; Owner/Admin
            // bypass the whitelist entirely.
            if (toolName === 'Bash' && typeof input.command === 'string' && channelUserId) {
              if (isBashCommandAllowed(rolePolicy?.bashWhitelist ?? [], role, input.command)) {
                return { behavior: 'allow' as const, updatedInput: input };
              }
              diagLog(
                `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=bash-whitelist`,
              );
              return {
                behavior: 'deny' as const,
                message: "I can't do that in this workspace.",
              };
            }

            if (decision === 'deny') {
              // Generic denial message — do NOT name the capability. Inbound bot
              // messages are an untrusted channel; naming the denied capability
              // would let an attacker probe the policy by mapping denials.
              const reason = getToolPermissionDenialReason(rolePolicy?.normalToolPolicy, toolName);
              diagLog(
                `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=${reason ?? 'deny'}`,
              );
              return {
                behavior: 'deny' as const,
                message: "I can't do that in this workspace.",
              };
            }

            if (FILE_TOOLS.has(toolName) && pathContext) {
              // Path context is built when the runtime starts, but role changes must
              // be respected immediately (R14). Recompute the owner/admin flag from
              // the freshly resolved role instead of the stale snapshot.
              const effectivePathContext = {
                ...pathContext,
                isAdminOrOwner: isOwnerOrAdmin(role),
              };
              const r = validateToolInput(effectivePathContext, toolName, input);
              if (!r.allowed) {
                diagLog(
                  `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=${r.reason ?? 'path-denied'}`,
                );
                if (session.botId && channel && channelUserId) {
                  botAuditLogger.logFileAccessDenied(
                    session.botId,
                    { type: channel, channelKey: channel, channelUserId },
                    {
                      sessionId: session.id,
                      toolName,
                      reason: r.reason ?? 'path-denied',
                      path: typeof input.file_path === 'string'
                        ? input.file_path
                        : typeof input.notebook_path === 'string'
                          ? input.notebook_path
                          : typeof input.pattern === 'string'
                            ? input.pattern
                            : typeof input.path === 'string'
                              ? input.path
                              : undefined,
                    },
                  );
                }
                return {
                  behavior: 'deny' as const,
                  message: "I can't do that in this workspace.",
                };
              }
            }

            if (toolName === 'Skill') {
              const r = evaluateBotSkill(rolePolicy ?? { normalToolPolicy: SAFE_PRESET, skillAllowlist: [], bashWhitelist: [] }, role, toolName, input);
              if (!r.allowed) {
                diagLog(
                  `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=${r.reason ?? 'skill-denied'}`,
                );
                return {
                  behavior: 'deny' as const,
                  message: "I can't do that in this workspace.",
                };
              }
            }

            // AskUserQuestion always requires user input, regardless of policy
            if (toolName === 'AskUserQuestion') {
              const runtime = this.runtimes.get(session.id);
              if (!runtime) {
                diagLog(
                  `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=missing-runtime`,
                );
                return {
                  behavior: 'deny' as const,
                  message: "I can't do that in this workspace.",
                };
              }
              const questions = (input.questions as unknown[] ?? []).map((q: unknown) => {
                const qx = q as Record<string, unknown>;
                return {
                  question: typeof qx.question === 'string' ? qx.question : '',
                  header: typeof qx.header === 'string' ? qx.header : undefined,
                  options: Array.isArray(qx.options)
                    ? qx.options.map((o: unknown) => {
                        const ox = o as Record<string, unknown>;
                        return {
                          label: typeof ox.label === 'string' ? ox.label : '',
                          description: typeof ox.description === 'string' ? ox.description : undefined,
                          preview: typeof ox.preview === 'string' ? ox.preview : undefined,
                        };
                      })
                    : [],
                  multiSelect: qx.multiSelect === true,
                };
              });
              const timeout = typeof input.timeout === 'number' && Number.isFinite(input.timeout) && input.timeout > 0 ? input.timeout : undefined;
              return runtime.requestToolQuestion(sdkOptions.toolUseID, questions, input, {
                timeout,
                signal: sdkOptions.signal,
              });
            }

            if (decision === 'ask') {
              const runtime = this.runtimes.get(session.id);
              if (!runtime) {
                diagLog(
                  `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=missing-runtime`,
                );
                return {
                  behavior: 'deny' as const,
                  message: "I can't do that in this workspace.",
                };
              }
              const timeout = typeof input.timeout === 'number' && Number.isFinite(input.timeout) && input.timeout > 0 ? input.timeout : undefined;
              return runtime.requestToolApproval(sdkOptions.toolUseID, toolName, sdkOptions.toolUseID, input, {
                title: sdkOptions.title,
                description: sdkOptions.description,
                suggestions: sdkOptions.suggestions,
                timeout,
                signal: sdkOptions.signal,
                decisionReasonType: sdkOptions.decisionReasonType,
              });
            }

            return { behavior: 'allow' as const, updatedInput: input };
          };
        }
      }

      // Legacy workspace-scoped fallback for bot sessions created before migration
      // or without an explicit bot binding.
      if (!options.canUseTool) {
        const resolved = resolveEffectivePolicy(workspace);
        const policy = resolved.policy;
        const wecomBotUser = this.getWecomBotUserForSession(session.id);
        const canonicalUserId = botUserId
          ?? (wecomBotUser?.plaintextUserId ?? wecomBotUser?.channelUserId);

        let skillContext: import('./bot-skill-policy.js').SkillPolicyContext | undefined;

        if (canonicalUserId) {
          const userDirName = canonicalUserId;
          const wsUsers = botService.listChannelUsersForWorkspace(workspace.id, 'wecom');
          const knownUserDirNames = wsUsers.map((u) => u.plaintextUserId ?? u.channelUserId);

          pathContext = createPathPolicyContext(
            workspace,
            userDirName,
            knownUserDirNames,
            false,
            workspace.settings.sensitiveFileDenylist ?? [],
          );
          const isolation = workspace.settings.wecomBotIsolation;
          const isAdmin = isolation?.adminUserIds?.includes(canonicalUserId) ?? false;
          pathContext = {
            ...pathContext,
            isAdminOrOwner: isAdmin,
          };
          const skillPolicy: BotRolePolicy = {
            normalToolPolicy: SAFE_PRESET,
            skillAllowlist: isolation?.defaultAllowedSkills ?? [],
            bashWhitelist: [],
          };
          skillContext = { policy: skillPolicy, isAdminOrOwner: isAdmin };
        }

        options.canUseTool = async (
          toolName: string,
          input: Record<string, unknown>,
          sdkOptions: {
            signal: AbortSignal;
            suggestions?: import('@anthropic-ai/claude-agent-sdk').PermissionUpdate[];
            title?: string;
            description?: string;
            toolUseID: string;
            decisionReasonType?: string;
          },
        ) => {
          // Browser tools never run in bot sessions — this deny must precede
          // the policy evaluation and the 'unknown' fall-through below.
          const browserDeny = denyBrowserToolInBotSession(session.id, toolName, sdkOptions?.toolUseID);
          if (browserDeny) return browserDeny;

          const decision = evaluateToolPermission(policy, toolName, pathContext?.isAdminOrOwner ?? false);
          if (decision === 'deny') {
            const reason = getToolPermissionDenialReason(policy, toolName);
            diagLog(
              `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=${reason ?? 'deny'}`,
            );
            return {
              behavior: 'deny' as const,
              message: "I can't do that in this workspace.",
            };
          }

          if (!canonicalUserId && IDENTITY_SENSITIVE_TOOLS.has(toolName)) {
            diagLog(
              `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=missing-identity`,
            );
            return {
              behavior: 'deny' as const,
              message: "I can't do that in this workspace.",
            };
          }

          if (FILE_TOOLS.has(toolName) && pathContext) {
            const r = validateToolInput(pathContext, toolName, input);
            if (!r.allowed) {
              diagLog(
                `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=${r.reason ?? 'path-denied'}`,
              );
              if (session.botId && canonicalUserId && (session.source === 'wecom' || session.source === 'feishu')) {
                botAuditLogger.logFileAccessDenied(
                  session.botId,
                  { type: session.source, channelKey: session.source, channelUserId: canonicalUserId },
                  {
                    sessionId: session.id,
                    toolName,
                    reason: r.reason ?? 'path-denied',
                    path: typeof input.file_path === 'string'
                      ? input.file_path
                      : typeof input.notebook_path === 'string'
                        ? input.notebook_path
                        : typeof input.pattern === 'string'
                          ? input.pattern
                          : typeof input.path === 'string'
                            ? input.path
                            : undefined,
                  },
                );
              }
              return {
                behavior: 'deny' as const,
                message: "I can't do that in this workspace.",
              };
            }
          }

          if (toolName === 'Skill' && skillContext) {
            const r = evaluateSkill(skillContext, toolName, input);
            if (!r.allowed) {
              diagLog(
                `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=${r.reason ?? 'skill-denied'}`,
              );
              return {
                behavior: 'deny' as const,
                message: "I can't do that in this workspace.",
              };
            }
          }

          if (toolName === 'AskUserQuestion') {
            const runtime = this.runtimes.get(session.id);
            if (!runtime) {
              diagLog(
                `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=missing-runtime`,
              );
              return {
                behavior: 'deny' as const,
                message: "I can't do that in this workspace.",
              };
            }
            const questions = (input.questions as unknown[] ?? []).map((q: unknown) => {
              const qx = q as Record<string, unknown>;
              return {
                question: typeof qx.question === 'string' ? qx.question : '',
                header: typeof qx.header === 'string' ? qx.header : undefined,
                options: Array.isArray(qx.options)
                  ? qx.options.map((o: unknown) => {
                      const ox = o as Record<string, unknown>;
                      return {
                        label: typeof ox.label === 'string' ? ox.label : '',
                        description: typeof ox.description === 'string' ? ox.description : undefined,
                        preview: typeof ox.preview === 'string' ? ox.preview : undefined,
                      };
                    })
                  : [],
                multiSelect: qx.multiSelect === true,
              };
            });
            const timeout = typeof input.timeout === 'number' && Number.isFinite(input.timeout) && input.timeout > 0 ? input.timeout : undefined;
            return runtime.requestToolQuestion(sdkOptions.toolUseID, questions, input, {
              timeout,
              signal: sdkOptions.signal,
            });
          }

          if (decision === 'ask') {
            const runtime = this.runtimes.get(session.id);
            if (!runtime) {
              diagLog(
                `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=missing-runtime`,
              );
              return {
                behavior: 'deny' as const,
                message: "I can't do that in this workspace.",
              };
            }
            const timeout = typeof input.timeout === 'number' && Number.isFinite(input.timeout) && input.timeout > 0 ? input.timeout : undefined;
            return runtime.requestToolApproval(sdkOptions.toolUseID, toolName, sdkOptions.toolUseID, input, {
              title: sdkOptions.title,
              description: sdkOptions.description,
              suggestions: sdkOptions.suggestions,
              timeout,
              signal: sdkOptions.signal,
              decisionReasonType: sdkOptions.decisionReasonType,
            });
          }

          return { behavior: 'allow' as const, updatedInput: input };
        };
      }
    }

    if (session.isDraft) {
      // First message to a draft session — create a new SDK session with our ID
      options.sessionId = session.id;
      options.title = session.name;
    } else {
      // Resume existing SDK session
      options.resume = session.id;
    }

    return options;
  }

  private async *wrapStream(
    stream: AsyncGenerator<SDKMessage>,
  ): AsyncGenerator<SDKMessage> {
    for await (const msg of stream) {
      yield msg;
    }
  }

  private mapSdkSessionInfo(sdkSession: SDKSessionInfo, workspaceId: string): ChatSession {
    return {
      id: sdkSession.sessionId,
      workspaceId,
      name: sdkSession.customTitle || sdkSession.summary || 'Untitled Session',
      isDraft: false,
      createdAt: sdkSession.createdAt ? new Date(sdkSession.createdAt).toISOString() : new Date().toISOString(),
      updatedAt: sdkSession.lastModified ? new Date(sdkSession.lastModified).toISOString() : new Date().toISOString(),
      summary: sdkSession.summary,
      lastModified: sdkSession.lastModified,
      firstPrompt: sdkSession.firstPrompt,
      gitBranch: sdkSession.gitBranch,
      customTitle: sdkSession.customTitle,
    };
  }
}

export class ChatError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

export const chatService = new ChatService();
