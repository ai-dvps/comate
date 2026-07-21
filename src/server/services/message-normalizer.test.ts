import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeSessionMessage, partsFromSdkContent, scanSdkMessagesForTasks } from './message-normalizer.js';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';

describe('message-normalizer tool_use_meta', () => {
  it('attaches block-level tool_use_meta to tool_use parts', () => {
    const parts = partsFromSdkContent([
      {
        type: 'tool_use',
        id: 'tu-1',
        name: 'mcp__server__fetch',
        input: { url: 'https://example.com' },
        tool_use_meta: { display_name: 'Web Fetch', icon_url: 'https://example.com/icon.png' },
      },
    ]);

    assert.strictEqual(parts.length, 1);
    assert.strictEqual(parts[0]?.type, 'tool_use');
    assert.strictEqual(parts[0]?.meta?.displayName, 'Web Fetch');
    assert.strictEqual(parts[0]?.meta?.iconUrl, 'https://example.com/icon.png');
  });

  it('attaches top-level tool_use_meta array to tool_use parts by index', () => {
    const parts = partsFromSdkContent(
      [
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 'tu-1', name: 'mcp__server__read', input: { path: '/' } },
      ],
      undefined,
      [undefined, { display_name: 'Read', icon_url: 'https://example.com/read.png' }],
    );

    assert.strictEqual(parts.length, 2);
    assert.strictEqual(parts[1]?.type, 'tool_use');
    assert.strictEqual(parts[1]?.meta?.displayName, 'Read');
    assert.strictEqual(parts[1]?.meta?.iconUrl, 'https://example.com/read.png');
  });

  it('prefers top-level meta over block-level meta when both are present', () => {
    const parts = partsFromSdkContent(
      [
        {
          type: 'tool_use',
          id: 'tu-1',
          name: 'mcp__server__read',
          input: { path: '/' },
          tool_use_meta: { display_name: 'Block Name' },
        },
      ],
      undefined,
      [{ display_name: 'Top Name', icon_url: 'https://example.com/top.png' }],
    );

    assert.strictEqual(parts[0]?.type, 'tool_use');
    assert.strictEqual(parts[0]?.meta?.displayName, 'Top Name');
    assert.strictEqual(parts[0]?.meta?.iconUrl, 'https://example.com/top.png');
  });

  it('leaves legacy tool_use blocks without meta unchanged', () => {
    const parts = partsFromSdkContent([
      { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
    ]);

    assert.strictEqual(parts.length, 1);
    assert.strictEqual(parts[0]?.type, 'tool_use');
    assert.strictEqual(parts[0]?.meta, undefined);
  });

  it('normalizes historical assistant message with top-level tool_use_meta', () => {
    const sessionMessage = {
      type: 'assistant',
      uuid: 'msg-1',
      session_id: 's1',
      message: {
        id: 'msg-1',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'mcp__server__fetch', input: { url: 'https://example.com' } },
        ],
        tool_use_meta: [{ display_name: 'Web Fetch', icon_url: 'https://example.com/icon.png' }],
      },
    } as unknown as SessionMessage;

    const normalized = normalizeSessionMessage(sessionMessage);
    assert.ok(normalized);
    assert.strictEqual(normalized.parts.length, 1);
    assert.strictEqual(normalized.parts[0]?.type, 'tool_use');
    assert.strictEqual(normalized.parts[0]?.meta?.displayName, 'Web Fetch');
    assert.strictEqual(normalized.parts[0]?.meta?.iconUrl, 'https://example.com/icon.png');
  });
});

