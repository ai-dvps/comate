import { Chat } from 'chat';
import { createMemoryState } from '@chat-adapter/state-memory';
import { createLarkAdapter, type LarkAdapter, type LarkAdapterConfig } from '@larksuite/vercel-chat-adapter';
import * as lark from '@larksuiteoapi/node-sdk';
import type { Thread, Message, DirectMessageHandler, MentionHandler, ActionEvent } from 'chat';
import type { SseEvent } from '../types/message.js';
import type { Workspace } from '../models/workspace.js';
import type { Bot } from '../models/bot.js';
import type { ChatSession } from '../models/session.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { botService } from './bot-service.js';
import { chatService } from './chat-service.js';
import { SAFE_PRESET } from './tool-permission-policy.js';
import { createFeishuSessionForUser } from './feishu-session-helpers.js';
import { FeishuStreamReply, type FeishuStreamReplyHandle } from './feishu-stream-reply.js';
import {
  buildWorkspaceListCard,
  buildSessionListCard,
  buildDisabledSessionListCard,
  buildSessionListFormElement,
  SESSION_FORM_ELEMENT_ID,
  type FeishuCard,
} from './feishu-card-builder.js';
import { feishuCardActionHandler, type CardActionPayload } from './feishu-card-action-handler.js';
import { feishuUserResolver } from './feishu-user-resolver.js';
import { diagLog } from '../utils/diag-logger.js';
import { sendPlainTextMessage } from './feishu-message-utils.js';
import { randomUUID } from 'crypto';

export type FeishuBotStatus =
  | 'not_configured'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

interface Connection {
  chat: Chat;
  adapter: LarkAdapter;
  larkClient: lark.Client;
  workspaceId: string;
  botId: string;
  status: FeishuBotStatus;
}

export class FeishuBotService {
  private connections = new Map<string, Connection>();
  private activeBotId: string | null = null;
  private workspaceIdToBotId = new Map<string, string>();
  private botIdToWorkspaceId = new Map<string, string>();
  private userQueues = new Map<string, Promise<unknown>>();
  private sessionListCardIds = new Map<string, string>();
  private cardUpdateSequences = new Map<string, number>();
  private pendingCardActionResponses = new Map<string, unknown>();
  private activeStreamReplies = new Map<string, FeishuStreamReplyHandle>();

  async initialize(): Promise<void> {
    const feishuBots = botService.listBots().filter((b) => b.providerSettings.feishu?.enabled);

    if (feishuBots.length > 0) {
      const storedActiveWorkspaceId = workspaceStore.getFeishuActiveWorkspace();
      const activeBot =
        feishuBots.find((b) => b.activeWorkspaceId === storedActiveWorkspaceId) ?? feishuBots[0];
      await this.connectBot(activeBot);
      return;
    }

    // Pre-migration fallback: connect the workspace stored in the global binding.
    const activeWorkspaceId = workspaceStore.getFeishuActiveWorkspace();
    if (!activeWorkspaceId) {
      diagLog('[FeishuBotService] no active workspace binding on startup');
      return;
    }

    const workspace = await workspaceStore.get(activeWorkspaceId);
    if (!workspace || !this.isFeishuEnabled(workspace)) {
      workspaceStore.clearFeishuActiveWorkspace();
      diagLog('[FeishuBotService] cleared stale active workspace binding');
      return;
    }

    await this.connect(workspace);
  }

  async connectBot(bot: Bot): Promise<void> {
    this.disconnectBot(bot.id);

    const feishu = bot.providerSettings.feishu;
    const appId = feishu?.appId?.trim();
    const appSecret = feishu?.appSecret?.trim();
    if (!appId || !appSecret) {
      diagLog(`[FeishuBotService] bot ${bot.id} missing Feishu credentials`);
      return;
    }

    const workspace = bot.activeWorkspaceId ? await workspaceStore.get(bot.activeWorkspaceId) : null;
    const workspaceId = bot.activeWorkspaceId ?? '';

    const larkClient = new lark.Client({
      appId,
      appSecret,
      appType: lark.AppType.SelfBuild,
    });

    const adapter = createLarkAdapter({
      appId,
      appSecret,
      channelFactory: (((opts: lark.LarkChannelOptions) =>
        lark.createLarkChannel({ ...opts, includeRawEvent: true })) as unknown as NonNullable<
        LarkAdapterConfig['channelFactory']
      >),
    });
    const chat = new Chat({
      adapters: { lark: adapter },
      state: createMemoryState(),
      userName: 'Comate',
      logger: 'silent',
    });

    const handler = this.createDispatchHandler();
    chat.onDirectMessage(handler);
    chat.onNewMention(handler);
    chat.onAction((event) => this.handleCardAction(event));

    const connection: Connection = {
      chat,
      adapter,
      larkClient,
      workspaceId,
      botId: bot.id,
      status: 'connecting',
    };
    this.connections.set(bot.id, connection);
    this.activeBotId = bot.id;
    if (workspaceId) {
      this.workspaceIdToBotId.set(workspaceId, bot.id);
      this.botIdToWorkspaceId.set(bot.id, workspaceId);
    }

    try {
      await chat.initialize();
      if (workspace) {
        this.registerWSMenuHandler(adapter, workspace, larkClient);
      }
      this.registerWSCardActionResponseHandler(adapter);
      if (workspace) {
        workspaceStore.setFeishuActiveWorkspace(workspace.id);
      }
      connection.status = 'connected';
      diagLog(`[FeishuBotService] connected bot ${bot.id} for workspace ${workspaceId}`);
    } catch (err) {
      connection.status = 'error';
      console.error(`[FeishuBotService] failed to initialize bot ${bot.id}:`, err);
    }
  }

