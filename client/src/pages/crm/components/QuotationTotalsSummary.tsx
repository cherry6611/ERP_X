/**
 * 报价单合计 / 毛利率条（§5.9 / F8，从 `QuotationFormDialog.tsx` 拆出）。
 *
 * 金额本身由父组件的 `computeQuotationTotals` 计算（纯函数，见 `./quotation-form.ts`
 * 及其单测 `quotation-form.spec.ts`）；本组件只负责把三个数按原样渲染，
 * 因此 props 名与块内标识符同名（`totals` / `belowMarginLine`），JSX **一行未改**。
 *
 * 毛利红线判定 `MARGIN_RED_LINE`（20%）与 `isBelowMarginLine` 也移入纯逻辑模块，
 * 便于对「恰好等于 20% 不算越线」这条边界做断言。
 */
import React from 'react';
import { formatMoney, formatPercent } from '@client/src/utils/format';
import type { QuotationTotals } from './quotation-form';

interface QuotationTotalsSummaryProps {
  /** 父组件 `computeQuotationTotals` 的结果 */
  totals: QuotationTotals;
  /** 毛利率是否低于红线（父组件用 `isBelowMarginLine` 判定） */
  belowMarginLine: boolean;
}

const QuotationTotalsSummary: React.FC<QuotationTotalsSummaryProps> = ({
  totals,
  belowMarginLine,
}) => {
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-1 border-t pt-3 text-sm">
      <span>
        报价总额：
        <span className="font-semibold">{formatMoney(totals.total)}</span>
      </span>
      <span>
        预估成本：
        <span className="font-semibold">{formatMoney(totals.cost)}</span>
      </span>
      <span className={belowMarginLine ? 'text-destructive' : ''}>
        毛利率：
        <span className="font-semibold">
          {totals.marginPct === null ? '-' : formatPercent(totals.marginPct)}
        </span>
        {belowMarginLine ? '（低于毛利红线）' : ''}
      </span>
    </div>
  );
};

export default QuotationTotalsSummary;
