/**
 * C-11 客户/供应商对账单（statement of account）的**纯函数**内核。
 *
 * 与 `statement.service.ts` 的分工：
 *   - 本文件不含 DB / Nest / IO，只做「期间切分 + 借贷方向 + 期初期末 + 余额滚动」；
 *   - service 负责把 `erp_ar` / `erp_receipt` / `erp_invoice` / `erp_ap_bill` /
 *     `erp_payment` 的行映射成 `StatementTxn`，再调用这里的 `computeStatement`。
 *
 * 这样拆分的理由：对账单的核心风险是**余额算错**（期初口径、边界日、作废单），
 * 把这段算术抽成纯函数后可以逐条断言，而不必起 pglite 集成测试。
 *
 * ⚠️ 会计口径（**需财务确认**，见 computeStatement 注释）：
 *   1. 期初 = 期间开始日**之前**的所有发生额净额（不是"全部历史的合计"，也不是
 *      "上期期末余额"的快照——本系统没有期末余额快照表，期末余额由发生额推导）。
 *   2. 期间发生额取 `[periodStart, periodEnd)` 左闭右开：期间开始日当天的单据算本期，
 *      期间结束日（次月 1 日）当天的单据算下期。与 `vendor-settlement.service.ts`
 *      的 `gte(start)` / `lt(nextMonthStart)` 口径一致。
 *   3. 作废单据（`erp_receipt.status='voided'` / `erp_payment.status='voided'` /
 *      `erp_invoice.status='voided'`）**整单剔除**：既不计入期初，也不计入本期。
 *      它们的账面影响已由作废凭证（红字）另行体现，重复计入会让余额翻倍扣减。
 *   4. 期末 = 期初 + 本期借方 − 本期贷方，三者用同一套 2 位小数四舍五入。
 */

import { round2 } from '@shared/number';

/** 对账方向：customer=客户对账单（我们开出去），supplier=供应商对账单（供应商开给我们） */
export const STATEMENT_DIRECTIONS = ['customer', 'supplier'] as const;

export type StatementDirection = (typeof STATEMENT_DIRECTIONS)[number];

/** 对账单上的单据类型（决定展示文案与排序） */
export const STATEMENT_DOC_TYPES = [
  'ar',
  'ap',
  'receipt',
  'payment',
  'invoice',
  /**
   * 收入折让 / 退回冲减（`erp_revenue_adjust`）。
   *
   * 为什么必须有这个类型：`ArService.applyCredit` 冲减应收时**只增加
   * `erp_ar.settled_amount`，不产生回款行**。若对账单不把折让额单列一行，
   * 该应收在对账单上会**永远显示全额余额**（台账已 `settled`、对外单据仍显示未收），
   * 这是对外单据上最严重的错误 —— 对方会据此认为我们还欠他钱。
   */
  'adjust',
] as const;

export type StatementDocType = (typeof STATEMENT_DOC_TYPES)[number];

/** 单据在对账单上的核对状态（契约侧同名类型为 `StatementReconStatus`） */
export type StatementStatus =
  /** 已完全核销/结清 */
  | 'reconciled'
  /** 部分核销 */
  | 'partial'
  /** 未核销（有未结余额） */
  | 'open'
  /** 已作废（仅出现在"已剔除"提示中） */
  | 'voided'
  /** 备查行：不参与余额（发票金额、核销明细） */
  | 'informational';

/** 期间范围（左闭右开） */
export interface StatementPeriod {
  /** YYYY-MM-01 */
  start: string;
  /** 次月 YYYY-MM-01 */
  end: string;
  /** 本期最后一天 YYYY-MM-DD，用于展示 */
  monthEnd: string;
}

/** 送入 `computeStatement` 的一条发生额 */
export interface StatementTxn {
  /** 单据日期 YYYY-MM-DD；缺失时由调用方补业务日期，不在此处兜底 */
  date: string;
  docType: StatementDocType;
  /** 业务单号（ARR/RCV/INV/APB/PAY…） */
  docCode: string;
  /** 本方向下的**增加额**（客户=应收增加，供应商=应付增加） */
  debit: number;
  /** 本方向下的**减少额**（客户=回款/冲减，供应商=付款/冲减） */
  credit: number;
  /** 是否参与余额滚动。发票金额属备查（避免与应收/应付重复计量），固定 false */
  affectsBalance: boolean;
  status: StatementStatus;
  /** 作废单据：整单剔除（见文件头口径 3） */
  voided: boolean;
  /** 关联的业务单号（发票→应收/应付、回款→核销的应收） */
  relatedDocCode: string | null;
  remark: string | null;
  /**
   * 同日排序位：同一 `date` 内按 `sortKey` 升序，保证**运行余额可复现**。
   * 约定：应收/应付=10，回款/付款=20，发票=30，其余=90。
   */
  sortKey: number;
}

