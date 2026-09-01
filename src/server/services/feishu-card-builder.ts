import type { Workspace } from '../models/workspace.js';
import type { ChatSession } from '../models/session.js';
import { humanizeBotToolName } from '../utils/bot-tool-presentation.js';

/**
 * Feishu Cards v2 interactive card.
 * Legacy v1 cards used `config` / `header` / `elements` at the root.
 * v2 cards declare `schema: "2.0"` and place elements under `body`.
 */
export interface FeishuCardV2 {
  schema: '2.0';
  body: {
    elements: unknown[];
  };
}

/** Backward-compatible alias used by existing callers. */
export type FeishuCard = FeishuCardV2;

export interface StreamingAnswerCard {
  schema: '2.0';
  config: {
    streaming_mode: boolean;
    summary?: { content: string };
    streaming_config: {
      print_frequency_ms: { default: number };
      print_step: { default: number };
      print_strategy: string;
    };
  };
  body: {
    elements: Array<{
      tag: 'markdown';
      element_id: string;
      content: string;
    }>;
  };
}

function cardV2(elements: unknown[]): FeishuCardV2 {
  return {
    schema: '2.0',
    body: { elements },
  };
}

export function markdownText(content: string): { tag: 'markdown'; content: string } {
  return { tag: 'markdown', content };
}

export function plainText(content: string): { tag: 'div'; text: { tag: 'plain_text'; content: string } } {
  return { tag: 'div', text: { tag: 'plain_text', content } };
}

export function actionButton(
  text: string,
  type: 'primary' | 'default',
  value: Record<string, unknown>,
  name?: string,
): unknown {
  const button: Record<string, unknown> = {
    tag: 'button',
    type,
    text: { tag: 'plain_text', content: text },
    behaviors: [{ type: 'callback', value }],
  };
  if (name) {
    button.name = name;
  }
  return button;
}

export function selectStatic(
  name: string,
  options: Array<{ text: string; value: string }>,
  initialIndex?: number,
  placeholder?: string,
  disabled?: boolean,
  elementId?: string,
): unknown {
  const select: Record<string, unknown> = {
    tag: 'select_static',
    name,
    options: options.map((option) => ({
      text: { tag: 'plain_text', content: option.text },
      value: option.value,
    })),
  };
  if (initialIndex !== undefined) {
    select.initial_index = initialIndex;
  }
  if (placeholder) {
    select.placeholder = { tag: 'plain_text', content: placeholder };
  }
  if (disabled) {
    select.disabled = true;
  }
  if (elementId) {
    select.element_id = elementId;
  }
  return select;
}

export function submitButton(
  text: string,
  type: 'primary' | 'default',
  value: Record<string, unknown>,
  name: string,
  disabled?: boolean,
  elementId?: string,
): unknown {
  const button: Record<string, unknown> = {
    tag: 'button',
    type,
    text: { tag: 'plain_text', content: text },
    name,
    form_action_type: 'submit',
    behaviors: [{ type: 'callback', value }],
  };
  if (disabled) {
    button.disabled = true;
  }
  if (elementId) {
    button.element_id = elementId;
  }
  return button;
}

export function formContainer(name: string, elements: unknown[], elementId?: string): unknown {
  const form: Record<string, unknown> = { tag: 'form', name, elements };
  if (elementId) {
    form.element_id = elementId;
  }
  return form;
}

export function buildWorkspaceListCard(
  botId: string,
  workspaces: Workspace[],
  activeWorkspaceId?: string,
): FeishuCardV2 {
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
  const elements: unknown[] = [markdownText(
    activeWorkspace
      ? `当前工作空间：**${activeWorkspace.name}**\n\n选择要切换到的工作空间。`
      : '选择一个工作空间作为当前 Feishu 机器人的绑定目标。',
  )];

  if (workspaces.length === 0) {
    elements.push(plainText('暂无可用的工作空间。'));
    return cardV2(elements);
  }

  const activeIndex = activeWorkspaceId
    ? workspaces.findIndex((workspace) => workspace.id === activeWorkspaceId)
    : -1;
  const fallbackWorkspaceId = activeWorkspaceId ?? workspaces[0].id;
  elements.push(formContainer('workspace_form', [
    selectStatic(
      'workspaceId',
      workspaces.map((workspace) => ({
        text: `${workspace.name}  (${workspace.folderPath})`,
        value: workspace.id,
      })),
      activeIndex >= 0 ? activeIndex : undefined,
      '请选择工作空间',
      false,
      'workspace_select',
    ),
    submitButton(
      '确认切换',
      'primary',
      {
        action: 'select_workspace',
        botId,
        // Card callbacks require a workspaceId in their static value. The
        // selected form value replaces this fallback before the action runs.
        workspaceId: fallbackWorkspaceId,
      },
      'submit_workspace',
      false,
      'workspace_submit',
    ),
  ], 'workspace_form'));

  return cardV2(elements);
}

