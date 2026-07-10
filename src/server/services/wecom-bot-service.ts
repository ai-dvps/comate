import AiBot from '@wecom/aibot-node-sdk';
import type {
  WSClient,
  WsFrame,
  TextMessage,
  FileMessage,
  ImageMessage,
  VoiceMessage,
  VideoMessage,
  BaseMessage,
  TemplateCard,
  TemplateCardEventData,
  EventMessageWith,
} from '@wecom/aibot-node-sdk';
import type { QuestionPayload } from '../types/message.js';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Workspace } from '../models/workspace.js';
import type { Bot, BotChannelKey } from '../models/bot.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { botService } from './bot-service.js';
import { chatService } from './chat-service.js';
import { wecomUserResolver } from './wecom-user-resolver.js';
import { wecomSessionRenamer } from './wecom-session-renamer.js';
import { createStreamReply, type StreamReplyConnection, type StreamReplyResult } from './wecom-stream-reply.js';
import { saveMediaFile } from './wecom-file-storage.js';
import { validateSendFilePath } from './wecom-send-file-policy.js';
import { REPLY_TOOL_NAME, evaluateToolPermission, resolveEffectivePolicy } from './tool-permission-policy.js';
import { diagLog } from '../utils/diag-logger.js';
import {
  buildWecomSessionListCard,
  buildWecomWorkspaceListCard,
  buildTerminalCard,
  decodeButtonKey,
  parseTemplateCardEvent,
  verifySessionOwner,
  formatQuestionFold,
  formatPermissionFold,
  type NormalizedSelectedItem,
  type PermissionFoldAction,
} from './wecom-template-card.js';

const MAX_SEND_FILE_SIZE_BYTES = 20 * 1024 * 1024;

/**
 * Resolve the stream-reply handler for an inbound WeCom message, honoring the
 * workspace's Reply-category permission.
 *
 * - If Reply is allowed (the default in SAFE_PRESET), constructs the stream
 *   reply and returns it; the caller passes `result.handler` to pushMessage.
 * - If Reply is denied, returns undefined. The caller still calls pushMessage
 *   so the agent runs (per R11/AE6), but no reply is sent to WeCom — and
 *   crucially, no placeholder frame leaks, and no Claude tokens are spent
 *   producing text the user will never see (because the stream reply's
 *   placeholder animation never fires).
 *
 * The workspace is read once per inbound message; if absent, defaults to
 * allowing Reply (defensive — should not happen for bot-enabled workspaces).
 */
async function resolveStreamReplyIfNeeded<TFrame>(
  workspaceId: string,
  conn: StreamReplyConnection,
  frame: WsFrame<TFrame>,
  sessionId: string,
  wecomUserId: string,
  sendTemplateCard?: (card: TemplateCard) => Promise<unknown>,
  callbacks?: { onFinalized?: () => void; onCleanup?: () => void },
): Promise<StreamReplyResult | undefined> {
  const workspace = await workspaceStore.get(workspaceId);
  if (!workspace) return undefined;
  const policy = resolveEffectivePolicy(workspace).policy;

  const botUser = workspaceStore.getBotUserByPlaintext(wecomUserId);
  const plaintextUserId = botUser?.plaintextUserId ?? wecomUserId;
  const isAdmin = workspace.settings.wecomBotIsolation?.adminUserIds?.includes(plaintextUserId) ?? false;

  if (evaluateToolPermission(policy, REPLY_TOOL_NAME, isAdmin) === 'deny') {
    return undefined;
  }
  return createStreamReply(
    { ...conn, sendTemplateCard },
    frame as WsFrame<unknown>,
    sessionId,
    wecomUserId,
    callbacks,
  );
}

export interface BotConnection {
  client: WSClient;
  workspaceId: string;
  botId: string;
  folderPath: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  connectionId: string;
  lastError?: string;
}

/**
 * Detect and parse the `/clear` and `/new` new-session commands (aliases).
 * Matches the exact token or a prefix followed by a space, so `/newer` or
 * `/clearx` do not trigger. Returns the optional title (text after the first
 * space, trimmed) when the message is a command.
 */
export function parseWecomNewSessionCommand(content: string): { isCommand: boolean; title: string } {
  const trimmed = content.trim();
  const isCommand =
    trimmed === '/clear' ||
    trimmed.startsWith('/clear ') ||
    trimmed === '/new' ||
    trimmed.startsWith('/new ');
  if (!isCommand) return { isCommand: false, title: '' };
  const firstSpace = trimmed.indexOf(' ');
  const title = firstSpace !== -1 ? trimmed.slice(firstSpace + 1).trim() : '';
  return { isCommand: true, title };
}

/**
 * Detect the `/resume` session-switch command. Matches the exact token or a
 * prefix followed by a space (so `/resumex` does not trigger). `/resume` takes
 * no arguments — trailing text is ignored (switch-only).
 */
export function parseWecomResumeCommand(content: string): boolean {
  const trimmed = content.trim();
  return trimmed === '/resume' || trimmed.startsWith('/resume ');
}

/**
 * Detect the `/stop` interrupt command. Matches the exact token or a prefix
 * followed by a space (so `/stopx` does not trigger). Trailing text is ignored.
 */
export function parseWecomStopCommand(content: string): boolean {
  const trimmed = content.trim();
  return trimmed === '/stop' || trimmed.startsWith('/stop ');
}

/**
 * Detect the `/workspace` workspace-switch command. Matches the exact token or a
 * prefix followed by a space (so `/workspacex` does not trigger). Trailing text
 * is ignored — the selection happens through the reply card.
 */
export function parseWecomWorkspaceCommand(content: string): boolean {
  const trimmed = content.trim();
  return trimmed === '/workspace' || trimmed.startsWith('/workspace ');
}
/**
 * Detect the `/status` command. Matches the exact token or a prefix followed by a
 * space (so `/statusx` does not trigger). Trailing text is ignored.
 */
export function parseWecomStatusCommand(content: string): boolean {
  const trimmed = content.trim();
  return trimmed === '/status' || trimmed.startsWith('/status ');
}

const MAX_RESUME_SESSIONS = 10;

