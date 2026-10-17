/**
 * C-04 / D-02：应收应付票据（银行承兑 / 商业承兑汇票）的会计口径与业务规则。
 *
 * ## 为什么抽成纯函数
 *
 * 票据是本系统里**状态最多、分录最绕、也最容易算错钱**的一块：
 * 贴现息的天数基准（360 / 365）、已持有天数要不要扣、背书与贴现的科目差异，
 * 任何一处错了都不会当场报错，而是月末对账时才发现差几千块。
 * 因此这里把「状态机 + 贴现息 + 分录模板」都做成可单测的纯函数。
 *
 * ## 状态机
 *
 * ```
 * received ──hold──> held ──endorse──> endorsed   （背书转让给供应商）
 *    │                 │
 *    │                 ├──discount──> discounted （贴现，银行扣息）
 *    │                 └──settle────> settled    （到期收款）
 *    └──dishonor──> dishonored                   （拒付/退票）
 * ```
 *
 * 允许 `received` 直接流转（不必先 hold），因为实务里"收到即持有"很常见；
 * 但**已终态（settled / dishonored）不可再流转**。
 *
 * ## 贴现息口径（**需财务确认**）
 *
 * ```
 * 贴现息 = 票面金额 × 贴现率 / 100 × 贴现天数 / 360
 * 贴现天数 = 贴现日 → 到期日 的实际天数（算头不算尾，到期日不计息）
 * ```
 *
 * 两个必须确认的点：
 * 1. **计息基准 360 还是 365**：本实现取 360（银行承兑汇票贴现的行业惯例），
 *    但《票据法》与部分银行按实际天数/365；差异约 1.4%。
 * 2. **到期日是否计息**：本实现不计（截止到到期日前一天），
 *    部分银行按"到期日也计一天"。
 *
 * 若贵司合作银行口径不同，改 `DISCOUNT_DAY_BASIS` 与 `discountDays` 即可，
 * 单测会立刻反映差异。
 */

import {
  ACCOUNT_AP,
  ACCOUNT_AR,
  ACCOUNT_BANK_PRIMARY,
  ACCOUNT_FINANCE_EXPENSE,
} from './account-codes';
import type { PostingLine } from './posting';
import { round2 } from '@server/common/utils/number';

