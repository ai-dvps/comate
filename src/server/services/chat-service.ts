import { spawn } from 'child_process';
import { homedir } from 'os';
import path from 'path';
import type { Query, SDKMessage, SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatSession, CreateSessionInput, UpdateSessionInput } from '../models/session.js';
import type { Workspace } from '../models/workspace.js';
import type { Provider } from '../models/provider.js';
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
import { pluginSettingsService } from './plugin-settings-service.js';
import { existsSync, readFileSync } from 'fs';

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
  private sdkClient = new SdkClient();
  private runtimes = new Map<string, SessionRuntime>();
  private creatingRuntimes = new Map<string, Promise<SessionRuntime>>();
  private idleTimeouts = new Map<string, NodeJS.Timeout>();
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

  async listSessions(workspaceId: string): Promise<ChatSession[]> {
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
    const botSessionIds = new Set(wecomMappings.map((m) => m.sessionId));
    for (const session of allSessions) {
      if (botSessionIds.has(session.id)) {
        session.source = 'wecom';
      }
    }

    return allSessions;
  }

  async createSession(input: CreateSessionInput): Promise<ChatSession> {
    return workspaceStore.createLocalSession(input.workspaceId, input.name, input.approvalMode, input.providerId, input.source);
  }

  async getSession(id: string, workspaceId: string): Promise<ChatSession | null> {
    // Try SDK first for freshest data
    const workspace = await workspaceStore.get(workspaceId);
    if (workspace) {
      try {
        const sdkSession = await this.sdkClient.getSessionInfo(id, { dir: workspace.folderPath });
        if (sdkSession) {
          const session = this.mapSdkSessionInfo(sdkSession, workspaceId);
          // Preserve providerId from local DB — the SDK doesn't know about providers
          const localSession = workspaceStore.getLocalSession(id);
          session.providerId = localSession?.providerId;
          session.isWip = localSession?.isWip;
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

    // Check local DB for current provider before update
    const localSession = workspaceStore.getLocalSession(id);
    const previousProviderId = localSession?.providerId;

    if (localSession && localSession.isDraft) {
      const draftInput: Parameters<typeof workspaceStore.updateLocalSession>[1] = {};
      if (input.name !== undefined) draftInput.name = input.name;
      if (input.providerId !== undefined) draftInput.providerId = input.providerId;
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

    // Also update local DB for providerId change on non-draft sessions
    if (input.providerId !== undefined) {
      workspaceStore.updateLocalSession(id, { providerId: input.providerId });
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

  async clearDraftFlag(id: string): Promise<boolean> {
    return workspaceStore.clearDraftFlag(id);
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
    return { messages: normalized, tasks };
  }

  async loadMessagesAfter(
    sessionId: string,
    workspaceId: string,
    afterMessageId?: string,
  ): Promise<{ messages: ChatMessage[]; tasks: TaskItem[] }> {
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

      const options = this.buildSdkOptions(workspace, session, isBotSession);
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
  ): import('@anthropic-ai/claude-agent-sdk').Options {
    const claudeSettings = loadClaudeSettings();
    const { env } = buildClaudeEnv(claudeSettings);

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