/** Format an ISO timestamp as a short relative-time label for the `/resume` card. */
function formatRelativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '未知时间';
  const diffMin = Math.floor((Date.now() - then) / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay} 天前`;
  return iso.slice(0, 10);
}

export class WeComBotService {
  private connections = new Map<string, BotConnection>();
  private botIdToWorkspaceId = new Map<string, string>();
  private workspaceIdToBotId = new Map<string, string>();
  private serverUrl: string | null = null;
  private cardClickRateLimit = new Map<string, number>();
  private activeStreamReplies = new Map<string, StreamReplyResult>();

  setServerUrl(url: string): void {
    this.serverUrl = url;
  }

  async initialize(): Promise<void> {
    await this.cleanupStaleContextFiles();

    const bots = botService.listBots().filter((b) => botService.getChannelSettings(b.id).wecom?.enabled);
    if (bots.length > 0) {
      for (const bot of bots) {
        await this.connectBot(bot);
      }
      return;
    }

    // Pre-migration fallback: connect workspaces that still embed WeCom settings.
    const workspaces = await workspaceStore.list();
    for (const ws of workspaces) {
      if (ws.settings.wecomBotEnabled && ws.settings.wecomBotId && ws.settings.wecomBotSecret) {
        await this.connect(ws);
      }
    }
  }

  async connectBot(bot: Bot): Promise<void> {
    this.disconnectBot(bot.id);

    const wecom = botService.getChannelSettings(bot.id).wecom;
    if (!wecom?.enabled || !wecom.botId || !wecom.botSecret) {
      diagLog(`[WeComBotService] skipping connect for bot ${bot.id}: missing WeCom credentials`);
      return;
    }
    const wecomBotId = wecom.botId;

    const workspace = bot.activeWorkspaceId ? await workspaceStore.get(bot.activeWorkspaceId) : null;
    const workspaceId = bot.activeWorkspaceId ?? '';
    const folderPath = workspace?.folderPath ?? '';

    const client = new AiBot.WSClient({
      botId: wecomBotId,
      secret: wecom.botSecret,
      maxReconnectAttempts: -1,
    });

    const conn: BotConnection = {
      client,
      workspaceId,
      botId: bot.id,
      folderPath,
      status: 'connecting',
      connectionId: randomUUID(),
      lastError: undefined,
    };

    this.connections.set(bot.id, conn);
    if (workspaceId) {
      this.workspaceIdToBotId.set(workspaceId, bot.id);
      this.botIdToWorkspaceId.set(bot.id, workspaceId);
    }

    client.on('authenticated', async () => {
      const activeConn = this.connections.get(bot.id);
      if (!activeConn || activeConn.connectionId !== conn.connectionId) return;
      activeConn.status = 'connected';
      activeConn.lastError = undefined;
      const freshBot = workspaceStore.getBot(bot.id);
      const activeWorkspaceId = freshBot?.activeWorkspaceId ?? workspaceId;
      activeConn.workspaceId = activeWorkspaceId;
      this.botIdToWorkspaceId.set(bot.id, activeWorkspaceId);
      if (activeWorkspaceId) {
        this.workspaceIdToBotId.set(activeWorkspaceId, bot.id);
      }
      const ws = activeWorkspaceId ? await workspaceStore.get(activeWorkspaceId) : null;
      if (ws) {
        this.writeContextFile(ws, wecomBotId).catch((err) => {
          console.warn(`Failed to write WeCom context file for workspace ${activeWorkspaceId}:`, err);
        });
      }
    });

    client.on('disconnected', (reason) => {
      const activeConn = this.connections.get(bot.id);
      if (!activeConn || activeConn.connectionId !== conn.connectionId) return;
      activeConn.status = 'disconnected';
      activeConn.lastError = undefined;
      console.log(`WeCom bot ${bot.id} disconnected: ${reason}`);
    });

    client.on('error', (err) => {
      const activeConn = this.connections.get(bot.id);
      if (!activeConn || activeConn.connectionId !== conn.connectionId) return;
      activeConn.status = 'error';
      activeConn.lastError = String(err);
      console.error(`WeCom bot ${bot.id} error:`, err);
    });

    client.on('message.text', (frame: WsFrame<TextMessage>) => {
      this.handleTextMessage(conn.workspaceId, frame).catch((err) => {
        console.error('Failed to handle WeCom text message:', err);
      });
    });

    client.on('message.file', (frame: WsFrame<FileMessage>) => {
      this.handleMediaMessage(conn.workspaceId, frame).catch((err) => {
        console.error('Failed to handle WeCom file message:', err);
      });
    });

    client.on('message.image', (frame: WsFrame<ImageMessage>) => {
      this.handleMediaMessage(conn.workspaceId, frame).catch((err) => {
        console.error('Failed to handle WeCom image message:', err);
      });
    });

    client.on('message.voice', (frame: WsFrame<VoiceMessage>) => {
      this.handleMediaMessage(conn.workspaceId, frame).catch((err) => {
        console.error('Failed to handle WeCom voice message:', err);
      });
    });

    client.on('message.video', (frame: WsFrame<VideoMessage>) => {
      this.handleMediaMessage(conn.workspaceId, frame).catch((err) => {
        console.error('Failed to handle WeCom video message:', err);
      });
    });

    client.on('event.template_card_event', (frame: WsFrame<EventMessageWith<TemplateCardEventData>>) => {
      this.handleTemplateCardEvent(conn.workspaceId, frame).catch((err) => {
        console.error('Failed to handle WeCom template card event:', err);
      });
    });

    client.connect();
  }

  connectChannel(botId: string, channelKey: BotChannelKey): Promise<void> {
    if (channelKey !== 'wecom') {
      throw new Error(`WeComBotService does not support channel ${channelKey}`);
    }
    const bot = botService.getBot(botId);
    if (!bot) {
      throw new Error(`Bot ${botId} not found`);
    }
    const channelSettings = botService.getChannelSettings(botId);
    return this.connectBot({ ...bot, channelSettings } as Bot & { channelSettings: import('../models/bot.js').BotChannelSettings });
  }

  disconnectChannel(botId: string, channelKey: BotChannelKey): void {
    if (channelKey !== 'wecom') {
      throw new Error(`WeComBotService does not support channel ${channelKey}`);
    }
    this.disconnectBot(botId);
  }

  getChannelError(botId: string): string | undefined {
    return this.connections.get(botId)?.lastError;
  }

  /** Backward-compatible workspace-scoped connect (pre-migration). */
  async connect(workspace: Workspace): Promise<void> {
    const bot: Bot = {
      id: workspace.settings.wecomBotId!,
      name: workspace.settings.wecomBotName ?? workspace.name,
      activeWorkspaceId: workspace.id,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
    await this.connectBot(bot);
  }

  disconnectBot(botId: string, expectedConnectionId?: string): void {
    const conn = this.connections.get(botId);
    if (!conn) return;
    if (expectedConnectionId && conn.connectionId !== expectedConnectionId) return;
    conn.client.disconnect();
    this.connections.delete(botId);
    this.botIdToWorkspaceId.delete(botId);
    this.workspaceIdToBotId.delete(conn.workspaceId);
    this.removeContextFile(conn.workspaceId).catch((err) => {
      console.warn(`Failed to remove WeCom context file for workspace ${conn.workspaceId}:`, err);
    });
  }

  /** Backward-compatible workspace-scoped disconnect (pre-migration). */
  disconnect(workspaceId: string): void {
    const botId = this.workspaceIdToBotId.get(workspaceId);
    if (botId) {
      this.disconnectBot(botId);
      return;
    }
    // Fallback: legacy connection keyed by workspaceId may still exist if
    // initialize() connected pre-migration workspaces before any bots existed.
    const legacy = Array.from(this.connections.values()).find((c) => c.workspaceId === workspaceId);
    if (legacy) {
      this.disconnectBot(legacy.botId);
    }
  }

  private getConnectionByWorkspaceId(workspaceId: string): BotConnection | undefined {
    const botId = this.workspaceIdToBotId.get(workspaceId);
    return botId ? this.connections.get(botId) : undefined;
  }

  /**
   * Resolve a live connection for a workspace. Connections are keyed by botId,
   * but legacy tests and pre-migration call sites may still key by workspaceId.
   * Prefer the explicit workspace map; fall back to a direct lookup.
   */
  private getConnectionForWorkspace(workspaceId: string): BotConnection | undefined {
    return this.connections.get(workspaceId) ?? this.getConnectionByWorkspaceId(workspaceId);
  }

  private getBotIdForWorkspace(workspaceId: string): string | undefined {
    return this.workspaceIdToBotId.get(workspaceId) ??
      Array.from(this.connections.values()).find((c) => c.workspaceId === workspaceId)?.botId;
  }

  private ensureBotUser(workspaceId: string, channel: 'wecom', channelUserId: string): void {
    const botId = this.getBotIdForWorkspace(workspaceId);
    if (!botId) return;
    if (!botService.getBot(botId)) return;

    const role = botService.getMemberRole(botId, channel, channelUserId);
    if (role !== null) return;

    try {
      botService.addMember(botId, { channelKey: channel, channelUserId, roleKey: 'normal' });
      chatService.scheduleRebuildsForBot(botId);
    } catch (err) {
      // Membership is best-effort; do not block message handling.
      console.error(`[WeComBotService] failed to auto-add member ${channelUserId} for bot ${botId}:`, err);
    }
  }

  private getWecomBotForWorkspace(workspaceId: string): { botId: string; channelId: string } | null {
    const botId = this.getBotIdForWorkspace(workspaceId);
    if (botId) {
      const channel = workspaceStore.getBotChannelByKey(botId, 'wecom');
      if (channel) return { botId, channelId: channel.id };
    }
    // Fallback for storage-only lookups (e.g. tests without an injected connection).
    const bot = workspaceStore.listBotsForWorkspace(workspaceId)[0];
    if (!bot) return null;
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'wecom');
    if (!channel) return null;
    return { botId: bot.id, channelId: channel.id };
  }

  private getBotUserForWecom(workspaceId: string, wecomUserId: string): { botUser: import('../models/bot-user.js').BotUser; botId: string; channelId: string } | null {
    const bot = this.getWecomBotForWorkspace(workspaceId);
    if (!bot) return null;
    let botUser = workspaceStore.getBotUserByChannelIdentity(bot.botId, bot.channelId, wecomUserId);
    if (!botUser) {
      botUser = botService.ensureMember(bot.botId, 'wecom', wecomUserId);
    }
    return { botUser, botId: bot.botId, channelId: bot.channelId };
  }

  private getPlaintextUserId(workspaceId: string, wecomUserId: string): string | null {
    const botUser = this.getBotUserForWecom(workspaceId, wecomUserId);
    return botUser?.botUser.plaintextUserId ?? null;
  }

  private getChannelUserIdByPlaintext(plaintextUserId: string): string | null {
    return workspaceStore.getBotUserByPlaintext(plaintextUserId)?.channelUserId ?? null;
  }

  private getChannelUserIdBySession(sessionId: string): string | null {
    const userIds = workspaceStore.getSessionUsers(sessionId);
    for (const userId of userIds) {
      const botUser = workspaceStore.getBotUser(userId);
      if (botUser) {
        const channel = workspaceStore.getBotChannel(botUser.channelId);
        if (channel?.channelKey === 'wecom') {
          return botUser.channelUserId;
        }
      }
    }
    return null;
  }

  private listWorkspaceChannelUsers(workspaceId: string): Array<{ encryptedUserId: string }> {
    const bot = this.getWecomBotForWorkspace(workspaceId);
    if (!bot) return [];
    const users = workspaceStore.listBotUsersByChannel(bot.botId, bot.channelId);
    return users.map((u) => ({ encryptedUserId: u.channelUserId }));
  }

  private getActiveChannelSession(workspaceId: string, wecomUserId: string): string | null {
    const botUser = this.getBotUserForWecom(workspaceId, wecomUserId);
    if (!botUser) return null;
    return workspaceStore.getActiveUserSession(botUser.botUser.id);
  }

  private setActiveChannelSession(workspaceId: string, wecomUserId: string, sessionId: string): void {
    const botUser = this.getBotUserForWecom(workspaceId, wecomUserId);
    if (!botUser) return;
    workspaceStore.addUserSession(workspaceId, sessionId, botUser.botUser.id);
    workspaceStore.setActiveUserSession(botUser.botUser.id, sessionId);
  }

  private listChannelSessionsByUser(workspaceId: string, wecomUserId: string): Array<{ sessionId: string; createdAt: string }> {
    const botUser = this.getBotUserForWecom(workspaceId, wecomUserId);
    if (!botUser) return [];
    return workspaceStore.listUserSessionsByUser(botUser.botUser.id);
  }

  private setChannelSession(workspaceId: string, wecomUserId: string, sessionId: string): void {
    this.setActiveChannelSession(workspaceId, wecomUserId, sessionId);
  }

  private ensureChannelUser(workspaceId: string, encryptedUserId: string): void {
    const bot = this.getWecomBotForWorkspace(workspaceId);
    if (!bot) return;
    const existing = workspaceStore.getBotUserByChannelIdentity(bot.botId, bot.channelId, encryptedUserId);
    if (existing) return;
    const normalRole = workspaceStore.getBotRoleByKey(bot.botId, 'normal');
    if (!normalRole) return;
    workspaceStore.createBotUser({
      botId: bot.botId,
      channelId: bot.channelId,
      roleId: normalRole.id,
      channelUserId: encryptedUserId,
      plaintextUserId: null,
    });
  }

  private async resolvePlaintextUserId(wecomUserId: string): Promise<string | null> {
    // First try the unified schema lookup
    const botUser = workspaceStore.getBotUserByPlaintext(wecomUserId);
    if (botUser?.plaintextUserId) return botUser.plaintextUserId;
    // Fallback to legacy mapping table
    return null;
  }

  disconnectAll(): void {
    for (const botId of Array.from(this.connections.keys())) {
      this.disconnectBot(botId);
    }
  }

  getBotStatus(botId: string): 'connecting' | 'connected' | 'disconnected' | 'error' | 'not_configured' {
    const conn = this.connections.get(botId);
    if (!conn) return 'not_configured';
    return conn.status;
  }

  getStatus(workspaceId: string): 'connecting' | 'connected' | 'disconnected' | 'error' | 'not_configured' {
    const conn = this.getConnectionByWorkspaceId(workspaceId);
    if (!conn) return 'not_configured';
    return conn.status;
  }

  async getAggregateStatus(): Promise<{
    state: 'connected' | 'partial' | 'disconnected' | 'not_configured';
  }> {
    let bots = botService.listBots().filter((b) => botService.getChannelSettings(b.id).wecom?.enabled);

    // Pre-migration fallback: treat workspace-embedded WeCom configs as bots.
    if (bots.length === 0) {
      try {
        const workspaces = await workspaceStore.list();
        bots = workspaces
          .filter((ws) => ws.settings.wecomBotEnabled && ws.settings.wecomBotId && ws.settings.wecomBotSecret)
          .map((ws) => ({
            id: ws.settings.wecomBotId!,
            name: ws.settings.wecomBotName ?? ws.name,
            activeWorkspaceId: ws.id,
            createdAt: ws.createdAt,
            updatedAt: ws.updatedAt,
          }));
      } catch {
        return { state: 'not_configured' };
      }
    }

    if (bots.length === 0) return { state: 'not_configured' };

    let connectedCount = 0;
    for (const bot of bots) {
      if (this.getBotStatus(bot.id) === 'connected') connectedCount += 1;
    }
    if (connectedCount === bots.length) return { state: 'connected' };
    if (connectedCount === 0) return { state: 'disconnected' };
    return { state: 'partial' };
  }

  private async handleTextMessage(workspaceId: string, frame: WsFrame<TextMessage>): Promise<void> {
    if (!frame.body) return;
    const wecomUserId = frame.body.from.userid;
    const content = frame.body.text.content;
    diagLog(`[WeComBotService] recv text workspace=${workspaceId} from=${wecomUserId} len=${content.length}`);

    // Fire-and-forget: queue unseen user IDs for batch resolution
    wecomUserResolver.resolveOnMessage(workspaceId, wecomUserId).catch(() => {
      // Ignore: resolver failures degrade gracefully to encrypted ID usage
    });

    // Track that this user has interacted with this workspace
    wecomUserResolver.trackWorkspaceUser(workspaceId, wecomUserId);

    // Auto-add first-time messengers as normal bot members.
    this.ensureBotUser(workspaceId, 'wecom', wecomUserId);

    // /clear and /new (aliases) start a fresh session. Intercepted before the
    // message reaches the agent so the literal command is never a chat turn.
    const command = parseWecomNewSessionCommand(content);
    if (command.isCommand) {
      const conn = this.getConnectionForWorkspace(workspaceId);
      if (!conn) return;
      await this.handleNewSessionCommand(workspaceId, wecomUserId, command.title, conn);
      return;
    }

    // /resume lists the user's sessions as a single-select card. Intercepted
    // before the agent so the literal command is never a chat turn.
    if (parseWecomResumeCommand(content)) {
      const conn = this.getConnectionForWorkspace(workspaceId);
      if (!conn) return;
      await this.handleResumeCommand(workspaceId, wecomUserId, conn);
      return;
    }

    // /stop interrupts the user's active session if it has an in-flight turn.
    if (parseWecomStopCommand(content)) {
      const conn = this.getConnectionForWorkspace(workspaceId);
      if (!conn) return;
      await this.handleStopCommand(workspaceId, wecomUserId, conn);
      return;
    }

    // /workspace lets a Bot Owner switch the bot's active workspace.
    if (parseWecomWorkspaceCommand(content)) {
      await this.handleWorkspaceCommand(workspaceId, wecomUserId);
      return;
    }

    // /status reports the current workspace and the user's active session.
    if (parseWecomStatusCommand(content)) {
      const conn = this.getConnectionForWorkspace(workspaceId);
      if (!conn) return;
      await this.handleStatusCommand(workspaceId, wecomUserId, conn);
      return;
    }

    const sessionId = await this.getOrCreateSession(workspaceId, wecomUserId);
    if (!sessionId) return;

    const conn = this.getConnectionForWorkspace(workspaceId);
    if (!conn) return;

    const streamReply = await resolveStreamReplyIfNeeded(
      workspaceId,
      conn,
      frame,
      sessionId,
      wecomUserId,
      (card) => this.sendTemplateCard(workspaceId, wecomUserId, card),
      {
        onFinalized: () => this.activeStreamReplies.delete(sessionId),
        onCleanup: () => this.activeStreamReplies.delete(sessionId),
      },
    );

    try {
      await chatService.pushMessage(sessionId, workspaceId, content, true, streamReply?.handler);
    } catch (err) {
      streamReply?.handler.cleanup();
      throw err;
    }

    if (streamReply) {
      this.activeStreamReplies.set(sessionId, streamReply);
    }
  }

  /**
   * Handle `/clear` / `/new`: create a fresh WeCom session, mark it the user's
   * current session, preserve prior sessions, refresh naming, and reply with a
   * title-bearing confirmation. Mirrors feishu-bot-service handleNewSessionCommand.
   * `title` is the user-supplied title (already trimmed) or '' when none given.
   */
  private async handleNewSessionCommand(
    workspaceId: string,
    wecomUserId: string,
    title: string,
    conn: BotConnection,
  ): Promise<void> {
    // Default name mirrors getOrCreateSession (wecomUserId). A user-supplied
    // title is also stored as customTitle so the auto-renamer cannot overwrite it.
    const name = title || wecomUserId;
    try {
      await this.instantiateWecomSession(workspaceId, wecomUserId, name, title || undefined);

      const displayTitle = title || name;
      await conn.client.sendMessage(wecomUserId, {
        msgtype: 'markdown',
        markdown: { content: `新的会话已创建：【${displayTitle}】，可继续对话` },
      });
    } catch (err) {
      console.error('[WeComBotService] failed to create session via /clear|/new:', err);
      try {
        await conn.client.sendMessage(wecomUserId, {
          msgtype: 'markdown',
          markdown: { content: '⚠️ 创建会话失败，请稍后重试。' },
        });
      } catch {
        // Ignore secondary send failure
      }
    }
  }

  /**
   * Handle `/resume`: list the user's WeCom sessions as a single-select card
   * (title + last-activity, most-recent first, capped), letting them switch.
   * Stateless — the target sessionId is encoded in each option's id, so the
   * submit callback needs no pending store. Mirrors feishu-bot-service
   * collectSessionList / sendSessionListCard.
   */
  private async handleResumeCommand(
    workspaceId: string,
    wecomUserId: string,
    conn: BotConnection,
  ): Promise<void> {
    try {
      const activeSessionId = this.getActiveChannelSession(workspaceId, wecomUserId);
      const rows = this.listChannelSessionsByUser(workspaceId, wecomUserId);

      type Candidate = { sessionId: string; title: string; updatedAt: string; isActive: boolean };
      const candidates: Candidate[] = [];
      for (const row of rows) {
        // listUserSessionsByUser returns only {sessionId, createdAt}; fetch
        // title + updatedAt per row (and filter archived) like collectSessionList.
        const session = await chatService.getSession(row.sessionId, workspaceId);
        if (!session || session.isArchived) continue; // R8: exclude archived
        candidates.push({
          sessionId: session.id,
          title: session.customTitle ?? session.name ?? row.sessionId,
          updatedAt: session.updatedAt,
          isActive: session.id === activeSessionId,
        });
      }

      // Most-recent first, capped to the card's option budget.
      candidates.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
      const capped = candidates.slice(0, MAX_RESUME_SESSIONS);

      if (capped.length === 0) {
        await conn.client.sendMessage(wecomUserId, {
          msgtype: 'markdown',
          markdown: { content: '暂无会话可恢复，发送消息即可开始新的对话。' },
        });
        return;
      }

      // Source session for the button key: the active one, else the first
      // candidate (always a session the user owns, so the ownership check passes).
      const sourceSessionId = activeSessionId ?? capped[0].sessionId;
      const requestId = randomUUID();
      const card = buildWecomSessionListCard({
        requestId,
        sessionId: sourceSessionId,
        taskId: requestId,
        options: capped.map((c) => ({
          sessionId: c.sessionId,
          label: `${c.title} · ${formatRelativeTime(c.updatedAt)}`,
          isActive: c.isActive,
        })),
      });
      await this.sendTemplateCard(workspaceId, wecomUserId, card);
    } catch (err) {
      console.error('[WeComBotService] failed to handle /resume:', err);
      try {
        await conn.client.sendMessage(wecomUserId, {
          msgtype: 'markdown',
          markdown: { content: '⚠️ 获取会话列表失败，请稍后重试。' },
        });
      } catch {
        // Ignore secondary send failure
      }
    }
  }

  /**
   * Handle `/stop`: interrupt the user's active WeCom session if it has an
   * in-flight turn, resolve any pending approvals/questions as denied, and
   * confirm the action. Mirrors feishu-bot-service handleStopCommand.
   */
  private async handleStopCommand(
    workspaceId: string,
    wecomUserId: string,
    conn: BotConnection,
  ): Promise<void> {
    try {
      const sessionId = this.getActiveChannelSession(workspaceId, wecomUserId);
      diagLog(`[WeComBotService] /stop from ${wecomUserId}, activeSession=${sessionId ?? 'none'}`);
      if (!sessionId) {
        await conn.client.sendMessage(wecomUserId, {
          msgtype: 'markdown',
          markdown: { content: '没有活跃的会话可中断。请运行 /resume 选择会话。' },
        });
        return;
      }

      const runtime = chatService.getRuntimeIfExists(sessionId);
      if (!runtime || !runtime.isProcessingTurn()) {
        diagLog(`[WeComBotService] /stop for ${sessionId}: no runtime or not processing`);
        await conn.client.sendMessage(wecomUserId, {
          msgtype: 'markdown',
          markdown: { content: '当前没有正在进行的对话。' },
        });
        return;
      }

      const streamReply = this.activeStreamReplies.get(sessionId);
      const interruptedInStream = streamReply?.interrupt('已中断') ?? false;
      diagLog(`[WeComBotService] /stop for ${sessionId}: streamReply=${streamReply ? 'present' : 'missing'}, interruptedInStream=${interruptedInStream}`);

      await runtime.interrupt();
      runtime.cancelPendingApprovals('Turn interrupted by user.');

      // Always send a proactive confirmation. Relying solely on the active
      // stream reply is unsafe: interrupt() returns true as soon as the final
      // frame is enqueued, but the stream reply may be bound to a stale
      // connection or the frame may be dropped by WeCom. A proactive message
      // through the current connection guarantees the user sees feedback.
      await conn.client.sendMessage(wecomUserId, {
        msgtype: 'markdown',
        markdown: { content: '已中断' },
      });
      diagLog(`[WeComBotService] /stop for ${sessionId}: sent proactive 已中断`);
    } catch (err) {
      console.error('[WeComBotService] failed to handle /stop:', err);
      try {
        await conn.client.sendMessage(wecomUserId, {
          msgtype: 'markdown',
          markdown: { content: '⚠️ 中断会话失败，请稍后重试。' },
        });
      } catch {
        // Ignore secondary send failure
      }
    }
  }

  /**
   * Handle `/workspace`: let a Bot Owner switch the active workspace.
   * Rejects non-Owners immediately; Owners receive a workspace-list card.
   */
  private async handleWorkspaceCommand(workspaceId: string, wecomUserId: string): Promise<void> {
    const botId = this.getBotIdForWorkspace(workspaceId);
    if (!botId) return;
    const conn = this.connections.get(botId);
    if (!conn) return;

    if (botService.getMemberRole(botId, 'wecom', wecomUserId) !== 'owner') {
      await conn.client.sendMessage(wecomUserId, {
        msgtype: 'markdown',
        markdown: { content: '你没有权限切换工作空间。' },
      });
      return;
    }

    const workspaces = await workspaceStore.list();
    const activeWorkspaceId = botService.resolveActiveWorkspace(botId) ?? workspaceId;
    const card = buildWecomWorkspaceListCard({
      requestId: randomUUID(),
      botId,
      workspaces: workspaces.map((ws) => ({
        workspaceId: ws.id,
        name: ws.name,
        isActive: ws.id === activeWorkspaceId,
      })),
    });
    await this.sendTemplateCard(workspaceId, wecomUserId, card);
  }

  /**
   * Handle `/status`: report the current workspace name and the user's active
   * session name as a plain-text markdown message.
   */
  private async handleStatusCommand(
    workspaceId: string,
    wecomUserId: string,
    conn: BotConnection,
  ): Promise<void> {
    try {
      const workspace = await workspaceStore.get(workspaceId);
      if (!workspace) {
        await conn.client.sendMessage(wecomUserId, {
          msgtype: 'markdown',
          markdown: { content: '机器人尚未绑定工作空间，请联系管理员进行设置。' },
        });
        return;
      }

      const sessionId = this.getActiveChannelSession(workspaceId, wecomUserId);
      let sessionName = '暂无活跃会话';
      if (sessionId) {
        try {
          const session = await chatService.getSession(sessionId, workspaceId);
          if (session) {
            sessionName = session.customTitle ?? session.name ?? sessionId;
          }
        } catch (err) {
          console.error('[WeComBotService] failed to read session for /status:', err);
          sessionName = '读取会话失败';
        }
      }

      await conn.client.sendMessage(wecomUserId, {
        msgtype: 'markdown',
        markdown: {
          content: `当前工作空间：**${workspace.name}**\n当前会话：**${sessionName}**`,
        },
      });
    } catch (err) {
      console.error('[WeComBotService] failed to handle /status:', err);
      try {
        await conn.client.sendMessage(wecomUserId, {
          msgtype: 'markdown',
          markdown: { content: '⚠️ 获取状态失败，请稍后重试。' },
        });
      } catch {
        // Ignore secondary send failure
      }
    }
  }

  /**
   * Switch a bot's active workspace after an Owner selects one from a card.
   * Updates the connection's routing in place, persists via BotService, and
   * best-effort notifies users in the previous workspace.
   */
  private async switchActiveWorkspace(
    botId: string,
    workspaceId: string,
    wecomUserId: string,
  ): Promise<void> {
    const conn = this.connections.get(botId);
    if (!conn) return;

    const previousWorkspaceId = this.botIdToWorkspaceId.get(botId);
    if (previousWorkspaceId === workspaceId) {
      await conn.client.sendMessage(wecomUserId, {
        msgtype: 'markdown',
        markdown: { content: '该工作空间已经是当前绑定目标。' },
      });
      return;
    }

    botService.setActiveWorkspace(botId, workspaceId, {
      type: 'wecom',
      channelKey: 'wecom',
      channelUserId: wecomUserId,
    });

    conn.workspaceId = workspaceId;
    this.botIdToWorkspaceId.set(botId, workspaceId);
    if (previousWorkspaceId) {
      this.workspaceIdToBotId.delete(previousWorkspaceId);
    }
    this.workspaceIdToBotId.set(workspaceId, botId);

    const workspace = await workspaceStore.get(workspaceId);
    if (workspace) {
      this.writeContextFile(workspace, conn.botId).catch((err) => {
        console.warn(`Failed to write WeCom context file for workspace ${workspaceId}:`, err);
      });
    }

    const workspaceName = workspace?.name ?? workspaceId;
    await conn.client.sendMessage(wecomUserId, {
      msgtype: 'markdown',
      markdown: { content: `已切换到工作空间：**${workspaceName}**。新消息将路由到该工作空间；进行中的任务仍在原工作空间继续。` },
    });

    if (previousWorkspaceId) {
      const users = this.listWorkspaceChannelUsers(previousWorkspaceId);
      const message = `当前机器人已切换到工作空间”${workspaceName}”。你正在进行的任务仍在原工作空间继续。`;
      for (const user of users) {
        this.sendProactiveMessage(botId, user.encryptedUserId, message).catch((err) => {
          diagLog(`[WeComBotService] failed to notify user ${user.encryptedUserId} of workspace switch:`, err);
        });
      }
    }
  }

  private async handleMediaMessage(workspaceId: string, frame: WsFrame<BaseMessage>): Promise<void> {
    if (!frame.body) return;
    const wecomUserId = frame.body.from.userid;
    const msgtype = frame.body.msgtype;
    diagLog(`[WeComBotService] recv ${msgtype} workspace=${workspaceId} from=${wecomUserId}`);

    // Fire-and-forget: queue unseen user IDs for batch resolution
    wecomUserResolver.resolveOnMessage(workspaceId, wecomUserId).catch(() => {});
    wecomUserResolver.trackWorkspaceUser(workspaceId, wecomUserId);

    // Auto-add first-time messengers as normal bot members.
    this.ensureBotUser(workspaceId, 'wecom', wecomUserId);

    const conn = this.getConnectionForWorkspace(workspaceId);
    if (!conn) return;

    try {
      // Voice messages only have a text transcription (no download URL)
      if (msgtype === 'voice') {
        const voiceContent = frame.body.voice?.content;
        if (!voiceContent) {
          // Voice message with no transcription — notify user
          await conn.client.sendMessage(wecomUserId, {
            msgtype: 'markdown',
            markdown: { content: '⚠️ 语音消息无法识别，请重试。' },
          });
          return;
        }

        // Look up or create session
        const sessionId = await this.getOrCreateSession(workspaceId, wecomUserId);
        if (!sessionId) return;

        const streamReply = await resolveStreamReplyIfNeeded(
          workspaceId,
          conn,
          frame,
          sessionId,
          wecomUserId,
          (card) => this.sendTemplateCard(workspaceId, wecomUserId, card),
          {
            onFinalized: () => this.activeStreamReplies.delete(sessionId),
            onCleanup: () => this.activeStreamReplies.delete(sessionId),
          },
        );
        const prompt = `a voice message transcribed as: "${voiceContent}" uploaded by ${wecomUserId}, if there is skill can process this content, process it with that skill, if no proper skill find, ask user how to handle it.`;
        try {
          await chatService.pushMessage(sessionId, workspaceId, prompt, true, streamReply?.handler);
        } catch (err) {
          streamReply?.handler.cleanup();
          throw err;
        }
        if (streamReply) {
          this.activeStreamReplies.set(sessionId, streamReply);
        }
        return;
      }

      // Downloadable media: file, image, video
      const mediaInfo = this.extractMediaInfo(frame.body);
      if (!mediaInfo) {
        console.warn(`[WeComBotService] No downloadable media found in ${msgtype} message from ${wecomUserId}`);
        return;
      }

      const { url, aesKey } = mediaInfo;
      const { buffer, filename: sdkFilename } = await conn.client.downloadFile(url, aesKey);

      // Determine filename with fallback
      const filename = sdkFilename ?? this.generateFallbackFilename(msgtype);

      // Determine user folder name
      const plaintextUserId = this.getPlaintextUserId(workspaceId, wecomUserId);
      const userFolderName = plaintextUserId ?? wecomUserId;

      // Save file to workspace
      const relativePath = await saveMediaFile(conn.folderPath, userFolderName, buffer, filename);

      // Look up or create session
      const sessionId = await this.getOrCreateSession(workspaceId, wecomUserId);
      if (!sessionId) return;

      const streamReply = await resolveStreamReplyIfNeeded(
        workspaceId,
        conn,
        frame,
        sessionId,
        wecomUserId,
        (card) => this.sendTemplateCard(workspaceId, wecomUserId, card),
        {
          onFinalized: () => this.activeStreamReplies.delete(sessionId),
          onCleanup: () => this.activeStreamReplies.delete(sessionId),
        },
      );
      const defaultFilePrompt = `a file named @${relativePath} uploaded by ${userFolderName}, if there is skill can process this file, process it with that skill, if no proper skill find, ask user how to handle it.`;
      const prompt = await this.resolveFilePrompt(workspaceId, relativePath, defaultFilePrompt);
      try {
        await chatService.pushMessage(sessionId, workspaceId, prompt, true, streamReply?.handler);
      } catch (err) {
        streamReply?.handler.cleanup();
        throw err;
      }
      if (streamReply) {
        this.activeStreamReplies.set(sessionId, streamReply);
      }
    } catch (err) {
      console.error(`[WeComBotService] Failed to handle ${msgtype} message from ${wecomUserId}:`, err);
      // Reply to the WeCom user with a failure message
      try {
        await conn.client.sendMessage(wecomUserId, {
          msgtype: 'markdown',
          markdown: { content: '⚠️ 文件处理失败，请稍后重试。' },
        });
      } catch (sendErr) {
        console.error('[WeComBotService] Failed to send error reply:', sendErr);
      }
    }
  }

  private extractMediaInfo(body: BaseMessage): { url: string; aesKey?: string } | null {
    if (body.file?.url) return { url: body.file.url, aesKey: body.file.aeskey };
    if (body.image?.url) return { url: body.image.url, aesKey: body.image.aeskey };
    if (body.video?.url) return { url: body.video.url, aesKey: body.video.aeskey };
    return null;
  }

  private generateFallbackFilename(msgtype: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19);
    const extMap: Record<string, string> = {
      image: 'png',
      video: 'mp4',
      file: 'bin',
    };
    const ext = extMap[msgtype] ?? 'bin';
    return `${msgtype}_${timestamp}.${ext}`;
  }

  private async resolveFilePrompt(
    workspaceId: string,
    relativePath: string,
    defaultPrompt: string,
  ): Promise<string> {
    const workspace = await workspaceStore.get(workspaceId);
    const template = workspace?.settings?.wecomFilePromptTemplate?.trim();
    if (!template) return defaultPrompt;
    return template.replace(/\$file_name\$/g, relativePath);
  }

  /**
   * Create a new WeCom session, register it in the user↔session mapping, mark it
   * the user's active session, and fire-and-forget refresh naming. Shared by the
   * normal-message path (getOrCreateSession) and the /clear,/new commands, so
   * both new-session creation paths stay identical.
   */
  private async instantiateWecomSession(
    workspaceId: string,
    wecomUserId: string,
    name: string,
    customTitle?: string,
  ): Promise<string> {
    const botId = this.workspaceIdToBotId.get(workspaceId) ?? undefined;
    const session = await chatService.createSession({
      workspaceId,
      name,
      source: 'wecom',
      customTitle,
      botId,
    });
    this.setActiveChannelSession(workspaceId, wecomUserId, session.id);

    const plaintextUserId = this.getPlaintextUserId(workspaceId, wecomUserId);
    if (plaintextUserId) {
      wecomSessionRenamer.renameSessionsForUser(workspaceId, wecomUserId).catch((err) => {
        console.error('[WeComBotService] Failed to rename sessions after creation:', err);
      });
    }
    return session.id;
  }

  private async getOrCreateSession(workspaceId: string, wecomUserId: string): Promise<string | null> {
    let sessionId = this.getActiveChannelSession(workspaceId, wecomUserId);

    if (sessionId) {
      const session = await chatService.getSession(sessionId, workspaceId);
      if (!session) {
        sessionId = null;
      }
    }

    if (!sessionId) {
      sessionId = await this.instantiateWecomSession(workspaceId, wecomUserId, wecomUserId);
    }

    return sessionId;
  }

  getWorkspaceIdByBotId(botId: string): string | undefined {
    return this.botIdToWorkspaceId.get(botId);
  }

  /**
   * Update an existing connection's workspace binding after the active workspace
   * has been changed through the API or another orchestrator. This is a
   * routing-only update: it does not persist the binding (that is BotService's
   * responsibility) and it does not re-authenticate the WeCom client.
   */
  async updateConnectionForBot(botId: string, workspaceId: string): Promise<void> {
    const conn = this.connections.get(botId);
    if (!conn) return;

    const previousWorkspaceId = this.botIdToWorkspaceId.get(botId);
    conn.workspaceId = workspaceId;
    this.botIdToWorkspaceId.set(botId, workspaceId);
    if (previousWorkspaceId) {
      this.workspaceIdToBotId.delete(previousWorkspaceId);
    }
    this.workspaceIdToBotId.set(workspaceId, botId);

    const workspace = await workspaceStore.get(workspaceId);
    if (workspace) {
      this.writeContextFile(workspace, conn.botId).catch((err) => {
        console.warn(`Failed to write WeCom context file for workspace ${workspaceId}:`, err);
      });
    }
  }

  async sendProactiveMessage(botId: string, toUser: string, message: string): Promise<void> {
    const workspaceId = this.botIdToWorkspaceId.get(botId);
    if (!workspaceId) {
      throw new Error(`Unknown bot ID: ${botId}`);
    }
    const conn = this.getConnectionForWorkspace(workspaceId);
    if (!conn || conn.status !== 'connected') {
      throw new Error(`Bot ${botId} is not connected`);
    }
    await conn.client.sendMessage(toUser, {
      msgtype: 'markdown',
      markdown: { content: message },
    });
  }

  async sendDirectMessage(
    workspaceId: string,
    toUser: string,
    message: string,
  ): Promise<void> {
    const conn = this.getConnectionForWorkspace(workspaceId);
    if (!conn || conn.status !== 'connected') {
      throw new Error(`Bot for workspace ${workspaceId} is not connected`);
    }
    // NOTE: The WeCom SDK's sendMessage only supports markdown for proactive sends.
    // We always send markdown regardless of the requested msgType.
    await conn.client.sendMessage(toUser, {
      msgtype: 'markdown',
      markdown: { content: message },
    });
  }

  async sendTemplateCard(workspaceId: string, toUser: string, card: TemplateCard): Promise<void> {
    const conn = this.getConnectionForWorkspace(workspaceId);
    if (!conn || conn.status !== 'connected') {
      return;
    }
    await conn.client.sendMessage(toUser, {
      msgtype: 'template_card',
      template_card: card,
    });
  }

  async sendFile(workspaceId: string, toUser: string, filePath: string, isAdmin = false): Promise<void> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    const conn = this.getConnectionForWorkspace(workspaceId);
    if (!conn || conn.status !== 'connected') {
      throw new Error(`Bot for workspace ${workspaceId} is not connected`);
    }

    const encryptedUserId = this.getChannelUserIdByPlaintext(toUser.trim());
    if (!encryptedUserId) {
      throw new Error(`WeCom user ID has not been decrypted yet. The recipient must send at least one message to the bot first.`);
    }

    const userFolderName = this.getPlaintextUserId(workspaceId, encryptedUserId) ?? encryptedUserId;

    const validation = validateSendFilePath(workspace.folderPath, userFolderName, filePath.trim(), isAdmin);
    if (!validation.allowed) {
      if (validation.reason === 'other-user-dir') {
        await conn.client.sendMessage(encryptedUserId, {
          msgtype: 'markdown',
          markdown: { content: 'unauthorized file access' },
        });
      }
      throw new Error(`File access denied: ${validation.reason}`);
    }

    const { absolutePath, relativePath } = validation;

    const stats = await fsPromises.stat(absolutePath);
    if (stats.size > MAX_SEND_FILE_SIZE_BYTES) {
      throw new Error(`File exceeds maximum send size of ${MAX_SEND_FILE_SIZE_BYTES} bytes`);
    }

    const buffer = await fsPromises.readFile(absolutePath);
    const md5 = createHash('md5').update(buffer).digest('hex');

    let mediaId: string;
    const cached = workspaceStore.getWecomMediaCacheEntry(workspaceId, relativePath, md5);
    if (cached) {
      mediaId = cached.mediaId;
    } else {
      const uploadResult = await conn.client.uploadMedia(buffer, {
        type: 'file',
        filename: path.basename(relativePath),
      });
      mediaId = uploadResult.media_id;
      const createdAt = new Date(uploadResult.created_at).toISOString();
      workspaceStore.createWecomMediaCacheEntry({
        workspaceId,
        relativePath,
        md5,
        filename: path.basename(relativePath),
        mediaId,
        createdAt,
      });
    }

    await conn.client.sendMediaMessage(encryptedUserId, 'file', mediaId);
  }

  private async handleTemplateCardEvent(
    workspaceId: string,
    frame: WsFrame<EventMessageWith<TemplateCardEventData>>,
  ): Promise<void> {
    if (!frame.body) return;
    const parsed = parseTemplateCardEvent(
      frame as unknown as WsFrame<{
        event: TemplateCardEventData;
        from?: { userid?: string };
      }>,
    );
    if (!parsed) return;
    diagLog(
      `[WeComBotService] recv template_card_event workspace=${workspaceId} from=${parsed.wecomUserId} action=${parsed.action} requestId=${parsed.requestId}`,
    );

    // Per-user per-request rate limit to absorb duplicate SDK deliveries.
    const now = Date.now();
    const rateLimitKey = `${parsed.wecomUserId}:${parsed.requestId}`;
    const last = this.cardClickRateLimit.get(rateLimitKey) ?? 0;
    if (now - last < 1000) return;
    this.cardClickRateLimit.set(rateLimitKey, now);

    // /workspace: bot Owner selects a new active workspace from the card.
    // Must branch before the session-ownership check because sessionId in the
    // decoded key is actually the botId for this action.
    if (parsed.action === 'select_workspace') {
      await this.handleWorkspaceSubmit(workspaceId, frame, parsed);
      return;
    }

    // Verify the clicking user owns the session.
    const ownerWecomUserId = this.getChannelUserIdBySession(parsed.sessionId);
    if (ownerWecomUserId !== parsed.wecomUserId) {
      await this.updateCardToTerminal(workspaceId, frame, parsed, '无法操作该会话');
      return;
    }

    // /resume: stateless session switch. No runtime or pending state — the
    // target sessionId is carried in the selected option id. Branched before the
    // runtime lookup because /resume has no in-flight turn.
    if (parsed.action === 'resume') {
      await this.handleResumeSubmit(workspaceId, frame, parsed);
      return;
    }

    const runtime = chatService.getRuntimeIfExists(parsed.sessionId);
    if (!runtime) {
      await this.updateCardToTerminal(workspaceId, frame, parsed, '会话已结束或已超时');
      return;
    }

    const pending = runtime.getPendingCardState(parsed.requestId);
    if (!pending) {
      await this.updateCardToTerminal(workspaceId, frame, parsed, '该请求已过期或已处理');
      return;
    }

    if (pending.type === 'approval') {
      // Fold the resolved permission into the streaming reply BEFORE the agent
      // resumes, so the receipt lands above the continuation in one bubble
      // (R1/R6). Redacted to tool name + outcome only (R3).
      const foldAction: PermissionFoldAction =
        parsed.action === 'deny' ? 'deny' : parsed.action === 'always_allow' ? 'always_allow' : 'allow';
      this.foldIntoActiveStream(
        parsed.sessionId,
        formatPermissionFold(pending.toolName ?? 'unknown', foldAction),
      );
      if (parsed.action === 'deny') {
        const toolName = pending.toolName ?? 'unknown';
        const toolUseId = pending.toolUseId ?? 'none';
        diagLog(`[WeComBotService] ask deny workspaceId=${workspaceId} sessionId=${parsed.sessionId} requestId=${parsed.requestId} tool=${toolName} toolUseId=${toolUseId} reason=user-deny`);
        runtime.resolveApproval(parsed.requestId, {
          behavior: 'deny',
          message: 'User denied this tool call.',
        });
        await this.updateCardToTerminal(workspaceId, frame, parsed, '已拒绝');
      } else {
        runtime.resolveApproval(parsed.requestId, {
          behavior: 'allow',
          updatedPermissions: parsed.action === 'always_allow' ? pending.suggestions : undefined,
        });
        await this.updateCardToTerminal(workspaceId, frame, parsed, parsed.action === 'always_allow' ? '已始终允许' : '已允许');
      }
      return;
    }

    // Question: parse selected options and resolve with answers. Fold the
    // resolved Q&A into the streaming reply BEFORE resuming the agent so the
    // answer sits above the continuation in one bubble (R1/R2/R6).
    const answers = this.buildAnswersFromCardEvent(parsed, pending.questions);
    this.foldIntoActiveStream(parsed.sessionId, formatQuestionFold(pending.questions, answers));
    runtime.resolveApproval(parsed.requestId, {
      behavior: 'allow',
      updatedInput: { questions: pending.questions, answers },
    });
    await this.updateCardToTerminal(workspaceId, frame, parsed, '已提交');
  }

  /**
   * Handle a `/resume` card submit: switch the user's active session to the
   * selected one. Stateless — the target sessionId is read from the selected
   * option id; no pending store is consulted. Mirrors feishu handleSelectSession
   * (ownership check on the TARGET session, then setActiveChannelSession).
   * Idempotent via setActiveChannelSession's transactional single-active invariant.
   */
  private async handleResumeSubmit(
    workspaceId: string,
    frame: WsFrame<EventMessageWith<TemplateCardEventData>>,
    parsed: {
      wecomUserId: string;
      cardType?: string;
      taskId?: string;
      selectedItems?: NormalizedSelectedItem[];
    },
  ): Promise<void> {
    const targetSessionId = parsed.selectedItems?.[0]?.option_ids?.[0];
    if (typeof targetSessionId !== 'string' || targetSessionId.length === 0) {
      await this.updateCardToTerminal(workspaceId, frame, parsed, '无法操作该会话');
      return;
    }

    // Verify the submitter owns the TARGET session (not just the card's source).
    const ownsTarget = verifySessionOwner(
      parsed.wecomUserId,
      targetSessionId,
      workspaceId,
      (_ws, sess) => this.getChannelUserIdBySession(sess),
    );
    if (!ownsTarget) {
      await this.updateCardToTerminal(workspaceId, frame, parsed, '无法操作该会话');
      return;
    }

    try {
      this.setActiveChannelSession(workspaceId, parsed.wecomUserId, targetSessionId);
    } catch (err) {
      console.error('[WeComBotService] failed to switch session via /resume:', err);
      await this.updateCardToTerminal(workspaceId, frame, parsed, '无法操作该会话');
      return;
    }

    // Update the card to its terminal state FIRST. WeCom only honors a card-update
    // response within ~5s of the template_card_event; getSession/sendMessage below
    // can exceed that window and leave the card interactive (re-clickable).
    await this.updateCardToTerminal(workspaceId, frame, parsed, '已恢复会话');

    // Confirmation message (best-effort, after the card is updated). A failure
    // here must not flip the already-updated card to an error state.
    try {
      const conn = this.getConnectionForWorkspace(workspaceId);
      const session = await chatService.getSession(targetSessionId, workspaceId);
      const title = session?.customTitle ?? session?.name ?? targetSessionId;
      if (conn && conn.status === 'connected') {
        await conn.client.sendMessage(parsed.wecomUserId, {
          msgtype: 'markdown',
          markdown: { content: `已切换到会话：【${title}】，可继续对话` },
        });
      }
    } catch (err) {
      console.error('[WeComBotService] failed to send /resume confirmation:', err);
    }
  }

  /**
   * Handle a `/workspace` card submit: verify the caller is the bot Owner and
   * switch the bot's active workspace. The selected workspaceId is carried in the
   * option id; the decoded sessionId is the botId.
   */
  private async handleWorkspaceSubmit(
    workspaceId: string,
    frame: WsFrame<EventMessageWith<TemplateCardEventData>>,
    parsed: {
      wecomUserId: string;
      sessionId: string;
      cardType?: string;
      taskId?: string;
      selectedItems?: NormalizedSelectedItem[];
    },
  ): Promise<void> {
    const botId = parsed.sessionId;
    const targetWorkspaceId = parsed.selectedItems?.[0]?.option_ids?.[0];

    if (typeof targetWorkspaceId !== 'string' || targetWorkspaceId.length === 0) {
      await this.updateCardToTerminal(workspaceId, frame, parsed, '缺少工作空间信息');
      return;
    }

    if (botService.getMemberRole(botId, 'wecom', parsed.wecomUserId) !== 'owner') {
      await this.updateCardToTerminal(workspaceId, frame, parsed, '你没有权限切换工作空间');
      return;
    }

    const workspace = await workspaceStore.get(targetWorkspaceId);
    // Update the card to terminal BEFORE changing routing maps: after the switch
    // getConnectionForWorkspace(workspaceId) would no longer resolve the
    // original workspace connection, and WeCom only honors updates within ~5s.
    await this.updateCardToTerminal(
      workspaceId,
      frame,
      parsed,
      `已切换到工作空间：${workspace?.name ?? targetWorkspaceId}`,
    );
    await this.switchActiveWorkspace(botId, targetWorkspaceId, parsed.wecomUserId);
  }

  /**
   * Fold a resolved card receipt (question answer or permission outcome) into
   * the session's active streaming reply so the receipt and the agent's
   * continuation share one bubble (R1/R6). Appends WITHOUT finalizing the
   * stream. No-ops when the text is empty, when there is no active stream for
   * the session (turn already finalized, replaced by a newer turn, or past the
   * 9-minute safeguard), or when the append itself reports the passive reply is
   * closed — in all those cases the card still flips terminal and, if the
   * passive reply is closed, the result is delivered proactively as usual.
   */
  private foldIntoActiveStream(sessionId: string, text: string): void {
    if (!text || !text.trim()) return;
    const stream = this.activeStreamReplies.get(sessionId);
    if (!stream) return;
    stream.appendNarrative(text);
  }

  private buildAnswersFromCardEvent(
    parsed: { requestId: string; selectedItems?: NormalizedSelectedItem[] },
    questions: QuestionPayload[],
  ): Record<string, string> {
    const answers: Record<string, string> = {};

    for (const item of parsed.selectedItems ?? []) {
      if (!item.question_key || !Array.isArray(item.option_ids)) continue;
      const decoded = decodeButtonKey(item.question_key);
      if (!decoded) continue;

      // The question key encodes either `requestId` (single-question vote) or
      // `requestId:qIdx` (multiple-interaction). Verify it belongs to this request.
      const [baseRequestId, qIdxStr] = decoded.requestId.split(':');
      if (baseRequestId !== parsed.requestId) continue;
      const qIdx = qIdxStr === undefined ? 0 : Number(qIdxStr);
      if (!Number.isFinite(qIdx) || qIdx < 0 || qIdx >= questions.length) continue;

      const question = questions[qIdx];
      const labels: string[] = [];
      for (const optId of item.option_ids) {
        const opt = question.options[Number(optId)];
        if (opt) labels.push(opt.label);
      }
      if (labels.length > 0) {
        answers[question.question] = labels.join(', ');
      }
    }

    return answers;
  }

  private async updateCardToTerminal(
    workspaceId: string,
    frame: WsFrame<EventMessageWith<TemplateCardEventData>>,
    parsed: { cardType?: string; taskId?: string },
    notice: string,
  ): Promise<void> {
    const conn = this.getConnectionForWorkspace(workspaceId);
    if (!conn || conn.status !== 'connected' || !frame.body) return;

    const card = buildTerminalCard(parsed.cardType ?? 'button_interaction', notice, parsed.taskId);
    try {
      await conn.client.updateTemplateCard({ headers: frame.headers }, card);
    } catch (err) {
      console.error('[WeComBotService] Failed to update template card:', err);
    }
  }

  private getContextFilePath(workspace: Workspace): string {
    return path.join(workspace.folderPath, '.claude', 'wecom-context.json');
  }

  private async writeContextFile(workspace: Workspace, botId: string): Promise<void> {
    if (!this.serverUrl) return;
    const filePath = this.getContextFilePath(workspace);
    const dir = path.dirname(filePath);
    const resolvedDir = path.resolve(dir);
    const resolvedBase = path.resolve(workspace.folderPath);
    if (!resolvedDir.startsWith(resolvedBase)) {
      throw new Error('Context file path is outside workspace directory');
    }
    try {
      await fsPromises.mkdir(dir, { recursive: true });
    } catch {
      // ignore
    }
    const content = JSON.stringify({ workspaceId: workspace.id, botId, serverUrl: this.serverUrl }, null, 2);
    await fsPromises.writeFile(filePath, content, 'utf-8');
  }

  private async removeContextFile(workspaceId: string): Promise<void> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) return;
    const filePath = this.getContextFilePath(workspace);
    const resolvedFile = path.resolve(filePath);
    const resolvedBase = path.resolve(workspace.folderPath);
    if (!resolvedFile.startsWith(resolvedBase)) {
      return;
    }
    try {
      await fsPromises.unlink(filePath);
    } catch {
      // ignore
    }
  }

  private async cleanupStaleContextFiles(): Promise<void> {
    const workspaces = await workspaceStore.list();
    for (const ws of workspaces) {
      const filePath = this.getContextFilePath(ws);
      const resolvedFile = path.resolve(filePath);
      const resolvedBase = path.resolve(ws.folderPath);
      if (!resolvedFile.startsWith(resolvedBase)) {
        continue;
      }
      let exists = false;
      try {
        await fsPromises.access(filePath);
        exists = true;
      } catch {
        continue;
      }
      if (!exists) continue;
      const botId = ws.settings.wecomBotId;
      if (!botId || !this.botIdToWorkspaceId.has(botId)) {
        try {
          await fsPromises.unlink(filePath);
          console.log(`Cleaned up stale WeCom context file for workspace ${ws.id}`);
        } catch (err) {
          console.warn(`Failed to clean up stale context file for workspace ${ws.id}:`, err);
        }
      }
    }
  }

}

export const wecomBotService = new WeComBotService();
