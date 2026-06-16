import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WeComDocService } from './wecom-doc-service.js';
import { WeComMcpClient, sign } from './wecom-mcp-client.js';
import type { Workspace } from '../models/workspace.js';

describe('WeComDocService', { concurrency: false }, () => {
  let service: WeComDocService;
  let tempDir: string;
  let origFetch: typeof global.fetch;
  const requests: RequestRecord[] = [];

  beforeEach(async () => {
    service = new WeComDocService();
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'wecom-doc-test-'));
    requests.length = 0;
    origFetch = global.fetch;
  });

  afterEach(async () => {
    global.fetch = origFetch;
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  function makeWorkspace(botId = 'bot_123', botSecret = 'secret_456'): Workspace {
    return {
      id: 'ws-1',
      name: 'Test',
      description: '',
      folderPath: tempDir,
      settings: { wecomBotId: botId, wecomBotSecret: botSecret },
      skills: [],
      mcpServers: [],
      hooks: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function mockFetch(handler: MockFetchHandler): void {
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const bodyText = init?.body ? String(init.body) : '';
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        // leave empty
      }
      const record: RequestRecord = { url, body };
      requests.push(record);
      const response = await handler(url, body, init);
      return response ?? new Response('{}', { status: 200 });
    }) as typeof global.fetch;
  }

  function mcpJsonResponse(business: Record<string, unknown>): Response {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'resp-1',
        result: {
          content: [{ type: 'text', text: JSON.stringify(business) }],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  it('throws when workspace is missing bot credentials', async () => {
    const workspace = makeWorkspace();
    workspace.settings.wecomBotId = undefined;
    workspace.settings.wecomBotSecret = undefined;

    await assert.rejects(
      service.callTool(workspace, 'get-doc-content', { docid: 'DOC1' }),
      /missing WeCom bot credentials/,
    );
  });

  it('forwards a plain tool call, mapping kebab-case to snake_case', async () => {
    mockFetch((url, body) => {
      if (url.includes('get_mcp_config')) {
        assert.ok(typeof body.signature === 'string');
        return new Response(
          JSON.stringify({
            errcode: 0,
            list: [{ biz_type: 'doc', url: 'https://qyapi.weixin.qq.com/mcp/robot-doc' }],
          }),
          { status: 200 },
        );
      }
      assert.strictEqual(url, 'https://qyapi.weixin.qq.com/mcp/robot-doc');
      assert.strictEqual((body.method as string).startsWith('tools/call'), true);
      const params = body.params as Record<string, unknown>;
      assert.strictEqual(params.name, 'get_doc_content');
      assert.deepStrictEqual(params.arguments, { docid: 'DOC1', type: 2 });
      return mcpJsonResponse({ errcode: 0, errmsg: 'ok', content: 'hello' });
    });

    const result = await service.callTool(makeWorkspace(), 'get-doc-content', {
      docid: 'DOC1',
      type: 2,
    });

    assert.deepStrictEqual(result, { errcode: 0, errmsg: 'ok', content: 'hello' });
  });

  it('returns business errors as a normal response (not a 500 throw)', async () => {
    mockFetch((url) => {
      if (url.includes('get_mcp_config')) {
        return new Response(
          JSON.stringify({
            errcode: 0,
            list: [{ biz_type: 'doc', url: 'https://qyapi.weixin.qq.com/mcp/robot-doc' }],
          }),
          { status: 200 },
        );
      }
      return mcpJsonResponse({ errcode: 40001, errmsg: 'invalid docid' });
    });

    const result = await service.callTool(makeWorkspace(), 'get-doc-content', { docid: 'BAD' });
    assert.deepStrictEqual(result, { errcode: 40001, errmsg: 'invalid docid' });
  });

  it('processes smartpage-create with top-level page_filepath', async () => {
    const mdPath = path.join(tempDir, 'overview.md');
    await fsPromises.writeFile(mdPath, '# Overview\n\nContent', 'utf-8');

    mockFetch((url, body) => {
      if (url.includes('get_mcp_config')) {
        return new Response(
          JSON.stringify({
            errcode: 0,
            list: [{ biz_type: 'doc', url: 'https://qyapi.weixin.qq.com/mcp/robot-doc' }],
          }),
          { status: 200 },
        );
      }
      const params = body.params as Record<string, unknown>;
      assert.strictEqual(params.name, 'smartpage_create');
      const args = params.arguments as Record<string, unknown>;
      assert.ok(Array.isArray(args.pages));
      const page = (args.pages as Record<string, unknown>[])[0];
      assert.strictEqual(page.title, 'Overview');
      assert.strictEqual(page.page_content, '# Overview\n\nContent');
      assert.strictEqual('page_filepath' in args, false);
      return mcpJsonResponse({ errcode: 0, errmsg: 'ok', docid: 'PAGE1' });
    });

    const result = await service.callTool(makeWorkspace(), 'smartpage-create', {
      title: 'Overview',
      page_filepath: mdPath,
    });
    assert.deepStrictEqual(result, { errcode: 0, errmsg: 'ok', docid: 'PAGE1' });
  });

  it('processes smartpage-create with pages array', async () => {
    const mdPath = path.join(tempDir, 'page.md');
    await fsPromises.writeFile(mdPath, 'Page body', 'utf-8');

    mockFetch((url, body) => {
      if (url.includes('get_mcp_config')) {
        return new Response(
          JSON.stringify({
            errcode: 0,
            list: [{ biz_type: 'doc', url: 'https://qyapi.weixin.qq.com/mcp/robot-doc' }],
          }),
          { status: 200 },
        );
      }
      const args = (body.params as Record<string, unknown>).arguments as Record<
        string,
        unknown
      >;
      const pages = args.pages as Record<string, unknown>[];
      assert.strictEqual(pages[0].page_content, 'Page body');
      assert.strictEqual('page_filepath' in pages[0], false);
      return mcpJsonResponse({ errcode: 0, errmsg: 'ok' });
    });

    await service.callTool(makeWorkspace(), 'smartpage-create', {
      pages: [{ title: 'P1', page_filepath: mdPath }],
    });
  });

  it('resolves page_filepath relative to workspace folderPath', async () => {
    const subDir = path.join(tempDir, 'docs');
    await fsPromises.mkdir(subDir, { recursive: true });
    const mdPath = path.join(subDir, 'relative.md');
    await fsPromises.writeFile(mdPath, 'Relative content', 'utf-8');

    mockFetch((url, body) => {
      if (url.includes('get_mcp_config')) {
        return new Response(
          JSON.stringify({
            errcode: 0,
            list: [{ biz_type: 'doc', url: 'https://qyapi.weixin.qq.com/mcp/robot-doc' }],
          }),
          { status: 200 },
        );
      }
      const args = (body.params as Record<string, unknown>).arguments as Record<string, unknown>;
      const pages = args.pages as Record<string, unknown>[];
      assert.strictEqual(pages[0].page_content, 'Relative content');
      return mcpJsonResponse({ errcode: 0, errmsg: 'ok' });
    });

    await service.callTool(makeWorkspace(), 'smartpage-create', {
      title: 'Rel',
      page_filepath: 'docs/relative.md',
    });
  });

  it('processes smartsheet-add-records-auto-file with image_path and file_path', async () => {
    const imgPath = path.join(tempDir, 'photo.png');
    const filePath = path.join(tempDir, 'scan.pdf');
    await fsPromises.writeFile(imgPath, 'fake-image-bytes', 'utf-8');
    await fsPromises.writeFile(filePath, 'fake-file-bytes', 'utf-8');

    mockFetch((url, body) => {
      if (url.includes('get_mcp_config')) {
        return new Response(
          JSON.stringify({
            errcode: 0,
            list: [{ biz_type: 'doc', url: 'https://qyapi.weixin.qq.com/mcp/robot-doc' }],
          }),
          { status: 200 },
        );
      }

      const params = body.params as Record<string, unknown>;
      const args = params.arguments as Record<string, unknown>;

      if (params.name === 'upload_doc_image') {
        assert.strictEqual(args.docid, 'DOC1');
        assert.strictEqual(typeof args.base64_content, 'string');
        return mcpJsonResponse({ errcode: 0, errmsg: 'ok', url: 'https://weixin.qq.com/img/1' });
      }

      if (params.name === 'upload_doc_file') {
        assert.strictEqual(args.file_name, 'scan.pdf');
        assert.strictEqual(typeof args.file_base64_content, 'string');
        return mcpJsonResponse({ errcode: 0, errmsg: 'ok', fileid: 'FILE_1' });
      }

      assert.strictEqual(params.name, 'smartsheet_add_records');
      const records = args.records as Record<string, unknown>[];
      const values = records[0].field_values as Record<string, unknown>;
      const imageCell = values.Photo as Record<string, unknown>;
      assert.strictEqual(imageCell.image_url, 'https://weixin.qq.com/img/1');
      assert.strictEqual(imageCell.title, 'photo.png');
      assert.strictEqual('image_path' in imageCell, false);
      const fileCell = values.Attachment as Record<string, unknown>;
      assert.strictEqual(fileCell.file_id, 'FILE_1');
      assert.strictEqual('file_path' in fileCell, false);
      return mcpJsonResponse({ errcode: 0, errmsg: 'ok', record_ids: ['rec_1'] });
    });

    const result = await service.callTool(makeWorkspace(), 'smartsheet-add-records-auto-file', {
      docid: 'DOC1',
      sheet_id: 'SHEET1',
      records: [
        {
          field_values: {
            Photo: { image_path: imgPath },
            Attachment: { file_path: filePath },
          },
        },
      ],
    });
    assert.deepStrictEqual(result, { errcode: 0, errmsg: 'ok', record_ids: ['rec_1'] });
  });

  it('maps smartsheet-update-records-auto-file to smartsheet_update_records', async () => {
    mockFetch((url, body) => {
      if (url.includes('get_mcp_config')) {
        return new Response(
          JSON.stringify({
            errcode: 0,
            list: [{ biz_type: 'doc', url: 'https://qyapi.weixin.qq.com/mcp/robot-doc' }],
          }),
          { status: 200 },
        );
      }
      const params = body.params as Record<string, unknown>;
      assert.strictEqual(params.name, 'smartsheet_update_records');
      return mcpJsonResponse({ errcode: 0, errmsg: 'ok' });
    });

    await service.callTool(makeWorkspace(), 'smartsheet-update-records-auto-file', {
      docid: 'DOC1',
      sheet_id: 'SHEET1',
      records: [{ record_id: 'rec_1', field_values: { Status: 'Done' } }],
    });
  });

  it('rejects files exceeding the size limit', async () => {
    const hugePath = path.join(tempDir, 'huge.png');
    const hugeContent = Buffer.alloc(IMAGE_SIZE_LIMIT + 1, 'x');
    await fsPromises.writeFile(hugePath, hugeContent);

    mockFetch((url) => {
      if (url.includes('get_mcp_config')) {
        return new Response(
          JSON.stringify({
            errcode: 0,
            list: [{ biz_type: 'doc', url: 'https://qyapi.weixin.qq.com/mcp/robot-doc' }],
          }),
          { status: 200 },
        );
      }
      return mcpJsonResponse({ errcode: 0, errmsg: 'ok' });
    });

    await assert.rejects(
      service.callTool(makeWorkspace(), 'smartsheet-add-records-auto-file', {
        docid: 'DOC1',
        sheet_id: 'SHEET1',
        records: [{ field_values: { Photo: { image_path: hugePath } } }],
      }),
      /exceeds limit/,
    );
  });
});

describe('WeComMcpClient', () => {
  let origFetch: typeof global.fetch;
  const requests: RequestRecord[] = [];

  beforeEach(() => {
    origFetch = global.fetch;
    requests.length = 0;
  });

  afterEach(() => {
    global.fetch = origFetch;
  });

  function mockFetch(handler: MockFetchHandler): void {
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const bodyText = init?.body ? String(init.body) : '';
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        // leave empty
      }
      requests.push({ url, body });
      const response = await handler(url, body, init);
      return response ?? new Response('{}', { status: 200 });
    }) as typeof global.fetch;
  }

  it('fetches and caches MCP config, then calls a tool', async () => {
    const client = new WeComMcpClient();
    mockFetch((url, body) => {
      if (url.includes('get_mcp_config')) {
        assert.strictEqual(body.bind_source, 1);
        assert.strictEqual(body.bot_id, 'bot_123');
        assert.ok(typeof body.signature === 'string' && body.signature.length === 64);
        return new Response(
          JSON.stringify({
            errcode: 0,
            list: [{ biz_type: 'doc', url: 'https://qyapi.weixin.qq.com/mcp/robot-doc' }],
          }),
          { status: 200 },
        );
      }
      const req = body;
      assert.strictEqual(req.method, 'tools/call');
      const params = req.params as Record<string, unknown>;
      assert.strictEqual(params.name, 'get_doc_content');
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'r1',
          result: { content: [{ type: 'text', text: '{"errcode":0,"errmsg":"ok"}' }] },
        }),
        { status: 200 },
      );
    });

    const result = await client.callJsonTool('bot_123', 'secret', 'doc', 'get_doc_content', {
      docid: 'D1',
    });
    assert.deepStrictEqual(result, { errcode: 0, errmsg: 'ok' });

    // Second call should reuse cached config (only one config request).
    await client.callJsonTool('bot_123', 'secret', 'doc', 'get_doc_content', { docid: 'D2' });
    const configRequests = requests.filter((r) => r.url.includes('get_mcp_config'));
    assert.strictEqual(configRequests.length, 1);
  });

  it('throws on malformed MCP response', async () => {
    const client = new WeComMcpClient();
    mockFetch((url) => {
      if (url.includes('get_mcp_config')) {
        return new Response(
          JSON.stringify({
            errcode: 0,
            list: [{ biz_type: 'doc', url: 'https://qyapi.weixin.qq.com/mcp/robot-doc' }],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 'r1', result: { content: [] } }),
        { status: 200 },
      );
    });

    await assert.rejects(
      client.callJsonTool('bot_123', 'secret', 'doc', 'get_doc_content', {}),
      /Malformed MCP response/,
    );
  });

  it('throws on MCP config API error', async () => {
    const client = new WeComMcpClient();
    mockFetch(() => {
      return new Response(
        JSON.stringify({ errcode: 40014, errmsg: 'invalid signature' }),
        { status: 200 },
      );
    });

    await assert.rejects(
      client.callJsonTool('bot_123', 'secret', 'doc', 'get_doc_content', {}),
      /errcode=40014/,
    );
  });
});

describe('sign', () => {
  it('produces deterministic SHA-256 signatures', () => {
    const a = sign('sec', 'id', 100, 'nonce');
    const b = sign('sec', 'id', 100, 'nonce');
    assert.strictEqual(a, b);
    assert.strictEqual(a.length, 64);
  });

  it('matches the known SHA-256 hex format', () => {
    const expected = crypto.createHash('sha256').update('test').digest('hex');
    // sign with empty secret/bot_id and time 0 computes sha256('0test'); instead
    // verify the helper returns the same digest the standard library does.
    assert.strictEqual(sign('', '', 0, 'test'), crypto.createHash('sha256').update('0test').digest('hex'));
    assert.strictEqual(expected, '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
  });
});

const IMAGE_SIZE_LIMIT = 30 * 1024 * 1024;

type RequestRecord = { url: string; body: Record<string, unknown> };
type MockFetchHandler = (
  url: string,
  body: Record<string, unknown>,
  init?: RequestInit,
) => Promise<Response | undefined> | Response | undefined;
