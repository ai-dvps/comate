import type { Workspace } from '../models/workspace.js';
import type { ChatSession } from '../models/session.js';
import type { QuestionPayload } from '../types/message.js';

export interface FeishuCard {
  config: { wide_screen_mode: boolean };
  header?: {
    title: {
      tag: 'plain_text';
      content: string;
    };
  };
  elements: unknown[];
}

export interface StreamingAnswerCard {
  schema: '2.0';
  config: {
    wide_screen_mode: boolean;
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

function baseCard(title: string, elements: unknown[]): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
    },
    elements,
  };
}

function plainText(text: string): unknown {
  return { tag: 'div', text: { tag: 'plain_text', content: text } };
}

function markdownText(text: string): unknown {
  return { tag: 'div', text: { tag: 'lark_md', content: text } };
}

function primaryButton(text: string, value: Record<string, unknown>): unknown {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type: 'primary',
    value,
  };
}

function defaultButton(text: string, value: Record<string, unknown>): unknown {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type: 'default',
    value,
  };
}

function actionRow(actions: unknown[]): unknown {
  return { tag: 'action', actions };
}

export function buildWorkspaceListCard(workspaces: Workspace[]): FeishuCard {
  const elements: unknown[] = [
    markdownText('请选择一个工作空间作为当前 Feishu 机器人的绑定目标。'),
  ];

  for (const ws of workspaces) {
    elements.push(
      plainText(`${ws.name}  (${ws.folderPath})`),
      actionRow([
        primaryButton('选择', {
          action: 'select_workspace',
          workspaceId: ws.id,
        }),
      ]),
    );
  }

  return baseCard('切换工作空间', elements);
}

export function buildSessionListCard(
  workspaceName: string,
  sessions: Array<{ session: ChatSession; isActive: boolean }>,
): FeishuCard {
  const elements: unknown[] = [
    markdownText(`当前工作空间：**${workspaceName}**`),
  ];

  if (sessions.length === 0) {
    elements.push(plainText('你还没有会话，点击下方的“新建会话”开始。'));
  } else {
    elements.push(plainText('选择要使用的会话：'));
    for (const { session, isActive } of sessions) {
      const label = `${session.name}${isActive ? ' （当前）' : ''}`;
      elements.push(
        plainText(label),
        actionRow([
          primaryButton('选择', {
            action: 'select_session',
            workspaceId: session.workspaceId,
            sessionId: session.id,
          }),
        ]),
      );
    }
  }

  elements.push(
    { tag: 'hr' },
    actionRow([
      defaultButton('新建会话', {
        action: 'create_session',
        workspaceId: sessions[0]?.session.workspaceId ?? '',
      }),
    ]),
  );

  return baseCard('选择会话', elements);
}

export function buildApprovalCard(params: {
  requestId: string;
  workspaceId: string;
  sessionId: string;
  toolName: string;
  title?: string;
  description?: string;
  inputSummary?: string;
}): FeishuCard {
  const { requestId, workspaceId, sessionId, toolName, title, description, inputSummary } = params;
  const elements: unknown[] = [
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
    actionRow([
      primaryButton('允许', {
        action: 'approval',
        workspaceId,
        sessionId,
        requestId,
        behavior: 'allow',
      }),
      defaultButton('拒绝', {
        action: 'approval',
        workspaceId,
        sessionId,
        requestId,
        behavior: 'deny',
      }),
    ]),
  );
  return baseCard('需要你的确认', elements);
}

export function buildQuestionCard(params: {
  requestId: string;
  workspaceId: string;
  sessionId: string;
  questions: QuestionPayload[];
}): FeishuCard {
  const { requestId, workspaceId, sessionId, questions } = params;
  const elements: unknown[] = [plainText('请回答以下问题：')];

  for (const [index, q] of questions.entries()) {
    elements.push(plainText(q.question));
    if (q.options && q.options.length > 0) {
      if (q.multiSelect) {
        elements.push({
          tag: 'div',
          text: { tag: 'plain_text', content: '（多选）' },
          extra: q.options.map((opt) => ({
            tag: 'button',
            text: { tag: 'plain_text', content: opt.label },
            type: 'default',
            value: {
              action: 'question',
              workspaceId,
              sessionId,
              requestId,
              questionIndex: index,
              answer: opt.label,
              multiSelect: true,
            },
          })),
        });
      } else {
        elements.push({
          tag: 'action',
          actions: q.options.map((opt) => ({
            tag: 'button',
            text: { tag: 'plain_text', content: opt.label },
            type: 'default',
            value: {
              action: 'question',
              workspaceId,
              sessionId,
              requestId,
              questionIndex: index,
              answer: opt.label,
              multiSelect: false,
            },
          })),
        });
      }
    } else {
      // Free-form questions are not supported via card buttons; ask the user to reply in chat.
      elements.push(plainText('请在聊天中直接回复该问题。'));
    }
  }

  elements.push(
    actionRow([
      primaryButton('提交', {
        action: 'question_submit',
        workspaceId,
        sessionId,
        requestId,
      }),
    ]),
  );

  return baseCard('需要你的回答', elements);
}

export function buildStreamingAnswerCard(initialText: string): StreamingAnswerCard {
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
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