  /** Backward-compatible workspace-scoped connect (pre-migration). */
  async connect(workspace: Workspace): Promise<void> {
    const bot: Bot = {
      id: workspace.settings.feishuAppId!,
      name: workspace.name,
      activeWorkspaceId: workspace.id,
      providerSettings: {
        feishu: {
          enabled: workspace.settings.feishuBotEnabled,
          appId: workspace.settings.feishuAppId,
          appSecret: workspace.settings.feishuAppSecret,
          encryptKey: workspace.settings.feishuEncryptKey,
          verificationToken: workspace.settings.feishuVerificationToken,
        },
      },
      rolePolicy: {
        normalToolPolicy: SAFE_PRESET,
        skillAllowlist: [],
        bashWhitelist: [],
      },
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
    await this.connectBot(bot);
  }

  private getActiveConnection(): Connection | null {
    return this.activeBotId ? this.connections.get(this.activeBotId) ?? null : null;
  }

  private getBotIdForWorkspace(workspaceId: string): string | undefined {
    return this.workspaceIdToBotId.get(workspaceId) ?? this.activeBotId ?? undefined;
  }

  /**
   * Lark WS dispatcher. This covers Feishu apps that use long-connection event
   * subscription instead of the HTTP callback route.
   */
  private registerWSMenuHandler(
    adapter: LarkAdapter,
    workspace: Workspace,
    larkClient: lark.Client,
  ): void {
    const channel = (adapter as unknown as { _getChannel?: () => lark.LarkChannel | null })._getChannel?.();
    if (!channel) {
      diagLog('[FeishuBotService] cannot register menu handler: underlying LarkChannel unavailable');
      return;
    }
    const dispatcher = (channel as unknown as { dispatcher?: lark.EventDispatcher }).dispatcher;
    if (!dispatcher) {
      diagLog('[FeishuBotService] cannot register menu handler: LarkChannel dispatcher unavailable');
      return;
    }
    diagLog('[FeishuBotService] registering application.bot.menu_v6 handler on WS dispatcher');
    dispatcher.register({
      'application.bot.menu_v6': async (data: Record<string, unknown>) => {
        const { openId, eventKey } = this.extractMenuEvent(data);
        diagLog(
          `[FeishuBotService] ws menu_v6 received openId=${openId || '(missing)'} key=${(eventKey ?? '').slice(0, 40)}`,
        );
        try {
          await this.handleMenuEvent(larkClient, workspace, openId, eventKey);
        } catch (err) {
          console.error('[FeishuBotService] ws menu handler error:', err);
        }
      },
    });
  }

  /**
   * Wrap the Lark SDK dispatcher's card.action.trigger handler so the WebSocket
   * response includes the updated card. The chat adapter's handler returns
   * nothing, which makes the Lark SDK reply with `{ code: 200 }` and no data;
   * Feishu then re-renders the original card and re-enables the form. By
   * returning the disabled card in the response we keep the UI in sync with the
   * submitted state.
   */
  private registerWSCardActionResponseHandler(adapter: LarkAdapter): void {
    const channel = (adapter as unknown as { _getChannel?: () => lark.LarkChannel | null })._getChannel?.();
    if (!channel) {
      diagLog('[FeishuBotService] cannot register card action response handler: underlying LarkChannel unavailable');
      return;
    }
    const dispatcher = (channel as unknown as { dispatcher?: lark.EventDispatcher }).dispatcher;
    if (!dispatcher) {
      diagLog('[FeishuBotService] cannot register card action response handler: LarkChannel dispatcher unavailable');
      return;
    }
    const handles = (dispatcher as unknown as { handles?: Map<string, (data: unknown) => Promise<unknown> | unknown> }).handles;
    if (!handles) {
      diagLog('[FeishuBotService] cannot register card action response handler: dispatcher handles unavailable');
      return;
    }
    const originalHandler = handles.get('card.action.trigger');
    if (!originalHandler) {
      diagLog('[FeishuBotService] no existing card.action.trigger handler to wrap');
      return;
    }

    diagLog('[FeishuBotService] wrapping card.action.trigger handler to return disabled card response');
    handles.set('card.action.trigger', async (raw: unknown) => {
      try {
        await originalHandler(raw);
      } catch (err) {
        console.error('[FeishuBotService] card action handler error:', err);
        return {};
      }

      const messageId = this.extractCardActionMessageId(raw);
      if (!messageId) {
        return {};
      }
      const response = this.pendingCardActionResponses.get(messageId);
      this.pendingCardActionResponses.delete(messageId);
      return response ?? {};
    });
  }

  /** Extract operator open_id and event_key from an application.bot.menu_v6 payload. */
  private extractMenuEvent(data: Record<string, unknown>): { openId: string; eventKey: string | undefined } {
    const operator = data.operator as { operator_id?: { open_id?: string } } | undefined;
    const openId = operator?.operator_id?.open_id ?? '';
    const eventKey = typeof data.event_key === 'string' ? data.event_key : undefined;
    return { openId, eventKey };
  }

  private extractCardActionMessageId(raw: unknown): string | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const record = raw as Record<string, unknown>;
    const context = record.context as Record<string, unknown> | undefined;
    const fromContext = context?.open_message_id;
    if (typeof fromContext === 'string') return fromContext;
    const fromRoot = record.open_message_id;
    if (typeof fromRoot === 'string') return fromRoot;
    return undefined;
  }

