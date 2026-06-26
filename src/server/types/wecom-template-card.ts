/**
 * Types for WeCom template card construction and event parsing.
 */

import type { TemplateCard } from '@wecom/aibot-node-sdk';

/**
 * Actions encoded into a button key for interactive cards. `'resume'` is used
 * by the `/resume` session-switch card and is branched on in
 * `handleTemplateCardEvent` before the runtime lookup.
 */
export type ToolApprovalAction = 'allow' | 'always_allow' | 'deny' | 'resume';

/** The decoded payload embedded in a button key. */
export interface DecodedKeyPayload {
  requestId: string;
  action: ToolApprovalAction;
  sessionId: string;
}

/** Normalized selected-item shape used by template-card event handlers. */
export interface NormalizedSelectedItem {
  question_key: string;
  option_ids: string[];
}

/** Result of parsing a template-card click event. */
export interface ParsedCardEvent {
  requestId: string;
  action: ToolApprovalAction;
  sessionId: string;
  /** The WeCom user ID who clicked the button. */
  wecomUserId: string;
  /** The task_id from the original card, used for updateTemplateCard. */
  taskId?: string;
  /** The card_type from the original card, used for terminal-state updates. */
  cardType?: string;
  /** Normalized selected options, present for question cards. */
  selectedItems?: NormalizedSelectedItem[];
}

/** Options for building a tool-approval card. */
export interface ToolApprovalCardOptions {
  requestId: string;
  sessionId: string;
  toolName: string;
  title?: string;
  description?: string;
  /** A stable task_id so later updateTemplateCard can target the card. */
  taskId?: string;
}

/** Options for building a question card. */
export interface QuestionCardOptions {
  requestId: string;
  sessionId: string;
  questions: Array<{
    question: string;
    header?: string;
    options: { label: string; description?: string; preview?: string }[];
    multiSelect: boolean;
  }>;
  taskId?: string;
}

/** Options for building a session-list (`/resume`) card. */
export interface SessionListCardOptions {
  requestId: string;
  /** The user's current session, encoded into the submit-button key for ownership checks. */
  sessionId: string;
  /** A stable task_id so later updateTemplateCard can target the card. */
  taskId?: string;
  /** Card main title; defaults to a generic prompt. */
  title?: string;
  /** Card sub-text; defaults to a generic prompt. */
  desc?: string;
  /** Selectable sessions. The option `id` carries the target sessionId (stateless). */
  options: Array<{ sessionId: string; label: string; isActive?: boolean }>;
}

/** Union of all card payloads produced by this module. */
export type CardPayload = TemplateCard;
