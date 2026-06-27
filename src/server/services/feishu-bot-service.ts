import { Chat } from 'chat';
import { createMemoryState } from '@chat-adapter/state-memory';
import { createLarkAdapter, type LarkAdapter } from '@larksuite/vercel-chat-adapter';
import * as lark from '@larksuiteoapi/node-sdk';
import type { Thread, Message, DirectMessageHandler, MentionHandler, ActionEvent } from 'chat';
import type { SseEvent } from '../types/message.js';
import type { Workspace } from '../models/workspace.js';
import type { ChatSession } from '../models/session.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import { createFeishuSessionForUser } from './feishu-session-helpers.js';
import { FeishuStreamReply } from './feishu-stream-reply.js';
import {
  buildWorkspaceListCard,
  buildSessionListCard,
  buildInactiveSessionCard,
  type FeishuCard,
} from './feishu-card-builder.js';
import { feishuCardActionHandler, type CardActionPayload } from './feishu-card-action-handler.js';
import { feishuUserResolver } from './feishu-user-resolver.js';
import { diagLog } from '../utils/diag-logger.js';
import { sendPlainTextMessage } from './feishu-message-utils.js';

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
  status: FeishuBotStatus;
}

export class FeishuBotService {
  private connection: Connection | null = null;
  private userQueues = new Map<string, Promise<unknown>>();

