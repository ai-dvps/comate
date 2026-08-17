import type { Workspace } from '../models/workspace.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { botService } from './bot-service.js';
import { chatService } from './chat-service.js';
import { createFeishuSessionForUser } from './feishu-session-helpers.js';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { buildTerminalDecisionCard, type FeishuCardV2 } from './feishu-card-builder.js';
import { humanizeBotToolName, summarizeBotToolOperation } from '../utils/bot-tool-presentation.js';
import { computeAlwaysAllowRules, exactSessionUpdatedPermissions } from './bot-escalation-guard.js';

export interface CardActionPayload {
  action: string;
  workspaceId: string;
  botId?: string;
  sessionId?: string;
  requestId?: string;
  behavior?: 'allow' | 'always_allow' | 'deny';
}

export interface CardActionCallbacks {
  setActiveWorkspace?: (workspaceId: string, botId: string, actorUserId: string) => Promise<void>;
  beforeDecisionResolve?: (sessionId: string, decision: 'allow' | 'deny') => void;
}

export interface CardActionResult {
  toast: { type: 'success' | 'error'; content: string };
  terminalCard?: FeishuCardV2;
}

export class FeishuCardActionHandler {
  private rateLimit = new Map<string, number>();
  private readonly rateLimitMs = 1000;

  async handle(openId: string, payload: CardActionPayload, callbacks?: CardActionCallbacks): Promise<CardActionResult> {
    const now = Date.now();
    const last = this.rateLimit.get(openId) ?? 0;
    if (now - last < this.rateLimitMs) {
      return this.toast('操作过于频繁，请稍后再试。', 'error');
    }
    this.rateLimit.set(openId, now);

    const workspace = await workspaceStore.get(payload.workspaceId);
    if (!workspace) {
      return this.toast('工作空间不存在。', 'error');
    }

    switch (payload.action) {
      case 'select_workspace':
        return this.handleSelectWorkspace(openId, workspace, payload, callbacks);
      case 'select_session':
        return this.handleSelectSession(openId, workspace, payload);
      case 'create_session':
        return this.handleCreateSession(openId, workspace);
      case 'approval':
        return this.handleApproval(openId, workspace, payload, callbacks);
      default:
        return this.toast('未知操作。', 'error');
    }
  }

  private async handleSelectWorkspace(
    openId: string,
    workspace: Workspace,
    payload: CardActionPayload,
    callbacks?: CardActionCallbacks,
  ): Promise<CardActionResult> {
    if (!payload.botId) {
      return this.toast('缺少机器人信息。', 'error');
    }
    if (botService.getMemberRole(payload.botId, 'feishu', openId) !== 'owner') {
      return this.toast('你没有权限切换工作空间。', 'error');
    }
    if (!payload.workspaceId) {
      return this.toast('缺少工作空间信息。', 'error');
    }
    try {
      await callbacks?.setActiveWorkspace?.(payload.workspaceId, payload.botId, openId);
    } catch (err) {
      console.error('[FeishuCardActionHandler] setActiveWorkspace failed:', err);
      return this.toast('切换工作空间失败。', 'error');
    }
    return this.toast('工作空间已切换。');
  }

  private handleSelectSession(
    openId: string,
    workspace: Workspace,
    payload: CardActionPayload,
  ): CardActionResult {
    const sessionId = payload.sessionId;
    if (!sessionId) {
      return this.toast('缺少会话信息。', 'error');
    }
    if (!this.isSessionOwner(workspace, openId, sessionId)) {
      return this.toast('你无法操作该会话。', 'error');
    }
    const user = this.requireFeishuUser(workspace, openId);
    if (user instanceof Error) {
      return this.toast(user.message, 'error');
    }
    workspaceStore.addUserSession(workspace.id, sessionId, user.id);
    workspaceStore.setActiveUserSession(user.id, sessionId);
    return this.toast('会话已切换。');
  }

