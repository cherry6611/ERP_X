import { splitTax } from '@shared/tax';
import {
  ACCOUNT_ACCUM_DEPRECIATION,
  ACCOUNT_ADMIN_EXPENSE,
  ACCOUNT_ADVANCE_RECEIPT,
  ACCOUNT_AP,
  ACCOUNT_AR,
  ACCOUNT_ASSET_IMPAIRMENT,
  ACCOUNT_BANK_PRIMARY,
  ACCOUNT_CASH,
  ACCOUNT_COST_MAIN,
  ACCOUNT_FIXED_ASSET,
  ACCOUNT_FIXED_ASSET_DISPOSAL,
  ACCOUNT_FIXED_ASSET_IMPAIRMENT,
  ACCOUNT_NON_OPERATING_EXPENSE,
  ACCOUNT_NON_OPERATING_INCOME,
  ACCOUNT_PAYROLL_PAYABLE,
  ACCOUNT_REVENUE_MAIN,
  ACCOUNT_VAT_INPUT,
  ACCOUNT_VAT_OUTPUT,
} from './account-codes';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

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

/**
 * ⚠️ **方案 A 下为死代码，禁止接线到销项作废路径。**
 *
 * 本函数是「销项开票即确认收入」时代的分录。方案 A 之后，收入确认是唯一收入入口，
 * 销项开票只登记台账、**不生成任何凭证**（见 `finance/invoice.service.ts` 开票路径），
 * 因此销项发票作废时**不能**生成本函数的分录 —— 那会把该发票从未入账的
 * 6001 / 222101 / 1122 反向冲掉，等于凭空冲减「收入确认」已确认的收入（比原缺陷更严重）。
 *
 * 现状下进项（`inputVoidLines`）必须冲、销项不必冲，这个"不对称"是正确的：
 * 进项开票时入了账（借库存/进项税、贷应付），销项开票时没入账。
 * 两者在底稿层面的口径差异由增值税底稿显式披露，而不是靠补一笔假凭证去"抹平"。
 *
 * 保留函数仅为兼容既有单测对分录方向的锁定；新代码不要调用。
 */
export function outputVoidLines(gross: number, rate: number): PostingLine[] {
  const { net, tax } = splitTax(gross, rate);
  return keep([
    { accountCode: ACCOUNT_REVENUE_MAIN, debit: net },
    { accountCode: ACCOUNT_VAT_OUTPUT, debit: tax },
    { accountCode: ACCOUNT_AR, credit: gross },
  ]);
}

/**
 * P0-4：手工应收登记分录。
 *
 * 为什么不再贷 6001 主营业务收入：
 *   手工应收登记与「收入确认」是两条独立入口，若两者都贷记 6001，
 *   同一合同会被重复确认收入（走查中总账收入 120,000 vs 收入台账 60,000）。
 *   收入只由「收入确认」模块单点确认，手工应收只登记债权：
 *     借 1122 应收账款（价税合计）
 *     贷 2203 预收账款（合同结算口径，不含税）
 *     贷 222101 应交增值税（销项税）
 *   开票即发生纳税义务，因此仍按不含税/销项税拆分，保持与增值税底稿一致。
 */