/** 对账单上的一行（含服务端算出的运行余额） */
export interface StatementLine extends StatementTxn {
  /** 计入本期期初的行（date < periodStart）无运行余额，为 null */
  runningBalance: number | null;
}

/** 核对状态汇总（按单据行计数，备查行不计） */
export interface StatementReconSummary {
  reconciled: number;
  partial: number;
  open: number;
  /** 本期存在、但已整单剔除的作废单据数 */
  voidedExcluded: number;
}

export interface StatementComputation {
  period: StatementPeriod;
  direction: StatementDirection;
  openingBalance: number;
  periodDebit: number;
  periodCredit: number;
  closingBalance: number;
  /** 参与余额滚动的本期行 */
  lines: StatementLine[];
  /** 期初之前的行（供"期初构成"追溯），按日期升序 */
  openingLines: StatementLine[];
  /** 本期被剔除的作废单据（供"已剔除"提示，不参与任何金额） */
  excludedLines: StatementTxn[];
  reconSummary: StatementReconSummary;
}

const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** 金额统一 2 位小数四舍五入：唯一入口 `round2`（十进制、对负数对称，红冲凭证可对冲） */
export function roundAmount(value: number): number {
  return round2(value);
}

/** 分比较：浮点金额判等一律走 round2，禁止 `===`（`round2` 对负数对称，负向金额也可靠） */
export function sameAmount(a: number, b: number): boolean {
  return round2(a) === round2(b);
}

/**
 * `YYYY-MM` → 期间范围（左闭右开）。
 * 非法期间抛 `RangeError`（service 层已由 DTO 正则拦一次，这里是纯函数自保）。
 */
