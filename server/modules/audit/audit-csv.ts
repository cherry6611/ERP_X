import type { AuditLog } from '@shared/api.interface';

/**
 * 审计日志 CSV 导出（纯函数，可单测）。
 *
 * ## 为什么导出要单独成模块
 *
 * 「导出」是审计/合规场景里**唯一会被带出系统**的产物：它一旦带上错误的列序、
 * 丢了一列、或把时间导成 UTC 而界面显示业务时区，就会在系统之外长期存在一份
 * 与系统不一致的"证据"。所以列定义、转义、时间口径都放在这里逐条断言。
 *
 * ## 三个必须处理的细节
 *
 * 1. **公式注入**：`detail` 是接口路径/请求体原文，可能以 `=` `+` `-` `@`
 *    开头。Excel/Numbers 打开后会把它当公式执行（`=1+1` 至少是错的，
 *    `=HYPERLINK(...)` 更糟）。按 OWASP 建议在前面加一个 `'`。
 * 2. **换行与逗号**：`detail` 里必然有 JSON（含 `"` 与 `,`），必须整体加引号
 *    并把内部 `"` 翻倍，否则一行会裂成多行、列会错位。
 * 3. **时间口径**：CSV 必须与界面同口径。界面用 `toLocaleString('zh-CN')`，
 *    而 CSV 要机器可读，因此统一输出**业务时区（Asia/Shanghai）**的
 *    `YYYY-MM-DD HH:mm:ss`，不带时区后缀，与仓库"业务时区 Asia/Shanghai"一致。
 */

/** CSV 列定义（顺序即导出顺序；改这里就要改表头断言） */
export const AUDIT_CSV_COLUMNS = [
  { key: 'createdAt', title: '时间' },
  { key: 'actor', title: '操作人' },
  { key: 'action', title: '操作' },
  { key: 'objectType', title: '模块' },
  { key: 'objectCode', title: '对象编号' },
  { key: 'statusBefore', title: '变更前状态' },
  { key: 'statusAfter', title: '变更后状态' },
  { key: 'detail', title: '详情' },
] as const;

export type AuditCsvColumnKey = (typeof AUDIT_CSV_COLUMNS)[number]['key'];

/** 会被电子表格软件当成公式起始的字符（OWASP CSV Injection） */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * 单个单元格转义：
 * - 公式前缀补 `'`
 * - 含 `"` `,` `\n` `\r` 时整体加双引号，内部 `"` 翻倍
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** 业务时区（Asia/Shanghai）`YYYY-MM-DD HH:mm:ss`，与界面同口径、可机器解析 */
export function formatAuditTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const pick = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

function cellOf(row: AuditLog, key: AuditCsvColumnKey): string {
  if (key === 'createdAt') return formatAuditTime(row.createdAt);
  const value = row[key as keyof AuditLog];
  return value === null || value === undefined ? '' : String(value);
}

/**
 * 生成 CSV 文本。
 *
 * BOM 是**必需**的：没有 `\uFEFF` 时 Excel 会把 UTF-8 中文按 GBK 解码，
 * 导出文件在 Windows 上全是乱码 —— 审计人员看到的第一眼就是乱码，
 * 这份导出等于没用。
 */
export function toAuditCsv(rows: AuditLog[]): string {
  const header = AUDIT_CSV_COLUMNS.map((c) => escapeCsvCell(c.title)).join(',');
  const body = rows.map((row) =>
    AUDIT_CSV_COLUMNS.map((c) => escapeCsvCell(cellOf(row, c.key))).join(',')
  );
  return `\uFEFF${[header, ...body].join('\r\n')}\r\n`;
}
