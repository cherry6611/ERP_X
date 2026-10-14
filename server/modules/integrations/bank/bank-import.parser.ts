/**
 * C-02 导入文件解析：CSV（自实现，无新依赖）与 Excel（exceljs，已在 dependencies）。
 * 纯解析层，不做业务校验，输出「列名 → 原始文本」的行集合供字段映射使用。
 */

import ExcelJS from 'exceljs';

export interface SheetTable {
  /** 实际使用的工作表名（CSV 固定为 csv） */
  sheetName: string;
  headers: string[];
  /** 每个元素形如 { 列名: 单元格文本 }，row 为 1 起的表头后行号 */
  rows: Array<{ row: number; values: Record<string, string> }>;
}

export interface ParseTableOptions {
  /** 指定工作表名（xlsx 多 sheet 时使用） */
  sheetName?: string;
  /** 是否包含表头行，默认 true */
  hasHeader?: boolean;
}

const MAX_PREVIEW_COLUMNS = 200;

/**
 * 解析 CSV 文本：支持 RFC4180 的引号包裹与双引号转义，自动嗅探 , ; \t | 分隔符。
 */
export function parseCsv(text: string, options: ParseTableOptions = {}): SheetTable {
  const content = text.replace(/^\uFEFF/, '');
  const delimiter = sniffDelimiter(content);
  const records = splitCsvRecords(content, delimiter);
  const hasHeader = options.hasHeader !== false;
  const headerRecord = hasHeader ? (records[0]?.cells ?? []) : [];
  const dataRecords = hasHeader ? records.slice(1) : records;
  const headers = hasHeader
    ? headerRecord.slice(0, MAX_PREVIEW_COLUMNS).map((cell, index) => {
        const name = (cell ?? '').trim();
        return name === '' ? `列${index + 1}` : name;
      })
    : buildSyntheticHeaders(dataRecords);
  const rows = dataRecords
    .filter((record) => record.cells.some((cell) => (cell ?? '').trim() !== ''))
    .map((record, index) => ({
      row: index + 1,
      values: toRecord(headers, record.cells),
    }));
  return { sheetName: 'csv', headers, rows };
}

function buildSyntheticHeaders(records: Array<{ cells: string[] }>): string[] {
  const width = records.reduce((max, record) => Math.max(max, record.cells.length), 0);
  return Array.from({ length: Math.min(width, MAX_PREVIEW_COLUMNS) }, (_, i) => `列${i + 1}`);
}

function toRecord(headers: string[], cells: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((header, index) => {
    record[header] = cells[index] ?? '';
  });
  return record;
}

function sniffDelimiter(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function splitCsvRecords(
  content: string,
  delimiter: string
): Array<{ cells: string[] }> {
  const records: Array<{ cells: string[] }> = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      cells.push(field);
      field = '';
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      cells.push(field);
      records.push({ cells });
      cells = [];
      field = '';
      continue;
    }
    field += char;
  }
  if (field !== '' || cells.length > 0) {
    cells.push(field);
    records.push({ cells });
  }
  return records;
}

function cellToText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) {
    // 业务时区口径：Excel 日期按 UTC 直取，避免本地时区回退一天
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'object') {
    const rich = value as { text?: string; result?: unknown; richText?: Array<{ text: string }> };
    if (typeof rich.text === 'string') return rich.text.trim();
    if (Array.isArray(rich.richText)) {
      return rich.richText.map((part) => part.text).join('').trim();
    }
    if (rich.result !== undefined && rich.result !== null) return String(rich.result).trim();
    if (value instanceof Date) return value.toISOString().slice(0, 10);
  }
  return String(value).trim();
}

/** 解析 xlsx/xlsm：取指定工作表（缺省第一个），首行表头 */
export async function parseWorkbook(
  buffer: Buffer,
  options: ParseTableOptions = {}
): Promise<SheetTable> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const worksheet =
    (options.sheetName
      ? workbook.worksheets.find((sheet) => sheet.name === options.sheetName)
      : undefined) ?? workbook.worksheets[0];
  if (!worksheet) {
    throw new Error('工作簿中没有可读取的工作表');
  }
  const headerRow = worksheet.getRow(1);
  const hasHeader = options.hasHeader !== false;
  // 列数：表头行与首个数据行的最大有效列数（exceljs 的 cellCount 不含尾部空单元格）
  const probeRows = worksheet.getRows(1, 50) ?? [];
  const observed = probeRows.reduce((max, row) => Math.max(max, row.cellCount), 0);
  const columnCount = Math.min(Math.max(observed, 1), MAX_PREVIEW_COLUMNS);
  const headers: string[] = [];
  for (let column = 1; column <= columnCount; column += 1) {
    if (hasHeader) {
      const name = cellToText(headerRow.getCell(column).value);
      headers.push(name === '' ? `列${column}` : name);
    } else {
      headers.push(`列${column}`);
    }
  }
  const startRow = hasHeader ? 2 : 1;
  const rows: Array<{ row: number; values: Record<string, string> }> = [];
  const lastRow = worksheet.rowCount;
  let logicalRow = 0;
  for (let rowNumber = startRow; rowNumber <= lastRow; rowNumber += 1) {
    const excelRow = worksheet.getRow(rowNumber);
    const cells: string[] = [];
    for (let column = 1; column <= columnCount; column += 1) {
      cells.push(cellToText(excelRow.getCell(column).value));
    }
    if (cells.every((cell) => cell === '')) continue;
    logicalRow += 1;
    rows.push({ row: logicalRow, values: toRecord(headers, cells) });
  }
  return { sheetName: worksheet.name, headers, rows };
}

/** 按扩展名或内容类型选择解析器 */
export async function parseImportFile(
  fileName: string,
  buffer: Buffer,
  options: ParseTableOptions = {}
): Promise<SheetTable> {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'csv' || ext === 'txt') {
    return parseCsv(buffer.toString('utf8'), options);
  }
  if (ext === 'xlsx' || ext === 'xlsm') {
    return parseWorkbook(buffer, options);
  }
  if (ext === 'xls') {
    throw new Error('不支持旧版 .xls 格式，请另存为 .xlsx 或 .csv 后导入');
  }
  throw new Error('不支持的文件类型，仅支持 .xlsx / .csv');
}
