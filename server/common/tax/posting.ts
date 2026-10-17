import { splitTax } from '@shared/tax';
import { round2 } from '@server/common/utils/number';
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
 * ⚠️ **现役用于「收入冲回」；禁止接线到销项发票作废路径。**
 *
 * ## 它现在是活代码（原注释自称"死代码"，会误导后来者删掉它）
 *
 * 审计 §4.2 复核结论：本函数有**两处真实调用**，都在收入侧：
 *   · `revenues.service.ts:336` —— `revenue-reverse:{code}` 收入冲回
 *   · `revenues.service.ts:386` —— `revenue-adjust:{code}` 收入调整冲回
 * 因为收入确认（`revenues.service.ts:200`）用的是 `outputIssueLines`
 * （借 1122 / 贷 6001 + 贷 222101），其冲回**必须**是等额反向，
 * 这正是本函数的分录。`posting.spec.ts:69-76` 用「红冲分录是正向分录的等额反向」
 * 钉死了这一点。**删除它会直接破坏收入冲回。**
 *
 * ## 为什么不能接到销项发票作废
 *
 * 本函数是「销项开票即确认收入」时代的分录。方案 A 之后收入确认是唯一收入入口，
 * 销项开票只登记台账、**不生成任何凭证**，因此销项发票作废时**不能**用本分录 ——
 * 那会把该发票从未入账的 6001 / 222101 / 1122 反向冲掉，等于凭空冲减
 * 「收入确认」已确认的收入（比原缺陷更严重）。
 *
 * 现状下进项（`inputVoidLines`）必须冲、销项不必冲，这个"不对称"是正确的：
 * 进项开票时入了账（借库存/进项税、贷应付），销项开票时没入账。
 * 两者在底稿层面的口径差异由增值税底稿显式披露（见
 * `vat-declaration.service.ts` 的 `uncertified_input_pending` /
 * `sales_not_invoiced` 差异项），而不是靠补一笔假凭证去"抹平"。
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
  /**
   * 处置收入（**不含税**净额）；报废/捐赠为 0。
   *
   * 与 `outputTax` 的分工必须严格区分（历史上这里出过一次错，见下方 gainLoss 推导注释）：
   *   · `disposalIncome` = 不含税净额（如价税合计 53,000、销项税 3,000 → 50,000）
   *   · `outputTax`      = 从价税合计中倒算出的销项税额
   * 银行实收 = `disposalIncome + outputTax`。
   */
  disposalIncome: number;
  /** 销项税额（由价税合计倒算）；无收入为 0 */
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
 *   gainLoss = 处置收入(不含税) − 净值 = disposalIncome − netBookValue
 *
 * ⚠️ `outputTax` **不进入** gainLoss：销项税是代收代缴的价外税，从买方收进来、
 * 全额交给税务局，既不是收益也不是费用。这一点曾经写错成
 * `disposalIncome − outputTax − netBookValue`，同时 1603 只按不含税入账，
 * 后果有两个且都不报错：
 *   ① 出售当期损益被凭空少计一个税额（本函数返回的 gainLoss 与账面 6301/6711 不符）；
 *   ② 分录**借贷不平** —— 借 1002(含税) vs 贷 1603(不含税) + 贷 222101(税) 少了
 *      「结转清理余额」那一笔的找平量，差额恰为 outputTax。
 * 正确写法是：1603 贷记不含税收入、gainLoss 不含税、银行借记价税合计，
 * 三笔一起自然平衡（单测 '出售有销项税' 用 debitTotal === creditTotal 钉死）。
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
  const gainLoss = round2(disposalIncome - netBookValue);

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
  //
  // 1603 固定资产清理 的贷方记**不含税处置收入**（`disposalIncome` 本身就按不含税传入，
  // 由调用方用 `splitTax(价税合计, 税率).net` 拆出）。银行按**价税合计**入账，
  // 销项税单列 222101。三者关系：
  //     借 1002 银行存款 = disposalIncome + outputTax
  //     贷 1603 清理     = disposalIncome
  //     贷 222101 销项税 = outputTax
  // 于是 1603 的贷方恰为不含税收入，与 ③ 结转的 gainLoss 一起把 1603 轧平为 0。
  //
  // 反例（曾经的真实写法）：把 `disposalIncome` 当成含税收入、在 1603 里再减一次
  // outputTax 贷记 —— 那样 1603 少贷一个税额，凭证**借贷不平**（差额 = outputTax），
  // 且 gainLoss 被少计一个税额。`posting-asset.spec.ts` 已用
  // `debitTotal(lines) === creditTotal(lines)` 钉死，不允许回归。
  if (disposalIncome > 0 || outputTax > 0) {
    lines.push({
      accountCode: ACCOUNT_BANK_PRIMARY,
      debit: round2(disposalIncome + outputTax),
    });
    if (disposalIncome !== 0) {
      lines.push({
        accountCode: ACCOUNT_FIXED_ASSET_DISPOSAL,
        credit: round2(disposalIncome),
      });
    }
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
