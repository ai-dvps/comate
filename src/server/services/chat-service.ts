import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import type { Query, SDKMessage, SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatSession, CreateSessionInput, UpdateSessionInput } from '../models/session.js';
import type { Workspace } from '../models/workspace.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import type { ChatMessage, SubagentState, TaskItem, SseEvent } from '../types/message.js';
import { normalizeSessionMessage, scanSdkMessagesForTasks } from './message-normalizer.js';
import { SdkClient } from './sdk-client.js';
import { SessionRuntime } from './session-runtime.js';
import { reconstructSubagentState } from './subagent-loader.js';
import { resolveTranscriptDir } from './analytics-transcript-path.js';
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

export interface MessageStream {
  messages: AsyncGenerator<SDKMessage>;
  rawQuery: Query;
  wasDraft: boolean;
}

let RUNTIME_IDLE_GRACE_PERIOD_MS = 10 * 60 * 1000; // 10 minutes

export function __setIdleGracePeriodForTesting(ms: number): void {
  RUNTIME_IDLE_GRACE_PERIOD_MS = ms;
}

export function __restoreIdleGracePeriod(): void {
  RUNTIME_IDLE_GRACE_PERIOD_MS = 10 * 60 * 1000;
}

export class ChatService {
  private sdkClient: SdkClient;
  private runtimes = new Map<string, SessionRuntime>();
  private creatingRuntimes = new Map<string, Promise<SessionRuntime>>();
  private idleTimeouts = new Map<string, NodeJS.Timeout>();
  readonly serverNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  constructor(sdkClient?: SdkClient) {
    this.sdkClient = sdkClient ?? new SdkClient();
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

    // Identify bot sessions from the user mapping table
    const wecomMappings = workspaceStore.listWecomSessions(workspaceId);
    const feishuMappings = workspaceStore.listFeishuSessionsForWorkspace(workspaceId);
    const botSessionIds = new Set([
      ...wecomMappings.map((m) => m.sessionId),
      ...feishuMappings.map((m) => m.sessionId),
    ]);
    for (const session of allSessions) {
      if (botSessionIds.has(session.id)) {
        session.source = wecomMappings.some((m) => m.sessionId === session.id) ? 'wecom' : 'feishu';
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
    return workspaceStore.createLocalSession(input.workspaceId, input.name, input.approvalMode, input.providerId, input.source, input.customTitle);
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
      const updated = workspaceStore.updateLocalSession(id, draftInput);

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
    for (const agentId of agentIds) {
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
    for (const agentId of agentIds) {
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
    for (const agentId of agentIds) {
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
    offset?: number,
    limit?: number,
  ): Promise<{ messages: ChatMessage[]; tasks: TaskItem[]; subagents: SubagentState[] }> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      throw new ChatError('Workspace not found', 'WORKSPACE_NOT_FOUND', 404);
    }

    const options: import('@anthropic-ai/claude-agent-sdk').GetSessionMessagesOptions = {
      dir: normalizeWindowsPath(workspace.folderPath),
    };
    if (offset !== undefined) options.offset = offset;
    if (limit !== undefined) options.limit = limit;

    const sdkMessages = await this.sdkClient.getSessionMessages(sessionId, options);

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

    const normalized: ChatMessage[] = [];
    sdkMessages.forEach((msg: SessionMessage, index: number) => {
      const chatMessage = normalizeSessionMessage(msg);
      if (chatMessage) {
        // Approximate ordering by index — SDK does not surface a per-message
        // timestamp on the historical read path. U7 verifies ordering matches
        // the JSONL transcript order.
        chatMessage.timestamp = Date.now() - (sdkMessages.length - index) * 1000;
        normalized.push(chatMessage);
      }
    });
    const tasks = scanSdkMessagesForTasks(sdkMessages);
    const subagents = await this.loadSubagentsForSession(sessionId, workspaceId, sdkMessages);
    return { messages: normalized, tasks, subagents };
  }

  async loadMessagesAfter(
    sessionId: string,
    workspaceId: string,
    afterMessageId?: string,
  ): Promise<{ messages: ChatMessage[]; tasks: TaskItem[]; subagents: SubagentState[] }> {
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
    sliced.forEach((msg: SessionMessage, index: number) => {
      const chatMessage = normalizeSessionMessage(msg);
      if (chatMessage) {
        chatMessage.timestamp = Date.now() - (sliced.length - index) * 1000;
        normalized.push(chatMessage);
      }
    });
    const tasks = scanSdkMessagesForTasks(sliced);
    const subagents = await this.loadSubagentsForSession(sessionId, workspaceId, sdkMessages);
    return { messages: normalized, tasks, subagents };
  }

  // Session runtime management

  async getOrCreateRuntime(
    sessionId: string,
    workspaceId: string,
    isBotSession?: boolean,
    botEventHandler?: (id: number, event: import('../types/message.js').SseEvent) => void,
    botUserId?: string,
  ): Promise<SessionRuntime> {
    const existing = this.runtimes.get(sessionId);
    if (existing && !existing.isClosed()) {
      this.cancelIdleClose(sessionId);
      if (botEventHandler) {
        existing.clearBotEventHandlers();
        existing.addBotEventHandler(botEventHandler);
      }
      return existing;
    }
    if (existing) {
      // Clean up a dead runtime
      this.runtimes.delete(sessionId);
    }

    const pending = this.creatingRuntimes.get(sessionId);
    if (pending) {
      const runtime = await pending;
      if (botEventHandler) {
        runtime.clearBotEventHandlers();
        runtime.addBotEventHandler(botEventHandler);
      }
      return runtime;
    }

    const promise = (async () => {
      const workspace = await workspaceStore.get(workspaceId);
      if (!workspace) {
        throw new ChatError('Workspace not found', 'WORKSPACE_NOT_FOUND', 404);
      }

      const session = await this.getSession(sessionId, workspaceId);
      if (!session) {
        throw new ChatError('Session not found', 'SESSION_NOT_FOUND', 404);
      }

      // Verify non-draft sessions actually exist in SDK before resuming.
      // If the SDK has lost track of the session, fall back to sessionId mode
      // so the conversation can be recreated rather than failing with
      // "No conversation found with session ID".
      if (!session.isDraft) {
        try {
          const sdkSession = await this.sdkClient.getSessionInfo(sessionId, { dir: workspace.folderPath });
          if (!sdkSession) {
            sidecarLog(`[ChatService] Session ${sessionId} not found in SDK, falling back to draft mode`);
            workspaceStore.setSessionDraft(sessionId, true);
            session.isDraft = true;
          }
        } catch (err) {
          sidecarLog(`[ChatService] Failed to verify session ${sessionId} in SDK: ${err}`);
        }
      }

      const options = this.buildSdkOptions(workspace, session, isBotSession, botUserId);
      await this.testClaudeBinary(options.pathToClaudeCodeExecutable, normalizeWindowsPath(workspace.folderPath), options.env || process.env);
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
      );
      this.runtimes.set(sessionId, runtime);
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
    this.cancelIdleClose(sessionId);
    this.runtimes.delete(sessionId);
    sidecarLog(`[ChatService] closing runtime ${sessionId}`);
    await runtime.close();
  }

  getRuntimeIfExists(sessionId: string): SessionRuntime | undefined {
    const runtime = this.runtimes.get(sessionId);
    if (runtime && !runtime.isClosed()) return runtime;
    return undefined;
  }

  private scheduleIdleClose(sessionId: string): void {
    this.cancelIdleClose(sessionId);
    const timeout = setTimeout(() => {
      // Hold the runtime open while a turn is in flight (streaming or blocked
      // on a pending approval/tool with no output). Without this guard a silent
      // in-flight turn is reclaimed before it completes, which would break the
      // WeCom long-reply safeguard for long-pending-approval turns.
      const runtime = this.getRuntimeIfExists(sessionId);
      if (runtime?.isProcessingTurn()) {
        sidecarLog(`[ChatService] idle close deferred for ${sessionId}: turn in flight`);
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

  private buildSdkOptions(
    workspace: Workspace,
    session: ChatSession,
    isBotSession?: boolean,
    botUserId?: string,
  ): import('@anthropic-ai/claude-agent-sdk').Options {
    const claudeSettings = loadClaudeSettings();
    let { env } = buildClaudeEnv(claudeSettings);

    // Resolve active provider: session -> default
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

    // Build flag-settings env so provider credentials survive upstream
    // settings reloads (applyConfigEnvironmentVariables overwrites process.env).
    const settingsEnv: Record<string, string> = {};
    settingsEnv.ANTHROPIC_BASE_URL = provider.baseUrl;
    settingsEnv.ANTHROPIC_API_KEY = provider.authToken;
    settingsEnv.ANTHROPIC_AUTH_TOKEN = provider.authToken;
    if (provider.model) {
      settingsEnv.ANTHROPIC_MODEL = provider.model;
    }
    if (provider.defaultOpusModel) {
      settingsEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = provider.defaultOpusModel;
    }
    if (provider.defaultSonnetModel) {
      settingsEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = provider.defaultSonnetModel;
    }
    if (provider.defaultHaikuModel) {
      settingsEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = provider.defaultHaikuModel;
    }
    if (provider.subagentModel) {
      settingsEnv.CLAUDE_CODE_SUBAGENT_MODEL = provider.subagentModel;
    }
    if (provider.effortLevel) {
      settingsEnv.CLAUDE_CODE_EFFORT_LEVEL = provider.effortLevel;
    }
    if (provider.customEnvVars) {
      for (const [key, value] of Object.entries(provider.customEnvVars)) {
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

    const claudePath = resolveSdkBinary();
    const normalizedCwd = normalizeWindowsPath(workspace.folderPath);
    sidecarLog(`[ChatService.buildSdkOptions] pathToClaudeCodeExecutable=${claudePath}`);
    sidecarLog(`[ChatService.buildSdkOptions] cwd=${normalizedCwd} (raw=${workspace.folderPath})`);
    sidecarLog(`[ChatService.buildSdkOptions] provider=${provider.name} model=${provider.model || 'default'}`);
    sidecarLog(`[ChatService.buildSdkOptions] sessionId=${session.id} isDraft=${!!session.isDraft}`);
    sidecarLog(`[ChatService.buildSdkOptions] platform=${process.platform} arch=${process.arch}`);
    const options: import('@anthropic-ai/claude-agent-sdk').Options = {
      cwd: normalizedCwd,
      env,
      settings: { env: settingsEnv },
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
      model: provider.model || undefined,
      includePartialMessages: false,
      pathToClaudeCodeExecutable: claudePath,
      stderr: (data) => {
        const trimmed = data.trim();
        if (trimmed) sidecarLog(`[ChatService.claude.stderr] ${trimmed}`);
      },
    };

    if (isBotSession) {
      // Resolve the workspace's tool permission policy once at runtime creation.
      // The policy is snapshotted for the lifetime of this cached runtime; policy
      // changes apply to the next runtime open, not mid-conversation. See
      // docs/brainstorms/2026-06-14-wecom-bot-tool-permissions-requirements.md
      // and plan KTD "Policy changes apply to the next bot session".
      const resolved = resolveEffectivePolicy(workspace);
      const policy = resolved.policy;

      // Sanitize the child process environment for bot sessions: remove WeCom
      // and non-Anthropic cloud credentials. Anthropic provider keys are kept
      // because the SDK child needs them to call the API.
      env = sanitizeBotEnv(env);

      // buildSdkOptions() already constructed an options object with the
      // original env reference, but sanitizeBotEnv() returns a new object above.
      // Ensure the returned options point to the sanitized env.
      options.env = env;

      // Resolve the canonical bot user identity for this session. Prefer the
      // explicitly supplied Feishu user ID, otherwise fall back to the existing
      // WeCom user mapping for backward compatibility.
      const wecomUserId = workspaceStore.getWecomUserIdBySession(workspace.id, session.id);
      const canonicalUserId = botUserId
        ?? (wecomUserId
          ? (workspaceStore.getWecomUserMapping(wecomUserId) ?? wecomUserId)
          : undefined);

      let pathContext: import('./bot-path-policy.js').PathPolicyContext | undefined;
      let skillContext: import('./bot-skill-policy.js').SkillPolicyContext | undefined;

      if (canonicalUserId) {
        const userDirName = canonicalUserId;
        const wsUsers = workspaceStore.listWecomWorkspaceUsers(workspace.id);
        const mappings = workspaceStore.listWecomUserMappings();
        const mappingMap = new Map(mappings.map((m) => [m.encryptedUserId, m.plaintextUserId]));
        const knownUserDirNames = wsUsers.map((u) => mappingMap.get(u.encryptedUserId) ?? u.encryptedUserId);

        pathContext = createPathPolicyContext(workspace, userDirName, knownUserDirNames);
        const isolation = workspace.settings.wecomBotIsolation;
        const isAdmin = isolation?.adminUserIds?.includes(canonicalUserId) ?? false;
        pathContext.isAdmin = isAdmin;
        skillContext = { isolation, isAdmin };
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
        const decision = evaluateToolPermission(policy, toolName, pathContext?.isAdmin ?? false);
        // 'unknown' = tool not in any category (MCP, Skill, future SDK built-in
        // without a category fit). Fall through to today's allow-all behavior
        // per R10. The brainstorm explicitly defers MCP and Skills gating.
        if (decision === 'deny') {
          // Generic denial message — do NOT name the capability. Inbound WeCom
          // messages are an untrusted channel; naming the denied capability
          // would let an attacker probe the policy by mapping denials.
          const reason = getToolPermissionDenialReason(policy, toolName);
          diagLog(
            `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=${reason ?? 'deny'}`,
          );
          return {
            behavior: 'deny' as const,
            message: "I can't do that in this workspace.",
          };
        }

        // Identity failure = fail closed on file/Bash/Skill tools.
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