  disconnectBot(botId: string): void {
    const connection = this.connections.get(botId);
    if (!connection) return;

    this.connections.delete(botId);
    this.workspaceIdToBotId.delete(connection.workspaceId);
    this.botIdToWorkspaceId.delete(botId);
    if (this.activeBotId === botId) {
      this.activeBotId = null;
      workspaceStore.clearFeishuActiveWorkspace();
    }

    connection.chat
      .shutdown()
      .then(() => {
        diagLog(`[FeishuBotService] disconnected bot ${botId} from workspace ${connection.workspaceId}`);
      })
      .catch((err) => {
        console.error(`[FeishuBotService] error during shutdown of bot ${botId}:`, err);
      });
  }

  /** Disconnect the currently active bot (backward-compatible pre-migration). */
  disconnect(): void {
    if (this.activeBotId) {
      this.disconnectBot(this.activeBotId);
      return;
    }
    // Fallback: disconnect any remaining connection keyed by workspaceId.
    const fallback = Array.from(this.connections.values())[0];
    if (fallback) {
      this.disconnectBot(fallback.botId);
    }
  }

  getBotStatus(botId: string): FeishuBotStatus {
    const connection = this.connections.get(botId);
    return connection?.status ?? 'not_configured';
  }

  getStatus(workspaceId: string): FeishuBotStatus {
    const botId = this.workspaceIdToBotId.get(workspaceId);
    if (!botId) return 'not_configured';
    return this.getBotStatus(botId);
  }

  async reconnectIfActive(workspaceId: string): Promise<void> {
    const botId = this.workspaceIdToBotId.get(workspaceId);
    if (!botId) return;

    const connection = this.connections.get(botId);
    if (!connection) return;

    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace || !this.isFeishuEnabled(workspace)) {
      this.disconnectBot(botId);
      return;
    }