export function arRegisterLines(gross: number, rate: number): PostingLine[] {
  const { net, tax } = splitTax(gross, rate);
  return keep([
    { accountCode: ACCOUNT_AR, debit: gross },
    { accountCode: ACCOUNT_ADVANCE_RECEIPT, credit: net },
    { accountCode: ACCOUNT_VAT_OUTPUT, credit: tax },
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

/* ========== D-08：固定资产减值与处置（口径需财务确认，见迁移注释） ========== */

/**
 * 计提固定资产减值：借 6701 资产减值损失，贷 1604 固定资产减值准备。
 *
 * 为什么单独挂 1604 而不是直接冲减 1601：
 * 固定资产原值必须保留（报表"固定资产原价"行取 1601 借方余额），
 * 减值只能作为备抵科目列示，否则"原价"与"累计折旧"两个口径同时失真。
 */
export function assetImpairmentLines(loss: number): PostingLine[] {
  return keep([
    { accountCode: ACCOUNT_ASSET_IMPAIRMENT, debit: loss },
    { accountCode: ACCOUNT_FIXED_ASSET_IMPAIRMENT, credit: loss },
  ]);
}

export interface AssetDisposalInput {
  /** 账面原值 */
  originalValue: number;
  /** 累计折旧 */
  accumulatedDepreciation: number;
  /** 已计提减值准备 */
  impairmentProvision: number;
  /** 处置收入（不含税）；报废/捐赠为 0 */
  disposalIncome: number;
  /** 销项税额（处置收入倒算）；无收入为 0 */
  outputTax: number;
  /** sale=出售转让 / scrap=报废 / donate=捐赠 */
  disposalType: 'sale' | 'scrap' | 'donate';
}

export interface AssetDisposalPosting {
  lines: PostingLine[];
  /** 处置净损益：正=收益（营业外收入），负=损失（营业外支出） */
  gainLoss: number;
}

/**
 * 固定资产处置（出售/报废/捐赠）：
 *
 *   ① 转入清理：借 1603 固定资产清理（净值）+ 借 1602 累计折旧 + 借 1604 减值准备
 *              / 贷 1601 固定资产（原值）
 *   ② 处置收入：借 1002 银行存款（含税）/ 贷 1603 清理 + 贷 222101 销项税
 *   ③ 清理净额：1603 借方余额（净损失）→ 借 6711 营业外支出；
 *              1603 贷方余额（净收益）→ 贷 6301 营业外收入
 *
 * 净损益推导（单测据此断言）：
 *   gainLoss = 处置收入 − 销项税 − (原值 − 累计折旧 − 减值准备)
 *            = disposalIncome − outputTax − netBookValue
 * 净损失走 6711、净收益走 6301，金额恒为 |gainLoss|。
 */
export function assetDisposalLines(input: AssetDisposalInput): AssetDisposalPosting {
  const {
    originalValue,
    accumulatedDepreciation,
    impairmentProvision,
    disposalIncome,
    outputTax,
  } = input;
  const netBookValue = round2(
    originalValue - accumulatedDepreciation - impairmentProvision
  );
  const gainLoss = round2(disposalIncome - outputTax - netBookValue);

  const lines: PostingLine[] = [];
  // ① 转入清理：把原值、累计折旧、减值准备同时转出到 1603
  //
  // 注意：每条分录只写**单边**金额（借方行只给 debit，贷方行只给 credit）。
  // 下面 keep() 会丢弃"两侧都为 0"的行；若把一条分录同时写成 `{debit: x, credit: 0}`
  // 之外的形态（例如两边都给值），会被 keep 的过滤条件误判，因此这里保持单边写法。
  if (originalValue > 0) {
    if (netBookValue > 0) {
      lines.push({ accountCode: ACCOUNT_FIXED_ASSET_DISPOSAL, debit: netBookValue });
    } else if (netBookValue < 0) {
      // 账面为负（累计折旧+减值超过原值，历史数据异常）时挂贷方，保证分录仍能轧平
      lines.push({ accountCode: ACCOUNT_FIXED_ASSET_DISPOSAL, credit: -netBookValue });
    }
    if (accumulatedDepreciation > 0) {
      lines.push({
        accountCode: ACCOUNT_ACCUM_DEPRECIATION,
        debit: accumulatedDepreciation,
      });
    }
    if (impairmentProvision > 0) {
      lines.push({
        accountCode: ACCOUNT_FIXED_ASSET_IMPAIRMENT,
        debit: impairmentProvision,
      });
    }
    lines.push({ accountCode: ACCOUNT_FIXED_ASSET, credit: originalValue });
  }
  // ② 处置收入（出售转让或报废变卖收入）
  if (disposalIncome > 0) {
    lines.push({
      accountCode: ACCOUNT_BANK_PRIMARY,
      debit: round2(disposalIncome + outputTax),
    });
    lines.push({
      accountCode: ACCOUNT_FIXED_ASSET_DISPOSAL,
      credit: disposalIncome,
    });
    if (outputTax > 0) {
      lines.push({ accountCode: ACCOUNT_VAT_OUTPUT, credit: outputTax });
    }
  }
  // ③ 清理净额结转
  if (gainLoss > 0) {
    lines.push({ accountCode: ACCOUNT_FIXED_ASSET_DISPOSAL, debit: gainLoss });
    lines.push({ accountCode: ACCOUNT_NON_OPERATING_INCOME, credit: gainLoss });
  } else if (gainLoss < 0) {
    lines.push({ accountCode: ACCOUNT_NON_OPERATING_EXPENSE, debit: -gainLoss });
    lines.push({ accountCode: ACCOUNT_FIXED_ASSET_DISPOSAL, credit: -gainLoss });
  }
  return { lines: keep(lines), gainLoss };
}
