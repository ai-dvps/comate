import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildWorkspaceListCard,
  buildSessionListCard,
  buildDisabledSessionListCard,
  buildApprovalCard,
  buildQuestionCard,
  buildStreamingAnswerCard,
  markdownText,
  plainText,
  actionButton,
  selectStatic,
  submitButton,
  formContainer,
} from './feishu-card-builder.js';
import type { Workspace } from '../models/workspace.js';
import type { ChatSession } from '../models/session.js';
import type { QuestionPayload } from '../types/message.js';

function findByTag(elements: unknown[], tag: string): Record<string, unknown> | undefined {
  return elements.find((el) => (el as Record<string, unknown>).tag === tag) as
    | Record<string, unknown>
    | undefined;
}

function findAllByTag(elements: unknown[], tag: string): Record<string, unknown>[] {
  return elements.filter((el) => (el as Record<string, unknown>).tag === tag) as Record<string, unknown>[];
}

describe('feishu-card-builder v2 helpers', () => {
  it('markdownText produces a v2 markdown element', () => {
    assert.deepStrictEqual(markdownText('hello'), { tag: 'markdown', content: 'hello' });
  });

  it('plainText produces a v2 div element', () => {
    assert.deepStrictEqual(plainText('hello'), {
      tag: 'div',
      text: { tag: 'plain_text', content: 'hello' },
    });
  });

  it('actionButton produces a callback button', () => {
    const button = actionButton('Btn', 'primary', { action: 'x' }, 'btn1');
    assert.deepStrictEqual(button, {
      tag: 'button',
      type: 'primary',
      text: { tag: 'plain_text', content: 'Btn' },
      name: 'btn1',
      behaviors: [{ type: 'callback', value: { action: 'x' } }],
    });
  });

  it('selectStatic produces a dropdown with options and initial_index', () => {
    const select = selectStatic(
      's1',
      [
        { text: 'A', value: 'a' },
        { text: 'B', value: 'b' },
      ],
      1,
      'placeholder',
    );
    assert.deepStrictEqual(select, {
      tag: 'select_static',
      name: 's1',
      placeholder: { tag: 'plain_text', content: 'placeholder' },
      initial_index: 1,
      options: [
        { text: { tag: 'plain_text', content: 'A' }, value: 'a' },
        { text: { tag: 'plain_text', content: 'B' }, value: 'b' },
      ],
    });
  });

  it('submitButton produces a form-submit button', () => {
    const button = submitButton('提交', 'primary', { action: 'submit' }, 'submit1');
    assert.deepStrictEqual(button, {
      tag: 'button',
      type: 'primary',
      text: { tag: 'plain_text', content: '提交' },
      name: 'submit1',
      form_action_type: 'submit',
      behaviors: [{ type: 'callback', value: { action: 'submit' } }],
    });
  });

  it('selectStatic supports disabled', () => {
    const select = selectStatic('s1', [{ text: 'A', value: 'a' }], undefined, undefined, true);
    assert.strictEqual(select.disabled, true);
  });

  it('submitButton supports disabled', () => {
    const button = submitButton('提交', 'primary', { action: 'submit' }, 'submit1', true);
    assert.strictEqual(button.disabled, true);
  });

  it('formContainer produces a form element', () => {
    assert.deepStrictEqual(formContainer('f1', [{ tag: 'div' }]), {
      tag: 'form',
      name: 'f1',
      elements: [{ tag: 'div' }],
    });
  });
});

describe('buildWorkspaceListCard', () => {
  it('renders a v2 card with one button per workspace', () => {
    const workspaces: Workspace[] = [
      { id: 'ws-1', name: 'A', folderPath: '/a' } as Workspace,
      { id: 'ws-2', name: 'B', folderPath: '/b' } as Workspace,
    ];
    const card = buildWorkspaceListCard(workspaces);
    assert.strictEqual(card.schema, '2.0');
    assert.strictEqual(card.body.elements.length, 5);

    const buttons = findAllByTag(card.body.elements, 'button');
    assert.strictEqual(buttons.length, 2);
    assert.deepStrictEqual(buttons[0].behaviors, [
      { type: 'callback', value: { action: 'select_workspace', workspaceId: 'ws-1' } },
    ]);
    assert.deepStrictEqual(buttons[1].behaviors, [
      { type: 'callback', value: { action: 'select_workspace', workspaceId: 'ws-2' } },
    ]);
  });

  it('renders an empty-state hint when there are no workspaces', () => {
    const card = buildWorkspaceListCard([]);
    assert.strictEqual(card.body.elements.length, 1);
    const hint = findByTag(card.body.elements, 'markdown');
    assert.ok(hint);
    assert.ok((hint.content as string).includes('绑定目标'));
  });
});