export const SESSION_SELECT_ELEMENT_ID = 'session_select';
export const SESSION_SUBMIT_ELEMENT_ID = 'session_submit';
export const SESSION_FORM_ELEMENT_ID = 'session_form';

export function buildSessionListCard(
  workspaceName: string,
  sessions: Array<{ session: ChatSession; isActive: boolean }>,
  disabled = false,
): FeishuCardV2 {
  const elements: unknown[] = [markdownText(`当前工作空间：**${workspaceName}**`)];

  if (sessions.length === 0) {
    elements.push(plainText('你还没有会话，发送 /new 创建新会话。'));
  } else {
    elements.push(plainText('选择要使用的会话：'));

    elements.push(buildSessionListFormElement(sessions, disabled));
  }

  return cardV2(elements);
}

export function buildSessionListFormElement(
  sessions: Array<{ session: ChatSession; isActive: boolean }>,
  disabled = false,
): unknown {
  const options: Array<{ text: string; value: string }> = [];
  let activeIndex: number | undefined;
  for (const [index, { session, isActive }] of sessions.entries()) {
    options.push({
      text: `${session.name}${isActive ? ' （当前）' : ''}`,
      value: session.id,
    });
    if (isActive) {
      activeIndex = index;
    }
  }

  return formContainer(
    'session_form',
    [
      selectStatic(
        'sessionId',
        options,
        activeIndex,
        '请选择会话',
        disabled,
        SESSION_SELECT_ELEMENT_ID,
      ),
      submitButton(
        '确认切换',
        'primary',
        { action: 'select_session', workspaceId: sessions[0].session.workspaceId },
        'submit_session',
        disabled,
        SESSION_SUBMIT_ELEMENT_ID,
      ),
    ],
    SESSION_FORM_ELEMENT_ID,
  );
}

/**
 * Disabled version of the session-switcher card, rendered after a successful
 * switch so the dropdown and confirm button cannot be used again.
 */
export function buildDisabledSessionListCard(
  workspaceName: string,
  sessions: Array<{ session: ChatSession; isActive: boolean }>,
): FeishuCardV2 {
  return buildSessionListCard(workspaceName, sessions, true);
}

export function buildApprovalCard(params: {
  requestId: string;
  workspaceId: string;
  sessionId: string;
  toolName: string;
  title?: string;
  description?: string;
  operationSummary?: string;
  allowAlways?: boolean;
}): FeishuCardV2 {
  const {
    requestId, workspaceId, sessionId, toolName, title, description,
    operationSummary, allowAlways,
  } = params;
  const elements: unknown[] = [
    markdownText('需要你的确认'),
    plainText(title ?? `确认${humanizeBotToolName(toolName)}`),
  ];

  if (description) {
    elements.push(plainText(description));
  }
  if (operationSummary) {
    elements.push(plainText(`操作：${operationSummary}`));
  }

  elements.push(
    actionButton(allowAlways ? '仅本次允许' : '允许', 'primary', {
      action: 'approval',
      workspaceId,
      sessionId,
      requestId,
      behavior: 'allow',
    }),
  );
  if (allowAlways) {
    elements.push(actionButton('对此规则始终允许', 'default', {
      action: 'approval',
      workspaceId,
      sessionId,
      requestId,
      behavior: 'always_allow',
    }));
  }
  elements.push(
    actionButton('拒绝', 'default', {
      action: 'approval',
      workspaceId,
      sessionId,
      requestId,
      behavior: 'deny',
    }),
  );

  return cardV2(elements);
}

export function buildTerminalDecisionCard(params: {
  title: string;
  description?: string;
  selection?: string;
}): FeishuCardV2 {
  const elements: unknown[] = [plainText(params.title)];
  if (params.description) elements.push(plainText(params.description));
  if (params.selection) elements.push(plainText(`你的选择：${params.selection}`));
  return cardV2(elements);
}

export function buildStreamingAnswerCard(initialText: string): StreamingAnswerCard {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      summary: { content: truncateStreamingSummary(initialText) },
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: 1 },
        print_strategy: 'fast',
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          element_id: 'stream_md',
          content: initialText,
        },
      ],
    },
  };
}

function truncateStreamingSummary(text: string, max = 50): string {
  if (!text) return '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max - 1) + '…';
}