  private async handleCreateSession(
    openId: string,
    workspace: Workspace,
  ): Promise<CardActionResult> {
    const session = await createFeishuSessionForUser(workspace, openId);
    return this.toast(`会话 “${session.name}” 已创建并选中。`);
  }

  private isSessionOwner(workspace: Workspace, openId: string, sessionId: string): boolean {
    const user = this.resolveFeishuUser(workspace, openId);
    if (!user) return false;
    return workspaceStore.getSessionUsers(sessionId).includes(user.id);
  }

  private resolveFeishuUser(workspace: Workspace, openId: string): import('../models/bot-user.js').BotUser | null {
    const bot = botService.getBotForWorkspace(workspace.id);
    if (!bot) return null;
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'feishu');
    if (!channel) return null;
    return workspaceStore.getBotUserByChannelIdentity(bot.id, channel.id, openId);
  }

  private requireFeishuUser(workspace: Workspace, openId: string): import('../models/bot-user.js').BotUser | Error {
    const user = this.resolveFeishuUser(workspace, openId);
    if (!user) {
      return new Error('无法识别操作用户。');
    }
    return user;
  }

  private handleApproval(
    openId: string,
    workspace: Workspace,
    payload: CardActionPayload,
    callbacks?: CardActionCallbacks,
  ): CardActionResult {
    const sessionId = payload.sessionId;
    const requestId = payload.requestId;
    if (!sessionId || !requestId) {
      return this.toast('缺少审批信息。', 'error');
    }
    if (!this.isSessionOwner(workspace, openId, sessionId)) {
      return this.toast('你无法操作该会话。', 'error');
    }

    const runtime = chatService.getRuntimeIfExists(sessionId);
    if (!runtime) {
      return this.toast('会话运行时已关闭，请重新发送消息。', 'error');
    }

    const pending = runtime.getPendingCardState(requestId);
    if (!pending || pending.type !== 'approval') {
      return this.toast('请求已过期或已处理。', 'error');
    }
    const command = typeof pending.input.command === 'string' ? pending.input.command : undefined;
    const alwaysAllow = computeAlwaysAllowRules({
      toolName: pending.toolName ?? '',
      command,
      suggestions: pending.suggestions,
    });
    if (payload.behavior === 'always_allow' && alwaysAllow.rules.length === 0) {
      return this.toast('该操作不支持始终允许。', 'error');
    }

    let result: PermissionResult;
    if (payload.behavior === 'allow' || payload.behavior === 'always_allow') {
      result = {
        behavior: 'allow',
        updatedInput: pending.input,
        updatedPermissions: payload.behavior === 'always_allow'
          ? exactSessionUpdatedPermissions(alwaysAllow.rules)
          : undefined,
      };
    } else {
      result = { behavior: 'deny', message: 'User denied this tool call.' };
    }
    callbacks?.beforeDecisionResolve?.(
      sessionId,
      payload.behavior === 'deny' ? 'deny' : 'allow',
    );
    if (!runtime.resolveApproval(requestId, result)) {
      return this.toast('请求已过期或已处理。', 'error');
    }
    const selection = payload.behavior === 'always_allow'
      ? '对此规则始终允许'
      : payload.behavior === 'allow' ? '仅本次允许' : '拒绝';
    return {
      ...this.toast(
        payload.behavior === 'always_allow' ? '已始终允许。' : payload.behavior === 'allow' ? '已允许。' : '已拒绝。',
      ),
      terminalCard: buildTerminalDecisionCard({
        title: payload.behavior === 'deny' ? '操作已拒绝' : '操作已允许',
        description: `${pending.title ?? humanizeBotToolName(pending.toolName ?? '')}\n操作：${summarizeBotToolOperation(pending.input, pending.toolName ?? '相关操作', 160)}`,
        selection,
      }),
    };
  }

  private toast(content: string, type: 'success' | 'error' = 'success'): CardActionResult {
    return {
      toast: {
        type,
        content,
      },
    };
  }
}

export const feishuCardActionHandler = new FeishuCardActionHandler();
