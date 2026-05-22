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
    // Check if it's a draft
    const draft = await draftStore.getDraft(id);
    if (draft) {
      const updated = await draftStore.updateDraft(id, input);
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
      return this.mapSdkSessionInfo(sdkSession, workspaceId);
    }
    return null;
  }

  async deleteSession(id: string, workspaceId: string): Promise<boolean> {
    // Close runtime if active
    await this.closeRuntime(id);

    // Try draft first
    const draftDeleted = await draftStore.deleteDraft(id);
    if (draftDeleted) return true;

    // Otherwise delete SDK session
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      throw new ChatError('Workspace not found', 'WORKSPACE_NOT_FOUND', 404);
    }

    try {
      await this.sdkClient.deleteSession(id, { dir: workspace.folderPath });
      return true;
    } catch {
      return false;
    }
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
      dir: workspace.folderPath,
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
        existing.addBotEventHandler(botEventHandler);
      }
      return existing;
    }

    const pending = this.creatingRuntimes.get(sessionId);
    if (pending) {
      const runtime = await pending;
      if (botEventHandler) {
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
        const info = await this.sdkClient.getSessionInfo(sessionId, { dir: ws.folderPath });
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
    const env: Record<string, string | undefined> = { ...process.env };
    if (workspace.settings.apiKey) {
      env.ANTHROPIC_API_KEY = workspace.settings.apiKey;
    }

    const wecomCliPath = resolveWecomCliPath();
    if (wecomCliPath) {
      const cliDir = path.dirname(wecomCliPath);
      const pathSeparator = process.platform === 'win32' ? ';' : ':';
      env.PATH = cliDir + pathSeparator + (env.PATH || '');
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
    sidecarLog(`[ChatService.buildSdkOptions] pathToClaudeCodeExecutable=${claudePath}`);
    const options: import('@anthropic-ai/claude-agent-sdk').Options = {
      cwd: workspace.folderPath,
      env,
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
      model: workspace.settings.model || undefined,
      includePartialMessages: true,
      pathToClaudeCodeExecutable: claudePath,
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
