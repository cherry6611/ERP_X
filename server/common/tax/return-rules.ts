/**
 * C-05：采购/销售退货闭环的会计口径与业务规则。
 *
 * ## 为什么抽成纯函数
 *
 * 退货最容易出错的是**可退数量**与**金额还原**两件事：
 * 1. 同一张订单可能分多次退货，每次都要扣减已退数量；少扣一次就会超退。
 * 2. 采购订单金额是**含税**的，退货要按原税率倒算不含税净额与税额，
 *    不能用 `金额 / 1.06` 这种硬编码税率。税率取原单快照。
 * 两个错误都不会当场报错，而是等对账或税务比对时才发现。
 *
 * ## 采购退货分录（冲减原采购入库）
 *
 * ```
 * 借 2202 应付账款（含税）  /  贷 1403 原材料（不含税） + 贷 222102 应交税费-进项税额（税额）
 * ```
 *
 * ## 销售退货分录（红冲收入，**需财务确认**）
 *
 * ```
 * 借 6001 主营业务收入（不含税，红字）/ 借 222101 销项税额（税额）
 *   贷 1122 应收账款（含税）
 * ```
 *
 * 销售退货是否**同时**红冲成本（借 1403 / 贷 6401）取决于退货商品是否回库可用，
 * 本系统不做自动处理：只红冲收入与应收，成本冲回需人工建凭证。
 * 这条口径需财务确认，已记录在 `docs/升级落地状态台账-2026-10-15.md`。
 */

import { splitTax } from '@shared/tax';
import {
  ACCOUNT_ADMIN_EXPENSE,
  ACCOUNT_AP,
  ACCOUNT_AR,
  ACCOUNT_COST_MAIN,
  ACCOUNT_INVENTORY,
  ACCOUNT_REVENUE_MAIN,
  ACCOUNT_VAT_INPUT,
  ACCOUNT_VAT_OUTPUT,
} from './account-codes';
import type { PostingLine } from './posting';

/** 退货状态机 */
export const RETURN_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'completed',
  'void',
] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export const RETURN_STATUS_LABELS: Record<ReturnStatus, string> = {
  draft: '草稿',
  submitted: '待审批',
  approved: '已批准',
  completed: '已完成',
  void: '已作废',
};

/** 退货动作 */
export const RETURN_ACTIONS = ['submit', 'approve', 'reject', 'complete', 'void'] as const;
export type ReturnAction = (typeof RETURN_ACTIONS)[number];

export const RETURN_ACTION_LABELS: Record<ReturnAction, string> = {
  submit: '提交审批',
  approve: '批准',
  reject: '驳回',
  complete: '完成退货（红字凭证）',
  void: '作废',
};

/** 每个动作允许的前置状态 */
export const RETURN_TRANSITIONS: Record<ReturnAction, readonly ReturnStatus[]> = {
  submit: ['draft'],
  approve: ['submitted'],
  // 驳回退回草稿，允许修改后重新提交（避免一次驳回就把单子废掉）
  reject: ['submitted'],
  complete: ['approved'],
  // 已完成不可作废（已生成红字凭证，需先作废凭证）；草稿/待审/已批准可作废
  void: ['draft', 'submitted', 'approved'],
};

/** 动作完成后的目标状态 */
export const RETURN_ACTION_TARGET: Record<ReturnAction, ReturnStatus> = {
  submit: 'submitted',
  approve: 'approved',
  reject: 'draft',
  complete: 'completed',
  void: 'void',
};

/** 终态 */
export const TERMINAL_RETURN_STATUSES: readonly ReturnStatus[] = [
  'completed',
  'void',
];

export function validateReturnAction(
  status: ReturnStatus,
  action: ReturnAction
): string[] {
  if (TERMINAL_RETURN_STATUSES.includes(status)) {
    return [
      `退货单已处于终态「${RETURN_STATUS_LABELS[status]}」，不允许再执行「${RETURN_ACTION_LABELS[action]}」`,
    ];
  }
  const allowed = RETURN_TRANSITIONS[action];
  if (!allowed.includes(status)) {
    return [
      `「${RETURN_ACTION_LABELS[action]}」不允许从「${RETURN_STATUS_LABELS[status]}」发起，` +
        `允许的前置状态：${allowed.map((s) => RETURN_STATUS_LABELS[s]).join(' / ')}`,
    ];
  }
  return [];
}

/* ========== 可退数量 ========== */

export interface OrderQuantityInput {
  /** 原单订购数量 */
  quantity: number;
  /** 已验收数量（未验收的货不能退） */
  acceptedQuantity: number;
  /** 该订单已通过（未作废）退货单累计已退数量 */
  returnedQuantity: number;
}

export interface ReturnableResult {
  /** 可退数量 = 已验收 − 已退，下限 0 */
  returnableQuantity: number;
  acceptedQuantity: number;
  returnedQuantity: number;
  /** 已验收数量为 0 说明还没收货，不可退 */
  notAccepted: boolean;
}

/**
 * 可退数量 = 已验收数量 − 已退数量。
 *
 * 为什么基准是**已验收**而不是**订购**：未验收的货还没入账，
 * 也就不存在"退货"这个动作（应向供应商催货或取消订单）。
 */
export function returnableQuantity(input: OrderQuantityInput): ReturnableResult {
  const accepted = Math.max(0, Math.trunc(input.acceptedQuantity || 0));
  const returned = Math.max(0, Math.trunc(input.returnedQuantity || 0));
  return {
    returnableQuantity: Math.max(accepted - returned, 0),
    acceptedQuantity: accepted,
    returnedQuantity: returned,
    notAccepted: accepted <= 0,
  };
}

