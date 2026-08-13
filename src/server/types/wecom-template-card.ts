/**
 * Types for WeCom template card construction and event parsing.
 */

import type { TemplateCard } from '@wecom/aibot-node-sdk';

/**
 * Actions encoded into a button key for interactive cards. `'resume'` is used
 * by the `/resume` session-switch card and is branched on in
 * `handleTemplateCardEvent` before the runtime lookup. The `escalate_*`
 * family (U11, KTD-15) is used by admins-audience escalation cards sent to
 * owner/admin recipients; those clicks authorize against the escalation
 * ledger + a fresh role check, never the session-ownership check.
 */
export type ToolApprovalAction =
  | 'allow'
  | 'always_allow'
  | 'deny'
  | 'resume'
  | 'select_workspace'
  | 'escalate_approve'
  | 'escalate_always_allow'
  | 'escalate_deny';

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
  /** Short, requester-visible summary of the exact operation being approved. */
  operationSummary?: string;
  /** Whether the runtime supplied a permission rule that can actually persist. */
  allowAlways?: boolean;
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

/** Options for building a workspace-switch (`/workspace`) card. */
export interface WorkspaceListCardOptions {
  requestId: string;
  /** The bot whose active workspace is being selected; encoded into the submit key. */
  botId: string;
  /** A stable task_id so later updateTemplateCard can target the card. */
  taskId?: string;
  /** Workspaces available for binding. The option `id` carries the workspaceId (stateless). */
  workspaces: Array<{ workspaceId: string; name: string; isActive: boolean }>;
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

/**
 * Options for building an admins-audience escalation approval card (U11,
 * KTD-18): the card shows the EXACT rule that "始终允许" would persist plus
 * its match-semantics prose, so the approver sees precisely what accumulates.
 */
export interface EscalationApprovalCardOptions {
  requestId: string;
  sessionId: string;
  toolName: string;
  /** Pre-truncated command/input summary. */
  commandSummary: string;
  /** Human label for the requester (channel user id). */
  requesterLabel: string;
  /** Requester role label (e.g. '普通成员' / '管理员'). */
  requesterRoleLabel: string;
  /** Exact-match rules that always-allow would persist; empty hides the button. */
  alwaysAllowRules: string[];
  /** Whole minutes the approval stays open. */
  ttlMinutes: number;
  /** A stable task_id so later updateTemplateCard can target the card. */
  taskId?: string;
}

/** Options for the requester's read-only escalation notice card (U11, KTD-15). */
export interface EscalationNoticeCardOptions {
  /** Pre-truncated command/input summary. */
  commandSummary: string;
  toolName: string;
  /** Approver audience label (e.g. '渠道 owner 或 admin'). */
  audienceLabel: string;
  /** Whole minutes the approval stays open. */
  ttlMinutes: number;
  taskId?: string;
}

/** Options for a terminal/result notification card (U11): approve/deny/expiry notices. */
export interface EscalationResultCardOptions {
  title: string;
  desc: string;
  taskId?: string;
}

/** Union of all card payloads produced by this module. */
export type CardPayload = TemplateCard;
