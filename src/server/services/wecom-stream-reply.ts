import type { TemplateCard, WsFrame } from '@wecom/aibot-node-sdk';
import type { SseEvent } from '../types/message.js';
import { debounce } from '../utils/debounce.js';
import { getRandomAcknowledgment } from '../utils/bot-placeholder.js';
import { splitWecomMessage } from '../utils/wecom-message-split.js';
import { buildToolApprovalCard, buildQuestionCard } from './wecom-template-card.js';
import { diagLog } from '../utils/diag-logger.js';

const THINKING_PLACEHOLDER = '\n\n收到，正在处理中.';
const THINKING_PLACEHOLDER_PREFIX = '\n\n收到，正在处理中';

/**
 * WeCom auto-ends a streaming passive reply 10 minutes after it starts. To
 * avoid a hard cutoff that leaves the user with a frozen message, fire a
 * safeguard at 9 minutes: tell the user the task needs more time, stop
 * refreshing the passive reply, and let WeCom end it on its own. The agent
 * keeps running; the final result is pushed proactively when it arrives.
 */
let SAFEGUARD_DELAY_MS = 9 * 60 * 1000;
const LONG_TASK_NOTICE = '任务处理需要更长的时间，在任务处理完成后，我将把结果发送给你。';

export function __setSafeguardDelayForTesting(ms: number): void {
  SAFEGUARD_DELAY_MS = ms;
}

