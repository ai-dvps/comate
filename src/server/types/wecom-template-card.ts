/**
 * Types for WeCom template card construction and event parsing.
 */

import type { TemplateCard } from '@wecom/aibot-node-sdk';

/** Actions encoded into a button key for tool-approval cards. */
export type ToolApprovalAction = 'allow' | 'always_allow' | 'deny';

/** The decoded payload embedded in a button key. */
export interface DecodedKeyPayload {
  requestId: string;
  action: ToolApprovalAction;
  sessionId: string;
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

/** Union of all card payloads produced by this module. */
export type CardPayload = TemplateCard;
