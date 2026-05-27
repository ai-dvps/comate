import { spawn } from 'child_process';
import { homedir } from 'os';
import path from 'path';
import type { Query, SDKMessage, SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatSession, CreateSessionInput, UpdateSessionInput } from '../models/session.js';
import type { Workspace } from '../models/workspace.js';
import { store as draftStore } from '../storage/json-store.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import type { ChatMessage, TaskItem } from '../types/message.js';
import { normalizeSessionMessage, scanSdkMessagesForTasks } from './message-normalizer.js';
import { SdkClient } from './sdk-client.js';
import { SessionRuntime } from './session-runtime.js';
import { resolveSdkBinary } from '../utils/resolve-sdk-binary.js';
import { resolveWecomCliPath } from '../utils/resolve-wecom-cli.js';
import { sidecarLog } from '../utils/sidecar-logger.js';
import { normalizeWindowsPath } from '../utils/normalize-windows-path.js';
import { loadClaudeSettings } from '../utils/claude-settings.js';
import { buildClaudeEnv, prependEnvPath, getPathEnvKey } from '../utils/sdk-env.js';

export interface MessageStream {
  messages: AsyncGenerator<SDKMessage>;
  rawQuery: Query;
  wasDraft: boolean;
}

export class ChatService {
  private sdkClient = new SdkClient();
  private runtimes = new Map<string, SessionRuntime>();
  private creatingRuntimes = new Map<string, Promise<SessionRuntime>>();
  readonly serverNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  getActiveSessionCount(): number {
    return this.runtimes.size;
  }

