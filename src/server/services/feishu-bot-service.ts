import { Chat } from 'chat';
import { createMemoryState } from '@chat-adapter/state-memory';
import { createLarkAdapter, type LarkAdapter } from '@larksuite/vercel-chat-adapter';
import * as lark from '@larksuiteoapi/node-sdk';
import type { Thread, Message, DirectMessageHandler, MentionHandler } from 'chat';
import type { Workspace } from '../models/workspace.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import { FeishuStreamReply } from './feishu-stream-reply.js';
import {
  buildWorkspaceListCard,
  buildSessionListCard,
  type FeishuCard,
} from './feishu-card-builder.js';
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
    await this.sendCardToThread(thread, card);
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
    await this.sendCardToThread(thread, card);
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

  private async handleChatMessage(thread: Thread, feishuUserId: string, text: string): Promise<void> {
    if (!text) return;

    const workspace = await this.requireActiveWorkspace(thread);
    if (!workspace) return;

    const sessionId = workspaceStore.getFeishuActiveSession(workspace.id, feishuUserId);
    if (!sessionId) {
      await this.safePostText(
        thread,
        '请先运行 /session 选择或创建一个会话，然后再发送消息。',
      );
      return;
    }

    const openId = this.resolveOpenId(thread);
    const larkClient = this.connection?.larkClient;
    if (!larkClient) return;

    const reply = new FeishuStreamReply(
      thread,
      larkClient,
      openId,
      workspace.id,
      sessionId,
    );

    let waiting = false;
    const { handler, stream, finalize } = reply.start({
      onWaiting: () => {
        waiting = true;
      },
    });

    const streamPromise = this.safePostStream(thread, stream).finally(() => {
      finalize();
    });

    try {
      await chatService.pushMessage(sessionId, workspace.id, text, true, handler, feishuUserId);
    } catch (err) {
      handler.cleanup();
      finalize();
      console.error('[FeishuBotService] pushMessage error:', err);
      await this.safePostText(thread, '⚠️ 发送消息失败，请稍后重试。');
      return;
    }

    if (waiting) {
      // The runtime is waiting for an approval/question. Let the queue advance
      // so the user can still issue /session or /stop, but leave the stream
      // promise running in the background to receive the resumed output.
      return;
    }

    await streamPromise;
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

  private resolveOpenId(thread: Thread): string {
    const adapter = this.connection?.adapter;
    if (!adapter) return '';
    try {
      const decoded = adapter.decodeThreadId(thread.id);
      if (decoded.chatId.startsWith('ou_')) {
        return decoded.chatId;
      }
    } catch {
      // fall through
    }
    return thread.channelId;
  }

  private async safePostText(thread: Thread, text: string): Promise<void> {
    try {
      await thread.post(text);
    } catch (err) {
      console.error('[FeishuBotService] failed to post text:', err);
    }
  }

  private async safePostStream(thread: Thread, stream: AsyncIterable<unknown>): Promise<void> {
    try {
      await thread.post(stream as AsyncIterable<string>);
    } catch (err) {
      console.error('[FeishuBotService] failed to post stream:', err);
    }
  }

  private async sendCardToThread(thread: Thread, card: FeishuCard): Promise<void> {
    const openId = this.resolveOpenId(thread);
    const larkClient = this.connection?.larkClient;
    if (!openId || !larkClient) return;
    try {
      await larkClient.im.message.create({
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