export function __restoreSafeguardDelay(): void {
  SAFEGUARD_DELAY_MS = 9 * 60 * 1000;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface StreamReplyConnection {
  client: {
    replyStream: (frame: WsFrame<any>, streamId: string, text: string, finish?: boolean) => Promise<unknown>;
    replyStreamNonBlocking: (frame: WsFrame<any>, streamId: string, text: string, finish?: boolean) => Promise<unknown>;
    sendMessage: (userId: string, body: any) => Promise<unknown>;
  };
  /** Optional callback used to send a template-card message for pending approvals/questions. */
  sendTemplateCard?: (card: TemplateCard) => Promise<unknown>;
}

export interface StreamReplyResult {
  handler: ((id: number, event: SseEvent) => void) & { cleanup: () => void };
  finalizeStream: () => void;
  setPlaceholder: (text: string, animate?: boolean) => void;
  /**
   * If the passive stream is still open, append the interrupt marker and
   * finalize it. Returns `true` when the marker was written into the stream;
   * returns `false` when the stream was already finalized or the 9-minute
   * safeguard has fired (the caller should send the message proactively).
   */
  interrupt: (message: string) => boolean;
  /**
   * Append a resolved narrative block (e.g. a folded question/permission
   * receipt) into the passive stream WITHOUT finalizing it, so the agent's
   * continuation keeps streaming into the same bubble below the block. Mirrors
   * `interrupt` (clears the active placeholder, ensures one blank-line
   * separator, appends to the same buffer, flushes) minus the finalize. Returns
   * `false` and changes nothing when the stream is finalized, the 9-minute
   * safeguard has closed the passive reply, or the text is empty/whitespace.
   */
  appendNarrative: (text: string) => boolean;
}

export interface StreamReplyCallbacks {
  onFinalized?: () => void;
  onCleanup?: () => void;
}

export function createStreamReply(
  conn: StreamReplyConnection,
  frame: WsFrame<any>,
  sessionId: string,
  wecomUserId: string,
  callbacks?: StreamReplyCallbacks,
): StreamReplyResult {
  const streamId = `${sessionId}-${Date.now()}`;
  const placeholderMessage = getRandomAcknowledgment();

  let responseText = '';
  let collecting = false;
  let bubbleFinalized = false;
  // Index into responseText marking what has already been delivered (via the
  // passive bubble on the first result, or a proactive send thereafter). Each
  // later result delivers only responseText.slice(deliveredLength). It advances
  // only once a send is confirmed, so content whose delivery failed stays in
  // the next result's delta instead of being silently dropped.
  let deliveredLength = 0;
  // True once the 9-minute safeguard has fired: the passive reply is no longer
  // refreshed and the final result must be delivered proactively.
  let passiveClosed = false;
  // Serializes proactive deliveries: each terminal event's delta is computed
  // and sent only after the previous delivery settles, so chunks from two
  // overlapping results can never interleave on the wire.
  let proactiveTail: Promise<void> = Promise.resolve();
  let animationInterval: NodeJS.Timeout | null = null;
  let currentPlaceholder: string | null = null;
  let placeholderAnimationInterval: NodeJS.Timeout | null = null;
  let safeguardTimer: NodeJS.Timeout | null = null;
  let finalizedNotified = false;
  const sentTemplateCards = new Set<string>();

  diagLog(`[WeComStreamReply ${sessionId}] create streamId=${streamId} user=${wecomUserId}`);

  // Behavior-preserving send logger: logs attempt + settle (OK/FAIL) without
  // altering the promise chain the caller sees. Logs lengths/flags only — never
  // message content — to avoid leaking secrets.
  const logSend = (
    label: string,
    contentLen: number,
    finish: boolean | undefined,
    promise: Promise<unknown>,
  ): Promise<unknown> => {
    diagLog(
      `[WeComStreamReply ${sessionId}] send ${label} streamId=${streamId} user=${wecomUserId} len=${contentLen} finish=${finish === true}`,
    );
    return promise.then(
      (value) => {
        diagLog(`[WeComStreamReply ${sessionId}] send ${label} OK streamId=${streamId}`);
        return value;
      },
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        diagLog(`[WeComStreamReply ${sessionId}] send ${label} FAIL streamId=${streamId} err=${msg}`);
        throw err;
      },
    );
  };

  const clearSafeguardTimer = () => {
    if (safeguardTimer) {
      clearTimeout(safeguardTimer);
      safeguardTimer = null;
    }
  };

  const emitFinalized = () => {
    if (finalizedNotified) return;
    finalizedNotified = true;
    callbacks?.onFinalized?.();
  };

  const stopAnimation = () => {
    if (animationInterval) {
      clearInterval(animationInterval);
      animationInterval = null;
    }
  };

  const stopPlaceholderAnimation = () => {
    if (placeholderAnimationInterval) {
      clearInterval(placeholderAnimationInterval);
      placeholderAnimationInterval = null;
    }
  };

  const clearPlaceholder = () => {
    stopPlaceholderAnimation();
    if (currentPlaceholder) {
      if (responseText.endsWith(currentPlaceholder)) {
        responseText = responseText.slice(0, -currentPlaceholder.length);
      } else {
        const idx = responseText.lastIndexOf(currentPlaceholder);
        if (idx >= 0) {
          responseText = responseText.slice(0, idx) + responseText.slice(idx + currentPlaceholder.length);
        }
      }
      currentPlaceholder = null;
    }
  };

  // Start a cycling placeholder animation until the first token arrives
  let dotCount = 0;
  const sendAnimationFrame = () => {
    dotCount = (dotCount + 1) % 3;
    const text = `${placeholderMessage}${'.'.repeat(dotCount + 1)}`;
    conn.client.replyStreamNonBlocking(frame, streamId, text, false).catch((err: Error) => {
      console.error('Failed to send WeCom animation frame:', err);
    });
  };

  logSend(
    'placeholder',
    `${placeholderMessage}.`.length,
    false,
    conn.client.replyStream(frame, streamId, `${placeholderMessage}.`, false),
  ).catch((err: Error) => {
    console.error('Failed to send WeCom processing placeholder:', err);
  });
  animationInterval = setInterval(sendAnimationFrame, 600);
  safeguardTimer = setTimeout(fireSafeguard, SAFEGUARD_DELAY_MS);

  const flushStream = debounce(() => {
    // Skip passive refreshes once the safeguard has fired or the passive bubble
    // has already been finished on an earlier result.
    if (!responseText || passiveClosed || bubbleFinalized) return;
    conn.client.replyStreamNonBlocking(frame, streamId, responseText).catch((err: Error) => {
      console.error('Failed to send WeCom stream frame:', err);
    });
  }, 150);

  const setPlaceholder = (text: string, animate: boolean = false) => {
    // Placeholders are passive-display hints; do not add them once the passive
    // channel is closed (they are not part of the answer text) or the passive
    // bubble has already been finished on an earlier result.
    if (passiveClosed || bubbleFinalized) return;
    clearPlaceholder();
    currentPlaceholder = text;
    responseText += text;
    flushStream.flush();
    if (animate) {
      const baseText = text.replace(/\.*$/, '');
      let dotCount = 0;
      const myPlaceholder = text;
      placeholderAnimationInterval = setInterval(() => {
        if (currentPlaceholder !== myPlaceholder) return;
        dotCount = (dotCount + 1) % 3;
        const newPlaceholder = `${baseText}${'.'.repeat(dotCount + 1)}`;
        if (responseText.endsWith(currentPlaceholder)) {
          responseText = responseText.slice(0, -currentPlaceholder.length) + newPlaceholder;
        } else {
          const idx = responseText.lastIndexOf(currentPlaceholder);
          if (idx < 0) return;
          responseText = responseText.slice(0, idx) + newPlaceholder + responseText.slice(idx + currentPlaceholder.length);
        }
        currentPlaceholder = newPlaceholder;
        conn.client.replyStreamNonBlocking(frame, streamId, responseText).catch((err: Error) => {
          console.error('Failed to send WeCom placeholder animation frame:', err);
        });
      }, 600);
    }
  };

  // Fast path: the turn finished before the safeguard. Finalize the passive
  // reply with finish=true, falling back to a proactive message on send error.
  const finalizeStream = () => {
    if (bubbleFinalized) return;
    diagLog(
      `[WeComStreamReply ${sessionId}] finalizeStream streamId=${streamId} len=${responseText.length} passiveClosed=${passiveClosed}`,
    );
    clearSafeguardTimer();
    bubbleFinalized = true;
    // Snapshot the bubble payload: later turns keep growing responseText, and
    // the async fallback below must send exactly what the bubble was meant to
    // show — not content a proactive delivery may already have covered.
    const finalText = responseText;
    collecting = false;
    stopAnimation();
    stopPlaceholderAnimation();
    flushStream.abort();

    const markBubbleDelivered = () => {
      // Never move the cursor backward if a proactive delivery already ran ahead.
      deliveredLength = Math.max(deliveredLength, finalText.length);
    };

    logSend('final', finalText.length, true, conn.client.replyStream(frame, streamId, finalText, true))
      .then(() => {
        // The bubble shows the full snapshot: mark it delivered. If the final
        // frame fails instead, the cursor stays put so a later result's delta
        // still carries this content.
        markBubbleDelivered();
      })
      .catch((err: Error) => {
        console.error('Failed to send WeCom stream final frame:', err);
        diagLog(`[WeComStreamReply ${sessionId}] final replyStream failed, falling back to sendMessage`);
        if (finalText.trim()) {
          logSend(
            'final-fallback',
            finalText.length,
            undefined,
            conn.client.sendMessage(wecomUserId, {
              msgtype: 'markdown',
              markdown: { content: finalText },
            }),
          )
            .then(() => {
              markBubbleDelivered();
            })
            .catch((fallbackErr: Error) => {
              console.error('Failed to send WeCom fallback response:', fallbackErr);
            });
        }
      });
    emitFinalized();
  };

  // Proactive path: the safeguard already fired, or the passive bubble already
  // closed on an earlier result. Push only the new content since the last
  // delivery via sendMessage, split into byte-safe chunks, guarding empties and
  // retrying a failed chunk once before aborting the remainder. The whole batch
  // advances the cursor only when every chunk is confirmed; an aborted batch
  // leaves its unsent tail inside the next result's delta (a rare duplicate
  // beats a silent drop).
  const deliverNewContent = (): Promise<void> => {
    const startLength = deliveredLength;
    const rawDelta = responseText.slice(startLength);
    const body = rawDelta.trim();
    if (!body) return Promise.resolve(); // nothing new to deliver (AE3)
    // Offset of `body` inside rawDelta: rawDelta = leading whitespace + body +
    // trailing whitespace, and only the body went on the wire.
    const leadTrim = rawDelta.length - rawDelta.trimStart().length;
    const chunks = splitWecomMessage(body);
    diagLog(`[WeComStreamReply ${sessionId}] finalizeProactive streamId=${streamId} len=${body.length} chunks=${chunks.length}`);
    emitFinalized();
    let aborted = false;
    const sendOne = (chunk: string, index: number): Promise<void> =>
      logSend(
        `proactive#${index + 1}/${chunks.length}`,
        chunk.length,
        undefined,
        conn.client.sendMessage(wecomUserId, { msgtype: 'markdown', markdown: { content: chunk } }),
      )
        .catch((err: Error) => {
          console.error('Failed to send WeCom proactive chunk, retrying:', err);
          return conn.client.sendMessage(wecomUserId, { msgtype: 'markdown', markdown: { content: chunk } });
        })
        .catch((err: Error) => {
          console.error('Failed to send WeCom proactive chunk after retry, aborting:', err);
          diagLog(
            `[WeComStreamReply ${sessionId}] proactive chunk ${index + 1}/${chunks.length} FAIL after retry, aborting remainder`,
          );
          aborted = true;
        })
        .then(() => undefined);
    return chunks
      .reduce<Promise<void>>(
        (p, chunk, index) => p.then(() => (aborted ? Promise.resolve() : sendOne(chunk, index))),
        Promise.resolve(),
      )
      .then(() => {
        if (!aborted) {
          deliveredLength = Math.max(deliveredLength, startLength + leadTrim + body.length);
        }
      })
      .catch((err: Error) => {
        console.error('Failed to deliver WeCom proactive result:', err);
      });
  };

  const finalizeProactive = () => {
    clearSafeguardTimer();
    collecting = false;
    clearPlaceholder();
    // Queue behind any in-flight delivery: the delta is computed inside the
    // tail task so it always starts from the latest confirmed cursor, and two
    // terminal events can never interleave chunks on the wire.
    proactiveTail = proactiveTail.then(deliverNewContent, deliverNewContent);
  };

  // Route a terminal event to the right finalize path.
  const handleTerminal = () => {
    clearSafeguardTimer();
    // First terminal event finishes the passive bubble; every later one (or any
    // after the safeguard) delivers its new content proactively.
    if (passiveClosed || bubbleFinalized) {
      finalizeProactive();
    } else {
      finalizeStream();
    }
  };

  // 9-minute safeguard: notify the user, stop passive refresh, let WeCom end
  // the stream. The agent keeps running; finalizeProactive delivers later.
  function fireSafeguard() {
    safeguardTimer = null;
    if (passiveClosed || bubbleFinalized) return;
    diagLog(`[WeComStreamReply ${sessionId}] safeguard fired streamId=${streamId}; passive reply closed, switching to proactive`);
    passiveClosed = true;
    stopAnimation();
    stopPlaceholderAnimation();
    flushStream.abort();
    logSend(
      'safeguard-notice',
      LONG_TASK_NOTICE.length,
      undefined,
      conn.client.sendMessage(wecomUserId, { msgtype: 'markdown', markdown: { content: LONG_TASK_NOTICE } }),
    ).catch((err: Error) => {
      console.error('Failed to send WeCom long-task notice:', err);
    });
  }

  const interrupt = (message: string): boolean => {
    if (bubbleFinalized || passiveClosed) {
      diagLog(`[WeComStreamReply ${sessionId}] interrupt skipped: bubbleFinalized=${bubbleFinalized}, passiveClosed=${passiveClosed}`);
      return false;
    }
    clearPlaceholder();
    if (responseText && !responseText.endsWith('\n\n')) {
      responseText += '\n\n';
    }
    responseText += message;
    diagLog(`[WeComStreamReply ${sessionId}] appending interrupt marker, finalizing stream`);
    handleTerminal();
    return true;
  };

  const appendNarrative = (text: string): boolean => {
    if (bubbleFinalized || passiveClosed) {
      diagLog(
        `[WeComStreamReply ${sessionId}] appendNarrative skipped: bubbleFinalized=${bubbleFinalized}, passiveClosed=${passiveClosed}`,
      );
      return false;
    }
    if (!text || !text.trim()) {
      return false;
    }
    clearPlaceholder();
    if (responseText && !responseText.endsWith('\n\n')) {
      responseText += '\n\n';
    }
    responseText += text;
    diagLog(
      `[WeComStreamReply ${sessionId}] appending narrative block (no finalize) len=${text.length}`,
    );
    flushStream.flush();
    return true;
  };

  const handler = Object.assign(
    (id: number, event: SseEvent) => {
      // Terminal events keep arriving after the passive bubble is finished (the
      // SDK may emit more than one result per run); each one is delivered below.
      if (event.type === 'assistant_start') {
        diagLog(`[WeComStreamReply ${sessionId}] handler event=assistant_start streamId=${streamId}`);
        collecting = true;
        clearPlaceholder();
        if (responseText && !responseText.endsWith('\n\n')) {
          responseText += '\n\n';
        }
      } else if (collecting && event.type === 'text_delta') {
        stopAnimation();
        clearPlaceholder();
        responseText += event.text;
        flushStream();
      } else if (collecting && event.type === 'thinking_start') {
        setPlaceholder(THINKING_PLACEHOLDER, true);
      } else if (collecting && event.type === 'tool_use_start') {
        clearPlaceholder();
        setPlaceholder(`\n\n🔧 ${event.toolName}...`, false);
      } else if (event.type === 'tool_result') {
        clearPlaceholder();
      } else if (event.type === 'subagent_start') {
        clearPlaceholder();
        setPlaceholder(`\n\n🤖 ${event.description ?? 'Running subagent'}...`, false);
      } else if (event.type === 'subagent_done') {
        clearPlaceholder();
      } else if (collecting && event.type === 'assistant_done') {
        collecting = false;
        stopAnimation();
        if (currentPlaceholder && currentPlaceholder.startsWith(THINKING_PLACEHOLDER_PREFIX)) {
          clearPlaceholder();
        }
        flushStream.flush();
      } else if (event.type === 'error_note') {
        diagLog(`[WeComStreamReply ${sessionId}] handler event=error_note streamId=${streamId}`);
        clearPlaceholder();
        if (event.text) {
          responseText += `\n\n⚠️ ${event.text}`;
        }
        handleTerminal();
      } else if (event.type === 'result') {
        diagLog(`[WeComStreamReply ${sessionId}] handler event=result isError=${event.isError} streamId=${streamId}`);
        clearPlaceholder();
        if (event.isError) {
          responseText += '\n\n⚠️ 处理失败，请稍后重试。';
        }
        handleTerminal();
      } else if (event.type === 'interrupted') {
        diagLog(`[WeComStreamReply ${sessionId}] handler event=interrupted streamId=${streamId}`);
        clearPlaceholder();
        handleTerminal();
      } else if (event.type === 'pending_approval') {
        if (sentTemplateCards.has(event.requestId)) return;
        sentTemplateCards.add(event.requestId);
        const card = buildToolApprovalCard({
          requestId: event.requestId,
          sessionId,
          toolName: event.toolName,
          title: event.title,
          description: event.description,
          taskId: event.requestId,
        });
        diagLog(`[WeComStreamReply ${sessionId}] send approval-card requestId=${event.requestId} tool=${event.toolName}`);
        conn.sendTemplateCard?.(card).then(
          () => diagLog(`[WeComStreamReply ${sessionId}] send approval-card OK requestId=${event.requestId}`),
          (err: Error) => {
            console.error('Failed to send WeCom approval card:', err);
            diagLog(`[WeComStreamReply ${sessionId}] send approval-card FAIL requestId=${event.requestId} err=${err.message}`);
          },
        );
      } else if (event.type === 'pending_question') {
        if (sentTemplateCards.has(event.requestId)) return;
        sentTemplateCards.add(event.requestId);
        const card = buildQuestionCard({
          requestId: event.requestId,
          sessionId,
          questions: event.questions,
          taskId: event.requestId,
        });
        diagLog(`[WeComStreamReply ${sessionId}] send question-card requestId=${event.requestId}`);
        conn.sendTemplateCard?.(card).then(
          () => diagLog(`[WeComStreamReply ${sessionId}] send question-card OK requestId=${event.requestId}`),
          (err: Error) => {
            console.error('Failed to send WeCom question card:', err);
            diagLog(`[WeComStreamReply ${sessionId}] send question-card FAIL requestId=${event.requestId} err=${err.message}`);
          },
        );
      }
    },
    {
      cleanup: () => {
        diagLog(
          `[WeComStreamReply ${sessionId}] handler cleanup streamId=${streamId} finalized=${bubbleFinalized} (removes active stream-reply registration)`,
        );
        stopAnimation();
        stopPlaceholderAnimation();
        clearSafeguardTimer();
        flushStream.abort();
        callbacks?.onCleanup?.();
      },
    },
  );

  return { handler, finalizeStream, setPlaceholder, interrupt, appendNarrative };
}