    const bot = botService.getBot(botId);
    if (bot) {
      await this.connectBot(bot);
    } else {
      await this.connect(workspace);
    }
  }

  /**
   * Set the active workspace binding and update routing.
   *
   * - When called from a card callback, `botId` and `actorUserId` are provided and
   *   the switch is persisted through `BotService` after an Owner check.
   * - When called from reconnect/fallback paths, only `workspaceId` is provided;
   *   the first bound bot or workspace-embedded config is used.
   */
  async setActiveWorkspace(
    workspaceId: string,
    botId?: string,
    actorUserId?: string,
  ): Promise<void> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace || !this.isFeishuEnabled(workspace)) {
      workspaceStore.clearFeishuActiveWorkspace();
      this.disconnect();
      return;
    }

    let bot: Bot | null = null;
    if (botId) {
      bot = botService.getBot(botId);
    }
    if (!bot) {
      const boundBots = botService.listBotsForWorkspace(workspaceId).filter((b) => b.providerSettings.feishu?.enabled);
      bot = boundBots[0] ?? this.botFromWorkspace(workspace);
    }
    if (!bot) {
      workspaceStore.clearFeishuActiveWorkspace();
      this.disconnect();
      return;
    }

    if (botId && actorUserId) {
      botService.setActiveWorkspace(botId, workspaceId, {
        type: 'feishu',
        provider: 'feishu',
        providerUserId: actorUserId,
      });
    }

    const previousWorkspaceId = this.botIdToWorkspaceId.get(bot.id);
    const existingConnection = this.connections.get(bot.id);
    if (existingConnection) {
      existingConnection.workspaceId = workspaceId;
      this.activeBotId = bot.id;
      if (previousWorkspaceId) {
        this.workspaceIdToBotId.delete(previousWorkspaceId);
      }
      this.workspaceIdToBotId.set(workspaceId, bot.id);
      this.botIdToWorkspaceId.set(bot.id, workspaceId);
      workspaceStore.setFeishuActiveWorkspace(workspaceId);
      diagLog(`[FeishuBotService] switched bot ${bot.id} to workspace ${workspaceId}`);
    } else {
      await this.connectBot(bot);
      return;
    }

    if (previousWorkspaceId && previousWorkspaceId !== workspaceId) {
      const users = workspaceStore.listFeishuWorkspaceUsers(previousWorkspaceId);
      const message = `当前机器人已切换到工作空间“${workspace.name}”。你正在进行的任务仍在原工作空间继续。`;
      for (const user of users) {
        this.sendProactiveMessage(bot.id, user.openId, message).catch((err) => {
          diagLog(
            `[FeishuBotService] failed to notify user ${user.openId} of workspace switch:`,
            err,
          );
        });
      }
    }
  }

  /**
   * Update an existing Feishu connection's workspace binding after the active
   * workspace has been changed through the API or another orchestrator. This is
   * a routing-only update: it does not persist the binding and does not create
   * a new Lark client.
   */
  async updateConnectionForBot(botId: string, workspaceId: string): Promise<void> {
    const connection = this.connections.get(botId);
    if (!connection) return;

    const previousWorkspaceId = this.botIdToWorkspaceId.get(botId);
    connection.workspaceId = workspaceId;
    this.activeBotId = botId;
    if (previousWorkspaceId) {
      this.workspaceIdToBotId.delete(previousWorkspaceId);
    }
    this.workspaceIdToBotId.set(workspaceId, botId);
    this.botIdToWorkspaceId.set(botId, workspaceId);
    workspaceStore.setFeishuActiveWorkspace(workspaceId);
  }

  /** Best-effort send a plain-text DM via a bot connection. */
  private async sendProactiveMessage(botId: string, openId: string, message: string): Promise<void> {
    const connection = this.connections.get(botId);
    if (!connection?.larkClient) return;
    await sendPlainTextMessage(connection.larkClient, openId, message);
  }

  /** Build an ephemeral Bot from a workspace's embedded Feishu config. */
  private botFromWorkspace(workspace: Workspace): Bot | null {
    const appId = workspace.settings.feishuAppId?.trim();
    const appSecret = workspace.settings.feishuAppSecret?.trim();
    if (!appId || !appSecret) return null;
    return {
      id: appId,
      name: workspace.name,
      activeWorkspaceId: workspace.id,
      providerSettings: {
        feishu: {
          enabled: workspace.settings.feishuBotEnabled,
          appId,
          appSecret,
          encryptKey: workspace.settings.feishuEncryptKey,
          verificationToken: workspace.settings.feishuVerificationToken,
        },
      },
      rolePolicy: {
        normalToolPolicy: SAFE_PRESET,
        skillAllowlist: [],
        bashWhitelist: [],
      },
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
  }

  /**
   * Handle a Feishu bot menu event (`application.bot.menu_v6`).
   *
   * Menu events arrive without a chat-SDK `Thread`, so this entry point takes an
   * explicit `larkClient` (built from the workspace's credentials) and sends all
   * responses to the operator's DM. `openId` (from
   * `operator.operator_id.open_id`) is the trusted identity anchor; all session
   * lookups and creation are scoped to it.
   */
  async handleMenuEvent(
    larkClient: lark.Client,
    workspace: Workspace,
    openId: string,
    eventKey: string | undefined,
  ): Promise<void> {
    const rawKey = (eventKey ?? '').trim();
    const key = this.normalizeMenuEventKey(rawKey);
    diagLog(
      `[FeishuBotService] menu event from=${openId || '(missing)'} rawKey="${rawKey}" normalizedKey="${key}" workspace=${workspace.id}`,
    );

    if (!openId) {
      diagLog('[FeishuBotService] menu event ignored: missing operator open_id');
      return;
    }

    // Defensive: guard against the binding being cleared/disabled between
    // dispatch and handling.
    if (!this.isFeishuEnabled(workspace)) {
      diagLog(`[FeishuBotService] menu event: workspace ${workspace.id} not feishu-enabled`);
      await this.sendMenuText(larkClient, openId, '⚠️ 当前工作空间未启用飞书机器人。');
      return;
    }

    if (key !== 'resume' && key !== 'new' && key !== 'clear' && key !== 'stop') {
      diagLog(`[FeishuBotService] menu event: unknown normalizedKey="${key}" (rawKey="${rawKey}")`);
      await this.sendMenuText(larkClient, openId, '⚠️ 未知的菜单操作。');
      return;
    }

    diagLog(`[FeishuBotService] menu event: processing normalizedKey="${key}" for ${openId}`);
    await this.runForUser(openId, async () => {
      if (key === 'resume') {
        diagLog(`[FeishuBotService] menu event: sending session-list card for ${openId}`);
        await this.sendSessionListCard(larkClient, workspace, openId);
      } else if (key === 'stop') {
        diagLog(`[FeishuBotService] menu event: stopping turn for ${openId}`);
        await this.handleMenuStopCommand(larkClient, workspace, openId);
      } else {
        diagLog(`[FeishuBotService] menu event: creating new session for ${openId}`);
        await this.createAndNotifyNewSession(larkClient, workspace, openId);
      }
      diagLog(`[FeishuBotService] menu event: completed normalizedKey="${key}" for ${openId}`);
    });
  }

  /** Strip a leading slash so menu keys configured as "/resume" match "resume". */
  private normalizeMenuEventKey(key: string): string {
    return key.startsWith('/') ? key.slice(1) : key;
  }

  /** Recognize /new, /new <title>, /clear, /clear <title> as new-session commands. */
  private isNewSessionCommand(text: string): boolean {
    return text === '/new' || text.startsWith('/new ') || text === '/clear' || text.startsWith('/clear ');
  }

  private isFeishuEnabled(workspace: Workspace): boolean {
    // In the decoupled bot architecture, Feishu is enabled at the bot level.
    // Keep the legacy workspace flag as a fallback for pre-migration setups.
    if (workspace.settings.feishuBotEnabled) return true;
    return botService.listBotsForWorkspace(workspace.id).some((b) => b.providerSettings.feishu?.enabled);
  }

  private createDispatchHandler(): DirectMessageHandler & MentionHandler {
    return async (thread: Thread, message: Message) => {
      if (!thread.isDM) return;

      const feishuUserId = message.author.userId;
      const text = (message.text ?? '').trim();

      const workspaceId = this.getActiveConnection()?.workspaceId;
      if (workspaceId) {
        workspaceStore.setFeishuWorkspaceUser(workspaceId, feishuUserId);
        void feishuUserResolver.resolveOnMessage(workspaceId, feishuUserId, this.getActiveConnection()!.larkClient);
      }

      diagLog(
        `[FeishuBotService] dispatch from=${feishuUserId} text=${text.slice(0, 80)} threadId=${thread.id}`,
      );

      try {
        if (text === '/workspace') {
          await this.runForUser(feishuUserId, () => this.handleWorkspaceCommand(thread, feishuUserId));
        } else if (text === '/resume') {
          await this.runForUser(feishuUserId, () => this.handleSessionCommand(thread, feishuUserId));
        } else if (text === '/stop') {
          await this.runForUser(feishuUserId, () => this.handleStopCommand(thread, feishuUserId));
        } else if (this.isNewSessionCommand(text)) {
          await this.runForUser(feishuUserId, () => this.handleNewSessionCommand(thread, feishuUserId, text));
        } else {
          await this.runForUser(feishuUserId, () => this.handleChatMessage(thread, feishuUserId, text));
        }
      } catch (err) {
        console.error('[FeishuBotService] dispatch error:', err);
        await this.safePostText(thread, '⚠️ 处理消息时出错，请稍后重试。');
      }
    };
  }

  private async runForUser(feishuUserId: string, task: () => Promise<unknown>): Promise<void> {
    const previous = this.userQueues.get(feishuUserId) ?? Promise.resolve();
    const next = previous.then(task).catch((err) => {
      console.error(`[FeishuBotService] user queue error for ${feishuUserId}:`, err);
    });
    this.userQueues.set(feishuUserId, next);
    await next;
  }

  private async handleCardAction(event: ActionEvent): Promise<void> {
    diagLog(
      `[FeishuBotService] card action actionId=${event.actionId} user=${event.user.userId} value=${event.value?.slice(0, 200) ?? ''}`,
    );

    const payload = this.parseCardActionValue(event.value);
    if (!this.isCardActionPayload(payload)) {
      diagLog('[FeishuBotService] card action value missing or unparseable');
      await this.safePostActionResponse(event, '无法解析卡片操作。');
      return;
    }

    let resolvedSessionId: string | undefined;
    if (payload.action === 'select_session') {
      resolvedSessionId = this.resolveSessionId(payload, event);
      if (!resolvedSessionId) {
        diagLog('[FeishuBotService] select_session missing sessionId in form_value');
        await this.safePostActionResponse(event, '无法解析会话选择。');
        return;
      }
      payload.sessionId = resolvedSessionId;
    }

    try {
      const result = await feishuCardActionHandler.handle(event.user.userId, payload, {
        setActiveWorkspace: (workspaceId: string, botId: string, actorUserId: string) =>
          this.setActiveWorkspace(workspaceId, botId, actorUserId),
      });
      const content = this.extractToastContent(result);
      if (content) {
        await this.safePostActionResponse(event, content);
      }
      if (payload.action === 'select_session' && this.isSuccessToast(result)) {
        const response = await this.buildSelectSessionActionResponse(
          event.messageId,
          payload.workspaceId,
          event.user.userId,
        );
        this.pendingCardActionResponses.set(event.messageId, response);
        await this.patchSessionListCardInactive(event.messageId, payload.workspaceId, event.user.userId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      diagLog(`[FeishuBotService] card action handler error: ${message}`);
      await this.safePostActionResponse(event, '处理操作失败，请稍后重试。');
    }
  }

  private resolveSessionId(
    payload: CardActionPayload,
    event: ActionEvent,
  ): string | undefined {
    if (payload.sessionId) return payload.sessionId;
    const formValue = this.extractFormValue(event);
    const sessionId = formValue?.sessionId;
    return typeof sessionId === 'string' ? sessionId : undefined;
  }

  private extractFormValue(event: ActionEvent): Record<string, unknown> | undefined {
    const raw = event.raw;
    if (!raw || typeof raw !== 'object') return undefined;
    const nested = (raw as Record<string, unknown>).raw;
    if (!nested || typeof nested !== 'object') return undefined;
    const action = (nested as Record<string, unknown>).action;
    if (!action || typeof action !== 'object') return undefined;
    return (action as Record<string, unknown>).form_value as Record<string, unknown> | undefined;
  }

  private getToast(result: unknown): Record<string, unknown> | undefined {
    if (!result || typeof result !== 'object' || !('toast' in result)) return undefined;
    const toast = (result as Record<string, unknown>).toast;
    return toast && typeof toast === 'object' ? (toast as Record<string, unknown>) : undefined;
  }

  private isSuccessToast(result: unknown): boolean {
    return this.getToast(result)?.type === 'success';
  }

  private async patchSessionListCardInactive(
    messageId: string,
    workspaceId: string,
    openId: string,
  ): Promise<void> {
    const larkClient = this.getActiveConnection()?.larkClient;
    if (!larkClient) return;

    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) return;

    const cardId = this.sessionListCardIds.get(messageId);
    if (!cardId) {
      diagLog(`[FeishuBotService] no cardId tracked for message=${messageId}, falling back to message patch`);
      await this.patchSessionListCardInactiveByMessage(messageId, workspace, openId);
      return;
    }

    const sessions = await this.collectSessionList(workspace, openId);
    if (sessions.length === 0) return;

    const form = buildSessionListFormElement(sessions, true);

    try {
      await larkClient.cardkit.v1.cardElement.update({
        path: { card_id: cardId, element_id: SESSION_FORM_ELEMENT_ID },
        data: {
          element: JSON.stringify(form),
          sequence: this.nextCardUpdateSequence(cardId),
          uuid: randomUUID(),
        },
      });
      diagLog(`[FeishuBotService] updated session-list card form disabled for card=${cardId}`);
    } catch (err) {
      diagLog(
        `[FeishuBotService] failed to update session-list card form: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async patchSessionListCardInactiveByMessage(
    messageId: string,
    workspace: Workspace,
    openId: string,
  ): Promise<void> {
    const larkClient = this.getActiveConnection()?.larkClient;
    if (!larkClient) return;

    const sessions = await this.collectSessionList(workspace, openId);
    const card = buildDisabledSessionListCard(workspace.name, sessions);

    try {
      await larkClient.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
      diagLog(`[FeishuBotService] patched session-list card inactive for message=${messageId}`);
    } catch (err) {
      diagLog(`[FeishuBotService] failed to patch session-list card: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async buildSelectSessionActionResponse(
    messageId: string,
    workspaceId: string,
    openId: string,
  ): Promise<unknown> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      diagLog(`[FeishuBotService] cannot build action response: workspace ${workspaceId} not found`);
      return {};
    }
    const sessions = await this.collectSessionList(workspace, openId);
    const disabledCard = buildDisabledSessionListCard(workspace.name, sessions);
    return {
      toast: {
        type: 'success',
        content: '会话已切换。',
      },
      card: {
        type: 'raw',
        data: disabledCard,
      },
    };
  }

  private nextCardUpdateSequence(cardId: string): number {
    const next = (this.cardUpdateSequences.get(cardId) ?? 0) + 1;
    this.cardUpdateSequences.set(cardId, next);
    return next;
  }

  private parseCardActionValue(raw: unknown): Record<string, unknown> | null {
    if (raw && typeof raw === 'object') {
      return raw as Record<string, unknown>;
    }
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // ignore malformed JSON
      }
    }
    return null;
  }

  private isCardActionPayload(payload: unknown): payload is CardActionPayload {
    if (!payload || typeof payload !== 'object') return false;
    const record = payload as Record<string, unknown>;
    return (
      typeof record.action === 'string' &&
      typeof record.workspaceId === 'string'
    );
  }

  private extractToastContent(result: unknown): string | undefined {
    const toast = this.getToast(result);
    return typeof toast?.content === 'string' ? toast.content : undefined;
  }

  private async safePostActionResponse(event: ActionEvent, text: string): Promise<void> {
    if (event.thread) {
      try {
        await event.thread.post(text);
        return;
      } catch (err) {
        diagLog('[FeishuBotService] failed to post action response to thread:', err);
      }
    }

    const larkClient = this.getActiveConnection()?.larkClient;
    const openId = event.user.userId;
    if (!larkClient || !openId) {
      diagLog('[FeishuBotService] no thread or larkClient available to send action response');
      return;
    }

    try {
      await sendPlainTextMessage(larkClient, openId, text);
    } catch (err) {
      console.error('[FeishuBotService] failed to send action response:', err);
    }
  }

  private async handleWorkspaceCommand(thread: Thread, feishuUserId: string): Promise<void> {
    const workspace = await this.requireActiveWorkspace(thread);
    if (!workspace) return;

    const connection = this.getActiveConnection();
    if (!connection) {
      await this.safePostText(thread, '机器人尚未建立连接，请稍后重试。');
      return;
    }

    if (botService.getMemberRole(connection.botId, 'feishu', feishuUserId) !== 'owner') {
      await this.safePostText(thread, '你没有权限切换工作空间。');
      return;
    }

    const workspaces = await workspaceStore.list();
    const card = buildWorkspaceListCard(connection.botId, workspaces, connection.workspaceId);
    await this.sendCardToThread(thread, feishuUserId, card);
  }

  private async handleSessionCommand(thread: Thread, feishuUserId: string): Promise<void> {
    const workspace = await this.requireActiveWorkspace(thread);
    if (!workspace) return;

    const sessions = await this.collectSessionList(workspace, feishuUserId);
    const card = buildSessionListCard(workspace.name, sessions);
    await this.sendSessionListCardToThread(thread, feishuUserId, card);
  }

  private async handleStopCommand(thread: Thread, feishuUserId: string): Promise<void> {
    const workspace = await this.requireActiveWorkspace(thread);
    if (!workspace) return;

    const sessionId = workspaceStore.getFeishuActiveSession(workspace.id, feishuUserId);
    if (!sessionId) {
      await this.safePostText(thread, '没有活跃的会话可中断。请运行 /resume 选择会话。');
      return;
    }

    await this.stopTurn(sessionId, (text) => this.safePostText(thread, text));
  }

  private async handleMenuStopCommand(
    larkClient: lark.Client,
    workspace: Workspace,
    openId: string,
  ): Promise<void> {
    const sessionId = workspaceStore.getFeishuActiveSession(workspace.id, openId);
    if (!sessionId) {
      await this.sendMenuText(larkClient, openId, '没有活跃的会话可中断。请运行 /resume 选择会话。');
      return;
    }

    await this.stopTurn(sessionId, (text) => this.sendMenuText(larkClient, openId, text));
  }

  private async stopTurn(
    sessionId: string,
    sendText: (text: string) => Promise<void>,
  ): Promise<void> {
    const runtime = chatService.getRuntimeIfExists(sessionId);
    if (!runtime || !runtime.isProcessingTurn()) {
      await sendText('当前没有正在进行的对话。');
      return;
    }

    try {
      const streamReply = this.activeStreamReplies.get(sessionId);
      const interrupted = streamReply?.interrupt('已中断') ?? false;
      await runtime.interrupt();
      runtime.cancelPendingApprovals('Turn interrupted by user.');
      if (!interrupted) {
        await sendText('已中断');
      }
    } catch (err) {
      console.error('[FeishuBotService] failed to interrupt session:', err);
      await sendText('⚠️ 中断会话失败，请稍后重试。');
    }
  }

  private async getOrCreateSession(
    workspace: Workspace,
    feishuUserId: string,
  ): Promise<{ sessionId: string; isNew: boolean }> {
    const activeSessionId = workspaceStore.getFeishuActiveSession(workspace.id, feishuUserId);
    if (activeSessionId) {
      const session = await chatService.getSession(activeSessionId, workspace.id);
      if (session) {
        return { sessionId: activeSessionId, isNew: false };
      }
    }

    const botId = this.getBotIdForWorkspace(workspace.id);
    const session = await createFeishuSessionForUser(workspace, feishuUserId, undefined, botId);

    return { sessionId: session.id, isNew: true };
  }

  private async handleNewSessionCommand(
    thread: Thread,
    feishuUserId: string,
    text: string,
  ): Promise<void> {
    const workspace = await this.requireActiveWorkspace(thread);
    if (!workspace) return;

    let title = '';
    const firstSpace = text.indexOf(' ');
    if (firstSpace !== -1) {
      title = text.slice(firstSpace + 1).trim();
    }

    if (!title) {
      title = feishuUserId;
    }

    try {
      const botId = this.getBotIdForWorkspace(workspace.id);
      await createFeishuSessionForUser(workspace, feishuUserId, title, botId);
      await this.safePostText(thread, `已创建新会话：${title}`);
    } catch (err) {
      console.error('[FeishuBotService] failed to create session via /new:', err);
      await this.safePostText(thread, '⚠️ 创建会话失败，请稍后重试。');
    }
  }

  private async handleChatMessage(thread: Thread, feishuUserId: string, text: string): Promise<void> {
    if (!text) return;

    const workspace = await this.requireActiveWorkspace(thread);
    if (!workspace) return;

    let sessionId: string;
    let initialHint: string | undefined;
    try {
      const result = await this.getOrCreateSession(workspace, feishuUserId);
      sessionId = result.sessionId;
      if (result.isNew) {
        initialHint = '已为你创建新会话。发送 /resume 可切换会话，发送 /new 或 /clear 可创建新会话。';
      }
    } catch (err) {
      console.error('[FeishuBotService] failed to get or create session:', err);
      await this.safePostText(thread, '⚠️ 创建会话失败，请稍后重试。');
      return;
    }

    const larkClient = this.getActiveConnection()?.larkClient;
    if (!larkClient) return;

    const reply = new FeishuStreamReply(
      thread,
      larkClient,
      feishuUserId,
      workspace.id,
      sessionId,
      { initialHint },
    );

    let handler: ((id: number, event: SseEvent) => void) & { cleanup: () => void } | undefined;
    let finalize: (() => Promise<void>) | undefined;

    try {
      const handle = await reply.start({
        onFinalized: () => {
          this.activeStreamReplies.delete(sessionId);
        },
        onCleanup: () => {
          this.activeStreamReplies.delete(sessionId);
        },
      });
      handler = handle.handler;
      finalize = handle.finalize;
      this.activeStreamReplies.set(sessionId, handle);
    } catch (err) {
      console.error('[FeishuBotService] failed to start streaming reply:', err);
      await this.safePostText(thread, '⚠️ 发送消息失败，请稍后重试。');
      return;
    }

    try {
      await chatService.pushMessage(sessionId, workspace.id, text, true, handler, feishuUserId);
    } catch (err) {
      handler.cleanup();
      await finalize();
      console.error('[FeishuBotService] pushMessage error:', err);
      await this.safePostText(thread, '⚠️ 发送消息失败，请稍后重试。');
      return;
    }

    // chatService.pushMessage only ENQUEUES the user message — it returns as
    // soon as the message is queued, NOT when the assistant turn completes
    // (runtime.pushMessage just calls input.push). The assistant streams its
    // events asynchronously afterwards. So we must NOT finalize here: doing so
    // would race the turn, freeze the card on the hint with empty content, and
    // drop every subsequent text_delta (handleEvent ignores events once
    // finalized). FeishuStreamReply finalizes itself when the turn's `result`
    // (or error_note / interrupted) event arrives. Returning now also lets the
    // per-user queue advance, so the user can still run /resume or /stop while
    // a turn — or a pending approval — is in flight.
  }

  private async requireActiveWorkspace(thread: Thread): Promise<Workspace | null> {
    const activeWorkspaceId = workspaceStore.getFeishuActiveWorkspace();
    if (!activeWorkspaceId) {
      await this.safePostText(thread, '机器人尚未绑定工作空间，请联系管理员运行 /workspace 进行设置。');
      return null;
    }

    const workspace = await workspaceStore.get(activeWorkspaceId);
    if (!workspace || !this.isFeishuEnabled(workspace)) {
      workspaceStore.clearFeishuActiveWorkspace();
      await this.safePostText(thread, '当前绑定的工作空间已失效，请联系管理员重新设置。');
      return null;
    }

    return workspace;
  }

  private async safePostText(thread: Thread, text: string): Promise<void> {
    try {
      await thread.post(text);
    } catch (err) {
      console.error('[FeishuBotService] failed to post text:', err);
    }
  }

  private async sendCardToThread(thread: Thread, openId: string, card: FeishuCard): Promise<void> {
    const larkClient = this.getActiveConnection()?.larkClient;
    if (!openId || !larkClient) return;
    try {
      await larkClient.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
    } catch (err) {
      console.error('[FeishuBotService] failed to send card:', err);
      await this.safePostText(thread, '发送卡片失败，请稍后重试。');
    }
  }

  private async sendSessionListCardToThread(
    thread: Thread,
    openId: string,
    card: FeishuCard,
  ): Promise<void> {
    const larkClient = this.getActiveConnection()?.larkClient;
    if (!openId || !larkClient) return;
    const result = await this.createAndSendCardKitCard(larkClient, openId, card);
    if (!result) {
      await this.safePostText(thread, '发送卡片失败，请稍后重试。');
    }
  }

  private async createAndSendCardKitCard(
    larkClient: lark.Client,
    openId: string,
    card: FeishuCard,
  ): Promise<{ cardId: string; messageId: string } | null> {
    try {
      const createRes = (await larkClient.cardkit.v1.card.create({
        data: { type: 'card_json', data: JSON.stringify(card) },
      })) as unknown;
      const cardId = (createRes as { data?: { card_id?: string } }).data?.card_id;
      if (!cardId) {
        diagLog('[FeishuBotService] cardkit.v1.card.create returned no card_id');
        return null;
      }

      const sendRes = (await larkClient.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          msg_type: 'interactive',
          content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
        },
      })) as unknown;
      const messageId = (sendRes as { data?: { message_id?: string } }).data?.message_id;
      if (!messageId) {
        diagLog('[FeishuBotService] im.v1.message.create returned no message_id');
        return null;
      }

      this.sessionListCardIds.set(messageId, cardId);
      return { cardId, messageId };
    } catch (err) {
      console.error('[FeishuBotService] failed to create/send CardKit card:', err);
      return null;
    }
  }

  /**
   * Collect the Feishu sessions owned by a user for the session-list card.
   * Shared by the `/resume` text command (Thread-based send) and the
   * "resume" bot menu (DM-based send).
   */
  private async collectSessionList(
    workspace: Workspace,
    openId: string,
  ): Promise<Array<{ session: ChatSession; isActive: boolean }>> {
    const sessionRows = workspaceStore.listFeishuSessionsByUser(workspace.id, openId);
    const activeSessionId = workspaceStore.getFeishuActiveSession(workspace.id, openId);

    const sessions: Array<{ session: ChatSession; isActive: boolean }> = [];
    for (const row of sessionRows) {
      const session = await chatService.getSession(row.sessionId, workspace.id);
      if (session) {
        sessions.push({ session, isActive: session.id === activeSessionId });
      }
    }
    return sessions;
  }

  /** Menu handler: send the session-list card to the operator's DM. */
  private async sendSessionListCard(
    larkClient: lark.Client,
    workspace: Workspace,
    openId: string,
  ): Promise<void> {
    const sessions = await this.collectSessionList(workspace, openId);
    const card = buildSessionListCard(workspace.name, sessions);
    const result = await this.createAndSendCardKitCard(larkClient, openId, card);
    if (result) {
      diagLog(
        `[FeishuBotService] menu: sent session-list card (${sessions.length} sessions) to ${openId}`,
      );
    } else {
      await this.sendMenuText(larkClient, openId, '发送会话列表卡片失败，请稍后重试。');
    }
  }

  /** Menu handler: create a session and notify the operator via DM. */
  private async createAndNotifyNewSession(
    larkClient: lark.Client,
    workspace: Workspace,
    openId: string,
  ): Promise<void> {
    try {
      const botId = this.getBotIdForWorkspace(workspace.id);
      const session = await createFeishuSessionForUser(workspace, openId, undefined, botId);
      await this.sendMenuText(larkClient, openId, `已创建新会话：${openId}`);
      diagLog(`[FeishuBotService] menu: created session ${session.id} and notified ${openId}`);
    } catch (err) {
      console.error('[FeishuBotService] failed to create session via menu:', err);
      await this.sendMenuText(larkClient, openId, '⚠️ 创建会话失败，请稍后重试。');
    }
  }

  /** Send a plain-text DM to a Feishu user via the menu handler's client. */
  private async sendMenuText(larkClient: lark.Client, openId: string, text: string): Promise<void> {
    if (!openId) return;
    try {
      await sendPlainTextMessage(larkClient, openId, text);
    } catch (err) {
      diagLog(`[FeishuBotService] failed to send menu text to ${openId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Send an interactive-card DM to a Feishu user via the menu handler's client. */
  private async sendMenuCard(larkClient: lark.Client, openId: string, card: FeishuCard): Promise<void> {
    if (!openId) return;
    try {
      await larkClient.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
    } catch (err) {
      diagLog(`[FeishuBotService] failed to send menu card to ${openId}: ${err instanceof Error ? err.message : String(err)}`);
      await this.sendMenuText(larkClient, openId, '发送卡片失败，请稍后重试。');
    }
  }
}

export const feishuBotService = new FeishuBotService();
