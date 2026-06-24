import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { WeComDocService } from './wecom-doc-service.js';
import type { Workspace } from '../models/workspace.js';

const MCP_URL = 'https://qyapi.weixin.qq.com/mcp/robot-doc';

type ToolCall = { name: string; args: Record<string, unknown> };
type ToolHandler = (call: ToolCall) => Record<string, unknown>;

describe('WeComDocService.exportSmartsheetWorkbook', { concurrency: false }, () => {
  let service: WeComDocService;
  let origFetch: typeof global.fetch;
  const calls: ToolCall[] = [];

  beforeEach(() => {
    service = new WeComDocService();
    origFetch = global.fetch;
    calls.length = 0;
  });

  afterEach(() => {
    global.fetch = origFetch;
  });

  function makeWorkspace(): Workspace {
    return {
      id: 'ws-1',
      name: 'Test',
      description: '',
      folderPath: '/tmp',
      settings: { wecomBotId: 'bot_123', wecomBotSecret: 'secret_456' },
      skills: [],
      mcpServers: [],
      hooks: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function mockMcp(handler: ToolHandler): void {
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

      if (url.includes('get_mcp_config')) {
        return new Response(
          JSON.stringify({ errcode: 0, list: [{ biz_type: 'doc', url: MCP_URL }] }),
          { status: 200 },
        );
      }

      const params = body.params as Record<string, unknown>;
      const call: ToolCall = {
        name: params.name as string,
        args: params.arguments as Record<string, unknown>,
      };
      calls.push(call);
      const business = handler(call);
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'r1',
          result: { content: [{ type: 'text', text: JSON.stringify(business) }] },
        }),
        { status: 200 },
      );
    }) as typeof global.fetch;
  }

  async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    return wb;
  }

  it('exports only entries whose type is smartsheet', async () => {
    mockMcp((call) => {
      if (call.name === 'smartsheet_get_sheet') {
        return {
          errcode: 0,
          sheet_list: [
            { sheet_id: 'S1', title: 'Data', type: 'smartsheet' },
            { sheet_id: 'S2', title: 'A Doc', type: 'document' },
          ],
        };
      }
      if (call.name === 'smartsheet_get_fields') {
        return { errcode: 0, fields: [{ field_id: 'f1', field_title: 'Name', field_type: 'FIELD_TYPE_TEXT' }] };
      }
      if (call.name === 'smartsheet_get_records') {
        return { errcode: 0, records: [{ record_id: 'r1', values: { f1: 'Alice' } }], has_more: false };
      }
      throw new Error(`unexpected tool ${call.name}`);
    });

    const buffer = await service.exportSmartsheetWorkbook(makeWorkspace(), 'DOC1');
    const wb = await loadWorkbook(buffer);
    assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ['Data']);
  });

  it('sends key_type CELL_VALUE_KEY_TYPE_FIELD_ID on record calls', async () => {
    mockMcp((call) => {
      if (call.name === 'smartsheet_get_sheet') {
        return { errcode: 0, sheet_list: [{ sheet_id: 'S1', title: 'Data', type: 'smartsheet' }] };
      }
      if (call.name === 'smartsheet_get_fields') {
        return { errcode: 0, fields: [{ field_id: 'f1', field_title: 'Name' }] };
      }
      return { errcode: 0, records: [], has_more: false };
    });

    await service.exportSmartsheetWorkbook(makeWorkspace(), 'DOC1');
    const recordCall = calls.find((c) => c.name === 'smartsheet_get_records');
    assert.ok(recordCall);
    assert.strictEqual(recordCall.args.key_type, 'CELL_VALUE_KEY_TYPE_FIELD_ID');
  });

  it('fetches all pages of records', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      record_id: `r${i}`,
      values: { f1: `Name ${i}` },
    }));
    const page2 = [{ record_id: 'r1000', values: { f1: 'Last' } }];

    mockMcp((call) => {
      if (call.name === 'smartsheet_get_sheet') {
        return { errcode: 0, sheet_list: [{ sheet_id: 'S1', title: 'Data', type: 'smartsheet' }] };
      }
      if (call.name === 'smartsheet_get_fields') {
        return { errcode: 0, fields: [{ field_id: 'f1', field_title: 'Name' }] };
      }
      // records: first page full (has_more), second page partial
      const offset = call.args.offset as number;
      if (offset === 0) {
        return { errcode: 0, records: page1, has_more: true };
      }
      return { errcode: 0, records: page2, has_more: false };
    });

    const buffer = await service.exportSmartsheetWorkbook(makeWorkspace(), 'DOC1');
    const wb = await loadWorkbook(buffer);
    const ws = wb.getWorksheet('Data');
    assert.ok(ws);
    // header + 1001 records
    assert.strictEqual(ws.rowCount, 1002);
    const recordCalls = calls.filter((c) => c.name === 'smartsheet_get_records');
    assert.strictEqual(recordCalls.length, 2);
    assert.strictEqual(recordCalls[1].args.offset, 1000);
  });

  it('maps cell types and flattens complex values', async () => {
    mockMcp((call) => {
      if (call.name === 'smartsheet_get_sheet') {
        return { errcode: 0, sheet_list: [{ sheet_id: 'S1', title: 'Mixed', type: 'smartsheet' }] };
      }
      if (call.name === 'smartsheet_get_fields') {
        return {
          errcode: 0,
          fields: [
            { field_id: 'f1', field_title: 'Count', field_type: 'FIELD_TYPE_NUMBER' },
            { field_id: 'f2', field_title: 'Owner', field_type: 'FIELD_TYPE_USER' },
          ],
        };
      }
      return {
        errcode: 0,
        records: [{ record_id: 'r1', values: { f1: 7, f2: [{ user_id: 'u1', name: 'Alice' }] } }],
        has_more: false,
      };
    });

    const buffer = await service.exportSmartsheetWorkbook(makeWorkspace(), 'DOC1');
    const wb = await loadWorkbook(buffer);
    const ws = wb.getWorksheet('Mixed');
    assert.ok(ws);
    assert.strictEqual(ws.getRow(2).getCell(1).value, 7);
    assert.strictEqual(ws.getRow(2).getCell(2).value, 'Alice');
  });

  it('throws when bot credentials are missing', async () => {
    const ws = makeWorkspace();
    ws.settings.wecomBotId = undefined;
    await assert.rejects(
      service.exportSmartsheetWorkbook(ws, 'DOC1'),
      /missing WeCom bot credentials/,
    );
  });
});
