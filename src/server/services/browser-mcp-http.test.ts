import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createBrowserMcpHttpRouter, getBrowserMcpToken } from './browser-mcp-http.js';

const MCP_HEADERS = (token: string) => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: `Bearer ${token}`,
});

describe('browser-mcp-http (U6)', { concurrency: false }, () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/mcp/browser',
      createBrowserMcpHttpRouter(async (sessionId) => ({
        workspaceId: `ws-for-${sessionId}`,
        approvalRequester: async () => ({ behavior: 'allow' as const }),
      })),
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/browser`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const post = async (sessionId: string, body: unknown, token = getBrowserMcpToken()) => {
    const res = await fetch(`${baseUrl}/${sessionId}`, {
      method: 'POST',
      headers: MCP_HEADERS(token),
      body: JSON.stringify(body),
    });
    // The streamable HTTP transport answers with an SSE frame; unwrap the
    // JSON-RPC payload from its data: line.
    const text = await res.text();
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    return { status: res.status, json: dataLine ? JSON.parse(dataLine.slice(5).trim()) : undefined };
  };

  it('rejects requests without the bearer token', async () => {
    const res = await fetch(`${baseUrl}/s1`, {
      method: 'POST',
      headers: { ...MCP_HEADERS('wrong') },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(res.status, 401);
  });

  it('answers initialize with server info', async () => {
    const res = await post('s1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.result.serverInfo.name, 'comate-browser');
  });

  it('lists the browser tool surface', async () => {
    const res = await post('s1', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(res.status, 200);
    const names = res.json.result.tools.map((t: { name: string }) => t.name);
    for (const expected of ['open', 'snapshot', 'act', 'submit', 'extract', 'requestHandoff', 'close']) {
      assert.ok(names.includes(expected), `tool ${expected} listed`);
    }
  });

  it('rejects non-POST methods', async () => {
    const res = await fetch(`${baseUrl}/s1`, { headers: MCP_HEADERS(getBrowserMcpToken()) });
    assert.equal(res.status, 405);
  });
});

describe('production mount order (review P1)', { concurrency: false }, () => {
  it('answers initialize without a global body parser (router-local json)', async () => {
    const app = express();
    // Mirror server-main order: router mounted BEFORE any global express.json().
    app.use(
      '/mcp/browser',
      createBrowserMcpHttpRouter(async () => ({
        workspaceId: 'ws',
        approvalRequester: async () => ({ behavior: 'allow' as const }),
      })),
    );
    app.use(express.json());
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/mcp/browser/s1`, {
        method: 'POST',
        headers: MCP_HEADERS(getBrowserMcpToken()),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
        }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
      assert.ok(dataLine, 'SSE data line present');
      assert.equal(JSON.parse(dataLine!.slice(5).trim()).result.serverInfo.name, 'comate-browser');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