  async initialize(): Promise<void> {
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

  async connect(workspace: Workspace): Promise<void> {
    this.disconnect();

    const appId = workspace.settings.feishuAppId?.trim();
    const appSecret = workspace.settings.feishuAppSecret?.trim();
    if (!appId || !appSecret) {
      diagLog(`[FeishuBotService] workspace ${workspace.id} missing Feishu credentials`);
      return;
    }

    const larkClient = new lark.Client({
      appId,
      appSecret,
      appType: lark.AppType.SelfBuild,
    });

    const adapter = createLarkAdapter({
      appId,
      appSecret,
      channelFactory: (opts) => lark.createLarkChannel({ ...opts, includeRawEvent: true }),
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

    this.connection = {
      chat,
      adapter,
      larkClient,
      workspaceId: workspace.id,
      status: 'connecting',
    };

    try {
      await chat.initialize();
      // The chat adapter listens to im.message / card.action / reaction events
      // but ignores application.bot.menu_v6. When Feishu is configured to use
      // long-connection (WebSocket) event subscription, menu events arrive on
      // the same WS channel, so register a handler there as well.
      this.registerWSMenuHandler(adapter, workspace, larkClient);
      workspaceStore.setFeishuActiveWorkspace(workspace.id);
      this.connection.status = 'connected';
      diagLog(`[FeishuBotService] connected for workspace ${workspace.id}`);
    } catch (err) {
      this.connection.status = 'error';
      console.error(`[FeishuBotService] failed to initialize for workspace ${workspace.id}:`, err);
    }
  }

  /**
   * Register an application.bot.menu_v6 handler on the chat adapter's underlying
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

  /** Extract operator open_id and event_key from an application.bot.menu_v6 payload. */
  private extractMenuEvent(data: Record<string, unknown>): { openId: string; eventKey: string | undefined } {
    const operator = data.operator as { operator_id?: { open_id?: string } } | undefined;
    const openId = operator?.operator_id?.open_id ?? '';
    const eventKey = typeof data.event_key === 'string' ? data.event_key : undefined;
    return { openId, eventKey };
  }

  disconnect(): void {
    if (!this.connection) return;
    const { chat, workspaceId } = this.connection;
    this.connection = null;
    chat
      .shutdown()
      .then(() => {
        diagLog(`[FeishuBotService] disconnected from workspace ${workspaceId}`);
      })
      .catch((err) => {
        console.error('[FeishuBotService] error during shutdown:', err);
      });
  }

  getStatus(workspaceId: string): FeishuBotStatus {
    if (!this.connection || this.connection.workspaceId !== workspaceId) {
      return 'not_configured';
    }
    return this.connection.status;
  }

  async reconnectIfActive(workspaceId: string): Promise<void> {
    const activeWorkspaceId = workspaceStore.getFeishuActiveWorkspace();
    if (activeWorkspaceId !== workspaceId) return;

    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace || !this.isFeishuEnabled(workspace)) {
      this.disconnect();
      workspaceStore.clearFeishuActiveWorkspace();
      return;
    }

    await this.connect(workspace);
  }

  /**
   * Set the active workspace binding and (re)connect the adapter.
   * Called from the card callback route when an admin selects a workspace.
   */
  async setActiveWorkspace(workspaceId: string): Promise<void> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace || !this.isFeishuEnabled(workspace)) {
      workspaceStore.clearFeishuActiveWorkspace();
      this.disconnect();
      return;
    }
    await this.connect(workspace);
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

    if (key !== 'resume' && key !== 'new' && key !== 'clear') {
      diagLog(`[FeishuBotService] menu event: unknown normalizedKey="${key}" (rawKey="${rawKey}")`);
      await this.sendMenuText(larkClient, openId, '⚠️ 未知的菜单操作。');
      return;
    }

    diagLog(`[FeishuBotService] menu event: processing normalizedKey="${key}" for ${openId}`);
    await this.runForUser(openId, async () => {
      if (key === 'resume') {
        diagLog(`[FeishuBotService] menu event: sending session-list card for ${openId}`);
        await this.sendSessionListCard(larkClient, workspace, openId);
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
    return !!workspace.settings.feishuBotEnabled;
  }

  private createDispatchHandler(): DirectMessageHandler & MentionHandler {
    return async (thread: Thread, message: Message) => {
      if (!thread.isDM) return;

      const feishuUserId = message.author.userId;
      const text = (message.text ?? '').trim();

      const workspaceId = this.connection?.workspaceId;
      if (workspaceId) {
        workspaceStore.setFeishuWorkspaceUser(workspaceId, feishuUserId);
        void feishuUserResolver.resolveOnMessage(workspaceId, feishuUserId, this.connection!.larkClient);
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
        setActiveWorkspace: (workspaceId: string) => this.setActiveWorkspace(workspaceId),
      });
      const content = this.extractToastContent(result);
      if (content) {
        await this.safePostActionResponse(event, content);
      }
      if (payload.action === 'select_session' && this.isSuccessToast(result)) {
        await this.patchSessionListCardInactive(event.messageId, payload.workspaceId, resolvedSessionId);
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
    sessionId: string,
  ): Promise<void> {
    const larkClient = this.connection?.larkClient;
    if (!larkClient) return;

    const [workspace, session] = await Promise.all([
      workspaceStore.get(workspaceId),
      chatService.getSession(sessionId, workspaceId),
    ]);
    if (!workspace) return;

    const sessionName = session?.name ?? sessionId;
    const card = buildInactiveSessionCard(workspace.name, sessionName);

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

  private isCardActionPayload(
    payload: Record<string, unknown> | null,
  ): payload is CardActionPayload {
    return (
      !!payload &&
      typeof payload.action === 'string' &&
      typeof payload.workspaceId === 'string'
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

    const larkClient = this.connection?.larkClient;
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

    const admins = workspace.settings.feishuAdminUserIds ?? [];
    if (!admins.includes(feishuUserId)) {
      await this.safePostText(thread, '你没有权限切换工作空间。');
      return;
    }

    const workspaces = await workspaceStore.list();
    const card = buildWorkspaceListCard(workspaces);
    await this.sendCardToThread(thread, feishuUserId, card);
  }

  private async handleSessionCommand(thread: Thread, feishuUserId: string): Promise<void> {
    const workspace = await this.requireActiveWorkspace(thread);
    if (!workspace) return;

    const sessions = await this.collectSessionList(workspace, feishuUserId);
    const card = buildSessionListCard(workspace.name, sessions);
    await this.sendCardToThread(thread, feishuUserId, card);
  }

  private async handleStopCommand(thread: Thread, feishuUserId: string): Promise<void> {
    const workspace = await this.requireActiveWorkspace(thread);
    if (!workspace) return;

    const sessionId = workspaceStore.getFeishuActiveSession(workspace.id, feishuUserId);
    if (!sessionId) {
      await this.safePostText(thread, '没有活跃的会话可中断。请运行 /resume 选择会话。');
      return;
    }

    const runtime = chatService.getRuntimeIfExists(sessionId);
    if (!runtime || !runtime.isProcessingTurn()) {
      await this.safePostText(thread, '当前没有正在进行的对话。');
      return;
    }

    await runtime.interrupt();
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

    const session = await createFeishuSessionForUser(workspace, feishuUserId);

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
      await createFeishuSessionForUser(workspace, feishuUserId, title);
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

    const larkClient = this.connection?.larkClient;
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
      const handle = await reply.start();
      handler = handle.handler;
      finalize = handle.finalize;
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
    const larkClient = this.connection?.larkClient;
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
    await this.sendMenuCard(larkClient, openId, card);
    diagLog(
      `[FeishuBotService] menu: sent session-list card (${sessions.length} sessions) to ${openId}`,
    );
  }

  /** Menu handler: create a session and notify the operator via DM. */
  private async createAndNotifyNewSession(
    larkClient: lark.Client,
    workspace: Workspace,
    openId: string,
  ): Promise<void> {
    try {
      const session = await createFeishuSessionForUser(workspace, openId);
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
