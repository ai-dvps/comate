import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as cardModule from './wecom-template-card.js';
import {
  encodeButtonKey,
  decodeButtonKey,
  buildToolApprovalCard,
  buildWecomSessionListCard,
  buildEscalationApprovalCard,
  buildEscalationNoticeCard,
  buildEscalationResultCard,
  buildTerminalCard,
  isEscalationAction,
  parseTemplateCardEvent,
  verifySessionOwner,
  formatPermissionFold,
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

    it('round-trips all actions including resume', () => {
      const actions = ['allow', 'always_allow', 'deny', 'resume'] as const;
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
        operationSummary: 'npm test',
        allowAlways: true,
      });

      assert.strictEqual(card.card_type, 'button_interaction');
      assert.ok(card.main_title);
      assert.strictEqual(card.main_title?.title, '执行 Bash 命令');
      assert.match(card.main_title?.desc ?? '', /请求执行 shell 命令/);
      assert.match(card.main_title?.desc ?? '', /npm test/);
      assert.ok(card.button_list);
      assert.strictEqual(card.button_list?.length, 3);

      const texts = card.button_list?.map((b) => b.text);
      assert.deepStrictEqual(texts, ['仅本次允许', '对此规则始终允许', '拒绝']);

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
      assert.strictEqual(card.main_title?.title, '需要确认：修改文件');
      assert.ok(card.main_title?.desc);
      assert.deepStrictEqual(card.button_list?.map((button) => button.text), ['仅本次允许', '拒绝']);
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
        allowAlways: true,
      });

      const allowDecoded = decodeButtonKey(card.button_list![0].key);
      assert.strictEqual(allowDecoded?.action, 'allow');

      const alwaysDecoded = decodeButtonKey(card.button_list![1].key);
      assert.strictEqual(alwaysDecoded?.action, 'always_allow');

      const denyDecoded = decodeButtonKey(card.button_list![2].key);
      assert.strictEqual(denyDecoded?.action, 'deny');
    });

    it('only offers always-allow when a persistent permission can be written', () => {
      const oneShot = buildToolApprovalCard({
        requestId: 'req-once',
        sessionId: 'sess-once',
        toolName: 'Bash',
      });
      const persistent = buildToolApprovalCard({
        requestId: 'req-persistent',
        sessionId: 'sess-persistent',
        toolName: 'Bash',
        allowAlways: true,
      });

      assert.deepStrictEqual(oneShot.button_list?.map((button) => button.text), ['仅本次允许', '拒绝']);
      assert.deepStrictEqual(
        persistent.button_list?.map((button) => button.text),
        ['仅本次允许', '对此规则始终允许', '拒绝'],
      );
    });
  });

  describe('U2 question-path removal (symbol absence)', () => {
    it('no longer exports buildQuestionCard or formatQuestionFold', () => {
      const exports = cardModule as unknown as Record<string, unknown>;
      assert.strictEqual(exports.buildQuestionCard, undefined, 'buildQuestionCard must be gone');
      assert.strictEqual(exports.formatQuestionFold, undefined, 'formatQuestionFold must be gone');
    });
  });

  describe('buildWecomSessionListCard', () => {
    it('builds a single-select multiple_interaction card whose option ids are sessionIds', () => {
      const card = buildWecomSessionListCard({
        requestId: 'req-r1',
        sessionId: 'sess-current',
        taskId: 'task-r1',
        options: [
          { sessionId: 'sess-a', label: '项目 A · 3小时前' },
          { sessionId: 'sess-b', label: '项目 B · 昨天', isActive: true },
        ],
      });

      assert.strictEqual(card.card_type, 'multiple_interaction');
      assert.ok(card.select_list);
      assert.strictEqual(card.select_list?.length, 1);
      const selector = card.select_list![0];
      assert.strictEqual(selector.option_list.length, 2);
      // Stateless: option id IS the target sessionId.
      assert.strictEqual(selector.option_list[0].id, 'sess-a');
      assert.strictEqual(selector.option_list[1].id, 'sess-b');
      // Active session is marked.
      assert.strictEqual(selector.option_list[0].text, '项目 A · 3小时前');
      assert.ok(selector.option_list[1].text.includes('（当前）'));
      // Submit button key carries action 'resume'.
      const decoded = decodeButtonKey(card.submit_button!.key);
      assert.ok(decoded);
      assert.strictEqual(decoded.action, 'resume');
      assert.strictEqual(decoded.sessionId, 'sess-current');
      assert.strictEqual(card.task_id, 'task-r1');
    });

    it('uses default title/desc and submit text when not provided', () => {
      const card = buildWecomSessionListCard({
        requestId: 'req-r2',
        sessionId: 'sess-current',
        options: [{ sessionId: 'sess-a', label: '会话 A' }],
      });
      assert.strictEqual(card.main_title?.title, '选择会话');
      assert.strictEqual(card.select_list?.[0].title, '可恢复的会话');
      assert.strictEqual(card.submit_button?.text, '恢复');
    });
  });

  describe('buildTerminalCard', () => {
    it('produces a text_notice card with the given notice', () => {
      const card = buildTerminalCard('button_interaction', '该请求已过期', 'task-123');

      assert.strictEqual(card.card_type, 'text_notice');
      assert.strictEqual(card.main_title?.title, '已处理');
      assert.strictEqual(card.main_title?.desc, '该请求已过期');
      assert.strictEqual(card.task_id, 'task-123');
      assert.deepStrictEqual(card.card_action, { type: 0 });
    });

    it('works without a task_id', () => {
      const card = buildTerminalCard('button_interaction', '已处理');
      assert.strictEqual(card.card_type, 'text_notice');
      assert.strictEqual(card.task_id, undefined);
    });

    it('produces a vote_interaction terminal with replace_text + disabled checkbox + disabled submit button', () => {
      const card = buildTerminalCard('vote_interaction', '已恢复会话', 'task-v1');
      assert.strictEqual(card.card_type, 'vote_interaction');
      assert.strictEqual((card as Record<string, unknown>).replace_text, '已恢复会话');
      assert.strictEqual(
        (card as Record<string, { disable?: boolean }>).checkbox?.disable,
        true,
      );
      assert.strictEqual((card as Record<string, { text?: string; key?: string }>).submit_button?.text, '已恢复会话');
      assert.strictEqual((card as Record<string, { text?: string; key?: string }>).submit_button?.key, 'terminal');
      assert.deepStrictEqual(card.card_action, { type: 0 });
      assert.strictEqual(card.task_id, 'task-v1');
    });

    it('produces a multiple_interaction terminal with replace_text + disabled selector + disabled submit button', () => {
      const card = buildTerminalCard('multiple_interaction', '已提交', 'task-m1');
      assert.strictEqual(card.card_type, 'multiple_interaction');
      assert.strictEqual((card as Record<string, unknown>).replace_text, '已提交');
      const selector = (card as Record<string, { select_list?: Array<{ disable?: boolean; selected_id?: string; title?: string }> }>).select_list?.[0];
      assert.strictEqual(selector?.disable, true);
      assert.strictEqual(selector?.selected_id, '0');
      assert.strictEqual(selector?.title, '已选择');
      assert.strictEqual((card as Record<string, { text?: string; key?: string }>).submit_button?.text, '已提交');
      assert.strictEqual((card as Record<string, { text?: string; key?: string }>).submit_button?.key, 'terminal');
      assert.deepStrictEqual(card.card_action, { type: 0 });
      assert.strictEqual(card.task_id, 'task-m1');
    });

    it('preserves decision context and the selected answer in a terminal card', () => {
      const card = buildTerminalCard('vote_interaction', '已提交', 'task-context', {
        title: '回答已提交',
        desc: '选择发布环境',
        selectionText: '测试环境',
      });

      assert.strictEqual(card.main_title?.title, '回答已提交');
      assert.strictEqual(card.main_title?.desc, '选择发布环境');
      assert.strictEqual(card.checkbox?.option_list[0].text, '测试环境');
      assert.strictEqual(card.checkbox?.disable, true);
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
          from: { userid: 'user-789' },
          event: {
            eventtype: 'template_card_event' as const,
            event_key: key,
            task_id: 'task-456',
            card_type: 'button_interaction',
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
      assert.strictEqual(parsed.cardType, 'button_interaction');
    });

    it('parses a resume action event (regression: not silently dropped)', () => {
      // P1 regression: before 'resume' was added to the action allowlist,
      // decodeButtonKey returned undefined and parseTemplateCardEvent dropped
      // the entire /resume callback. The selected option id is the target sessionId.
      const requestId = 'req-resume';
      const sessionId = 'sess-source';
      const key = encodeButtonKey(requestId, 'resume', sessionId);
      const targetSessionId = 'sess-target';

      const frame = {
        headers: { req_id: 'req-123' },
        body: {
          from: { userid: 'user-1' },
          event: {
            eventtype: 'template_card_event' as const,
            template_card_event: {
              card_type: 'vote_interaction',
              event_key: key,
              task_id: 'task-1',
              selected_items: {
                selected_item: [
                  { question_key: key, option_ids: { option_id: [targetSessionId] } },
                ],
              },
            },
          },
        },
      };

      const parsed = parseTemplateCardEvent(frame as unknown as Parameters<typeof parseTemplateCardEvent>[0]);
      assert.ok(parsed, 'resume event must not be silently dropped');
      assert.strictEqual(parsed.action, 'resume');
      assert.strictEqual(parsed.sessionId, sessionId);
      assert.deepStrictEqual(parsed.selectedItems?.[0].option_ids, [targetSessionId]);
    });

    it('parses the raw SDK wrapper shape with nested selected_items', () => {
      const requestId = 'req-event-2';
      const sessionId = 'sess-event-2';
      const key = encodeButtonKey(requestId, 'allow', sessionId);
      const questionKey = encodeButtonKey(requestId, 'allow', sessionId);

      const frame = {
        headers: { req_id: 'req-123' },
        body: {
          from: { userid: 'user-999' },
          event: {
            eventtype: 'template_card_event' as const,
            template_card_event: {
              card_type: 'vote_interaction',
              event_key: key,
              task_id: 'task-789',
              selected_items: {
                selected_item: [
                  {
                    question_key: questionKey,
                    option_ids: { option_id: ['1', '2'] },
                  },
                ],
              },
            },
          },
        },
      };

      const parsed = parseTemplateCardEvent(frame as unknown as Parameters<typeof parseTemplateCardEvent>[0]);
      assert.ok(parsed);
      assert.strictEqual(parsed.requestId, requestId);
      assert.strictEqual(parsed.sessionId, sessionId);
      assert.strictEqual(parsed.wecomUserId, 'user-999');
      assert.strictEqual(parsed.taskId, 'task-789');
      assert.strictEqual(parsed.cardType, 'vote_interaction');
      assert.deepStrictEqual(parsed.selectedItems, [
        { question_key: questionKey, option_ids: ['1', '2'] },
      ]);
    });

    it('returns undefined for non-Comate keys', () => {
      const frame = {
        headers: { req_id: 'req-123' },
        body: {
          from: { userid: 'user-1' },
          event: {
            eventtype: 'template_card_event' as const,
            event_key: 'random-key',
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
          from: { userid: 'user-1' },
          event: {
            eventtype: 'template_card_event' as const,
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
      const getChannelUserIdBySession = () => 'user-abc';
      const result = verifySessionOwner('user-abc', 'sess-1', 'ws-1', getChannelUserIdBySession);
      assert.strictEqual(result, true);
    });

    it('returns false when the user does not own the session', () => {
      const getChannelUserIdBySession = () => 'user-abc';
      const result = verifySessionOwner('user-other', 'sess-1', 'ws-1', getChannelUserIdBySession);
      assert.strictEqual(result, false);
    });

    it('returns false when session owner is not found', () => {
      const getChannelUserIdBySession = () => null;
      const result = verifySessionOwner('user-abc', 'sess-1', 'ws-1', getChannelUserIdBySession);
      assert.strictEqual(result, false);
    });
  });

  describe('formatPermissionFold', () => {
    it('maps actions to 已允许 / 已拒绝 / 已始终允许', () => {
      assert.strictEqual(formatPermissionFold('Bash', 'allow'), '🔐 Bash → 已允许');
      assert.strictEqual(formatPermissionFold('Bash', 'deny'), '🔐 Bash → 已拒绝');
      assert.strictEqual(formatPermissionFold('Edit', 'always_allow'), '🔐 Edit → 已始终允许');
    });

    it('never echoes command arguments (signature accepts only tool + action)', () => {
      const out = formatPermissionFold('Bash', 'allow');
      assert.ok(out.includes('Bash'));
      assert.ok(out.includes('已允许'));
      assert.ok(!out.includes('--') && !out.includes('/') && !out.includes('rm '));
    });

    it('falls back to "unknown" for an empty tool name', () => {
      assert.strictEqual(formatPermissionFold('', 'allow'), '🔐 unknown → 已允许');
      assert.strictEqual(formatPermissionFold('   ', 'deny'), '🔐 unknown → 已拒绝');
    });
  });

  describe('escalation cards (U11, KTD-15/KTD-18)', () => {
    const baseOptions = {
      requestId: 'req-esc-1',
      sessionId: 'sess-1',
      toolName: 'Bash',
      commandSummary: 'curl https://a.com/x',
      requesterLabel: 'user-1',
      requesterRoleLabel: '普通成员',
      alwaysAllowRules: ['Bash(curl https://a.com/x)'],
      ttlMinutes: 30,
      taskId: 'req-esc-1',
    };

    it('buildEscalationApprovalCard shows the exact rule + match semantics and all three escalate actions', () => {
      const card = buildEscalationApprovalCard(baseOptions);
      assert.strictEqual(card.card_type, 'button_interaction');
      assert.match(card.main_title.title, /出沙箱审批/);
      // KTD-18: the card content IS the rule that would persist + its prose.
      assert.match(card.main_title.desc, /Bash\(curl https:\/\/a\.com\/x\)/);
      assert.match(card.main_title.desc, /仅精确匹配此命令/);
      assert.match(card.main_title.desc, /30 分钟/);
      assert.match(card.main_title.desc, /user-1/);

      const buttons = (card as { button_list: Array<{ text: string; key: string }> }).button_list;
      assert.strictEqual(buttons.length, 3);
      const actions = buttons.map((b) => decodeButtonKey(b.key)?.action);
      assert.deepStrictEqual(actions, ['escalate_approve', 'escalate_always_allow', 'escalate_deny']);
      // Keys decode back to this request/session for the click handler.
      assert.ok(buttons.every((b) => decodeButtonKey(b.key)?.requestId === 'req-esc-1'));
      assert.ok(buttons.every((b) => decodeButtonKey(b.key)?.sessionId === 'sess-1'));
    });

    it('buildEscalationApprovalCard hides the always-allow button when there is nothing persistable', () => {
      const card = buildEscalationApprovalCard({ ...baseOptions, alwaysAllowRules: [] });
      const buttons = (card as { button_list: Array<{ text: string; key: string }> }).button_list;
      assert.strictEqual(buttons.length, 2);
      const actions = buttons.map((b) => decodeButtonKey(b.key)?.action);
      assert.deepStrictEqual(actions, ['escalate_approve', 'escalate_deny']);
      assert.doesNotMatch(card.main_title.desc, /始终允许将写入直通名单/);
    });

    it('buildEscalationNoticeCard is read-only (no buttons) with pinned content', () => {
      const card = buildEscalationNoticeCard({
        commandSummary: 'curl https://a.com/x',
        toolName: 'Bash',
        audienceLabel: '渠道 owner 或 admin',
        ttlMinutes: 30,
        taskId: 'req-esc-1',
      });
      assert.strictEqual(card.card_type, 'text_notice');
      assert.strictEqual((card as { button_list?: unknown }).button_list, undefined);
      assert.match(card.main_title.desc, /curl https:\/\/a\.com\/x/);
      assert.match(card.main_title.desc, /渠道 owner 或 admin/);
      assert.match(card.main_title.desc, /30 分钟/);
    });

    it('buildEscalationResultCard carries the outcome title and detail', () => {
      const card = buildEscalationResultCard({
        title: '出沙箱审批已批准',
        desc: '命令:curl https://a.com/x\n处理人:owner-1',
        taskId: 'req-esc-1',
      });
      assert.strictEqual(card.card_type, 'text_notice');
      assert.strictEqual(card.main_title.title, '出沙箱审批已批准');
      assert.match(card.main_title.desc, /owner-1/);
      assert.strictEqual(card.task_id, 'req-esc-1');
    });

    it('isEscalationAction classifies the escalate family only', () => {
      assert.ok(isEscalationAction('escalate_approve'));
      assert.ok(isEscalationAction('escalate_always_allow'));
      assert.ok(isEscalationAction('escalate_deny'));
      assert.ok(!isEscalationAction('allow'));
      assert.ok(!isEscalationAction('deny'));
      assert.ok(!isEscalationAction('select_workspace'));
    });

    it('escalate actions round-trip through encode/decode (replayed clicks stay decodable)', () => {
      for (const action of ['escalate_approve', 'escalate_always_allow', 'escalate_deny'] as const) {
        const key = encodeButtonKey('req-1', action, 'sess-1');
        assert.strictEqual(decodeButtonKey(key)?.action, action);
      }
    });
  });
});
