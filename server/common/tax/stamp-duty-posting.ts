import type { PostingLine } from './posting';
import type { StampDutyResult } from './stamp-duty';
import {
  ACCOUNT_TAX_PAYABLE_STAMP_DUTY,
  ACCOUNT_TAX_SURCHARGE_STAMP_DUTY,
} from './account-codes';

/**
 * 印花税计提分录模板。
 *
 * 借 640304 税金及附加-印花税 / 贷 222113 应交税费-印花税
 *
 * ## 为什么计入「税金及附加」而不是管理费用
 *
 * 财会〔2016〕22 号《增值税会计处理规定》把印花税、房产税、城镇土地使用税、
 * 车船税**从管理费用调整到「税金及附加」**（原「营业税金及附加」）。
 * 本仓 `6403` 科目家族已经在位（640301/640302/640303），
 * 印花税作为同族第四个末级科目，编码 640304。
 *
 * ⚠️ 这个科目归属**影响利润表结构**（税金及附加 vs 管理费用分列两行），
 * 属于口径选择。若公司会计政策仍按管理费用归集，改这里的
 * `ACCOUNT_TAX_SURCHARGE_STAMP_DUTY` 为 `ACCOUNT_ADMIN_EXPENSE` 即可，
 * 计算逻辑不受影响 —— 这也是"计算与分录分离"的好处。
 *
 * ## 金额为 0 不出行
 *
 * 不足 1 角（法定不计）、或 0 元合同，都不产生分录。
 * 出 0 元分录会让凭证行数虚增，且与"该税种本期无应纳税额"的事实不符。
 */
export function stampDutyAccrualLines(
  result: StampDutyResult
): PostingLine[] {
  if (!(result.tax > 0)) return [];
  return [
    { accountCode: ACCOUNT_TAX_SURCHARGE_STAMP_DUTY, debit: result.tax },
    { accountCode: ACCOUNT_TAX_PAYABLE_STAMP_DUTY, credit: result.tax },
  ];
}
