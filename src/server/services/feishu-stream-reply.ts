import type { Thread } from 'chat';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { SseEvent } from '../types/message.js';

export const FALLBACK_TEXT = '⚠️ 处理失败，请稍后重试。';
import {
  buildApprovalCard,
  buildQuestionCard,
  type FeishuCard,
} from './feishu-card-builder.js';
import { feishuCardActionHandler } from './feishu-card-action-handler.js';
import { FeishuCardStream, hasVisibleChar } from './feishu-card-stream.js';
import { getRandomAcknowledgment } from '../utils/bot-placeholder.js';
import { sendPlainTextMessage } from './feishu-message-utils.js';

export interface FeishuStreamReplyHandle {
  handler: ((id: number, event: SseEvent) => void) & { cleanup: () => void };
  finalize: () => Promise<void>;
  interrupt: (message: string) => boolean;
}

export class FeishuStreamReply {
  private thread: Thread;
  private larkClient: lark.Client;
  private openId: string;
  private workspaceId: string;
  private sessionId: string;
  private onWaiting?: () => void;
  private initialHint?: string;
  private callbacks?: { onFinalized?: () => void; onCleanup?: () => void };

  private controller: FeishuCardStream | null = null;
  private finalized = false;
  private finalizedNotified = false;
  private finishPromise: Promise<void> | null = null;
  private waitingSignaled = false;
  private collecting = false;
  private responseText = '';
  private visiblePlaceholder = '';
  private seenPendingApprovals = new Set<string>();
  private seenPendingQuestions = new Set<string>();

  constructor(
    thread: Thread,
    larkClient: lark.Client,
    openId: string,
    workspaceId: string,
    sessionId: string,
    options?: { onWaiting?: () => void; initialHint?: string },
  ) {
    this.thread = thread;
    this.larkClient = larkClient;
    this.openId = openId;
    this.workspaceId = workspaceId;
    this.sessionId = sessionId;
    this.onWaiting = options?.onWaiting;
    this.initialHint = options?.initialHint;
  }

  async start(options?: {
    onWaiting?: () => void;
    onFinalized?: () => void;
    onCleanup?: () => void;
  }): Promise<FeishuStreamReplyHandle> {
    this.onWaiting = options?.onWaiting ?? this.onWaiting;
    this.callbacks = { onFinalized: options?.onFinalized, onCleanup: options?.onCleanup };

    this.controller = new FeishuCardStream(this.larkClient, this.openId);
    try {
      await this.controller.start(this.initialHint ?? getRandomAcknowledgment());
    } catch (err) {
      console.error('[FeishuStreamReply] Failed to start streaming card:', err);
      this.controller = null;
      throw err;
    }

    const handler = Object.assign(
      (_id: number, event: SseEvent) => {
        this.handleEvent(event);
      },
      {
        cleanup: () => {
          this.callbacks?.onCleanup?.();
          void this.finalize();
        },
      },
    );

    return {
      handler,
      finalize: () => this.finalize(),
      interrupt: (message: string) => this.interrupt(message),
    };
  }

  private handleEvent(event: SseEvent): void {
    if (this.finalized) {
      return;
    }

    switch (event.type) {
      case 'assistant_start':
        this.collecting = true;
        this.clearPlaceholderState();
        if (this.responseText && !this.responseText.endsWith('\n\n')) {
          this.responseText += '\n\n';
        }
        break;
      case 'text_delta':
        if (this.collecting) {
          this.clearPlaceholderState();
          this.responseText += event.text;
          this.updateController();
        }
        break;
      case 'thinking_start':
        if (this.collecting) {
          this.setPlaceholder('\n\n正在思考...');
        }
        break;
      case 'tool_use_start':
        if (this.collecting) {
          this.setPlaceholder(`\n\n🔧 ${event.toolName}...`);
        }
        break;
      case 'tool_result':
        this.clearPlaceholder();
        break;
      case 'subagent_start':
        if (this.collecting) {
          this.setPlaceholder(`\n\n🤖 ${event.description ?? '运行子代理'}...`);
        }
        break;
      case 'subagent_done':
        this.clearPlaceholder();
        break;
      case 'assistant_done':
        this.collecting = false;
        this.clearPlaceholder();
        break;
      case 'error_note':
        this.clearPlaceholder();
        if (event.text) {
          this.responseText += `\n\n⚠️ ${event.text}`;
        }
        this.updateController();
        void this.finalize();
        break;
      case 'result':
        this.clearPlaceholder();
        if (event.isError) {
          this.responseText += '\n\n⚠️ 处理失败，请稍后重试。';
        }
        this.updateController();
        void this.finalize();
        break;
      case 'interrupted':
        this.clearPlaceholder();
        this.updateController();
        void this.finalize();
        break;
      case 'pending_approval':
        this.signalWaiting();
        this.postApprovalCard(event);
        break;
      case 'pending_question':
        this.signalWaiting();
        this.postQuestionCard(event);
        break;
      case 'approval_timeout':
        this.sendTextMessage('⏰ 请求已超时，已按拒绝处理。');
        break;
      default:
        break;
    }
  }

