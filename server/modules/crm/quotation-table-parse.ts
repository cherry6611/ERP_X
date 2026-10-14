import type { ParsedQuotationDraft, ParsedQuotationItem } from '@shared/api.interface';

const NAME_KEYS = ['类别', '明细名称', '服务项', '品名', '项目', '名称', '费用项', '条目'];
const QTY_KEYS = ['数量', 'qty', '数量（人）'];
const PRICE_KEYS = ['单价', '单价（元）', '不含税单价', 'unitprice'];
const UNIT_KEYS = ['单位'];
const DAYS_KEYS = ['工期', '天数', '人天', '工时'];
const REMARK_KEYS = ['备注', '说明'];
const AMOUNT_KEYS = ['金额', '金额（元）', '合计'];

function normalizeHeader(h: string): string {
  return h.replace(/\s+/g, '').trim();
}

function findCol(headers: string[], keys: string[]): number {
  const normalized = headers.map(normalizeHeader);
  for (const key of keys) {
    const k = normalizeHeader(key);
    const idx = normalized.findIndex((h) => h === k || h.includes(k));
    if (idx >= 0) return idx;
  }
  return -1;
}

function toNumber(raw: string): number | null {
  const t = raw.replace(/[,，￥¥]/g, '').trim();
  if (!t || t.startsWith('=')) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function isHeaderRow(cells: string[]): boolean {
  const joined = cells.map(normalizeHeader).join('|');
  const hasName = NAME_KEYS.some((k) => joined.includes(normalizeHeader(k)));
  const hasPrice = PRICE_KEYS.some((k) => joined.includes(normalizeHeader(k)));
  return hasName && hasPrice;
}

function parseRow(
  cells: string[],
  headers: string[],
): ParsedQuotationItem | null {
  const nameIdx = findCol(headers, NAME_KEYS);
  const qtyIdx = findCol(headers, QTY_KEYS);
  const priceIdx = findCol(headers, PRICE_KEYS);
  const unitIdx = findCol(headers, UNIT_KEYS);
  const daysIdx = findCol(headers, DAYS_KEYS);
  const remarkIdx = findCol(headers, REMARK_KEYS);
  const amountIdx = findCol(headers, AMOUNT_KEYS);

  if (nameIdx < 0 || priceIdx < 0) return null;
  const itemName = (cells[nameIdx] ?? '').trim();
  if (!itemName || /^(合计|总计|小计|汇总)$/.test(itemName)) return null;

  let unitPrice = toNumber(cells[priceIdx] ?? '');
  let quantity = qtyIdx >= 0 ? toNumber(cells[qtyIdx] ?? '') : 1;
  const days = daysIdx >= 0 ? toNumber(cells[daysIdx] ?? '') : null;
  let unit = unitIdx >= 0 ? (cells[unitIdx] ?? '').trim() || null : null;
  const remarkParts: string[] = [];
  if (remarkIdx >= 0 && (cells[remarkIdx] ?? '').trim()) {
    remarkParts.push(cells[remarkIdx].trim());
  }

  // 单价×数量×工期 类报价：折算为 ERP 行「单价 × 数量」
  if (quantity != null && days != null && days > 0) {
    quantity = quantity * days;
    if (unit === '人') unit = '人天';
    else if (unit === '台') unit = '台·天';
    else if (!unit) unit = '人天';
    if (daysIdx >= 0) remarkParts.push(`工期${days}`);
  }

  if (unitPrice === null) return null;
  if (quantity === null || quantity <= 0) {
    // 仅有金额时，按数量 1、单价=金额
    const amount = amountIdx >= 0 ? toNumber(cells[amountIdx] ?? '') : null;
    if (amount != null && amount > 0) {
      quantity = 1;
      unitPrice = amount;
    } else {
      return null;
    }
  }

  return {
    itemName,
    unit,
    quantity,
    unitPrice,
    discountPct: null,
    estUnitCost: null,
    remark: remarkParts.length ? remarkParts.join('；') : null,
  };
}

/**
 * 从制表符表格文本（含 `# SheetName`）确定性解析报价明细，不依赖 LLM。
 */
export function tryParseQuotationTable(text: string): ParsedQuotationDraft | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

  let title: string | null = null;
  let headers: string[] | null = null;
  const items: ParsedQuotationItem[] = [];

  for (const line of lines) {
    if (line.startsWith('# ')) {
      if (!title) title = line.slice(2).trim() || null;
      headers = null;
      continue;
    }
    const cells = line.split('\t').map((c) => c.trim());
    if (isHeaderRow(cells)) {
      headers = cells;
      continue;
    }
    if (!headers) continue;
    // 跳过占比公式行噪声：金额列仍可能是未求值公式且无单价
    const item = parseRow(cells, headers);
    if (item) items.push(item);
  }

  if (items.length === 0) return null;
  return {
    title,
    quoteDate: null,
    validUntil: null,
    remark: null,
    items,
  };
}
