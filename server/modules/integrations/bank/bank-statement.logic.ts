/**
 * C-02 银行流水导入：字段映射 + 去重键 + 匹配规则（纯函数，可单测）。
 *
 * 口径说明（需财务确认）：
 *  1) 借贷方向：银行对账单常见三种形态 ——
 *     a) 单独一列"借贷标志"，取值 借/贷、收入/支出、Credit/Debit 等；
 *     b) 收入列 + 支出列分开（本实现用 amount 列 + direction 列覆盖，分列格式需先把两列
 *        合并成 amount 列并补 direction 列后再导入）；
 *     c) 单一金额列，正数为收入、负数为支出（direction 未映射时按此约定）。
 *  2) 金额一律取绝对值入库，方向由 direction 承载，避免"负数金额 + 方向"双重语义歧义。
 *  3) 去重：优先银行交易流水号；无流水号时退化为业务指纹
 *     `账户|交易日期|方向|金额|对方户名|摘要` 的 SHA1，同一账户下唯一。
 */

import { createHash } from 'node:crypto';
import type {
  BankStatementDirection,
  BankStatementMapping,
} from '@shared/api.interface';

/** 内置收入/支出关键词（映射未显式给出 creditKeywords/debitKeywords 时使用） */
export const DEFAULT_CREDIT_KEYWORDS = [
  '收入',
  '收',
  '贷',
  '进账',
  '转入',
  '存入',
  'credit',
  'cr',
  'in',
];
export const DEFAULT_DEBIT_KEYWORDS = [
  '支出',
  '付',
  '借',
  '出账',
  '转出',
  '支取',
  'debit',
  'dr',
  'out',
];

export interface RawStatementRow {
  /** 1 起的表头后数据行号（用于错误定位） */
  row: number;
  values: Record<string, string>;
}

export interface ParsedStatementRow {
  row: number;
  transactionDate: string;
  direction: BankStatementDirection;
  amount: number;
  balance: number | null;
  counterpartyName: string | null;
  counterpartyAccount: string | null;
  summary: string | null;
  transactionNo: string | null;
  dedupeKey: string;
}

export interface RowParseError {
  row: number;
  reason: string;
}

export interface ParseStatementRowsResult {
  rows: ParsedStatementRow[];
  errors: RowParseError[];
}

/** 归一化列名：去空白、去全角空格、小写 */
export function normalizeHeader(value: string): string {
  return value.replace(/[\s\u3000]/g, '').toLowerCase();
}

/** 单元格取值：按映射的列名（大小写与空白不敏感）取原始文本 */
export function pickCell(
  values: Record<string, string>,
  column: string | undefined
): string {
  if (!column) return '';
  const target = normalizeHeader(column);
  for (const [key, value] of Object.entries(values)) {
    if (normalizeHeader(key) === target) return (value ?? '').trim();
  }
  return '';
}

/** 金额解析：容忍千分位、货币符号、括号负数、全角字符 */
export function parseAmount(raw: string): number | null {
  if (!raw) return null;
  let text = raw
    .replace(/[\s\u3000]/g, '')
    .replace(/[¥￥$€,，]/g, '')
    .replace(/[（(]/g, '-')
    .replace(/[）)]/g, '');
  if (text === '' || text === '-') return null;
  const negativeBySuffix = /-$/.test(text);
  text = text.replace(/-$/, '');
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return negativeBySuffix ? -Math.abs(value) : value;
}

/**
 * 日期解析：支持 2026-10-15 / 2026/10/15 / 20261015 / 2026年10月15日 / Excel 序列号。
 * 返回 YYYY-MM-DD；无法解析返回 null。
 */