  private setPlaceholder(text: string): void {
    if (this.visiblePlaceholder) return;
    this.visiblePlaceholder = text;
    this.updateController();
  }

  private clearPlaceholder(): void {
    if (!this.visiblePlaceholder) return;
    this.clearPlaceholderState();
    this.updateController();
  }

  private clearPlaceholderState(): void {
    this.visiblePlaceholder = '';
  }

  private updateController(): void {
    if (!this.controller) return;
    const content = this.responseText + this.visiblePlaceholder;
    // Feishu rejects empty/whitespace-only content updates (99992402 min len 1,
    // and zero-width spaces are normalized away too). When there is nothing
    // visible to show, skip the update entirely — the card keeps its last
    // content until real answer text arrives and overwrites it.
    if (!content || content.trim() === '') return;
    this.controller.setContent(content);
  }

  public interrupt(message: string): boolean {
    if (this.finalized) {
      return false;
    }
    this.clearPlaceholderState();
    if (this.responseText && !this.responseText.endsWith('\n\n')) {
      this.responseText += '\n\n';
    }
    this.responseText += message;
    this.updateController();
    void this.finalize();
    return true;
  }

  private signalWaiting(): void {
    if (this.waitingSignaled || !this.onWaiting) return;
    this.waitingSignaled = true;
    this.onWaiting();
  }

  private finalize(): Promise<void> {
    if (this.finalized) {
      return this.finishPromise ?? Promise.resolve();
    }
    this.finalized = true;
    this.collecting = false;
    this.clearPlaceholderState();
    this.updateController();

    if (!hasVisibleChar(this.responseText)) {
      this.responseText = FALLBACK_TEXT;
    }

    if (!this.controller) {
      // If the controller was never started (should not happen in normal flow),
      // there is nothing to finalize.
      this.emitFinalized();
      return Promise.resolve();
    }

    this.finishPromise = this.controller.finish(this.responseText).finally(() => {
      this.emitFinalized();
    });
    return this.finishPromise;
  }

  private emitFinalized(): void {
    if (this.finalizedNotified) return;
    this.finalizedNotified = true;
    this.callbacks?.onFinalized?.();
  }

  private postApprovalCard(event: Extract<SseEvent, { type: 'pending_approval' }>): void {
    if (this.seenPendingApprovals.has(event.requestId)) return;
    this.seenPendingApprovals.add(event.requestId);
    const card = buildApprovalCard({
      requestId: event.requestId,
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
      toolName: event.toolName,
      title: event.title,
      description: event.description,
      inputSummary: event.inputSummary,
    });
    this.sendCard(card).catch((err) => {
      console.error('[FeishuStreamReply] Failed to post approval card:', err);
    });
  }

  private postQuestionCard(event: Extract<SseEvent, { type: 'pending_question' }>): void {
    if (this.seenPendingQuestions.has(event.requestId)) return;
    this.seenPendingQuestions.add(event.requestId);
    feishuCardActionHandler.registerQuestion(event.requestId, event.questions);
    const card = buildQuestionCard({
      requestId: event.requestId,
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
      questions: event.questions,
    });
    this.sendCard(card).catch((err) => {
      console.error('[FeishuStreamReply] Failed to post question card:', err);
    });
  }

  private async sendCard(card: FeishuCard): Promise<void> {
    await this.larkClient.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: this.openId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
  }

  private sendTextMessage(text: string): void {
    sendPlainTextMessage(this.larkClient, this.openId, text).catch((err) => {
      console.error('[FeishuStreamReply] Failed to send text:', err);
    });
  }
}
