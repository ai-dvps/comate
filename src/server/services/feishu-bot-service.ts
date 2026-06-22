import { Chat } from 'chat';
import { createMemoryState } from '@chat-adapter/state-memory';
import { createLarkAdapter, type LarkAdapter } from '@larksuite/vercel-chat-adapter';
import * as lark from '@larksuiteoapi/node-sdk';
import type { Thread, Message, DirectMessageHandler, MentionHandler, ActionEvent } from 'chat';
import type { SseEvent } from '../types/message.js';
import type { Workspace } from '../models/workspace.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import { FeishuStreamReply } from './feishu-stream-reply.js';
import {
  buildWorkspaceListCard,
  buildSessionListCard,
  type FeishuCard,
} from './feishu-card-builder.js';
import { feishuCardActionHandler, type CardActionPayload } from './feishu-card-action-handler.js';
import { feishuUserResolver } from './feishu-user-resolver.js';
import { diagLog } from '../utils/diag-logger.js';

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

    const adapter = createLarkAdapter({ appId, appSecret });
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
      workspaceStore.setFeishuActiveWorkspace(workspace.id);
      this.connection.status = 'connected';
      diagLog(`[FeishuBotService] connected for workspace ${workspace.id}`);
    } catch (err) {
      this.connection.status = 'error';
      console.error(`[FeishuBotService] failed to initialize for workspace ${workspace.id}:`, err);
    }
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
        } else if (text === '/session') {
          await this.runForUser(feishuUserId, () => this.handleSessionCommand(thread, feishuUserId));
        } else if (text === '/stop') {
          await this.runForUser(feishuUserId, () => this.handleStopCommand(thread, feishuUserId));
        } else if (text === '/new' || text.startsWith('/new ')) {
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
    if (!payload) {
      diagLog('[FeishuBotService] card action value missing or unparseable');
      await this.safePostActionResponse(event, '无法解析卡片操作。');
      return;
    }

    try {
      const result = await feishuCardActionHandler.handle(event.user.userId, payload as unknown as CardActionPayload, {
        setActiveWorkspace: (workspaceId: string) => this.setActiveWorkspace(workspaceId),
      });
      const content = this.extractToastContent(result);
      if (content) {
        await this.safePostActionResponse(event, content);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      diagLog(`[FeishuBotService] card action handler error: ${message}`);
      await this.safePostActionResponse(event, '处理操作失败，请稍后重试。');
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

  private extractToastContent(result: unknown): string | undefined {
    if (
      result &&
      typeof result === 'object' &&
      'toast' in result &&
      result.toast &&
      typeof result.toast === 'object' &&
      'content' in result.toast &&
      typeof result.toast.content === 'string'
    ) {
      return result.toast.content;
    }
    return undefined;
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
      await larkClient.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
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

    const sessionRows = workspaceStore.listFeishuSessionsByUser(workspace.id, feishuUserId);
    const activeSessionId = workspaceStore.getFeishuActiveSession(workspace.id, feishuUserId);

    const sessions: Array<{ session: import('../models/session.js').ChatSession; isActive: boolean }> = [];
    for (const row of sessionRows) {
      const session = await chatService.getSession(row.sessionId, workspace.id);
      if (session) {
        sessions.push({ session, isActive: session.id === activeSessionId });
      }
    }

    const card = buildSessionListCard(workspace.name, sessions);
    await this.sendCardToThread(thread, feishuUserId, card);
  }

  private async handleStopCommand(thread: Thread, feishuUserId: string): Promise<void> {
    const workspace = await this.requireActiveWorkspace(thread);
    if (!workspace) return;

    const sessionId = workspaceStore.getFeishuActiveSession(workspace.id, feishuUserId);
    if (!sessionId) {
      await this.safePostText(thread, '没有活跃的会话可中断。请运行 /session 选择会话。');
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

    const session = await chatService.createSession({
      workspaceId: workspace.id,
      name: feishuUserId,
      source: 'feishu',
    });

    workspaceStore.addFeishuUserSession(workspace.id, feishuUserId, session.id);
    workspaceStore.setFeishuActiveSession(workspace.id, feishuUserId, session.id);

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
      const session = await chatService.createSession({
        workspaceId: workspace.id,
        name: title,
        source: 'feishu',
      });

      workspaceStore.addFeishuUserSession(workspace.id, feishuUserId, session.id);
      workspaceStore.setFeishuActiveSession(workspace.id, feishuUserId, session.id);

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
        initialHint = '已为你创建新会话。发送 /session 可切换会话，发送 /new 可创建新会话。';
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
    // per-user queue advance, so the user can still run /session or /stop while
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
}

export const feishuBotService = new FeishuBotService();
