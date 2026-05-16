import type { Response } from 'express';
import type {
  Options,
  SDKMessage,
  SDKUserMessage,
  PermissionResult,
  Query,
} from '@anthropic-ai/claude-agent-sdk';
import type { SseEvent, QuestionPayload } from '../types/message.js';
import { PushableIterator } from './pushable-iterator.js';
import { SseEmitter } from './sse-emitter.js';
import { SdkClient } from './sdk-client.js';


const RING_BUFFER_CAP = 500;

export class SessionRuntime {
  private sessionId: string;
  private serverNonce: string;
  private options: Options;
  private sdkClient: SdkClient;
  private input: PushableIterator<SDKUserMessage>;
  private query!: Query;
  private emitter: SseEmitter;
  private ringBuffer: Array<{ id: string; event: SseEvent }> = [];
  private pendingApprovals = new Map<
    string,
    { resolve: (result: PermissionResult) => void }
  >();
  private closed = false;
  private messageLoopPromise: Promise<void> = Promise.resolve();

  static open(
    sessionId: string,
    serverNonce: string,
    options: Options,
    sdkClient: SdkClient,
  ): SessionRuntime {
    const input = new PushableIterator<SDKUserMessage>();
    const runtime = new SessionRuntime(
      sessionId,
      serverNonce,
      input,
      options,
      sdkClient,
    );
    runtime.start();
    return runtime;
  }

  private constructor(
    sessionId: string,
    serverNonce: string,
    input: PushableIterator<SDKUserMessage>,
    options: Options,
    sdkClient: SdkClient,
  ) {
    this.sessionId = sessionId;
    this.serverNonce = serverNonce;
    this.input = input;
    this.options = options;
    this.sdkClient = sdkClient;
    this.emitter = new SseEmitter(null, (id, event) => {
      this.ringBuffer.push({ id: String(id), event });
      if (this.ringBuffer.length > RING_BUFFER_CAP) {
        this.ringBuffer.shift();
      }
    });
  }

  private start(): void {
    const optionsWithCallback: Options = {
      ...this.options,
      canUseTool: this.buildCanUseToolCallback(),
    };
    const { query, messages } = this.sdkClient.createStreamingQuery(
      this.input,
      optionsWithCallback,
    );
    this.query = query;
    this.messageLoopPromise = this.runMessageLoop(messages);
  }

  private async runMessageLoop(
    messages: AsyncGenerator<SDKMessage>,
  ): Promise<void> {
    try {
      for await (const msg of messages) {
        if (this.closed) break;
        this.emitter.handle(msg);
      }
    } catch (err) {
      console.error('SessionRuntime message loop error:', err);
      this.emitter.emitErrorNote(
        `Stream error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private buildCanUseToolCallback() {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      options: {
        signal: AbortSignal;
        suggestions?: import('@anthropic-ai/claude-agent-sdk').PermissionUpdate[];
        title?: string;
        description?: string;
        toolUseID: string;
      },
    ): Promise<PermissionResult> => {
      const requestId = options.toolUseID;

      if (toolName === 'AskUserQuestion') {
        const questions = this.parseAskUserQuestion(input);
        this.emitter.emitPendingQuestion(requestId, questions);
      } else {
        this.emitter.emitPendingApproval(
          requestId,
          toolName,
          options.toolUseID,
          input,
          options.title,
          options.description,
          options.suggestions,
        );
      }

      return new Promise<PermissionResult>((resolve) => {
        this.pendingApprovals.set(requestId, { resolve });

        if (options.signal) {
          const onAbort = () => {
            this.pendingApprovals.delete(requestId);
            this.emitter.emitApprovalResolved(requestId);
            resolve({
              behavior: 'deny',
              message: `Tool approval aborted by SDK: ${requestId}`,
            });
          };
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    };
  }

  private parseAskUserQuestion(
    input: Record<string, unknown>,
  ): QuestionPayload[] {
    const questions = input.questions;
    if (!Array.isArray(questions)) return [];
    return questions.map((q: unknown) => {
      const qx = q as Record<string, unknown>;
      return {
        question: typeof qx.question === 'string' ? qx.question : '',
        header: typeof qx.header === 'string' ? qx.header : undefined,
        options: Array.isArray(qx.options)
          ? qx.options.map((o: unknown) => {
              const ox = o as Record<string, unknown>;
              return {
                label: typeof ox.label === 'string' ? ox.label : '',
                description:
                  typeof ox.description === 'string'
                    ? ox.description
                    : undefined,
                preview:
                  typeof ox.preview === 'string' ? ox.preview : undefined,
              };
            })
          : [],
        multiSelect: qx.multiSelect === true,
      };
    });
  }

  subscribe(res: Response, lastEventId?: string): void {
    this.emitter.setResponse(res);
    this.emitter.emitSubscriptionAck(this.serverNonce, this.sessionId);
    if (lastEventId !== undefined) {
      this.replayFrom(lastEventId, res);
    }
  }

  unsubscribe(): void {
    this.emitter.setResponse(null);
  }

  pushMessage(content: string): void {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    };
    this.input.push(msg);
  }

  resolveApproval(requestId: string, result: PermissionResult): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;
    this.pendingApprovals.delete(requestId);
    this.emitter.emitApprovalResolved(requestId);
    pending.resolve(result);
  }

  async interrupt(): Promise<void> {
    try {
      await this.query.interrupt();
      this.emitter.emitInterrupted(null);
    } catch (err) {
      console.error('Interrupt failed:', err);
      this.emitter.emitErrorNote(
        `Interrupt failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  private replayFrom(lastEventId: string, res: Response): void {
    const startIndex = this.ringBuffer.findIndex(
      (item) => item.id === lastEventId,
    );
    if (startIndex < 0) {
      for (const item of this.ringBuffer) {
        res.write(SseEmitter.formatSsePayload(item.id, item.event));
      }
      this.emitter.emitErrorNote(
        'Some output may have been missed due to reconnect.',
      );
      return;
    }
    for (let i = startIndex + 1; i < this.ringBuffer.length; i++) {
      const item = this.ringBuffer[i];
      res.write(SseEmitter.formatSsePayload(item.id, item.event));
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.input.close();
    try {
      await this.query.interrupt();
    } catch {
      // Ignore interrupt errors during close
    }
    await this.messageLoopPromise.catch(() => {});
  }
}
