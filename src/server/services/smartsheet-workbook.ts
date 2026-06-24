import ExcelJS from 'exceljs';

/** A smartsheet field (column) descriptor, normalized across API shapes. */
export interface SmartsheetField {
  fieldId: string;
  title: string;
  type?: string;
}

/** One smartsheet's worksheet data: title, columns, and rows. */
export interface SmartsheetData {
  title: string;
  fields: SmartsheetField[];
  /**
   * Each record's cell map. The WeCom get_records API keys this by field_title
   * (it ignores the requested CELL_VALUE_KEY_TYPE_FIELD_ID); buildSmartsheetWorkbook
   * resolves cells by field_id first, then falls back to field_title.
   */
  records: Array<Record<string, unknown>>;
}

const EXCEL_SHEET_NAME_MAX = 31;
const ILLEGAL_SHEET_NAME_CHARS = /[\\/?*[\]:]/g;

/**
 * Sanitize a smartsheet title into a valid Excel worksheet name.
 *
 * Excel forbids the characters `\ / ? * [ ] :`, caps names at 31 characters,
 * disallows leading/trailing apostrophes, and rejects blank names.
 */
export function sanitizeWorksheetName(title: string): string {
  let name = (title ?? '').replace(ILLEGAL_SHEET_NAME_CHARS, ' ').trim();
  name = name.replace(/^'+|'+$/g, '').trim();
  if (name.length === 0) {
    name = 'Sheet';
  }
  if (name.length > EXCEL_SHEET_NAME_MAX) {
    name = name.slice(0, EXCEL_SHEET_NAME_MAX).trim();
  }
  return name;
}

/**
 * Produce a unique worksheet name given the names already used, appending
 * ` (2)`, ` (3)`, … and truncating the base so the result stays within 31 chars.
 * Comparison is case-insensitive because Excel treats sheet names that way.
 */
export function dedupeWorksheetName(name: string, used: Set<string>): string {
  if (!used.has(name.toLowerCase())) {
    used.add(name.toLowerCase());
    return name;
  }
  for (let i = 2; ; i += 1) {
    const suffix = ` (${i})`;
    const base = name.slice(0, EXCEL_SHEET_NAME_MAX - suffix.length).trim();
    const candidate = `${base}${suffix}`;
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

/**
 * Convert a WeCom cell value into an Excel cell value, preserving scalar types
 * where the field type maps cleanly and flattening complex values to text.
 */
export function formatCellValue(fieldType: string | undefined, value: unknown): ExcelJS.CellValue {
  if (value === null || value === undefined) {
    return '';
  }

  const type = (fieldType ?? '').toUpperCase();

  if (type.includes('NUMBER') || type.includes('CURRENCY') || type.includes('PERCENT')) {
    const num = coerceNumber(value);
    return num === undefined ? flattenText(value) : num;
  }

  if (type.includes('CHECKBOX') || type.includes('BOOL')) {
    return coerceBoolean(value);
  }

  if (type.includes('DATE') || type.includes('TIME')) {
    const date = coerceDate(value);
    return date ?? flattenText(value);
  }

  return flattenText(value);
}

/** Build an `.xlsx` workbook (one worksheet per smartsheet) and return its bytes. */
export async function buildSmartsheetWorkbook(sheets: SmartsheetData[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const usedNames = new Set<string>();

  for (const sheet of sheets) {
    const name = dedupeWorksheetName(sanitizeWorksheetName(sheet.title), usedNames);
    const worksheet = workbook.addWorksheet(name);

    worksheet.addRow(sheet.fields.map((field) => field.title));

    for (const record of sheet.records) {
      const row = sheet.fields.map((field) => {
        // The WeCom get_records API ignores key_type and returns the `values`
        // map keyed by field_title, so a field_id lookup misses. Prefer the
        // field_id (forward-compatible if the API ever honors key_type) and
        // fall back to the title the API actually uses.
        const cell =
          record[field.fieldId] !== undefined ? record[field.fieldId] : record[field.title];
        return formatCellValue(field.type, cell);
      });
      worksheet.addRow(row);
    }
  }

  // exceljs has no sheets when given an empty list; ensure a valid workbook.
  if (workbook.worksheets.length === 0) {
    workbook.addWorksheet('Sheet');
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer as ArrayBuffer);
}

function coerceNumber(value: unknown): number | undefined {
  const v = unwrapSingle(value);
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return undefined;
}

function coerceBoolean(value: unknown): boolean {
  const v = unwrapSingle(value);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.toLowerCase() === 'true' || v === '1';
  return Boolean(v);
}

function coerceDate(value: unknown): Date | undefined {
  const v = unwrapSingle(value);
  let ms: number | undefined;
  if (typeof v === 'number' && Number.isFinite(v)) {
    ms = v;
  } else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    ms = Number(v);
  }
  if (ms === undefined) return undefined;
  // WeCom timestamps are Unix milliseconds; treat 10-digit values as seconds.
  if (ms < 1e12) ms *= 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Unwrap a single-element array so `[x]` is treated like `x`. */
function unwrapSingle(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 1) {
    return value[0];
  }
  return value;
}

function flattenText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map(flattenItem).filter((s) => s !== '').join(', ');
  }
  return flattenItem(value);
}

const TEXT_KEYS = ['text', 'name', 'title', 'value', 'url', 'email', 'phone_number', 'phone'];

function flattenItem(item: unknown): string {
  if (item === null || item === undefined) return '';
  if (typeof item !== 'object') return String(item);
  const obj = item as Record<string, unknown>;
  for (const key of TEXT_KEYS) {
    if (typeof obj[key] === 'string' && (obj[key] as string).length > 0) {
      return obj[key] as string;
    }
    if (typeof obj[key] === 'number') {
      return String(obj[key]);
    }
  }
  try {
    return JSON.stringify(item);
  } catch {
    return String(item);
  }
}
