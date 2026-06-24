import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeButtonKey,
  decodeButtonKey,
  buildToolApprovalCard,
  buildQuestionCard,
  buildTerminalCard,
  parseTemplateCardEvent,
  verifySessionOwner,
} from './wecom-template-card.js';

describe('wecom-template-card', () => {
  describe('encodeButtonKey / decodeButtonKey', () => {
    it('round-trips requestId, action, and sessionId', () => {
      const requestId = 'req-abc-123';
      const action = 'allow' as const;
      const sessionId = 'sess-xyz-456';

      const key = encodeButtonKey(requestId, action, sessionId);
      const decoded = decodeButtonKey(key);

      assert.ok(decoded);
      assert.strictEqual(decoded.requestId, requestId);
      assert.strictEqual(decoded.action, action);
      assert.strictEqual(decoded.sessionId, sessionId);
    });

    it('round-trips all three actions', () => {
      const actions = ['allow', 'always_allow', 'deny'] as const;
      for (const action of actions) {
        const key = encodeButtonKey('r1', action, 's1');
        const decoded = decodeButtonKey(key);
        assert.ok(decoded);
        assert.strictEqual(decoded.action, action);
      }
    });

    it('produces a key under 1024 bytes for typical IDs', () => {
      const requestId = 'toolu_01ABCDEF1234567890abcdef123456';
      const sessionId = 'sess-2024-01-15T12-34-56-789Z-uuid-1234';
      const key = encodeButtonKey(requestId, 'always_allow', sessionId);
      const byteLength = Buffer.byteLength(key, 'utf-8');
      assert.ok(byteLength < 1024, `Key length ${byteLength} bytes >= 1024`);
    });

    it('rejects non-Comate keys', () => {
      const decoded = decodeButtonKey('some-other-key');
      assert.strictEqual(decoded, undefined);
    });

    it('rejects malformed base64 payload', () => {
      const decoded = decodeButtonKey('comate:1:not-valid-base64!!!');
      assert.strictEqual(decoded, undefined);
    });

    it('rejects JSON with missing fields', () => {
      const badJson = JSON.stringify({ r: 'req', s: 'sess' });
      const base64 = Buffer.from(badJson, 'utf-8').toString('base64');
      const key = `comate:1:${base64}`;
      const decoded = decodeButtonKey(key);
      assert.strictEqual(decoded, undefined);
    });

    it('rejects JSON with invalid action', () => {
      const badJson = JSON.stringify({ r: 'req', a: 'invalid', s: 'sess' });
      const base64 = Buffer.from(badJson, 'utf-8').toString('base64');
      const key = `comate:1:${base64}`;
      const decoded = decodeButtonKey(key);
      assert.strictEqual(decoded, undefined);
    });

    it('throws when key exceeds 1024 bytes', () => {
      const longId = 'x'.repeat(2000);
      assert.throws(() => {
        encodeButtonKey(longId, 'allow', longId);
      }, /exceeds 1024 bytes/);
    });
  });

  describe('buildToolApprovalCard', () => {
    it('produces a button_interaction card with main_title and three buttons', () => {
      const card = buildToolApprovalCard({
        requestId: 'req-1',
        sessionId: 'sess-1',
        toolName: 'Bash',
        title: '执行 Bash 命令',
        description: '请求执行 shell 命令',
      });

      assert.strictEqual(card.card_type, 'button_interaction');
      assert.ok(card.main_title);
      assert.strictEqual(card.main_title?.title, '执行 Bash 命令');
      assert.strictEqual(card.main_title?.desc, '请求执行 shell 命令');
      assert.ok(card.button_list);
      assert.strictEqual(card.button_list?.length, 3);

      const texts = card.button_list?.map((b) => b.text);
      assert.deepStrictEqual(texts, ['允许', '始终允许', '拒绝']);

      // Each button key should decode successfully
      for (const btn of card.button_list ?? []) {
        const decoded = decodeButtonKey(btn.key);
        assert.ok(decoded, `Button key should decode: ${btn.key}`);
        assert.strictEqual(decoded.requestId, 'req-1');
        assert.strictEqual(decoded.sessionId, 'sess-1');
      }
    });

    it('uses default title and description when not provided', () => {
      const card = buildToolApprovalCard({
        requestId: 'req-2',
        sessionId: 'sess-2',
        toolName: 'Edit',
      });

      assert.ok(card.main_title);
      assert.ok(card.main_title?.title?.includes('Edit'));
      assert.ok(card.main_title?.desc);
      assert.strictEqual(card.button_list?.length, 3);
    });

    it('includes task_id when provided', () => {
      const card = buildToolApprovalCard({
        requestId: 'req-3',
        sessionId: 'sess-3',
        toolName: 'Write',
        taskId: 'task-123',
      });

      assert.strictEqual(card.task_id, 'task-123');
    });

    it('encodes correct actions into each button key', () => {
      const card = buildToolApprovalCard({
        requestId: 'req-4',
        sessionId: 'sess-4',
        toolName: 'Bash',
      });

      const allowDecoded = decodeButtonKey(card.button_list![0].key);
      assert.strictEqual(allowDecoded?.action, 'allow');

      const alwaysDecoded = decodeButtonKey(card.button_list![1].key);
      assert.strictEqual(alwaysDecoded?.action, 'always_allow');

      const denyDecoded = decodeButtonKey(card.button_list![2].key);
      assert.strictEqual(denyDecoded?.action, 'deny');
    });
  });

  describe('buildQuestionCard', () => {
    it('builds a vote_interaction card for a single boolean question', () => {
      const card = buildQuestionCard({
        requestId: 'req-q1',
        sessionId: 'sess-q1',
        questions: [
          {
            question: '是否继续？',
            header: '确认',
            options: [
              { label: '是' },
              { label: '否' },
            ],
            multiSelect: false,
          },
        ],
      });

      assert.strictEqual(card.card_type, 'vote_interaction');
      assert.ok(card.checkbox);
      assert.strictEqual(card.checkbox?.mode, 0);
      assert.strictEqual(card.checkbox?.option_list.length, 2);
      assert.strictEqual(card.checkbox?.option_list[0].text, '是');
      assert.strictEqual(card.checkbox?.option_list[1].text, '否');
      assert.ok(card.submit_button);
      assert.strictEqual(card.submit_button?.text, '提交');
    });

    it('builds a multiple_interaction card for multiple questions', () => {
      const card = buildQuestionCard({
        requestId: 'req-q2',
        sessionId: 'sess-q2',
        questions: [
          {
            question: '选择颜色',
            options: [{ label: '红' }, { label: '蓝' }],
            multiSelect: false,
          },
          {
            question: '选择大小',
            options: [{ label: '大' }, { label: '小' }],
            multiSelect: false,
          },
        ],
      });

      assert.strictEqual(card.card_type, 'multiple_interaction');
      assert.ok(card.select_list);
      assert.strictEqual(card.select_list?.length, 2);
      assert.strictEqual(card.select_list![0].option_list.length, 2);
      assert.strictEqual(card.select_list![1].option_list.length, 2);
      assert.ok(card.submit_button);
    });

    it('builds a multiple_interaction card for multi-select question', () => {
      const card = buildQuestionCard({
        requestId: 'req-q3',
        sessionId: 'sess-q3',
        questions: [
          {
            question: '选择所有适用的选项',
            options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
            multiSelect: true,
          },
        ],
      });

      assert.strictEqual(card.card_type, 'multiple_interaction');
      assert.ok(card.select_list);
      assert.strictEqual(card.select_list?.length, 1);
    });

    it('falls back to text_notice for free-text questions', () => {
      const card = buildQuestionCard({
        requestId: 'req-q4',
        sessionId: 'sess-q4',
        questions: [
          {
            question: '请描述您的需求',
            options: [],
            multiSelect: false,
          },
        ],
      });

      assert.strictEqual(card.card_type, 'text_notice');
      assert.ok(card.main_title);
      assert.ok(card.main_title?.desc?.includes('请描述您的需求'));
      assert.ok(card.sub_title_text?.includes('请在聊天中直接回复'));
    });

    it('includes task_id when provided', () => {
      const card = buildQuestionCard({
        requestId: 'req-q5',
        sessionId: 'sess-q5',
        questions: [
          {
            question: '是否继续？',
            options: [{ label: '是' }, { label: '否' }],
            multiSelect: false,
          },
        ],
        taskId: 'task-q5',
      });

      assert.strictEqual(card.task_id, 'task-q5');
    });
  });

  describe('buildTerminalCard', () => {
    it('produces a text_notice card with the given notice', () => {
      const card = buildTerminalCard('button_interaction', '该请求已过期', 'task-123');

      assert.strictEqual(card.card_type, 'text_notice');
      assert.strictEqual(card.main_title?.title, '已处理');
      assert.strictEqual(card.main_title?.desc, '该请求已过期');
      assert.strictEqual(card.task_id, 'task-123');
    });

    it('works without a task_id', () => {
      const card = buildTerminalCard('vote_interaction', '已处理');
      assert.strictEqual(card.card_type, 'text_notice');
      assert.strictEqual(card.task_id, undefined);
    });
  });

  describe('parseTemplateCardEvent', () => {
    it('parses a valid template card event frame', () => {
      const requestId = 'req-event-1';
      const sessionId = 'sess-event-1';
      const key = encodeButtonKey(requestId, 'allow', sessionId);

      const frame = {
        headers: { req_id: 'req-123' },
        body: {
          event: {
            eventtype: 'template_card_event' as const,
            event_key: key,
            task_id: 'task-456',
            from: { userid: 'user-789' },
          },
        },
      };

      const parsed = parseTemplateCardEvent(frame as unknown as Parameters<typeof parseTemplateCardEvent>[0]);
      assert.ok(parsed);
      assert.strictEqual(parsed.requestId, requestId);
      assert.strictEqual(parsed.action, 'allow');
      assert.strictEqual(parsed.sessionId, sessionId);
      assert.strictEqual(parsed.wecomUserId, 'user-789');
      assert.strictEqual(parsed.taskId, 'task-456');
    });

    it('returns undefined for non-Comate keys', () => {
      const frame = {
        headers: { req_id: 'req-123' },
        body: {
          event: {
            eventtype: 'template_card_event' as const,
            event_key: 'random-key',
            from: { userid: 'user-1' },
          },
        },
      };

      const parsed = parseTemplateCardEvent(frame as unknown as Parameters<typeof parseTemplateCardEvent>[0]);
      assert.strictEqual(parsed, undefined);
    });

    it('returns undefined when event_key is missing', () => {
      const frame = {
        headers: { req_id: 'req-123' },
        body: {
          event: {
            eventtype: 'template_card_event' as const,
            from: { userid: 'user-1' },
          },
        },
      };

      const parsed = parseTemplateCardEvent(frame as unknown as Parameters<typeof parseTemplateCardEvent>[0]);
      assert.strictEqual(parsed, undefined);
    });

    it('handles missing from.userid gracefully', () => {
      const key = encodeButtonKey('r1', 'deny', 's1');
      const frame = {
        headers: { req_id: 'req-123' },
        body: {
          event: {
            eventtype: 'template_card_event' as const,
            event_key: key,
          },
        },
      };

      const parsed = parseTemplateCardEvent(frame as unknown as Parameters<typeof parseTemplateCardEvent>[0]);
      assert.ok(parsed);
      assert.strictEqual(parsed.wecomUserId, '');
    });
  });

  describe('verifySessionOwner', () => {
    it('returns true when the user owns the session', () => {
      const getWecomUserIdBySession = () => 'user-abc';
      const result = verifySessionOwner('user-abc', 'sess-1', 'ws-1', getWecomUserIdBySession);
      assert.strictEqual(result, true);
    });

    it('returns false when the user does not own the session', () => {
      const getWecomUserIdBySession = () => 'user-abc';
      const result = verifySessionOwner('user-other', 'sess-1', 'ws-1', getWecomUserIdBySession);
      assert.strictEqual(result, false);
    });

    it('returns false when session owner is not found', () => {
      const getWecomUserIdBySession = () => null;
      const result = verifySessionOwner('user-abc', 'sess-1', 'ws-1', getWecomUserIdBySession);
      assert.strictEqual(result, false);
    });
  });
});