export function parseTradeDate(raw: string, _epoch?: Date): string | null {
  const text = (raw ?? '').replace(/[\s\u3000]/g, '');
  if (!text) return null;
  let match = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(text);
  if (match) {
    return buildDate(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (match) {
    return buildDate(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  // Excel 序列号（1900 日期系统，含 Excel 的 1900 闰年 bug 惯例）：
  // 标准换算 serial 1 = 1899-12-31，即 serial 25569 = 1970-01-01。
  if (/^\d+(\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial > 20000 && serial < 80000) {
      const date = new Date((Math.floor(serial) - 25569) * 86_400_000);
      return date.toISOString().slice(0, 10);
    }
  }
  return null;
}

function buildDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const y = String(year).padStart(4, '0');
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 方向解析：先看关键词，再按金额正负兜底（正数入账，负数出账） */
export function parseDirection(
  raw: string,
  amount: number,
  mapping?: Pick<BankStatementMapping, 'creditKeywords' | 'debitKeywords'>
): BankStatementDirection {
  const text = normalizeHeader(raw);
  if (text) {
    const credit = splitKeywords(mapping?.creditKeywords) ?? DEFAULT_CREDIT_KEYWORDS;
    const debit = splitKeywords(mapping?.debitKeywords) ?? DEFAULT_DEBIT_KEYWORDS;
    const hitCredit = credit.some((word) => word && text.includes(normalizeHeader(word)));
    const hitDebit = debit.some((word) => word && text.includes(normalizeHeader(word)));
    if (hitCredit && !hitDebit) return 'income';
    if (hitDebit && !hitCredit) return 'expense';
  }
  return amount < 0 ? 'expense' : 'income';
}

function splitKeywords(value: string | undefined): string[] | null {
  if (!value) return null;
  const list = value
    .split(/[,，|]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

/**
 * 去重键：优先交易流水号；无流水号时用业务指纹（SHA1，稳定可重现）。
 * 指纹字段按固定顺序拼接，避免列顺序差异导致重复导入。
 */
export function buildDedupeKey(input: {
  transactionNo: string | null;
  transactionDate: string;
  direction: BankStatementDirection;
  amount: number;
  counterpartyName: string | null;
  summary: string | null;
}): string {
  const no = (input.transactionNo ?? '').trim();
  if (no) return `NO:${no}`;
  const fingerprint = [
    input.transactionDate,
    input.direction,
    input.amount.toFixed(2),
    (input.counterpartyName ?? '').replace(/[\s\u3000]/g, ''),
    (input.summary ?? '').replace(/[\s\u3000]/g, ''),
  ].join('|');
  return `FP:${createHash('sha1').update(fingerprint).digest('hex').slice(0, 40)}`;
}

/** 逐行解析 + 校验；非法行不进入 rows，而是登记到 errors（可读中文原因） */
export function parseStatementRows(
  rows: RawStatementRow[],
  mapping: BankStatementMapping
): ParseStatementRowsResult {
  const parsed: ParsedStatementRow[] = [];
  const errors: RowParseError[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const dateText = pickCell(row.values, mapping.transactionDate);
    const date = parseTradeDate(dateText);
    if (!date) {
      errors.push({
        row: row.row,
        reason: dateText
          ? `交易日期无法识别：${dateText}`
          : `交易日期列为空（映射列：${mapping.transactionDate}）`,
      });
      continue;
    }
    const amountText = pickCell(row.values, mapping.amount);
    const rawAmount = parseAmount(amountText);
    if (rawAmount === null) {
      errors.push({
        row: row.row,
        reason: amountText ? `金额无法识别：${amountText}` : '金额列为空',
      });
      continue;
    }
    if (rawAmount === 0) {
      errors.push({ row: row.row, reason: '金额为 0，已跳过' });
      continue;
    }
    const direction = parseDirection(
      pickCell(row.values, mapping.direction),
      rawAmount,
      mapping
    );
    const amount = Math.abs(rawAmount);
    const balanceText = pickCell(row.values, mapping.balance);
    const balance = balanceText === '' ? null : parseAmount(balanceText);
    const counterpartyName = emptyToNull(pickCell(row.values, mapping.counterpartyName));
    const counterpartyAccount = emptyToNull(
      pickCell(row.values, mapping.counterpartyAccount)
    );
    const summary = emptyToNull(pickCell(row.values, mapping.summary));
    const transactionNo = emptyToNull(pickCell(row.values, mapping.transactionNo));
    const dedupeKey = buildDedupeKey({
      transactionNo,
      transactionDate: date,
      direction,
      amount,
      counterpartyName,
      summary,
    });
    if (seen.has(dedupeKey)) {
      errors.push({ row: row.row, reason: '文件内重复行（同一流水号/同一指纹），已跳过' });
      continue;
    }
    seen.add(dedupeKey);
    parsed.push({
      row: row.row,
      transactionDate: date,
      direction,
      amount,
      balance,
      counterpartyName,
      counterpartyAccount,
      summary,
      transactionNo,
      dedupeKey,
    });
  }
  return { rows: parsed, errors };
}

function emptyToNull(value: string): string | null {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
}

/* ==================== 自动匹配规则 ==================== */

export interface MatchCandidate {
  bizType: 'receipt' | 'payment' | 'voucher';
  bizId: string;
  bizCode: string | null;
  /** 对方单据金额（正数） */
  amount: number;
  /** 对方单据日期 YYYY-MM-DD */
  date: string;
  /** 检索用文本：单号 / 对方户名 / 客户供应商名 / 摘要 */
  texts: Array<string | null | undefined>;
}

export interface MatchStatementInput {
  amount: number;
  transactionDate: string;
  texts: Array<string | null | undefined>;
}

export interface MatchEvaluation {
  candidate: MatchCandidate;
  amountEqual: boolean;
  dateDiffDays: number;
  textHit: boolean;
  score: number;
  eligible: boolean;
}

/** 金额相等判定：分位对齐后比较，容差 0.01 元（银行常见尾差） */
export function amountEqual(a: number, b: number, tolerance = 0.01): boolean {
  return Math.abs(round2(a) - round2(b)) <= tolerance;
}

/** 日期差（天，绝对值）；入参为 YYYY-MM-DD */
export function dateDiffDays(a: string, b: string): number {
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((left - right) / 86_400_000));
}

/** 文本归一：去空白、去常见分隔符、小写，便于"包含"判定 */
export function normalizeMatchText(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[-_/\\（）()【】\[\]]/g, '')
    .toLowerCase();
}

/** 匹配度：0~100。金额（50）+ 日期（30）+ 文本（20） */
export const MATCH_AMOUNT_SCORE = 50;
export const MATCH_DATE_SCORE = 30;
export const MATCH_TEXT_SCORE = 20;
/** 日期窗口 ±3 天 */
export const MATCH_DATE_WINDOW_DAYS = 3;
/** 认定为自动匹配的最低分（金额相同 + 日期在窗口内即可达 50+10=60） */
export const MATCH_MIN_SCORE = 60;

export function scoreMatch(
  statement: MatchStatementInput,
  candidate: MatchCandidate
): MatchEvaluation {
  const amountEqualHit = amountEqual(statement.amount, candidate.amount);
  const diff = dateDiffDays(statement.transactionDate, candidate.date);
  const statementText = normalizeMatchText(statement.texts.filter(Boolean).join(' '));
  const candidateTexts = candidate.texts
    .map((item) => normalizeMatchText(item))
    .filter((item) => item.length > 0);
  const textHit =
    statementText.length > 0 &&
    candidateTexts.some(
      (item) => statementText.includes(item) || item.includes(statementText)
    );

  let score = 0;
  if (amountEqualHit) score += MATCH_AMOUNT_SCORE;
  if (diff <= MATCH_DATE_WINDOW_DAYS) {
    // 当日满分，之后每天递减，±3 天时为 10 分
    score += MATCH_DATE_SCORE - diff * 6.67;
  }
  if (textHit) score += MATCH_TEXT_SCORE;
  score = Math.max(0, round2(score));

  return {
    candidate,
    amountEqual: amountEqualHit,
    dateDiffDays: diff,
    textHit,
    score,
    eligible: amountEqualHit && diff <= MATCH_DATE_WINDOW_DAYS,
  };
}

/**
 * 为一条流水挑最佳候选：金额相同 + 日期 ±3 天为硬条件，摘要命中对方名称/单号为加分。
 * 同分时按「文本命中优先 → 日期更近 → 单号字典序」稳定排序，保证可重现。
 */
export function bestMatch(
  statement: MatchStatementInput,
  candidates: MatchCandidate[]
): MatchEvaluation | null {
  const evaluated = candidates
    .map((candidate) => scoreMatch(statement, candidate))
    .filter((item) => item.eligible);
  if (evaluated.length === 0) return null;
  evaluated.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.dateDiffDays !== b.dateDiffDays) return a.dateDiffDays - b.dateDiffDays;
    const left = a.candidate.bizCode ?? '';
    const right = b.candidate.bizCode ?? '';
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const winner = evaluated[0];
  return winner.score >= MATCH_MIN_SCORE ? winner : null;
}

/**
 * 匹配率 = matched / (total - ignored)，分母为 0 时为 0。
 * ignored 视为用户主动排除，不计入分母（否则长期无法匹配的备注行会拉低指标）。
 */
export function computeMatchRate(total: number, matched: number, ignored: number): number {
  const denominator = total - ignored;
  if (denominator <= 0) return 0;
  return round2(matched / denominator);
}

// 统一取整口径：原先这里自带一份 `Math.round((v + EPSILON) * 100) / 100`，
// 对负数不对称（红冲差 1 分）。改为再导出全仓唯一实现，保持本模块的导出面不变。
import { round2 } from '@server/common/utils/number';

export { round2 };
