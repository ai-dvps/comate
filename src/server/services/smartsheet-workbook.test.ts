import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  sanitizeWorksheetName,
  dedupeWorksheetName,
  formatCellValue,
  buildSmartsheetWorkbook,
  type SmartsheetData,
} from './smartsheet-workbook.js';

describe('sanitizeWorksheetName', () => {
  it('strips Excel-illegal characters', () => {
    assert.strictEqual(sanitizeWorksheetName('a/b\\c?d*e[f]g:h'), 'a b c d e f g h');
  });

  it('falls back to "Sheet" for blank titles', () => {
    assert.strictEqual(sanitizeWorksheetName(''), 'Sheet');
    assert.strictEqual(sanitizeWorksheetName('   '), 'Sheet');
    assert.strictEqual(sanitizeWorksheetName('///'), 'Sheet');
  });

  it('truncates to 31 characters', () => {
    const long = 'x'.repeat(40);
    assert.strictEqual(sanitizeWorksheetName(long).length, 31);
  });

  it('removes leading/trailing apostrophes', () => {
    assert.strictEqual(sanitizeWorksheetName("'Plan'"), 'Plan');
  });
});

describe('dedupeWorksheetName', () => {
  it('returns the name unchanged when unused', () => {
    const used = new Set<string>();
    assert.strictEqual(dedupeWorksheetName('Q2 Plan', used), 'Q2 Plan');
  });

  it('appends a counter on collision', () => {
    const used = new Set<string>();
    assert.strictEqual(dedupeWorksheetName('Q2 Plan', used), 'Q2 Plan');
    assert.strictEqual(dedupeWorksheetName('Q2 Plan', used), 'Q2 Plan (2)');
    assert.strictEqual(dedupeWorksheetName('Q2 Plan', used), 'Q2 Plan (3)');
  });

  it('keeps deduped names within 31 characters', () => {
    const used = new Set<string>();
    const long = 'y'.repeat(31);
    const first = dedupeWorksheetName(long, used);
    const second = dedupeWorksheetName(long, used);
    assert.strictEqual(first.length, 31);
    assert.ok(second.length <= 31);
    assert.ok(second.endsWith(' (2)'));
  });
});

describe('formatCellValue', () => {
  it('preserves numbers for number-like field types', () => {
    assert.strictEqual(formatCellValue('FIELD_TYPE_NUMBER', 42), 42);
    assert.strictEqual(formatCellValue('FIELD_TYPE_NUMBER', '3.5'), 3.5);
    assert.strictEqual(formatCellValue('FIELD_TYPE_CURRENCY', [12]), 12);
  });

  it('maps checkbox to boolean', () => {
    assert.strictEqual(formatCellValue('FIELD_TYPE_CHECKBOX', true), true);
    assert.strictEqual(formatCellValue('FIELD_TYPE_CHECKBOX', 0), false);
    assert.strictEqual(formatCellValue('FIELD_TYPE_CHECKBOX', 'true'), true);
  });

  it('converts millisecond timestamps to Date', () => {
    const ms = 1_700_000_000_000;
    const result = formatCellValue('FIELD_TYPE_DATE_TIME', ms);
    assert.ok(result instanceof Date);
    assert.strictEqual((result as Date).getTime(), ms);
  });

  it('flattens text-bearing objects', () => {
    assert.strictEqual(formatCellValue('FIELD_TYPE_TEXT', { text: 'hello' }), 'hello');
    assert.strictEqual(
      formatCellValue('FIELD_TYPE_USER', [{ user_id: 'u1', name: 'Alice' }]),
      'Alice',
    );
  });

  it('joins multi-value arrays with commas', () => {
    assert.strictEqual(
      formatCellValue('FIELD_TYPE_MULTI_SELECT', [{ text: 'A' }, { text: 'B' }]),
      'A, B',
    );
  });

  it('returns empty string for null/undefined', () => {
    assert.strictEqual(formatCellValue('FIELD_TYPE_TEXT', null), '');
    assert.strictEqual(formatCellValue('FIELD_TYPE_NUMBER', undefined), '');
  });
});

describe('buildSmartsheetWorkbook', () => {
  it('builds one worksheet per sheet with header and record rows', async () => {
    const sheets: SmartsheetData[] = [
      {
        title: 'People',
        fields: [
          { fieldId: 'f1', title: 'Name', type: 'FIELD_TYPE_TEXT' },
          { fieldId: 'f2', title: 'Age', type: 'FIELD_TYPE_NUMBER' },
        ],
        records: [
          { f1: 'Alice', f2: 30 },
          { f1: 'Bob', f2: 25 },
        ],
      },
    ];

    const buffer = await buildSmartsheetWorkbook(sheets);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);

    const ws = wb.getWorksheet('People');
    assert.ok(ws);
    assert.strictEqual(ws.getRow(1).getCell(1).value, 'Name');
    assert.strictEqual(ws.getRow(1).getCell(2).value, 'Age');
    assert.strictEqual(ws.getRow(2).getCell(1).value, 'Alice');
    assert.strictEqual(ws.getRow(2).getCell(2).value, 30);
    assert.strictEqual(ws.getRow(3).getCell(1).value, 'Bob');
  });

  it('populates cells when records are keyed by field title (real WeCom API shape)', async () => {
    // The WeCom smartsheet_get_records API ignores key_type and returns the
    // `values` map keyed by field_title, not field_id. The workbook must still
    // resolve each cell. See data/paulinexu regression.
    const sheets: SmartsheetData[] = [
      {
        title: '工作表1',
        fields: [
          { fieldId: 'f0D5oz', title: '项目名称', type: 'FIELD_TYPE_TEXT' },
          { fieldId: 'f0WSMP', title: 'GPU', type: 'FIELD_TYPE_NUMBER' },
          { fieldId: 'f4XdGt', title: '非GPU', type: 'FIELD_TYPE_NUMBER' },
        ],
        records: [
          { 项目名称: [{ text: 'M-安全', type: 'text' }], 非GPU: 47817.21 },
          { 项目名称: [{ text: 'M-公共资源', type: 'text' }], GPU: 0, 非GPU: 18684.18 },
        ],
      },
    ];

    const buffer = await buildSmartsheetWorkbook(sheets);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);

    const ws = wb.getWorksheet('工作表1');
    assert.ok(ws);
    assert.strictEqual(ws.getRow(1).getCell(1).value, '项目名称');
    assert.strictEqual(ws.getRow(2).getCell(1).value, 'M-安全');
    assert.strictEqual(ws.getRow(2).getCell(3).value, 47817.21);
    assert.strictEqual(ws.getRow(3).getCell(1).value, 'M-公共资源');
    assert.strictEqual(ws.getRow(3).getCell(2).value, 0);
    assert.strictEqual(ws.getRow(3).getCell(3).value, 18684.18);
  });

  it('deduplicates worksheet names', async () => {
    const sheets: SmartsheetData[] = [
      { title: 'Q2 Plan', fields: [], records: [] },
      { title: 'Q2 Plan', fields: [], records: [] },
    ];
    const buffer = await buildSmartsheetWorkbook(sheets);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const names = wb.worksheets.map((w) => w.name);
    assert.deepStrictEqual(names, ['Q2 Plan', 'Q2 Plan (2)']);
  });

  it('produces a valid workbook even with no sheets', async () => {
    const buffer = await buildSmartsheetWorkbook([]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    assert.strictEqual(wb.worksheets.length, 1);
  });
});
