import type { WsFrame } from '@wecom/aibot-node-sdk';
import type { SseEvent } from '../types/message.js';
import { debounce } from '../utils/debounce.js';

export interface StreamReplyConnection {
  client: {
    replyStream: (frame: WsFrame<any>, streamId: string, text: string, finish?: boolean) => Promise<unknown>;
    replyStreamNonBlocking: (frame: WsFrame<any>, streamId: string, text: string, finish?: boolean) => Promise<unknown>;
    sendMessage: (userId: string, body: any) => Promise<unknown>;
  };
}

export interface StreamReplyResult {
  handler: ((id: number, event: SseEvent) => void) & { cleanup: () => void };
  finalizeStream: () => void;
  setPlaceholder: (text: string, animate?: boolean) => void;
}

export function createStreamReply(
  conn: StreamReplyConnection,
  frame: WsFrame<any>,
  sessionId: string,
  wecomUserId: string,
): StreamReplyResult {
  const streamId = `${sessionId}-${Date.now()}`;

  let responseText = '';
  let collecting = false;
  let streamFinalized = false;
  let animationInterval: NodeJS.Timeout | null = null;
  let currentPlaceholder: string | null = null;
  let placeholderAnimationInterval: NodeJS.Timeout | null = null;

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
    const text = `收到，正在处理中${'.'.repeat(dotCount + 1)}`;
    conn.client.replyStreamNonBlocking(frame, streamId, text, false).catch((err: Error) => {
      console.error('Failed to send WeCom animation frame:', err);
    });
  };

  conn.client.replyStream(frame, streamId, '收到，正在处理中.', false).catch((err: Error) => {
    console.error('Failed to send WeCom processing placeholder:', err);
  });
  animationInterval = setInterval(sendAnimationFrame, 600);

  const flushStream = debounce(() => {
    if (!responseText) return;
    conn.client.replyStreamNonBlocking(frame, streamId, responseText).catch((err: Error) => {
      console.error('Failed to send WeCom stream frame:', err);
    });
  }, 150);

  const setPlaceholder = (text: string, animate: boolean = false) => {
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

  const finalizeStream = () => {
    streamFinalized = true;
    collecting = false;
    stopAnimation();
    stopPlaceholderAnimation();
    flushStream.abort();

    conn.client.replyStream(frame, streamId, responseText, true).catch((err: Error) => {
      console.error('Failed to send WeCom stream final frame:', err);
      if (responseText.trim()) {
        conn.client.sendMessage(wecomUserId, {
          msgtype: 'markdown',
          markdown: { content: responseText },
        }).catch((fallbackErr: Error) => {
          console.error('Failed to send WeCom fallback response:', fallbackErr);
        });
      }
    });
  };

  const handler = Object.assign(
    (id: number, event: SseEvent) => {
      if (streamFinalized) return;

      if (event.type === 'assistant_start') {
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
        setPlaceholder('\n\n收到，正在处理中.', true);
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
        if (currentPlaceholder && currentPlaceholder.includes('收到，正在处理中')) {
          clearPlaceholder();
        }
        flushStream.flush();
      } else if (event.type === 'error_note') {
        clearPlaceholder();
        if (event.text) {
          responseText += `\n\n⚠️ ${event.text}`;
        }
        finalizeStream();
      } else if (event.type === 'result') {
        clearPlaceholder();
        if (event.isError) {
          responseText += '\n\n⚠️ 处理失败，请稍后重试。';
        }
        finalizeStream();
      } else if (event.type === 'interrupted') {
        clearPlaceholder();
        finalizeStream();
      }
    },
    {
      cleanup: () => {
        stopAnimation();
        stopPlaceholderAnimation();
        flushStream.abort();
      },
    },
  );

  return { handler, finalizeStream, setPlaceholder };
}
