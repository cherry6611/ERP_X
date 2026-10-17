import type { PostingLine } from './posting';
import type { VatSurchargeComputed } from './vat-surcharge';
import {
  ACCOUNT_TAX_PAYABLE_EDUCATION,
  ACCOUNT_TAX_PAYABLE_LOCAL_EDUCATION,
  ACCOUNT_TAX_PAYABLE_URBAN_MAINT,
  ACCOUNT_TAX_SURCHARGE_EDUCATION,
  ACCOUNT_TAX_SURCHARGE_LOCAL_EDUCATION,
  ACCOUNT_TAX_SURCHARGE_URBAN_MAINT,
} from './account-codes';

/**
 * 附加税费计提分录模板（与 `vat-surcharge.ts` 的计算口径同源，故并列放同一个目录）。
 *
 * 为什么不在 `posting.ts`：那里是"单据 → 分录"的通用模板集合；本模板只在
 * 增值税申报底稿确认时被调用一次，且必须与 `computeVatSurcharge` 的三个分项
 * **逐项对应**，放在一起才能保证"改口径时两边一起改"。
 *
 * ## 为什么借方按税种分三行
 *
 * `vat-surcharge.ts` 的取整策略是"逐税种取整、合计由分项相加得出"。若凭证上只写
 * 一行合计，就失去了与底稿三个分项逐一对账的能力；而若把合计与分项混用，
 * 在基数带小数时会借贷不平。因此**只会**按分项各出两行（借/贷各一）。
 *
 * 金额为 0 的税种不出行：留抵月份（合法 0）不会产生任何分录。
 */
export function vatSurchargeAccrualLines(
  result: VatSurchargeComputed
): PostingLine[] {
  if (result.total <= 0) return [];

  const items = [
    {
      amount: result.urbanMaint,
      debit: ACCOUNT_TAX_SURCHARGE_URBAN_MAINT,
      credit: ACCOUNT_TAX_PAYABLE_URBAN_MAINT,
    },
    {
      amount: result.education,
      debit: ACCOUNT_TAX_SURCHARGE_EDUCATION,
      credit: ACCOUNT_TAX_PAYABLE_EDUCATION,
    },
    {
      amount: result.localEducation,
      debit: ACCOUNT_TAX_SURCHARGE_LOCAL_EDUCATION,
      credit: ACCOUNT_TAX_PAYABLE_LOCAL_EDUCATION,
    },
  ];

  const lines: PostingLine[] = [];
  for (const item of items) {
    if (!(item.amount > 0)) continue;
    lines.push({ accountCode: item.debit, debit: item.amount });
    lines.push({ accountCode: item.credit, credit: item.amount });
  }
  return lines;
}
