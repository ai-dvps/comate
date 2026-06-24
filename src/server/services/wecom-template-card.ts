/**
 * WeCom template card helpers: builders, key encoding/decoding, event parsing,
 * and terminal-state card generation.
 *
 * Encapsulates all template-card payload construction so that wecom-bot-service
 * and wecom-stream-reply do not duplicate card logic.
 */

import type { TemplateCard, TemplateCardEventData, WsFrame } from '@wecom/aibot-node-sdk';
import type {
  ToolApprovalAction,
  DecodedKeyPayload,
  ParsedCardEvent,
  ToolApprovalCardOptions,
  QuestionCardOptions,
} from '../types/wecom-template-card.js';

const KEY_PREFIX = 'comate:1:';
const MAX_KEY_BYTES = 1024;

/** Encode a compact JSON payload into a base64url string. */
function encodePayload(payload: { r: string; a: ToolApprovalAction; s: string }): string {
  const json = JSON.stringify(payload);
  // base64url: replace + with -, / with _, drop trailing =
  const base64 = Buffer.from(json, 'utf-8').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a base64url string back to the original JSON payload. */
function decodePayload(encoded: string): { r: string; a: ToolApprovalAction; s: string } {
  // Restore base64 padding
  const padLen = (4 - (encoded.length % 4)) % 4;
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  const json = Buffer.from(base64, 'base64').toString('utf-8');
  return JSON.parse(json) as { r: string; a: ToolApprovalAction; s: string };
}

/**
 * Encode {requestId, action, sessionId} into a versioned button key.
 * Returns the full key with the `comate:1:` prefix.
 * Throws if the encoded key exceeds 1024 bytes.
 */
export function encodeButtonKey(
  requestId: string,
  action: ToolApprovalAction,
  sessionId: string,
): string {
  const payload = encodePayload({ r: requestId, a: action, s: sessionId });
  const key = `${KEY_PREFIX}${payload}`;
  const byteLength = Buffer.byteLength(key, 'utf-8');
  if (byteLength > MAX_KEY_BYTES) {
    throw new Error(
      `Encoded button key exceeds ${MAX_KEY_BYTES} bytes (${byteLength} bytes)`,
    );
  }
  return key;
}

/**
 * Decode a button key back to its payload.
 * Returns undefined for non-Comate keys or malformed payloads.
 */
export function decodeButtonKey(key: string): DecodedKeyPayload | undefined {
  if (!key.startsWith(KEY_PREFIX)) return undefined;
  const encoded = key.slice(KEY_PREFIX.length);
  if (!encoded) return undefined;
  try {
    const decoded = decodePayload(encoded);
    if (
      typeof decoded.r !== 'string' ||
      typeof decoded.s !== 'string' ||
      !isValidAction(decoded.a)
    ) {
      return undefined;
    }
    return { requestId: decoded.r, action: decoded.a, sessionId: decoded.s };
  } catch {
    return undefined;
  }
}

function isValidAction(a: unknown): a is ToolApprovalAction {
  return a === 'allow' || a === 'always_allow' || a === 'deny';
}

/**
 * Build a `button_interaction` template card for tool approvals.
 * Shows the tool category, a brief description, and three buttons.
 */
export function buildToolApprovalCard(options: ToolApprovalCardOptions): TemplateCard {
  const { requestId, sessionId, toolName, title, description, taskId } = options;

  const mainTitle: string = title ?? `请求执行工具: ${toolName}`;
  const subTitle: string = description ?? '请确认是否允许执行该操作';

  const card: TemplateCard = {
    card_type: 'button_interaction',
    source: {
      desc: 'Comate',
      desc_color: 0,
    },
    main_title: {
      title: mainTitle,
      desc: subTitle,
    },
    task_id: taskId,
    button_list: [
      {
        text: '允许',
        style: 1,
        key: encodeButtonKey(requestId, 'allow', sessionId),
      },
      {
        text: '始终允许',
        style: 2,
        key: encodeButtonKey(requestId, 'always_allow', sessionId),
      },
      {
        text: '拒绝',
        style: 4,
        key: encodeButtonKey(requestId, 'deny', sessionId),
      },
    ],
  };

  return card;
}

/**
 * Build a question card.
 * - Single-choice / boolean questions → `vote_interaction`
 * - Multiple questions or multi-select → `multiple_interaction`
 *
 * For free-text questions with no options, we render a single text-notice card
 * instructing the user to reply in chat (fallback because cards lack clean text
 * input).
 */
export function buildQuestionCard(options: QuestionCardOptions): TemplateCard {
  const { requestId, sessionId, questions, taskId } = options;

  // If any question has no options, fall back to a text-notice card instructing
  // the user to reply in chat.
  const hasFreeText = questions.some((q) => q.options.length === 0);
  if (hasFreeText) {
    const questionText = questions.map((q) => q.question).join('\n');
    return {
      card_type: 'text_notice',
      source: { desc: 'Comate', desc_color: 0 },
      main_title: {
        title: '需要您的回答',
        desc: questionText,
      },
      task_id: taskId,
      sub_title_text: '请在聊天中直接回复您的答案。',
    };
  }

  // Single question with options → vote_interaction
  if (questions.length === 1 && !questions[0].multiSelect) {
    const q = questions[0];
    return {
      card_type: 'vote_interaction',
      source: { desc: 'Comate', desc_color: 0 },
      main_title: {
        title: q.header ?? '请选择',
        desc: q.question,
      },
      task_id: taskId,
      checkbox: {
        question_key: encodeButtonKey(requestId, 'allow', sessionId),
        mode: 0,
        option_list: q.options.map((opt, idx) => ({
          id: String(idx),
          text: opt.label,
        })),
      },
      submit_button: {
        text: '提交',
        key: encodeButtonKey(requestId, 'allow', sessionId),
      },
    };
  }

  // Multiple questions or multi-select → multiple_interaction
  const selectList = questions.map((q, qIdx) => ({
    question_key: encodeButtonKey(`${requestId}:${qIdx}`, 'allow', sessionId),
    title: q.header ?? `问题 ${qIdx + 1}`,
    option_list: q.options.map((opt, idx) => ({
      id: String(idx),
      text: opt.label,
    })),
    selected_id: q.options[0]?.label ? '0' : undefined,
  }));

  return {
    card_type: 'multiple_interaction',
    source: { desc: 'Comate', desc_color: 0 },
    main_title: {
      title: '请回答以下问题',
      desc: questions.map((q) => q.question).join(' / '),
    },
    task_id: taskId,
    select_list: selectList,
    submit_button: {
      text: '提交',
      key: encodeButtonKey(requestId, 'allow', sessionId),
    },
  };
}

/**
 * Build a terminal-state card used to update an expired or resolved card.
 * Replaces interactive elements with a plain text notice.
 */
export function buildTerminalCard(
  originalCardType: string,
  notice: string,
  taskId?: string,
): TemplateCard {
  // For button_interaction, vote_interaction, multiple_interaction: replace
  // with a text_notice that carries the same task_id so updateTemplateCard
  // can target it.
  return {
    card_type: 'text_notice',
    source: { desc: 'Comate', desc_color: 0 },
    main_title: {
      title: '已处理',
      desc: notice,
    },
    task_id: taskId,
  };
}

/**
 * Parse a template-card event frame into a structured result.
 * Validates the event_key is a Comate key and decodes the payload.
 */
export function parseTemplateCardEvent(
  frame: WsFrame<{
    event: TemplateCardEventData & { from?: { userid?: string } };
  }>,
): ParsedCardEvent | undefined {
  const event = frame.body?.event;
  if (!event) return undefined;

  const key = event.event_key;
  if (!key) return undefined;

  const decoded = decodeButtonKey(key);
  if (!decoded) return undefined;

  const wecomUserId = frame.body?.event?.from?.userid ?? '';
  const taskId = event.task_id;

  return {
    requestId: decoded.requestId,
    action: decoded.action,
    sessionId: decoded.sessionId,
    wecomUserId,
    taskId,
  };
}

/**
 * Verify that the clicking user owns the session.
 * Returns true when the user is the owner, false otherwise.
 */
export function verifySessionOwner(
  wecomUserId: string,
  sessionId: string,
  workspaceId: string,
  getWecomUserIdBySession: (workspaceId: string, sessionId: string) => string | null | undefined,
): boolean {
  const ownerWecomUserId = getWecomUserIdBySession(workspaceId, sessionId);
  if (!ownerWecomUserId) return false;
  return ownerWecomUserId === wecomUserId;
}