  /** Diagnostic: test-run the Claude binary in the workspace cwd to capture stderr. */
  private async testClaudeBinary(claudePath: string | undefined, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
    if (!claudePath) {
      sidecarLog('[ChatService.testClaudeBinary] no binary path, skipping test');
      return;
    }
    sidecarLog(`[ChatService.testClaudeBinary] testing binary: ${claudePath} in cwd: ${cwd}`);
    return new Promise((resolve) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      const finish = () => {
        if (settled) return false;
        settled = true;
        if (timeout) clearTimeout(timeout);
        return true;
      };
      const proc = spawn(claudePath, ['--version'], { cwd, env });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d) => { stdout += String(d); });
      proc.stderr?.on('data', (d) => { stderr += String(d); });
      proc.on('close', (code) => {
        if (!finish()) return;
        sidecarLog(`[ChatService.testClaudeBinary] exit code=${code} stdout=${stdout.trim()} stderr=${stderr.trim()}`);
        resolve();
      });
      proc.on('error', (err) => {
        if (!finish()) return;
        sidecarLog(`[ChatService.testClaudeBinary] spawn error: ${err.message}`);
        resolve();
      });
      // 10s timeout
      timeout = setTimeout(() => {
        if (!finish()) return;
        sidecarLog('[ChatService.testClaudeBinary] timeout after 10s');
        proc.kill();
        resolve();
      }, 10000);
    });
  }

  // Session management

  async listSessions(workspaceId: string): Promise<ChatSession[]> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      throw new ChatError('Workspace not found', 'WORKSPACE_NOT_FOUND', 404);
    }

    // Discover SDK sessions for this workspace directory
    let sdkSessions: ChatSession[] = [];
    try {
      const sessions = await this.sdkClient.listSessions({ dir: workspace.folderPath });
      sdkSessions = sessions.map((s) => this.mapSdkSessionInfo(s, workspaceId));
    } catch (err) {
      console.error('Failed to list SDK sessions:', err);
      // Continue with drafts even if SDK listing fails
    }

    // Merge with local draft sessions
    const drafts = await draftStore.listDrafts(workspaceId);
    // Filter out drafts that have already been promoted to SDK sessions
    const draftIds = new Set(sdkSessions.map((s) => s.id));
    const activeDrafts = drafts.filter((d) => !draftIds.has(d.id));

    const allSessions = [...activeDrafts, ...sdkSessions];

    // Merge session metadata (WIP, etc.)
    const sessionIds = allSessions.map((s) => s.id);
    const metadata = workspaceStore.getSessionMetadata(sessionIds);
    for (const session of allSessions) {
      const meta = metadata[session.id];
      if (meta) {
        session.isWip = meta.isWip;
      }
    }

    // Identify bot sessions from the user mapping table
    const wecomMappings = workspaceStore.listWecomSessions(workspaceId);
    const botSessionIds = new Set(wecomMappings.map((m) => m.sessionId));
    for (const session of allSessions) {
      if (botSessionIds.has(session.id)) {
        session.source = 'wecom';
      }
    }

    return allSessions;
  }

  async createSession(input: CreateSessionInput): Promise<ChatSession> {
    return draftStore.createDraft(input);
  }

  async getSession(id: string, workspaceId: string): Promise<ChatSession | null> {
    // Try SDK first
    const workspace = await workspaceStore.get(workspaceId);
    if (workspace) {
      try {
        const sdkSession = await this.sdkClient.getSessionInfo(id, { dir: workspace.folderPath });
        if (sdkSession) {
          return this.mapSdkSessionInfo(sdkSession, workspaceId);
        }
      } catch {
        // Ignore SDK errors, fall back to draft lookup
      }
    }

    // Fall back to draft
    return draftStore.getDraft(id);
  }

  async updateSession(id: string, input: UpdateSessionInput, workspaceId: string): Promise<ChatSession | null> {
    // Persist isWip to metadata table (applies to both drafts and SDK sessions)
    if (input.isWip !== undefined) {
      workspaceStore.setSessionMetadata(id, input.isWip);
    }

    // Check if it's a draft
    const draft = await draftStore.getDraft(id);
    if (draft && draft.isDraft) {
      // Only pass name to draft update; isWip is handled via metadata table
      const draftInput: UpdateSessionInput = input.name !== undefined ? { name: input.name } : {};
      const updated = await draftStore.updateDraft(id, draftInput);
      if (updated) {
        updated.isWip = input.isWip !== undefined ? input.isWip : workspaceStore.getSessionMetadata([id])[id]?.isWip;
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

    // Return updated session info
    const sdkSession = await this.sdkClient.getSessionInfo(id, { dir: workspace.folderPath });
    if (sdkSession) {
      const session = this.mapSdkSessionInfo(sdkSession, workspaceId);
      session.isWip = input.isWip !== undefined ? input.isWip : workspaceStore.getSessionMetadata([id])[id]?.isWip;
      return session;
    }
    return null;
  }

  async clearDraftFlag(id: string): Promise<boolean> {
    return draftStore.clearDraftFlag(id);
  }

  // Message history loading

  async loadMessages(
    sessionId: string,
    workspaceId: string,
    offset?: number,
    limit?: number,
  ): Promise<{ messages: ChatMessage[]; tasks: TaskItem[] }> {
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
    return { messages: normalized, tasks };
  }

  // Session runtime management

  async getOrCreateRuntime(
    sessionId: string,
    workspaceId: string,
    isBotSession?: boolean,
    botEventHandler?: (id: number, event: import('../types/message.js').SseEvent) => void,
  ): Promise<SessionRuntime> {
    const existing = this.runtimes.get(sessionId);
    if (existing) {
      if (botEventHandler) {
        existing.clearBotEventHandlers();
        existing.addBotEventHandler(botEventHandler);
      }
      return existing;
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

      const options = this.buildSdkOptions(workspace, session, isBotSession);
      await this.testClaudeBinary(options.pathToClaudeCodeExecutable, normalizeWindowsPath(workspace.folderPath), options.env || process.env);
      const runtime = SessionRuntime.open(sessionId, workspaceId, this.serverNonce, options, this.sdkClient, botEventHandler);
      this.runtimes.set(sessionId, runtime);

      if (session.isDraft) {
        this.clearDraftFlag(sessionId).catch((err) => {
          console.error('Failed to clear draft flag:', err);
        });
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
    this.runtimes.delete(sessionId);
    await runtime.close();
  }

  getSessionsStatus(workspaceId: string): Record<string, { pendingCount: number }> {
    const statuses: Record<string, { pendingCount: number }> = {};
    for (const [sessionId, runtime] of this.runtimes) {
      const status = runtime.getStatus();
      if (status.workspaceId === workspaceId) {
        statuses[sessionId] = { pendingCount: status.pendingCount };
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
    // Check drafts first
    const draft = await draftStore.getDraft(sessionId);
    if (draft) {
      return workspaceStore.get(draft.workspaceId);
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

  private buildSdkOptions(
    workspace: Workspace,
    session: ChatSession,
    isBotSession?: boolean,
  ): import('@anthropic-ai/claude-agent-sdk').Options {
    const claudeSettings = loadClaudeSettings();
    const { env, sources: envSources } = buildClaudeEnv(claudeSettings);
    if (workspace.settings.apiKey) {
      env.ANTHROPIC_API_KEY = workspace.settings.apiKey;
    }

    // Diagnostic: log Windows home-dir env vars
    sidecarLog(`[ChatService.buildSdkOptions] USERPROFILE=${process.env.USERPROFILE}`);
    sidecarLog(`[ChatService.buildSdkOptions] HOME=${process.env.HOME}`);
    sidecarLog(`[ChatService.buildSdkOptions] HOMEDRIVE=${process.env.HOMEDRIVE}`);
    sidecarLog(`[ChatService.buildSdkOptions] HOMEPATH=${process.env.HOMEPATH}`);
    sidecarLog(`[ChatService.buildSdkOptions] homedir=${homedir()}`);
    sidecarLog(`[ChatService.buildSdkOptions] CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR}`);
    sidecarLog(`[ChatService.buildSdkOptions] CLAUDE_SECURESTORAGE_CONFIG_DIR=${env.CLAUDE_SECURESTORAGE_CONFIG_DIR}`);

    // Log all ANTHROPIC_* env vars for diagnostics
    for (const key of Object.keys(env)) {
      if (key.startsWith('ANTHROPIC_') && env[key]) {
        sidecarLog(`[ChatService.buildSdkOptions] env.${key}=<set> source=${envSources[key] ?? 'process'}`);
      }
    }

    const wecomCliPath = resolveWecomCliPath();
    if (wecomCliPath) {
      const cliDir = path.dirname(wecomCliPath);
      prependEnvPath(env, cliDir);
      env.WECOM_CLI_PATH = wecomCliPath;
      sidecarLog(`[ChatService.buildSdkOptions] injected wecom CLI dir into PATH: ${cliDir}`);
      sidecarLog(`[ChatService.buildSdkOptions] set WECOM_CLI_PATH=${wecomCliPath}`);
    }

    const mcpServers: Record<string, import('@anthropic-ai/claude-agent-sdk').McpServerConfig> = {};
    for (const mcp of workspace.mcpServers) {
      mcpServers[mcp.name] = {
        type: 'stdio',
        command: mcp.command,
        args: mcp.args,
      };
    }

    const claudePath = resolveSdkBinary();
    const normalizedCwd = normalizeWindowsPath(workspace.folderPath);
    sidecarLog(`[ChatService.buildSdkOptions] pathToClaudeCodeExecutable=${claudePath}`);
    sidecarLog(`[ChatService.buildSdkOptions] cwd=${normalizedCwd} (raw=${workspace.folderPath})`);
    sidecarLog(`[ChatService.buildSdkOptions] model=${workspace.settings.model || 'default'}`);
    sidecarLog(`[ChatService.buildSdkOptions] sessionId=${session.id} isDraft=${!!session.isDraft}`);
    sidecarLog(`[ChatService.buildSdkOptions] platform=${process.platform} arch=${process.arch}`);
    const options: import('@anthropic-ai/claude-agent-sdk').Options = {
      cwd: normalizedCwd,
      env,
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
      model: workspace.settings.model || undefined,
      includePartialMessages: true,
      pathToClaudeCodeExecutable: claudePath,
      stderr: (data) => {
        const trimmed = data.trim();
        if (trimmed) sidecarLog(`[ChatService.claude.stderr] ${trimmed}`);
      },
    };

    if (isBotSession) {
      options.canUseTool = async (
        _toolName: string,
        input: Record<string, unknown>,
      ) => ({ behavior: 'allow', updatedInput: input });
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
