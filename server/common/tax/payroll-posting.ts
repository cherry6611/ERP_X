import type { PostingLine } from './posting';
import { round2 } from '@server/common/utils/number';
import {
  ACCOUNT_PAYROLL_PAYABLE_HOUSING_FUND,
  ACCOUNT_PAYROLL_PAYABLE_OTHER_DEDUCTION,
  ACCOUNT_PAYROLL_PAYABLE_SALARY,
  ACCOUNT_PAYROLL_PAYABLE_SOCIAL_INSURANCE,
  ACCOUNT_TAX_PAYABLE_INDIVIDUAL_INCOME_TAX,
} from './account-codes';

/**
 * N-1：工资**按应发计提**的分录模板（唯一实现）。
 *
 * 原先 `posting.ts` 里的 `payrollAccrualLines(净额)` 是死代码，实际调用方
 * `hr-pay.service.ts` 自己写了「借 成本 / 贷 2211 净额」两行 —— 两处口径不一致，
 * 而且**两处都是错的**：
 *   1. 成本费用按净额入账 → 少计应发工资（费用少、负债少）；
 *   2. 代扣个税从未形成 2221 负债 → 实际缴税时账上无处可冲。
 *
 * ## 分录结构（借=贷 必然成立）
 *
 * ```
 * 借 成本/费用（应发）            gross
 * 贷 2211-工资（应发）            gross
 * 借 2211-工资（代扣合计）        withheld
 *   贷 222112 应交个人所得税      tax
 *   贷 221102 社会保险费          socialInsurance
 *   贷 221103 住房公积金          housingFund
 *   贷 221104 其他代扣            otherDeduction
 * ```
 *
 * 于是 `2211-工资` 的净余额 = `gross - withheld` = **实发**，与银行发放金额逐笔对得上。
 *
 * ## 为什么调用方要传「代扣合计」的**差额**而不是自己相加
 *
 * 引擎口径下还存在"其他扣除"（企业年金等，见 payroll-engine 的 P2-9），
 * 它并未单独落库。调用方用 `gross - netSalary` 求代扣合计，可保证无论引擎内部
 * 怎么拆，2211-工资 都恰好落在实发上，且借贷必然相等 —— 不依赖对引擎细节的猜测。
 */
export interface PayrollAccrualInput {
  /** 应发工资（代扣前；基本 + 绩效 + 津贴） */
  gross: number;
  /** 借方归集科目（按场景配置；未配置时调用方传 6401） */
  expenseAccountCode: string;
  /** 代扣个人所得税 */
  individualIncomeTax?: number;
  /** 代扣个人社会保险费 */
  socialInsurance?: number;
  /** 代扣个人住房公积金 */
  housingFund?: number;
  /** 其他代扣（企业年金等） */
  otherDeduction?: number;
}

export function payrollAccrualLines(input: PayrollAccrualInput): PostingLine[] {
  const gross = input.gross;
  if (!(gross > 0)) return [];

  const tax = Math.max(0, input.individualIncomeTax ?? 0);
  const socialInsurance = Math.max(0, input.socialInsurance ?? 0);
  const housingFund = Math.max(0, input.housingFund ?? 0);
  const otherDeduction = Math.max(0, input.otherDeduction ?? 0);
  const withheld = round2(
    tax + socialInsurance + housingFund + otherDeduction
  );

  const lines: PostingLine[] = [
    { accountCode: input.expenseAccountCode, debit: gross },
    { accountCode: ACCOUNT_PAYROLL_PAYABLE_SALARY, credit: gross },
  ];

  // 无代扣时只出两行：2211-工资 余额 = 应发 = 实发
  if (!(withheld > 0)) return lines;

  lines.push({ accountCode: ACCOUNT_PAYROLL_PAYABLE_SALARY, debit: withheld });
  if (tax > 0) {
    lines.push({ accountCode: ACCOUNT_TAX_PAYABLE_INDIVIDUAL_INCOME_TAX, credit: tax });
  }
  if (socialInsurance > 0) {
    lines.push({
      accountCode: ACCOUNT_PAYROLL_PAYABLE_SOCIAL_INSURANCE,
      credit: socialInsurance,
    });
  }
  if (housingFund > 0) {
    lines.push({
      accountCode: ACCOUNT_PAYROLL_PAYABLE_HOUSING_FUND,
      credit: housingFund,
    });
  }
  if (otherDeduction > 0) {
    lines.push({
      accountCode: ACCOUNT_PAYROLL_PAYABLE_OTHER_DEDUCTION,
      credit: otherDeduction,
    });
  }
  return lines;
}
