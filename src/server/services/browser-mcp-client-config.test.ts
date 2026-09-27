import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildBrowserMcpClientConnection } from './browser-mcp-client-config.js';

describe('browser MCP client parity', () => {
  it('gives Claude and OpenCode one exact authenticated HTTP connection', () => {
    const connection = buildBrowserMcpClientConnection('http://127.0.0.1:4123', 'session-1', 'task-token');
    const claude = { type: 'http', ...connection };
    const opencode = { type: 'remote', ...connection, oauth: false };
    assert.equal(claude.url, opencode.url);
    assert.deepEqual(claude.headers, opencode.headers);
    assert.equal(claude.headers.Authorization, 'Bearer task-token');
    assert.equal(JSON.stringify(connection).includes('session-1'), true);
  });
});