describe('buildSessionListCard', () => {
  function makeSession(id: string, name: string, workspaceId: string): ChatSession {
    return {
      id,
      name,
      workspaceId,
      source: 'feishu',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as ChatSession;
  }

  it('renders a form with dropdown and confirm button', () => {
    const sessions = [
      { session: makeSession('s1', 'Session A', 'ws-1'), isActive: false },
      { session: makeSession('s2', 'Session B', 'ws-1'), isActive: true },
    ];
    const card = buildSessionListCard('Workspace', sessions);
    assert.strictEqual(card.schema, '2.0');

    const form = findByTag(card.body.elements, 'form');
    assert.ok(form, 'form container should exist');
    assert.strictEqual(form.name, 'session_form');

    const formElements = form.elements as unknown[];
    assert.strictEqual(formElements.length, 2);

    const select = findByTag(formElements, 'select_static');
    assert.ok(select);
    assert.strictEqual(select.name, 'sessionId');
    assert.strictEqual(select.initial_index, 1);
    const options = select.options as Array<{ text: { content: string }; value: string }>;
    assert.strictEqual(options.length, 2);
    assert.strictEqual(options[0].value, 's1');
    assert.strictEqual(options[0].text.content, 'Session A');
    assert.strictEqual(options[1].value, 's2');
    assert.strictEqual(options[1].text.content, 'Session B （当前）');

    const button = findByTag(formElements, 'button');
    assert.ok(button);
    assert.strictEqual(button.form_action_type, 'submit');
    assert.deepStrictEqual(button.behaviors, [
      { type: 'callback', value: { action: 'select_session', workspaceId: 'ws-1' } },
    ]);
  });

  it('renders empty-state text and no form when there are no sessions', () => {
    const card = buildSessionListCard('Workspace', []);
    assert.strictEqual(card.body.elements.length, 2);

    const form = findByTag(card.body.elements, 'form');
    assert.strictEqual(form, undefined);

    const hint = findByTag(card.body.elements, 'div');
    assert.ok(hint);
    assert.strictEqual((hint.text as { content: string }).content, '你还没有会话，发送 /new 创建新会话。');
  });
});

describe('buildDisabledSessionListCard', () => {
  function makeSession(id: string, name: string, workspaceId: string): ChatSession {
    return {
      id,
      name,
      workspaceId,
      source: 'feishu',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as ChatSession;
  }

  it('renders the session list with disabled dropdown and submit button', () => {
    const sessions = [
      { session: makeSession('s1', 'Session A', 'ws-1'), isActive: false },
      { session: makeSession('s2', 'Session B', 'ws-1'), isActive: true },
    ];
    const card = buildDisabledSessionListCard('Workspace', sessions);
    assert.strictEqual(card.schema, '2.0');

    const form = findByTag(card.body.elements, 'form');
    assert.ok(form, 'form container should exist');
    const formElements = form.elements as unknown[];

    const select = findByTag(formElements, 'select_static');
    assert.ok(select);
    assert.strictEqual(select.disabled, true);

    const button = findByTag(formElements, 'button');
    assert.ok(button);
    assert.strictEqual(button.disabled, true);
    assert.strictEqual(button.form_action_type, 'submit');
  });
});

describe('buildApprovalCard', () => {
  it('renders allow/deny buttons with action values', () => {
    const card = buildApprovalCard({
      requestId: 'req-1',
      workspaceId: 'ws-1',
      sessionId: 's1',
      toolName: 'read_file',
      title: 'Confirm?',
      description: 'desc',
      inputSummary: 'args',
    });
    assert.strictEqual(card.schema, '2.0');

    const buttons = findAllByTag(card.body.elements, 'button');
    assert.strictEqual(buttons.length, 2);

    assert.deepStrictEqual(buttons[0].behaviors, [
      {
        type: 'callback',
        value: {
          action: 'approval',
          workspaceId: 'ws-1',
          sessionId: 's1',
          requestId: 'req-1',
          behavior: 'allow',
        },
      },
    ]);
    assert.deepStrictEqual(buttons[1].behaviors, [
      {
        type: 'callback',
        value: {
          action: 'approval',
          workspaceId: 'ws-1',
          sessionId: 's1',
          requestId: 'req-1',
          behavior: 'deny',
        },
      },
    ]);
  });
});

describe('buildQuestionCard', () => {
  it('renders single-select option buttons', () => {
    const questions: QuestionPayload[] = [
      {
        question: 'Pick one',
        options: [{ label: 'A' }, { label: 'B' }],
        multiSelect: false,
      },
    ];
    const card = buildQuestionCard({
      requestId: 'req-1',
      workspaceId: 'ws-1',
      sessionId: 's1',
      questions,
    });
    assert.strictEqual(card.schema, '2.0');

    const buttons = findAllByTag(card.body.elements, 'button');
    const optionButtons = buttons.slice(0, -1);
    assert.strictEqual(optionButtons.length, 2);
    assert.deepStrictEqual(optionButtons[0].behaviors, [
      {
        type: 'callback',
        value: {
          action: 'question',
          workspaceId: 'ws-1',
          sessionId: 's1',
          requestId: 'req-1',
          questionIndex: 0,
          answer: 'A',
          multiSelect: false,
        },
      },
    ]);

    const submitButton = buttons[buttons.length - 1];
    assert.deepStrictEqual(submitButton.behaviors, [
      {
        type: 'callback',
        value: {
          action: 'question_submit',
          workspaceId: 'ws-1',
          sessionId: 's1',
          requestId: 'req-1',
        },
      },
    ]);
  });

  it('renders multi-select toggle buttons and a submit button', () => {
    const questions: QuestionPayload[] = [
      {
        question: 'Pick many',
        options: [{ label: 'A' }, { label: 'B' }],
        multiSelect: true,
      },
    ];
    const card = buildQuestionCard({
      requestId: 'req-1',
      workspaceId: 'ws-1',
      sessionId: 's1',
      questions,
    });

    const texts = findAllByTag(card.body.elements, 'div');
    assert.ok(texts.some((t) => (t.text as { content: string }).content === '（多选）'));

    const buttons = findAllByTag(card.body.elements, 'button');
    assert.strictEqual(buttons.length, 3);
    const values = buttons.map((b) => (b.behaviors as Array<{ value: unknown }>)[0].value);
    assert.deepStrictEqual(values[2], {
      action: 'question_submit',
      workspaceId: 'ws-1',
      sessionId: 's1',
      requestId: 'req-1',
    });
  });

  it('renders free-form fallback text and no option buttons', () => {
    const questions: QuestionPayload[] = [{ question: 'Why?', multiSelect: false }];
    const card = buildQuestionCard({
      requestId: 'req-1',
      workspaceId: 'ws-1',
      sessionId: 's1',
      questions,
    });

    const buttons = findAllByTag(card.body.elements, 'button');
    assert.strictEqual(buttons.length, 1); // submit only

    const texts = findAllByTag(card.body.elements, 'div');
    assert.ok(
      texts.some((t) => (t.text as { content: string }).content === '请在聊天中直接回复该问题。'),
    );
  });
});

describe('buildStreamingAnswerCard', () => {
  it('still produces the CardKit streaming card shape', () => {
    const card = buildStreamingAnswerCard('hello world');
    assert.strictEqual(card.schema, '2.0');
    assert.strictEqual(card.config.streaming_mode, true);
    assert.strictEqual(card.body.elements[0].element_id, 'stream_md');
    assert.strictEqual(card.body.elements[0].content, 'hello world');
  });
});