export function resolveStatementPeriod(period: string): StatementPeriod {
  const matched = PERIOD_PATTERN.exec(period);
  if (!matched) {
    throw new RangeError('期间格式必须为 YYYY-MM');
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  // 本期最后一天（UTC 安全：Date.UTC(year, month, 0) 即当月天数）
  const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return {
    start: `${period}-01`,
    end: `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`,
    monthEnd,
  };
}

/**
 * 借贷方向换算：客户对账单里"应收增加"在借方，
 * 供应商对账单里"应付增加"也在借方（站在"我们欠对方"的负债视角，贷方增加是付款）。
 *
 * 即：**无论哪个方向，debit 都是本方向余额的增加项，credit 都是减少项**。
 * 供应商的贷项通知单（红字进项）金额为负，此处会落到 `debit = 负数`，
 * 语义等价于"冲减本期增加"，且 `closing = opening + debit − credit` 仍成立。
 */
export function toStatementDocAmount(
  direction: StatementDirection,
  kind: 'increase' | 'decrease',
  amount: number
): { debit: number; credit: number } {
  const value = Math.abs(amount);
  const increase = kind === 'increase';
  // direction 目前不改变借贷归属（两侧口径相同），保留入参是为了
  // 未来若改为"供应商对账单以我方为收款方"的镜像口径时不用改调用点。
  void direction;
  return increase ? { debit: value, credit: 0 } : { debit: 0, credit: value };
}

/** 单据核对状态入参 */
export interface StatementReconInput {
  /** 作废单据优先：即使有余额也整单剔除，状态直接为 voided */
  voided?: boolean;
  /** 备查行（发票金额等不参与余额的行） */
  informational?: boolean;
  /** 单据总额（应收/应付金额、回款/付款金额） */
  amount: number;
  /** 已核销额（应收/应付取 settledAmount/paidAmount；回款/付款取 usedAmount） */
  settled?: number;
}

/**
 * 单据核对状态：
 *   - 作废优先（作废单即使有余额也整单剔除）；
 *   - 应收/应付按 `amount` vs `settledAmount|paidAmount`（分比较）；
 *   - 回款/付款按 `amount` vs `usedAmount`；
 *   - 备查行固定 `informational`（不参与本期核对进度统计）；
 *   - 其余归 `open`（未核销）/`partial`（部分核销）/`reconciled`（已结清）。
 *
 * 浮点比较一律走 `sameAmount`（分），不用 `===`。
 */
export function statementReconStatus(
  input: StatementReconInput
): StatementStatus {
  if (input.voided) return 'voided';
  if (input.informational) return 'informational';
  const amount = roundAmount(Number(input.amount ?? 0));
  const settled = roundAmount(Number(input.settled ?? 0));
  if (amount <= 0) return settled !== 0 ? 'partial' : 'open';
  if (sameAmount(settled, amount)) return 'reconciled';
  if (settled > 0) return 'partial';
  return 'open';
}

/** 单据类型 → 同日排序位 */
export function statementSortKey(docType: StatementDocType): number {
  switch (docType) {
    case 'ar':
    case 'ap':
      return 10;
    case 'receipt':
    case 'payment':
      return 20;
    case 'invoice':
      return 30;
    // 折让/冲减与发票同为"非资金类"调整，排在资金类之后
    case 'adjust':
      return 40;
    default:
      return 90;
  }
}

/**
 * 核心：把发生额切成「期初 / 本期 / 剔除」，并算出运行余额、期末余额。
 *
 * 期初口径（**需财务确认**）：`sum(本方向发生额净额 with date < period.start)`。
 * 注意不是"数据库里所有记录的合计"——`[period.start, period.end)` 必须排除，
 * 否则本期发生额会在期初里再算一次，运行余额列整体偏移（对账单会直接寄错）。
 */
export function computeStatement(
  direction: StatementDirection,
  period: string,
  txns: readonly StatementTxn[]
): StatementComputation {
  const range = resolveStatementPeriod(period);

  const openingLines: StatementLine[] = [];
  const periodTxns: StatementTxn[] = [];
  const excludedLines: StatementTxn[] = [];
  let openingBalance = 0;

  for (const txn of txns) {
    if (txn.voided) {
      // 只登记"本期被剔除的作废单"用于提示；期初之前的作废单无需出现在对账单上
      if (txn.date >= range.start && txn.date < range.end) {
        excludedLines.push({ ...txn, debit: 0, credit: 0 });
      }
      continue;
    }
    if (!txn.affectsBalance) {
      // 备查行（发票）：只在所属期间出现，不参与期初/期末
      if (txn.date >= range.start && txn.date < range.end) periodTxns.push(txn);
      continue;
    }
    const delta = roundAmount(txn.debit - txn.credit);
    if (txn.date < range.start) {
      openingBalance = roundAmount(openingBalance + delta);
      openingLines.push({ ...txn, runningBalance: null });
      continue;
    }
    if (txn.date < range.end) periodTxns.push(txn);
    // date >= range.end 属未来期间，本期对账单不展示
  }

  periodTxns.sort(compareTxn);

  const lines: StatementLine[] = [];
  let running = openingBalance;
  let periodDebit = 0;
  let periodCredit = 0;
  const reconSummary: StatementReconSummary = {
    reconciled: 0,
    partial: 0,
    open: 0,
    voidedExcluded: excludedLines.length,
  };

  for (const txn of periodTxns) {
    const debit = roundAmount(txn.debit);
    const credit = roundAmount(txn.credit);
    let runningBalance: number | null = null;
    if (txn.affectsBalance) {
      // 只有参与余额的行才进"本期发生额"汇总；
      // 备查行（发票）金额若计入，`closing = opening + debit − credit` 就会被发票虚增。
      periodDebit = roundAmount(periodDebit + debit);
      periodCredit = roundAmount(periodCredit + credit);
      running = roundAmount(running + debit - credit);
      runningBalance = running;
      // 统计只针对"参与余额"的单据，备查行不计入核对进度
      if (txn.status === 'reconciled') reconSummary.reconciled += 1;
      else if (txn.status === 'partial') reconSummary.partial += 1;
      else if (txn.status === 'open') reconSummary.open += 1;
    }
    lines.push({ ...txn, runningBalance });
  }

  const closingBalance = roundAmount(
    openingBalance + periodDebit - periodCredit
  );

  return {
    period: range,
    direction,
    openingBalance,
    periodDebit,
    periodCredit,
    closingBalance,
    lines,
    openingLines: openingLines.sort(compareTxn),
    excludedLines: excludedLines.sort(compareTxn),
    reconSummary,
  };
}

/**
 * 同日排序：date → sortKey → docCode。
 * 加 docCode 是为了并发写入/同秒创建时**顺序仍然确定**，
 * 否则运行余额列每次刷新都可能不同（对账双方看到的余额序列会"漂"）。
 */
export function compareTxn(a: StatementTxn, b: StatementTxn): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
  if (a.docCode !== b.docCode) return a.docCode < b.docCode ? -1 : 1;
  return 0;
}

/** 金额 + 中文大写，供打印件（`toRmbUpper` 的入参允许 number/string） */
export function statementAmountInWords(
  amount: number,
  toRmbUpper: (value: number | string) => string
): string {
  return toRmbUpper(roundAmount(amount));
}
