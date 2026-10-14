import { splitTax } from '@shared/tax';
import {
  ACCOUNT_ADMIN_EXPENSE,
  ACCOUNT_AP,
  ACCOUNT_AR,
  ACCOUNT_BANK_PRIMARY,
  ACCOUNT_CASH,
  ACCOUNT_COST_MAIN,
  ACCOUNT_FIXED_ASSET,
  ACCOUNT_PAYROLL_PAYABLE,
  ACCOUNT_REVENUE_MAIN,
  ACCOUNT_VAT_INPUT,
  ACCOUNT_VAT_OUTPUT,
} from './account-codes';

export interface PostingLine {
  /** 语义科目编码（可为汇总科目，由 AccountResolverService 下钻到末级） */
  accountCode: string;
  debit?: number;
  credit?: number;
}

function keep(lines: PostingLine[]): PostingLine[] {
  return lines.filter(
    (line) => Number(line.debit ?? 0) !== 0 || Number(line.credit ?? 0) !== 0
  );
}

/** 销项开票 / 收入确认：借 1122 价税合计，贷 6001 不含税，贷 222101 销项税。 */
export function outputIssueLines(gross: number, rate: number): PostingLine[] {
  const { net, tax } = splitTax(gross, rate);
  return keep([
    { accountCode: ACCOUNT_AR, debit: gross },
    { accountCode: ACCOUNT_REVENUE_MAIN, credit: net },
    { accountCode: ACCOUNT_VAT_OUTPUT, credit: tax },
  ]);
}

export function outputVoidLines(gross: number, rate: number): PostingLine[] {
  const { net, tax } = splitTax(gross, rate);
  return keep([
    { accountCode: ACCOUNT_REVENUE_MAIN, debit: net },
    { accountCode: ACCOUNT_VAT_OUTPUT, debit: tax },
    { accountCode: ACCOUNT_AR, credit: gross },
  ]);
}

/**
 * 进项登记：借 6602 不含税，借 222102 进项税，贷 2202 价税合计。
 * 进项费用化走管理费用，不进主营业务成本。
 */
export function inputIssueLines(gross: number, rate: number): PostingLine[] {
  const { net, tax } = splitTax(gross, rate);
  return keep([
    { accountCode: ACCOUNT_ADMIN_EXPENSE, debit: net },
    { accountCode: ACCOUNT_VAT_INPUT, debit: tax },
    { accountCode: ACCOUNT_AP, credit: gross },
  ]);
}

/** 进项红冲：进项费用化走管理费用，不进主营业务成本。 */
export function inputVoidLines(gross: number, rate: number): PostingLine[] {
  const { net, tax } = splitTax(gross, rate);
  return keep([
    { accountCode: ACCOUNT_AP, debit: gross },
    { accountCode: ACCOUNT_ADMIN_EXPENSE, credit: net },
    { accountCode: ACCOUNT_VAT_INPUT, credit: tax },
  ]);
}

/** 采购验收-固定资产：借 1601 固定资产 + 借 222102 进项税，贷 2202 应付（不进当期费用）。 */
export function inputCapitalizeLines(gross: number, rate: number): PostingLine[] {
  const { net, tax } = splitTax(gross, rate);
  return keep([
    { accountCode: ACCOUNT_FIXED_ASSET, debit: net },
    { accountCode: ACCOUNT_VAT_INPUT, debit: tax },
    { accountCode: ACCOUNT_AP, credit: gross },
  ]);
}

/** 成本确认：借 6401，贷 2202（非增值税，无税金分录）。 */
export function costConfirmLines(amount: number): PostingLine[] {
  return [
    { accountCode: ACCOUNT_COST_MAIN, debit: amount },
    { accountCode: ACCOUNT_AP, credit: amount },
  ];
}

/**
 * 银行收款：借 1002 银行存款（下钻 100201 基本户），贷 1122 应收账款。
 * A-10 科目表纠正后，"银行存款"的准则编码为 1002，历史实现误用 1001（库存现金）。
 */
export function receiptLines(amount: number): PostingLine[] {
  return [
    { accountCode: ACCOUNT_BANK_PRIMARY, debit: amount },
    { accountCode: ACCOUNT_AR, credit: amount },
  ];
}

export function receiptVoidLines(amount: number): PostingLine[] {
  return [
    { accountCode: ACCOUNT_AR, debit: amount },
    { accountCode: ACCOUNT_BANK_PRIMARY, credit: amount },
  ];
}

/** 银行付款：借 2202 应付账款，贷 1002 银行存款。 */
export function paymentLines(amount: number): PostingLine[] {
  return [
    { accountCode: ACCOUNT_AP, debit: amount },
    { accountCode: ACCOUNT_BANK_PRIMARY, credit: amount },
  ];
}

export function paymentVoidLines(amount: number): PostingLine[] {
  return [
    { accountCode: ACCOUNT_BANK_PRIMARY, debit: amount },
    { accountCode: ACCOUNT_AP, credit: amount },
  ];
}

/** 现金收付（备用，供出纳现钞场景使用） */
export function cashReceiptLines(amount: number): PostingLine[] {
  return [
    { accountCode: ACCOUNT_CASH, debit: amount },
    { accountCode: ACCOUNT_AR, credit: amount },
  ];
}

/** 工资计提：借 6401 主营业务成本，贷 2211 应付职工薪酬。 */
export function payrollAccrualLines(amount: number): PostingLine[] {
  return [
    { accountCode: ACCOUNT_COST_MAIN, debit: amount },
    { accountCode: ACCOUNT_PAYROLL_PAYABLE, credit: amount },
  ];
}