describe('message-normalizer task-notification suppression', () => {
  // The bundled CLI injects <task-notification>…</task-notification> as the
  // text body of a synthetic user-role message. Such messages are model
  // context, not user content, and must not render as chat bubbles. See plan
  // 2026-07-21-001-fix-hide-task-notification-xml-plan.md.

  it('drops a user message whose envelope origin is task-notification (covers AE1)', () => {
    const msg = {
      type: 'user',
      uuid: 'u-1',
      session_id: 's1',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '<task-notification>\n  <task-id>agent-1</task-id>\n</task-notification>' }],
      },
      origin: { kind: 'task-notification' },
    } as unknown as SessionMessage;

    assert.strictEqual(normalizeSessionMessage(msg), null);
  });

  it('drops a user message whose whole text body is the wrapper, no origin (covers AE2)', () => {
    const msg = {
      type: 'user',
      uuid: 'u-2',
      session_id: 's1',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '<task-notification>\n  <status>completed</status>\n</task-notification>' }],
      },
    } as unknown as SessionMessage;

    assert.strictEqual(normalizeSessionMessage(msg), null);
  });

  it('keeps a user message that only mentions the tag inline (covers AE3)', () => {
    const inline = {
      type: 'user',
      uuid: 'u-3',
      session_id: 's1',
      message: { role: 'user', content: [{ type: 'text', text: 'See <task-notification> in the docs below' }] },
    } as unknown as SessionMessage;
    const r1 = normalizeSessionMessage(inline);
    assert.ok(r1, 'inline mention must not be suppressed');
    assert.strictEqual(r1?.role, 'user');

    // Starts with the opening tag but has no closing tag — still not a wrapper.
    const openOnly = {
      type: 'user',
      uuid: 'u-3b',
      session_id: 's1',
      message: { role: 'user', content: [{ type: 'text', text: '<task-notification>\n some prose, no close' }] },
    } as unknown as SessionMessage;
    const r2 = normalizeSessionMessage(openOnly);
    assert.ok(r2, 'open-tag-without-close must not be suppressed');
  });

  it('suppresses a wrapper with surrounding whitespace (trim)', () => {
    const msg = {
      type: 'user',
      uuid: 'u-4',
      session_id: 's1',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '  \n<task-notification>\n</task-notification>\n  ' }],
      },
    } as unknown as SessionMessage;

    assert.strictEqual(normalizeSessionMessage(msg), null);
  });

  it('suppresses an all-text multi-block message that joins to the wrapper', () => {
    const whole = {
      type: 'user',
      uuid: 'u-5',
      session_id: 's1',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<task-notification>' },
          { type: 'text', text: '\n</task-notification>' },
        ],
      },
    } as unknown as SessionMessage;
    assert.strictEqual(normalizeSessionMessage(whole), null);

    // A wrapper plus extra prose is NOT wholly a wrapper — keep it.
    const withExtra = {
      type: 'user',
      uuid: 'u-5b',
      session_id: 's1',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<task-notification>' },
          { type: 'text', text: '</task-notification>' },
          { type: 'text', text: 'more text after' },
        ],
      },
    } as unknown as SessionMessage;
    assert.ok(normalizeSessionMessage(withExtra), 'wrapper plus extra text must not be suppressed');
  });

  it('suppresses a user message whose content is a bare wrapper string', () => {
    const msg = {
      type: 'user',
      uuid: 'u-6',
      session_id: 's1',
      message: { role: 'user', content: '<task-notification>\n</task-notification>' },
    } as unknown as SessionMessage;

    assert.strictEqual(normalizeSessionMessage(msg), null);
  });

  it('does not suppress assistant or system messages that contain the wrapper (role gating)', () => {
    const assistant = {
      type: 'assistant',
      uuid: 'a-1',
      session_id: 's1',
      message: {
        id: 'a-1',
        role: 'assistant',
        content: [{ type: 'text', text: '<task-notification>\n</task-notification>' }],
      },
    } as unknown as SessionMessage;
    const r = normalizeSessionMessage(assistant);
    assert.ok(r, 'assistant wrapper message must not be suppressed by the user-only check');
    assert.strictEqual(r?.role, 'assistant');

    // The suppression is role-gated to user, so a system-role wrapper is left
    // alone (handled by the system-message path, not this check).
    const systemWrapper = {
      type: 'system',
      uuid: 'sys-gate',
      session_id: 's1',
      message: { content: [{ type: 'text', text: '<task-notification>\n</task-notification>' }] },
    } as unknown as SessionMessage;
    const rs = normalizeSessionMessage(systemWrapper);
    assert.ok(rs, 'system wrapper message must not be suppressed by the user-only check');
    assert.strictEqual(rs?.role, 'system');
  });

  it('does not suppress a user message whose wrapper text shares content with a non-text block', () => {
    const msg = {
      type: 'user',
      uuid: 'u-mix',
      session_id: 's1',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<task-notification>\n</task-notification>' },
          { type: 'tool_result', tool_use_id: 'tu-x', content: 'ok' },
        ],
      },
    } as unknown as SessionMessage;

    const r = normalizeSessionMessage(msg);
    assert.ok(r, 'mixed text + tool_result content must not be suppressed');
    assert.strictEqual(r?.role, 'user');
  });

  it('still suppresses via text when origin.kind is not task-notification', () => {
    const msg = {
      type: 'user',
      uuid: 'u-of',
      session_id: 's1',
      message: { role: 'user', content: [{ type: 'text', text: '<task-notification>\n</task-notification>' }] },
      origin: { kind: 'something-else' },
    } as unknown as SessionMessage;

    // origin is present but not the task-notification kind -> falls through to
    // the whole-wrapper text check, which still suppresses.
    assert.strictEqual(normalizeSessionMessage(msg), null);
  });

  it('keeps the Tasks panel fed while dropping the user-role wrapper (covers AE4 / R5)', () => {
    const msgs = [
      {
        type: 'system',
        uuid: 'sys-1',
        session_id: 's1',
        message: { subtype: 'task_started', task_id: 't1', description: 'do thing' },
      },
      {
        type: 'system',
        uuid: 'sys-2',
        session_id: 's1',
        message: { subtype: 'task_notification', task_id: 't1', status: 'completed' },
      },
      {
        type: 'user',
        uuid: 'u-7',
        session_id: 's1',
        message: { role: 'user', content: [{ type: 'text', text: '<task-notification>\n</task-notification>' }] },
      },
    ] as unknown as SessionMessage[];

    const tasks = scanSdkMessagesForTasks(msgs);
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0]?.id, 't1');
    assert.strictEqual(tasks[0]?.status, 'completed');

    // The structured lifecycle still drives the panel; the leaking user-role
    // wrapper is dropped independently.
    assert.strictEqual(normalizeSessionMessage(msgs[2] as SessionMessage), null);
  });
});