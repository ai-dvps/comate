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
  NormalizedSelectedItem,
  ParsedCardEvent,
  ToolApprovalCardOptions,
  QuestionCardOptions,
  SessionListCardOptions,
  WorkspaceListCardOptions,
} from '../types/wecom-template-card.js';

const KEY_PREFIX = 'comate:1:';
const MAX_KEY_BYTES = 1024;

/**
 * Runtime shape of a WeCom `template_card_event` callback.
 * The SDK emits the raw body unchanged; the payload we care about is nested
 * under `event.template_card_event`, not the typed `TemplateCardEventData`.
 */
interface RawTemplateCardEventWrapper {
  eventtype: 'template_card_event';
  template_card_event: {
    card_type: string;
    event_key: string;
    task_id?: string;
    selected_items?: {
      selected_item: Array<{
        question_key: string;
        option_ids?: { option_id: string[] };
      }>;
    };
  };
}

/** Normalized selected-item shape used by the event handler. */
export type { NormalizedSelectedItem } from '../types/wecom-template-card.js';

/**
 * Extract the actionable detail from a raw template-card event.
 * Handles both the observed runtime wrapper (`event.template_card_event`)
 * and the flat SDK type in case a future SDK version flattens it.
 */
export function getTemplateCardEventDetail(
  event: unknown,
): {
  card_type?: string;
  event_key?: string;
  task_id?: string;
  selected_items?: NormalizedSelectedItem[];
} | undefined {
  const wrapper = event as RawTemplateCardEventWrapper | undefined;
  if (wrapper?.template_card_event) {
    const detail = wrapper.template_card_event;
    return {
      card_type: detail.card_type,
      event_key: detail.event_key,
      task_id: detail.task_id,
      selected_items: detail.selected_items?.selected_item.map((item) => ({
        question_key: item.question_key,
        option_ids: item.option_ids?.option_id ?? [],
      })),
    };
  }

  const flat = event as
    | (TemplateCardEventData & {
        selected_items?: NormalizedSelectedItem[];
      })
    | undefined;
  if (flat?.event_key) {
    return {
      event_key: flat.event_key,
      task_id: flat.task_id,
      card_type: (flat as { card_type?: string }).card_type,
      selected_items: flat.selected_items,
    };
  }

  return undefined;
}

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
  return (
    a === 'allow' ||
    a === 'always_allow' ||
    a === 'deny' ||
    a === 'resume' ||
    a === 'select_workspace'
  );
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
 * - Single question with options → `vote_interaction` (mode 0 for single
 *   select, mode 1 for multi-select)
 * - Multiple questions → `multiple_interaction`
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
  if (questions.length === 1) {
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
        mode: q.multiSelect ? 1 : 0,
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

  // Multiple questions → multiple_interaction
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
 * Build a `multiple_interaction` card listing a user's sessions in a single
 * dropdown selector for the `/resume` command. The target sessionId is encoded
 * directly in each option's `id` so the submit callback can read it statelessly
 * — mirroring Feishu's `select_session`. The submit-button key carries action
 * `'resume'` so `handleTemplateCardEvent` can branch a resume submit apart from
 * approvals. No pending store: the selected option id is the source of truth on
 * submit.
 */
export function buildWecomSessionListCard(options: SessionListCardOptions): TemplateCard {
  const { requestId, sessionId, taskId, title, desc, options: sessions } = options;

  return {
    card_type: 'multiple_interaction',
    source: { desc: 'Comate', desc_color: 0 },
    main_title: {
      title: title ?? '选择会话',
      desc: desc ?? '请选择要恢复的会话',
    },
    task_id: taskId,
    select_list: [
      {
        question_key: encodeButtonKey(requestId, 'resume', sessionId),
        title: '可恢复的会话',
        option_list: sessions.map((s) => ({
          id: s.sessionId,
          text: s.isActive ? `${s.label} （当前）` : s.label,
        })),
      },
    ],
    submit_button: {
      text: '恢复',
      key: encodeButtonKey(requestId, 'resume', sessionId),
    },
  };
}

/**
 * Build a `vote_interaction` card listing workspaces for the `/workspace` command.
 * The target workspaceId is carried in each option's `id`; the submit key encodes
 * the botId and action so the callback can verify the caller is the bot Owner.
 */
export function buildWecomWorkspaceListCard(options: WorkspaceListCardOptions): TemplateCard {
  const { requestId, botId, taskId, workspaces } = options;

  return {
    card_type: 'vote_interaction',
    source: { desc: 'Comate', desc_color: 0 },
    main_title: {
      title: '选择当前工作空间',
      desc: '请选择该机器人要绑定的工作空间',
    },
    task_id: taskId,
    checkbox: {
      question_key: encodeButtonKey(requestId, 'select_workspace', botId),
      mode: 0,
      option_list: workspaces.map((ws) => ({
        id: ws.workspaceId,
        text: ws.isActive ? `${ws.name} （当前）` : ws.name,
      })),
    },
    submit_button: {
      text: '切换',
      key: encodeButtonKey(requestId, 'select_workspace', botId),
    },
  };
}

/**
 * Build a terminal-state card used to update an expired or resolved card.
 *
 * For `vote_interaction` and `multiple_interaction` cards, keeps the card_type
 * and sets `replace_text` (greys out the submit button) + disables the
 * interactive elements (`checkbox.disable` / `select_list[i].disable`). This is
 * the only reliable way to disable these cards per WeCom doc /94888.
 * Replacing them with a `text_notice` does NOT disable the interactive
 * elements.
 *
 * For other card types (`button_interaction`, etc.), replaces with a
 * `text_notice` carrying the same `task_id`.
 */
export function buildTerminalCard(
  originalCardType: string,
  notice: string,
  taskId?: string,
): TemplateCard {
  const source = { desc: 'Comate', desc_color: 0 } as const;
  const mainTitle = { title: notice, desc: '' };
  const terminalButton = { text: notice, key: 'terminal' };

  if (originalCardType === 'vote_interaction') {
    return {
      card_type: 'vote_interaction',
      source,
      main_title: mainTitle,
      task_id: taskId,
      checkbox: {
        question_key: 'terminal',
        mode: 0,
        disable: true,
        option_list: [{ id: '0', text: notice, is_checked: true }],
      },
      submit_button: terminalButton,
      replace_text: notice,
    } as TemplateCard;
  }

  if (originalCardType === 'multiple_interaction') {
    return {
      card_type: 'multiple_interaction',
      source,
      main_title: mainTitle,
      task_id: taskId,
      select_list: [
        {
          question_key: 'terminal',
          title: '已选择',
          disable: true,
          selected_id: '0',
          option_list: [{ id: '0', text: notice }],
        },
      ],
      submit_button: terminalButton,
      replace_text: notice,
    } as TemplateCard;
  }

  return {
    card_type: 'text_notice',
    source,
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
    event: TemplateCardEventData | RawTemplateCardEventWrapper;
    from?: { userid?: string };
  }>,
): ParsedCardEvent | undefined {
  const rawEvent = frame.body?.event;
  if (!rawEvent) return undefined;

  const detail = getTemplateCardEventDetail(rawEvent);
  if (!detail?.event_key) return undefined;

  const decoded = decodeButtonKey(detail.event_key);
  if (!decoded) return undefined;

  const wecomUserId = frame.body?.from?.userid ?? '';

  return {
    requestId: decoded.requestId,
    action: decoded.action,
    sessionId: decoded.sessionId,
    wecomUserId,
    taskId: detail.task_id,
    cardType: detail.card_type,
    selectedItems: detail.selected_items,
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
  getChannelUserIdBySession: (workspaceId: string, sessionId: string) => string | null | undefined,
): boolean {
  const ownerChannelUserId = getChannelUserIdBySession(workspaceId, sessionId);
  if (!ownerChannelUserId) return false;
  return ownerChannelUserId === wecomUserId;
}