/* ========== 金额还原 ========== */

export interface ReturnAmountInput {
  /** 含税单价（原单快照） */
  unitPrice: number;
  /** 本次退货数量 */
  quantity: number;
  /** 原单税率（%，快照） */
  taxRate: number;
}

export interface ReturnAmountResult {
  quantity: number;
  /** 含税金额 */
  amount: number;
  /** 不含税净额 */
  netAmount: number;
  /** 税额 */
  taxAmount: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 按原单税率倒算退货金额。
 *
 * 关键点：**税额必须用 `splitTax(含税额, 税率)` 反算，而不是 `净额 × 税率`**——
 * 后者会在分位上差 1 分（因为含税额本身已四舍五入过一次）。
 * `splitTax` 保证 `净额 + 税额 === 含税额`（见 `shared/tax.ts`）。
 */
export function returnAmount(input: ReturnAmountInput): ReturnAmountResult {
  const quantity = Math.max(0, Math.trunc(input.quantity || 0));
  const amount = round2(input.unitPrice * quantity);
  const { net, tax } = splitTax(amount, input.taxRate);
  return {
    quantity,
    amount,
    netAmount: round2(net),
    taxAmount: round2(tax),
  };
}

/** 汇总多行退货金额（含税/净额/税额三项都必须是行金额之和，不能各自重算） */
export function sumReturnLines(
  lines: Array<{ quantity: number; unitPrice: number; taxRate: number }>
): ReturnAmountResult {
  let amount = 0;
  let net = 0;
  let tax = 0;
  let quantity = 0;
  for (const line of lines) {
    const result = returnAmount(line);
    quantity += result.quantity;
    amount = round2(amount + result.amount);
    net = round2(net + result.netAmount);
    tax = round2(tax + result.taxAmount);
  }
  return { quantity, amount, netAmount: net, taxAmount: tax };
}

/* ========== 分录模板 ========== */

/**
 * 采购退货（冲减原采购入库）：
 * 借 2202 应付账款（含税）/ 贷 1403 原材料（不含税）+ 贷 222102 进项税额（税额）
 *
 * 为什么冲减应付而不是"应收供应商"：退货通常直接抵减对该供应商的应付余额，
 * 不产生独立的债权；若供应商已付款，则需另行走退款流程（涉及资金，本系统不自动处理）。
 */
export function purchaseReturnLines(
  netAmount: number,
  taxAmount: number
): PostingLine[] {
  const gross = round2(netAmount + taxAmount);
  const lines: PostingLine[] = [];
  if (gross > 0) lines.push({ accountCode: ACCOUNT_AP, debit: gross });
  if (netAmount > 0) {
    lines.push({ accountCode: ACCOUNT_INVENTORY, credit: netAmount });
  }
  if (taxAmount > 0) {
    lines.push({ accountCode: ACCOUNT_VAT_INPUT, credit: taxAmount });
  }
  return lines.filter(
    (line) => Number(line.debit ?? 0) !== 0 || Number(line.credit ?? 0) !== 0
  );
}

/**
 * 销售退货（红冲收入与应收）：
 * 借 6001 主营业务收入（不含税）/ 借 222101 销项税额（税额）/ 贷 1122 应收账款（含税）
 *
 * ⚠️ **不自动红冲成本**：退货商品是否回库可用需业务判定，
 * 因此成本冲回（借 1403 / 贷 6401）留给人工建凭证。这属于需财务确认的口径。
 */
export function salesReturnLines(
  netAmount: number,
  taxAmount: number
): PostingLine[] {
  const gross = round2(netAmount + taxAmount);
  const lines: PostingLine[] = [];
  if (netAmount > 0) {
    lines.push({ accountCode: ACCOUNT_REVENUE_MAIN, debit: netAmount });
  }
  if (taxAmount > 0) {
    lines.push({ accountCode: ACCOUNT_VAT_OUTPUT, debit: taxAmount });
  }
  if (gross > 0) lines.push({ accountCode: ACCOUNT_AR, credit: gross });
  return lines.filter(
    (line) => Number(line.debit ?? 0) !== 0 || Number(line.credit ?? 0) !== 0
  );
}

/**
 * 销售退货同步红冲成本（按**处置方式**选择对方科目）：
 *   - `restock`（退回商品可再售）：借 1403 原材料 / 贷 6401 主营业务成本
 *   - `scrap`  （退回商品报废）  ：借 6602 管理费用 / 贷 6401 主营业务成本
 *
 * 为什么不给一个全局默认：处置方式取决于实物状态，只能逐单判定。
 * 一律按回库处理会把报废退货挂成库存（报表显示"有货"而实际没有）；
 * 一律按报废处理会把可再售退货计成费用。两者都属于"错误数字看起来是对的"。
 *
 * 金额为 0（项目缺收入/成本数据）时返回空数组，由调用方保持"不生成成本行"。
 */
export function salesReturnCostLines(
  cost: number,
  disposal: 'restock' | 'scrap' = 'restock'
): PostingLine[] {
  if (cost <= 0) return [];
  const counterAccount =
    disposal === 'scrap' ? ACCOUNT_ADMIN_EXPENSE : ACCOUNT_INVENTORY;
  return [
    { accountCode: counterAccount, debit: cost },
    { accountCode: ACCOUNT_COST_MAIN, credit: cost },
  ];
}

/** 校验分录借贷平衡（金额口径自检，供服务层与单测共用） */
export function isBalanced(lines: PostingLine[]): boolean {
  const debit = round2(lines.reduce((sum, l) => sum + (l.debit ?? 0), 0));
  const credit = round2(lines.reduce((sum, l) => sum + (l.credit ?? 0), 0));
  return debit === credit;
}
