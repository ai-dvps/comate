import type { Workspace } from '../models/workspace.js';
import type { QuestionPayload } from '../types/message.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import { feishuBotService } from './feishu-bot-service.js';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

export interface CardActionPayload {
  action: string;
  workspaceId: string;
  sessionId?: string;
  requestId?: string;
  behavior?: 'allow' | 'deny';
  questionIndex?: number;
  answer?: string;
  multiSelect?: boolean;
}

interface PendingQuestionState {
  questions: QuestionPayload[];
  selected: Map<number, Set<string>>;
}

export class FeishuCardActionHandler {
  private rateLimit = new Map<string, number>();
  private readonly rateLimitMs = 1000;
  private pendingQuestions = new Map<string, PendingQuestionState>();

  registerQuestion(requestId: string, questions: QuestionPayload[]): void {
    this.pendingQuestions.set(requestId, {
      questions,
      selected: new Map(),
    });
  }

  async handle(openId: string, payload: CardActionPayload): Promise<unknown> {
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
        return this.handleSelectWorkspace(openId, workspace, payload);
      case 'select_session':
        return this.handleSelectSession(openId, workspace, payload);
      case 'create_session':
        return this.handleCreateSession(openId, workspace);
      case 'approval':
        return this.handleApproval(openId, workspace, payload);
      case 'question':
        return this.handleQuestionOption(openId, workspace, payload);
      case 'question_submit':
        return this.handleQuestionSubmit(openId, workspace, payload);
      default:
        return this.toast('未知操作。', 'error');
    }
  }

  private handleSelectWorkspace(
    openId: string,
    workspace: Workspace,
    payload: CardActionPayload,
  ): unknown {
    const admins = workspace.settings.feishuAdminUserIds ?? [];
    if (!admins.includes(openId)) {
      return this.toast('你没有权限切换工作空间。', 'error');
    }
    if (!payload.workspaceId) {
      return this.toast('缺少工作空间信息。', 'error');
    }
    feishuBotService.setActiveWorkspace(payload.workspaceId).catch((err) => {
      console.error('[FeishuCardActionHandler] setActiveWorkspace failed:', err);
    });
    return this.toast('工作空间已切换。');
  }

  private handleSelectSession(
    openId: string,
    workspace: Workspace,
    payload: CardActionPayload,
  ): unknown {
    const sessionId = payload.sessionId;
    if (!sessionId) {
      return this.toast('缺少会话信息。', 'error');
    }
    const owner = workspaceStore.getFeishuSessionOwner(workspace.id, sessionId);
    if (owner !== openId) {
      return this.toast('你无法操作该会话。', 'error');
    }
    workspaceStore.setFeishuActiveSession(workspace.id, openId, sessionId);
    return this.toast('会话已切换。');
  }

  private async handleCreateSession(
    openId: string,
    workspace: Workspace,
  ): Promise<unknown> {
    const session = await chatService.createSession({
      workspaceId: workspace.id,
      name: 'Feishu Session',
      source: 'feishu',
    });
    workspaceStore.addFeishuUserSession(workspace.id, openId, session.id);
    workspaceStore.setFeishuActiveSession(workspace.id, openId, session.id);
    return this.toast(`会话 “${session.name}” 已创建并选中。`);
  }

  private handleApproval(
    openId: string,
    workspace: Workspace,
    payload: CardActionPayload,
  ): unknown {
    const sessionId = payload.sessionId;
    const requestId = payload.requestId;
    if (!sessionId || !requestId) {
      return this.toast('缺少审批信息。', 'error');
    }
    const owner = workspaceStore.getFeishuSessionOwner(workspace.id, sessionId);
    if (owner !== openId) {
      return this.toast('你无法操作该会话。', 'error');
    }

    const runtime = chatService.getRuntimeIfExists(sessionId);
    if (!runtime) {
      return this.toast('会话运行时已关闭，请重新发送消息。', 'error');
    }

    let result: PermissionResult;
    if (payload.behavior === 'allow') {
      result = { behavior: 'allow', updatedInput: {} };
    } else {
      result = { behavior: 'deny', message: 'User denied this tool call.' };
    }
    runtime.resolveApproval(requestId, result);
    return this.toast(payload.behavior === 'allow' ? '已允许。' : '已拒绝。');
  }

  private handleQuestionOption(
    openId: string,
    workspace: Workspace,
    payload: CardActionPayload,
  ): unknown {
    const sessionId = payload.sessionId;
    const requestId = payload.requestId;
    if (!sessionId || !requestId) {
      return this.toast('缺少问题信息。', 'error');
    }
    const owner = workspaceStore.getFeishuSessionOwner(workspace.id, sessionId);
    if (owner !== openId) {
      return this.toast('你无法操作该会话。', 'error');
    }

    const state = this.pendingQuestions.get(requestId);
    if (!state) {
      return this.toast('问题已过期或不存在。', 'error');
    }

    const idx = payload.questionIndex ?? 0;
    const answer = payload.answer ?? '';
    if (payload.multiSelect) {
      const set = state.selected.get(idx) ?? new Set();
      if (set.has(answer)) {
        set.delete(answer);
      } else {
        set.add(answer);
      }
      state.selected.set(idx, set);
      return this.toast(`已更新选择：${Array.from(set).join(', ')}`);
    }

    // Single-select: resolve immediately
    const answers = this.buildAnswers(state.questions, [[idx, answer]]);
    this.resolveQuestion(sessionId, requestId, state.questions, answers);
    return this.toast('已提交。');
  }

  private handleQuestionSubmit(
    openId: string,
    workspace: Workspace,
    payload: CardActionPayload,
  ): unknown {
    const sessionId = payload.sessionId;
    const requestId = payload.requestId;
    if (!sessionId || !requestId) {
      return this.toast('缺少问题信息。', 'error');
    }
    const owner = workspaceStore.getFeishuSessionOwner(workspace.id, sessionId);
    if (owner !== openId) {
      return this.toast('你无法操作该会话。', 'error');
    }

    const state = this.pendingQuestions.get(requestId);
    if (!state) {
      return this.toast('问题已过期或不存在。', 'error');
    }

    const selections: Array<[number, string]> = [];
    for (const [idx, set] of state.selected) {
      for (const answer of set) {
        selections.push([idx, answer]);
      }
    }
    const answers = this.buildAnswers(state.questions, selections);
    this.resolveQuestion(sessionId, requestId, state.questions, answers);
    return this.toast('已提交。');
  }

  private resolveQuestion(
    sessionId: string,
    requestId: string,
    questions: QuestionPayload[],
    answers: string[],
  ): void {
    this.pendingQuestions.delete(requestId);
    const runtime = chatService.getRuntimeIfExists(sessionId);
    if (!runtime) return;
    const result: PermissionResult = {
      behavior: 'allow',
      updatedInput: { questions, answers },
    };
    runtime.resolveApproval(requestId, result);
  }

  private buildAnswers(
    questions: QuestionPayload[],
    selections: Array<[number, string]>,
  ): string[] {
    const answers = new Array(questions.length).fill('');
    for (const [idx, answer] of selections) {
      if (idx < 0 || idx >= answers.length) continue;
      const existing = answers[idx];
      answers[idx] = existing ? `${existing}, ${answer}` : answer;
    }
    return answers;
  }

  private toast(content: string, type: 'success' | 'error' = 'success'): unknown {
    return {
      toast: {
        type,
        content,
      },
    };
  }
}

export const feishuCardActionHandler = new FeishuCardActionHandler();
