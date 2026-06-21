import type { Thread, StreamChunk } from 'chat';
import * as lark from '@larksuiteoapi/node-sdk';
import type { SseEvent } from '../types/message.js';
import {
  buildApprovalCard,
  buildQuestionCard,
  type FeishuCard,
} from './feishu-card-builder.js';
import { feishuCardActionHandler } from './feishu-card-action-handler.js';

interface QueueItem {
  value?: StreamChunk;
  done?: boolean;
  error?: Error;
}

export interface FeishuStreamReplyHandle {
  handler: ((id: number, event: SseEvent) => void) & { cleanup: () => void };
  stream: AsyncIterable<StreamChunk>;
  finalize: () => void;
}

export class FeishuStreamReply {
  private thread: Thread;
  private larkClient: lark.Client;
  private openId: string;
  private workspaceId: string;
  private sessionId: string;
  private onWaiting?: () => void;

  private queue: QueueItem[] = [];
  private pendingResolve: (() => void) | null = null;
  private finalized = false;
  private waitingSignaled = false;
  private collecting = false;
  private buffer = '';
  private placeholderActive = false;
  private seenPendingApprovals = new Set<string>();
  private seenPendingQuestions = new Set<string>();

  constructor(
    thread: Thread,
    larkClient: lark.Client,
    openId: string,
    workspaceId: string,
    sessionId: string,
    options?: { onWaiting?: () => void },
  ) {
    this.thread = thread;
    this.larkClient = larkClient;
    this.openId = openId;
    this.workspaceId = workspaceId;
    this.sessionId = sessionId;
    this.onWaiting = options?.onWaiting;
  }

  start(options?: { onWaiting?: () => void }): FeishuStreamReplyHandle {
    this.onWaiting = options?.onWaiting ?? this.onWaiting;
    const handler = Object.assign(
      (_id: number, event: SseEvent) => {
        this.handleEvent(event);
      },
      {
        cleanup: () => {
          this.finalize();
        },
      },
    );

    return {
      handler,
      stream: this.makeStream(),
      finalize: () => this.finalize(),
    };
  }

  private handleEvent(event: SseEvent): void {
    if (this.finalized) {
      // After the stream has finalized, only approval/question/timeout cards
      // that were already in-flight may still arrive. Ignore stream events.
      return;
    }

    switch (event.type) {
      case 'assistant_start':
        this.collecting = true;
        this.clearPlaceholder();
        break;
      case 'text_delta':
        if (this.collecting) {
          this.clearPlaceholder();
          this.buffer += event.text;
          this.enqueue({ type: 'markdown_text', text: event.text });
        }
        break;
      case 'thinking_start':
        this.setPlaceholder('\n\n正在思考...');
        break;
      case 'tool_use_start':
        this.setPlaceholder(`\n\n🔧 ${event.toolName}...`);
        break;
      case 'tool_result':
        this.clearPlaceholder();
        break;
      case 'subagent_start':
        this.setPlaceholder(`\n\n🤖 ${event.description ?? '运行子代理'}...`);
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
          this.buffer += `\n\n⚠️ ${event.text}`;
          this.enqueue({ type: 'markdown_text', text: `\n\n⚠️ ${event.text}` });
        }
        this.finalize();
        break;
      case 'result':
        this.clearPlaceholder();
        if (event.isError) {
          const text = '\n\n⚠️ 处理失败，请稍后重试。';
          this.buffer += text;
          this.enqueue({ type: 'markdown_text', text });
        }
        this.finalize();
        break;
      case 'interrupted':
        this.clearPlaceholder();
        this.finalize();
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
        this.sendText('⏰ 请求已超时，已按拒绝处理。');
        break;
      default:
        break;
    }
  }

  private setPlaceholder(text: string): void {
    if (this.placeholderActive) return;
    this.placeholderActive = true;
    this.buffer += text;
    this.enqueue({ type: 'markdown_text', text });
  }

  private clearPlaceholder(): void {
    if (!this.placeholderActive) return;
    this.placeholderActive = false;
  }

  private enqueue(chunk: StreamChunk): void {
    this.queue.push({ value: chunk });
    if (this.pendingResolve) {
      this.pendingResolve();
      this.pendingResolve = null;
    }
  }

  private signalWaiting(): void {
    if (this.waitingSignaled || !this.onWaiting) return;
    this.waitingSignaled = true;
    this.onWaiting();
  }

  private finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.collecting = false;
    this.clearPlaceholder();
    this.queue.push({ done: true });
    if (this.pendingResolve) {
      this.pendingResolve();
      this.pendingResolve = null;
    }
  }

  private async nextItem(): Promise<QueueItem> {
    while (this.queue.length === 0) {
      await new Promise<void>((resolve) => {
        this.pendingResolve = resolve;
      });
    }
    return this.queue.shift()!;
  }

  private async *makeStream(): AsyncIterable<StreamChunk> {
    // Opening placeholder so the user sees immediate feedback.
    yield { type: 'markdown_text', text: '收到，正在处理...' };

    while (true) {
      const item = await this.nextItem();
      if (item.error) throw item.error;
      if (item.done) return;
      if (item.value) yield item.value;
    }
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
    await this.larkClient.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: this.openId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
  }

  private sendText(text: string): void {
    this.sendCard({
      config: { wide_screen_mode: true },
      elements: [{ tag: 'div', text: { tag: 'plain_text', content: text } }],
    }).catch((err) => {
      console.error('[FeishuStreamReply] Failed to send text card:', err);
    });
  }
}
