import type { Workspace } from '../models/workspace.js';
import type { ChatSession } from '../models/session.js';
import type { QuestionPayload } from '../types/message.js';

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
  return select;
}

export function submitButton(
  text: string,
  type: 'primary' | 'default',
  value: Record<string, unknown>,
  name: string,
): unknown {
  return {
    tag: 'button',
    type,
    text: { tag: 'plain_text', content: text },
    name,
    form_action_type: 'submit',
    behaviors: [{ type: 'callback', value }],
  };
}

export function formContainer(name: string, elements: unknown[]): unknown {
  return { tag: 'form', name, elements };
}

export function buildWorkspaceListCard(workspaces: Workspace[]): FeishuCardV2 {
  const elements: unknown[] = [
    markdownText('请选择一个工作空间作为当前 Feishu 机器人的绑定目标。'),
  ];

  for (const workspace of workspaces) {
    elements.push(
      plainText(`${workspace.name}  (${workspace.folderPath})`),
      actionButton('选择', 'primary', {
        action: 'select_workspace',
        workspaceId: workspace.id,
      }),
    );
  }

  return cardV2(elements);
}

export function buildSessionListCard(
  workspaceName: string,
  sessions: Array<{ session: ChatSession; isActive: boolean }>,
): FeishuCardV2 {
  const elements: unknown[] = [markdownText(`当前工作空间：**${workspaceName}**`)];

  if (sessions.length === 0) {
    elements.push(plainText('你还没有会话，发送 /new 创建新会话。'));
  } else {
    elements.push(plainText('选择要使用的会话：'));

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

    elements.push(
      formContainer('session_form', [
        selectStatic('sessionId', options, activeIndex, '请选择会话'),
        submitButton(
          '确认切换',
          'primary',
          { action: 'select_session', workspaceId: sessions[0].session.workspaceId },
          'submit_session',
        ),
      ]),
    );
  }

  return cardV2(elements);
}

/**
 * Inactive version of the session-switcher card, rendered after a successful
 * switch so the user cannot submit the form again.
 */
export function buildInactiveSessionCard(
  workspaceName: string,
  sessionName: string,
): FeishuCardV2 {
  return cardV2([
    markdownText(`当前工作空间：**${workspaceName}**`),
    plainText(`已切换至会话：**${sessionName}**`),
  ]);
}

export function buildApprovalCard(params: {
  requestId: string;
  workspaceId: string;
  sessionId: string;
  toolName: string;
  title?: string;
  description?: string;
  inputSummary?: string;
}): FeishuCardV2 {
  const { requestId, workspaceId, sessionId, toolName, title, description, inputSummary } = params;
  const elements: unknown[] = [
    markdownText('需要你的确认'),
    markdownText(`工具：**${toolName}**`),
  ];

  if (title) {
    elements.push(plainText(title));
  }
  if (description) {
    elements.push(plainText(description));
  }
  if (inputSummary) {
    elements.push(markdownText(`\`\`\`\n${inputSummary}\n\`\`\``));
  }

  elements.push(
    actionButton('允许', 'primary', {
      action: 'approval',
      workspaceId,
      sessionId,
      requestId,
      behavior: 'allow',
    }),
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

export function buildQuestionCard(params: {
  requestId: string;
  workspaceId: string;
  sessionId: string;
  questions: QuestionPayload[];
}): FeishuCardV2 {
  const { requestId, workspaceId, sessionId, questions } = params;
  const elements: unknown[] = [markdownText('需要你的回答'), plainText('请回答以下问题：')];

  for (const [index, question] of questions.entries()) {
    elements.push(plainText(question.question));

    if (question.options && question.options.length > 0) {
      if (question.multiSelect) {
        elements.push(plainText('（多选）'));
      }
      for (const option of question.options) {
        elements.push(
          actionButton(option.label, 'default', {
            action: 'question',
            workspaceId,
            sessionId,
            requestId,
            questionIndex: index,
            answer: option.label,
            multiSelect: question.multiSelect,
          }),
        );
      }
    } else {
      // Free-form questions are not supported via card buttons; ask the user to reply in chat.
      elements.push(plainText('请在聊天中直接回复该问题。'));
    }
  }

  elements.push(
    actionButton('提交', 'primary', {
      action: 'question_submit',
      workspaceId,
      sessionId,
      requestId,
    }),
  );

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
