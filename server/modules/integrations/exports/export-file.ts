/**
 * C-07 导出文件生成（Excel / CSV）。
 *
 * 单独成文件的原因：文件生成是**纯函数**（输入列定义 + 记录，输出 Buffer），
 * 不依赖数据库与 NestJS 容器，因此可以独立单测（见 export-file.spec.ts），
 * 也便于被后台任务在**请求事务之外**调用（B-22 约束）。
 */

import ExcelJS from 'exceljs';

/** 导出列定义 */
export interface ExportColumn {
  key: string;
  label: string;
  width?: number;
}

/** 一条待导出记录（key 与 ExportColumn.key 对齐） */
export type ExportRecord = Record<string, string | number | null>;

export interface ExportFileMeta {
  resourceLabel: string;
  filterSummary: string;
  requestedByName: string;
  generatedAt: string;
  truncated: boolean;
  dateInShanghai: string;
}

/** 审计要求：文件首行必须含筛选条件说明与导出人 */
export function buildAuditHeader(meta: ExportFileMeta): string {
  const parts = [
    `资源：${meta.resourceLabel}`,
    `筛选条件：${meta.filterSummary}`,
    `导出人：${meta.requestedByName}`,
    `导出时间：${meta.generatedAt}`,
    `业务日期：${meta.dateInShanghai}`,
  ];
  if (meta.truncated) parts.push('注意：导出行数已达上限，结果被截断');
  return parts.join('｜');
}

function cellText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function csvLine(cells: string[]): string {
  return cells
    .map((cell) => {
      const text = cell ?? '';
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    })
    .join(',');
}

export function buildCsv(
  columns: ExportColumn[],
  rows: ExportRecord[],
  meta: ExportFileMeta
): Buffer {
  const lines: string[] = [];
  lines.push(csvLine([buildAuditHeader(meta)]));
  lines.push(csvLine(columns.map((column) => column.label)));
  for (const row of rows) {
    lines.push(csvLine(columns.map((column) => cellText(row[column.key]))));
  }
  // BOM：Excel 直接双击打开 CSV 时中文不乱码
  return Buffer.concat([
    Buffer.from('\uFEFF', 'utf8'),
    Buffer.from(lines.join('\r\n'), 'utf8'),
  ]);
}

export async function buildXlsx(
  columns: ExportColumn[],
  rows: ExportRecord[],
  meta: ExportFileMeta
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = meta.requestedByName;
  workbook.created = new Date(meta.generatedAt);
  const sheet = workbook.addWorksheet('导出结果');
  sheet.addRow([buildAuditHeader(meta)]).font = { bold: true };
  sheet.addRow([]);
  const header = sheet.addRow(columns.map((column) => column.label));
  header.font = { bold: true };
  for (const row of rows) {
    sheet.addRow(columns.map((column) => row[column.key] ?? ''));
  }
  columns.forEach((column, index) => {
    sheet.getColumn(index + 1).width = column.width ?? 18;
  });
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** 生成导出文件（按格式分派） */
export async function buildExportFile(
  format: 'xlsx' | 'csv',
  columns: ExportColumn[],
  rows: ExportRecord[],
  meta: ExportFileMeta
): Promise<Buffer> {
  return format === 'csv' ? buildCsv(columns, rows, meta) : buildXlsx(columns, rows, meta);
}
