import type * as lark from '@larksuiteoapi/node-sdk';
import { randomUUID } from 'crypto';
import { buildStreamingAnswerCard } from './feishu-card-builder.js';
import { diagWarn } from '../utils/diag-logger.js';

const DEFAULT_THROTTLE_MS = 100;
const DEFAULT_THROTTLE_CHARS = 50;
const STREAM_ELEMENT_ID = 'stream_md';

export interface FeishuCardStreamOptions {
  streamThrottleMs?: number;
  streamThrottleChars?: number;
}

export interface FeishuCardStreamStartResult {
  cardId: string;
  messageId: string;
}

class ContentThrottle {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingChars = 0;
  private lastFireAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(
    private fn: () => Promise<void>,
    private ms: number,
    private chars: number,
  ) {}

  note(deltaChars: number): void {
    this.pendingChars += deltaChars;
    if (this.pendingChars >= this.chars) {
      this.fireSoon(0);
      return;
    }
    if (!this.timer) {
      const elapsed = Date.now() - this.lastFireAt;
      const wait = Math.max(0, this.ms - elapsed);
      this.fireSoon(wait);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      await this.inFlight;
    }
    await this.doFire();
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private fireSoon(delay: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.doFire();
    }, delay);
  }

  private async doFire(): Promise<void> {
    if (this.inFlight) {
      this.fireSoon(this.ms);
      return;
    }
    const p = (async () => {
      this.pendingChars = 0;
      this.lastFireAt = Date.now();
      await this.fn();
    })();
    this.inFlight = p;
    try {
      await p;
    } finally {
      this.inFlight = null;
    }
  }
}

export class FeishuCardStream {
  private larkClient: lark.Client;
  private openId: string;
  private throttleMs: number;
  private throttleChars: number;

  private cardId: string | null = null;
  private messageId: string | null = null;
  private sequence = 0;
  private pendingText = '';
  private failed = false;
  private finalized = false;
  private finishPromise: Promise<void> | null = null;
  private throttle: ContentThrottle;

  constructor(
    larkClient: lark.Client,
    openId: string,
    options?: FeishuCardStreamOptions,
  ) {
    this.larkClient = larkClient;
    this.openId = openId;
    this.throttleMs = options?.streamThrottleMs ?? DEFAULT_THROTTLE_MS;
    this.throttleChars = options?.streamThrottleChars ?? DEFAULT_THROTTLE_CHARS;
    this.throttle = new ContentThrottle(
      () => this.pushContent(),
      this.throttleMs,
      this.throttleChars,
    );
  }

  async start(initialText: string): Promise<FeishuCardStreamStartResult> {
    const cardSpec = buildStreamingAnswerCard(initialText);
    const createRes = (await this.larkClient.cardkit.v1.card.create({
      data: { type: 'card_json', data: JSON.stringify(cardSpec) },
    })) as unknown;

    const cardId = (createRes as { data?: { card_id?: string } }).data?.card_id;
    if (!cardId) {
      throw new Error('cardkit.v1.card.create returned no card_id');
    }
    this.cardId = cardId;
    this.pendingText = initialText;

    const sendRes = (await this.larkClient.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: this.openId,
        msg_type: 'interactive',
        content: JSON.stringify({
          type: 'card',
          data: { card_id: cardId },
        }),
      },
    })) as unknown;

    const messageId = (sendRes as { data?: { message_id?: string } }).data?.message_id;
    if (!messageId) {
      throw new Error('im.v1.message.create returned no message_id');
    }
    this.messageId = messageId;

    return { cardId, messageId };
  }

  setContent(text: string): void {
    if (this.failed || this.finalized || !this.cardId) return;
    if (!text || text === this.pendingText) return;

    const deltaChars = Math.max(1, Math.abs(text.length - this.pendingText.length));
    this.pendingText = text;
    this.throttle.note(deltaChars);
  }

  finish(text?: string): Promise<void> {
    if (this.finalized) {
      return this.finishPromise ?? Promise.resolve();
    }
    this.finalized = true;
    if (text !== undefined && !this.failed) {
      this.pendingText = text;
    }
    this.finishPromise = this.doFinish();
    return this.finishPromise;
  }

  private async doFinish(): Promise<void> {
    try {
      await this.throttle.flush();
      if (!this.cardId) return;

      const summary = truncateSummary(this.pendingText);
      const config: Record<string, unknown> = { streaming_mode: false };
      if (summary) {
        config.summary = { content: summary };
      }
      await this.larkClient.cardkit.v1.card.settings({
        path: { card_id: this.cardId },
        data: {
          settings: JSON.stringify({ config }),
          sequence: ++this.sequence,
          uuid: randomUUID(),
        },
      });
    } catch (err) {
      diagWarn('[FeishuCardStream] finish settings failed:', formatApiError(err));
    } finally {
      this.throttle.dispose();
    }
  }

  private async pushContent(): Promise<void> {
    if (!this.cardId || this.failed) return;
    try {
      await this.larkClient.cardkit.v1.cardElement.content({
        path: { card_id: this.cardId, element_id: STREAM_ELEMENT_ID },
        data: {
          content: this.pendingText,
          sequence: ++this.sequence,
          uuid: randomUUID(),
        },
      });
    } catch (err) {
      this.failed = true;
      diagWarn('[FeishuCardStream] content update failed:', formatApiError(err));
    }
  }
}

function formatApiError(err: unknown): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const axiosErr = err as {
      message?: string;
      response?: {
        status?: number;
        data?: {
          code?: number | string;
          msg?: string;
          error?: unknown;
          field_violations?: Array<{ field?: string; description?: string }>;
        };
      };
    };
    const status = axiosErr.response?.status;
    const body = axiosErr.response?.data;
    const violations = body?.field_violations
      ?.map((v) => `${v.field ?? '?'}: ${v.description ?? 'invalid'}`)
      .join('; ');
    const payload = JSON.stringify({
      status,
      code: body?.code,
      msg: body?.msg,
      field_violations: body?.field_violations,
    });
    return `${axiosErr.message ?? 'unknown'} ${payload}${violations ? ` [${violations}]` : ''}`;
  }
  return String(err);
}

function truncateSummary(text: string, max = 50): string {
  if (!text) return '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max - 1) + '…';
}
