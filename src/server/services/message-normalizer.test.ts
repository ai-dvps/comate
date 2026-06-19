import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeSessionMessage, partsFromSdkContent } from './message-normalizer.js';
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