/** 票据类型 */
export const NOTE_TYPES = ['bank', 'commercial'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export const NOTE_TYPE_LABELS: Record<NoteType, string> = {
  bank: '银行承兑汇票',
  commercial: '商业承兑汇票',
};

/** 票据状态 */
export const NOTE_STATUSES = [
  'received',
  'held',
  'endorsed',
  'discounted',
  'settled',
  'dishonored',
] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export const NOTE_STATUS_LABELS: Record<NoteStatus, string> = {
  received: '已收到',
  held: '持有中',
  endorsed: '已背书',
  discounted: '已贴现',
  settled: '已结清',
  dishonored: '已拒付',
};

/** 流转动作 */
export const NOTE_ACTIONS = [
  'hold',
  'endorse',
  'discount',
  'settle',
  'dishonor',
] as const;
export type NoteAction = (typeof NOTE_ACTIONS)[number];

export const NOTE_ACTION_LABELS: Record<NoteAction, string> = {
  hold: '确认持有',
  endorse: '背书转让',
  discount: '贴现',
  settle: '到期收款',
  dishonor: '拒付/退票',
};

/** 终态：不可再流转 */
export const TERMINAL_NOTE_STATUSES: readonly NoteStatus[] = [
  'settled',
  'dishonored',
];

/** 每个动作允许的**前置状态** */
export const NOTE_TRANSITIONS: Record<NoteAction, readonly NoteStatus[]> = {
  // received 可直接 hold（收到即持有），也可从 held 再确认一次（幂等语义由日志唯一索引兜底）
  hold: ['received', 'held'],
  // 只有持有的票据能背书出去
  endorse: ['received', 'held'],
  // 只有持有的票据能贴现
  discount: ['received', 'held'],
  // 到期收款：持有中或已背书/贴现（被追索后又收到款的情形）都能结清
  settle: ['received', 'held', 'endorsed', 'discounted'],
  // 拒付：未结清的都能拒付
  dishonor: ['received', 'held', 'endorsed', 'discounted'],
};

/** 动作完成后的目标状态 */
export const NOTE_ACTION_TARGET: Record<NoteAction, NoteStatus> = {
  hold: 'held',
  endorse: 'endorsed',
  discount: 'discounted',
  settle: 'settled',
  dishonor: 'dishonored',
};

/** 需要审批动作之外附加信息的动作 */
export const NOTE_ACTION_REQUIRES_COUNTERPARTY: readonly NoteAction[] = [
  'endorse',
];
export const NOTE_ACTION_REQUIRES_RATE: readonly NoteAction[] = ['discount'];

/** 校验动作是否合法；返回错误消息数组（空 = 通过） */
export function validateNoteAction(
  status: NoteStatus,
  action: NoteAction
): string[] {
  const errors: string[] = [];
  if (TERMINAL_NOTE_STATUSES.includes(status)) {
    errors.push(
      `票据已处于终态「${NOTE_STATUS_LABELS[status]}」，不允许再执行「${NOTE_ACTION_LABELS[action]}」`
    );
    return errors;
  }
  const allowed = NOTE_TRANSITIONS[action];
  if (!allowed.includes(status)) {
    errors.push(
      `「${NOTE_ACTION_LABELS[action]}」不允许从「${NOTE_STATUS_LABELS[status]}」发起，` +
        `允许的前置状态：${allowed.map((s) => NOTE_STATUS_LABELS[s]).join(' / ')}`
    );
  }
  return errors;
}

/* ========== 贴现息 ========== */

/** 贴现计息基准（**需财务确认**：银行惯例 360，部分机构 365） */
export const DISCOUNT_DAY_BASIS = 360;

/** `YYYY-MM-DD` → UTC 毫秒（避免本地时区把天数算偏 1 天） */
function parseDateOnly(value: string): number {
  const [y, m, d] = value.split('-').map(Number);
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
}

/**
 * 贴现天数 = 贴现日 → 到期日，**算头不算尾**（到期日不计息）。
 * 到期日早于或等于贴现日时返回 0（当日到期当日贴现无息可扣）。
 */
export function discountDays(discountDate: string, dueDate: string): number {
  const diff = parseDateOnly(dueDate) - parseDateOnly(discountDate);
  const days = Math.floor(diff / 86_400_000);
  return days > 0 ? days : 0;
}


export interface DiscountInput {
  /** 票面金额 */
  amount: number;
  /** 贴现率（百分数，如 3.5 表示 3.5%） */
  rate: number;
  discountDate: string;
  dueDate: string;
}

export interface DiscountResult {
  days: number;
  /** 贴现息（银行扣除部分） */
  interest: number;
  /** 实际到账 = 票面 − 贴现息 */
  netProceeds: number;
}

/**
 * 贴现息计算。
 *
 * `interest = 票面 × 贴现率/100 × 贴现天数 / 基准`，四舍五入到分。
 * 贴现息**不允许为负**；若贴现天数已按算头不算尾取 0，则息为 0、到账即票面。
 */
export function computeDiscount(input: DiscountInput): DiscountResult {
  const days = discountDays(input.discountDate, input.dueDate);
  const rate = Number.isFinite(input.rate) ? Math.max(input.rate, 0) : 0;
  const interest = round2(
    (input.amount * rate * days) / (100 * DISCOUNT_DAY_BASIS)
  );
  return {
    days,
    interest,
    netProceeds: round2(input.amount - interest),
  };
}

/* ========== 分录模板 ========== */

/**
 * 收到票据（冲抵应收账款）：借 1122 应收账款 **红字** 还是贷记？
 *
 * 这里采用实务中最常见的做法：把收到的票据仍挂在 1122 应收账款下，
 * 通过**贷记 1122** 冲减，同时不新增资产科目（票据不是"其他货币资金"）。
 * 若贵司要求单列"应收票据 1121"科目，需先补科目再改本函数 —— 这属于
 * A-10 科目表调整范围，且会影响资产负债表"应收票据"行次。
 */
export function noteReceiveLines(amount: number): PostingLine[] {
  return [
    { accountCode: ACCOUNT_AR, debit: amount },
    { accountCode: ACCOUNT_AR, credit: amount },
  ];
}

/** 背书转让给供应商（支付货款）：借 2202 应付账款 / 贷 1122 应收账款 */
export function noteEndorseLines(amount: number): PostingLine[] {
  return [
    { accountCode: ACCOUNT_AP, debit: amount },
    { accountCode: ACCOUNT_AR, credit: amount },
  ];
}

/**
 * 贴现：借 100201 银行存款（净额）+ 借 6603 财务费用（贴现息）/ 贷 1122 应收账款（票面）
 *
 * 贴现息为 0 时不产生财务费用行（避免 0 元分录）。
 */
export function noteDiscountLines(
  amount: number,
  interest: number
): PostingLine[] {
  const lines: PostingLine[] = [];
  const net = round2(amount - interest);
  if (net > 0) {
    lines.push({ accountCode: ACCOUNT_BANK_PRIMARY, debit: net });
  }
  if (interest > 0) {
    lines.push({ accountCode: ACCOUNT_FINANCE_EXPENSE, debit: interest });
  }
  lines.push({ accountCode: ACCOUNT_AR, credit: amount });
  return lines.filter(
    (line) => Number(line.debit ?? 0) !== 0 || Number(line.credit ?? 0) !== 0
  );
}

/** 到期收款：借 100201 银行存款 / 贷 1122 应收账款 */
export function noteSettleLines(amount: number): PostingLine[] {
  return [
    { accountCode: ACCOUNT_BANK_PRIMARY, debit: amount },
    { accountCode: ACCOUNT_AR, credit: amount },
  ];
}

/**
 * 拒付/退票：把票据退回业务方并恢复应收。
 *
 * 若此前已背书或贴现，被追索时需冲回原分录 —— 本函数只处理
 * 「未流转过的票据被拒付」这一最简单情形（借贷同科目轧平），
 * 已背书/贴现后被追索的追索款需人工建凭证（涉及或有负债，本系统不做自动处理）。
 */
export function noteDishonorLines(amount: number): PostingLine[] {
  return [
    { accountCode: ACCOUNT_AR, debit: amount },
    { accountCode: ACCOUNT_AR, credit: amount },
  ];
}

/** 按动作选择分录模板 */
export function noteActionLines(
  action: NoteAction,
  amount: number,
  interest = 0
): PostingLine[] {
  switch (action) {
    case 'hold':
    case 'endorse':
      return action === 'endorse'
        ? noteEndorseLines(amount)
        : noteReceiveLines(amount);
    case 'discount':
      return noteDiscountLines(amount, interest);
    case 'settle':
      return noteSettleLines(amount);
    case 'dishonor':
      return noteDishonorLines(amount);
  }
}

/* ========== 备查簿与到期预警 ========== */

export const NOTE_DUE_WARNING_DAYS = 15;

export interface NoteAlertInput {
  code: string;
  noteNo: string;
  status: string;
  amount: number;
  dueDate: string;
}

export interface NoteDueAlert {
  code: string;
  noteNo: string;
  amount: number;
  dueDate: string;
  /** 距到期天数；负数表示已逾期 */
  daysLeft: number;
  level: 'overdue' | 'urgent' | 'upcoming';
}

/**
 * 到期预警：逾期 / 15 天内到期。
 *
 * 为什么阈值是 15 天：银行承兑汇票贴现通常需要 2–3 个工作日审批，
 * 加上内部用印与走款，15 天是可操作的最短窗口。
 */
export function dueAlerts(
  notes: NoteAlertInput[],
  today: string
): NoteDueAlert[] {
  const alerts: NoteDueAlert[] = [];
  for (const note of notes) {
    // 已结清/已拒付的不再提醒
    if (TERMINAL_NOTE_STATUSES.includes(note.status as NoteStatus)) continue;
    const daysLeft = Math.floor(
      (parseDateOnly(note.dueDate) - parseDateOnly(today)) / 86_400_000
    );
    if (daysLeft > NOTE_DUE_WARNING_DAYS) continue;
    alerts.push({
      code: note.code,
      noteNo: note.noteNo,
      amount: note.amount,
      dueDate: note.dueDate,
      daysLeft,
      level: daysLeft < 0 ? 'overdue' : daysLeft <= 3 ? 'urgent' : 'upcoming',
    });
  }
  return alerts.sort((a, b) => a.daysLeft - b.daysLeft);
}

/** 备查簿汇总（按状态分组，供 D-02 票据备查簿展示） */
export function noteRegisterSummary(
  notes: Array<{ status: string; amount: number; noteType: string }>
): {
  byStatus: Array<{ status: NoteStatus; label: string; count: number; amount: number }>;
  byType: Array<{ noteType: NoteType; label: string; count: number; amount: number }>;
  totalAmount: number;
  outstandingAmount: number;
} {
  const byStatus = NOTE_STATUSES.map((status) => {
    const matched = notes.filter((note) => note.status === status);
    return {
      status,
      label: NOTE_STATUS_LABELS[status],
      count: matched.length,
      amount: round2(matched.reduce((sum, note) => sum + note.amount, 0)),
    };
  });
  const byType = NOTE_TYPES.map((noteType) => {
    const matched = notes.filter((note) => note.noteType === noteType);
    return {
      noteType,
      label: NOTE_TYPE_LABELS[noteType],
      count: matched.length,
      amount: round2(matched.reduce((sum, note) => sum + note.amount, 0)),
    };
  });
  return {
    byStatus,
    byType,
    totalAmount: round2(notes.reduce((sum, note) => sum + note.amount, 0)),
    // 未结清 = 还在手上或已流转但可能被追索的（排除 settled）
    outstandingAmount: round2(
      notes
        .filter((note) => !TERMINAL_NOTE_STATUSES.includes(note.status as NoteStatus))
        .reduce((sum, note) => sum + note.amount, 0)
    ),
  };
}
