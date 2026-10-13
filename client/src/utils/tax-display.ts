import { splitTax } from '@shared/tax';
import { formatMoney } from '@client/src/utils/format';

/** 价税合计拆分结果（前端展示用）。 */
export interface TaxDisplay {
  gross: number;
  net: number;
  tax: number;
  rate: number;
}

/** 包装 `@shared/tax` 的 `splitTax`，附带 gross / rate 便于展示。 */
export function formatTaxSplit(gross: number, rate: number): TaxDisplay {
  const amount = Number(gross) || 0;
  const pct = Number(rate) || 0;
  const { net, tax } = splitTax(amount, pct);
  return { gross: amount, net, tax, rate: pct };
}

/** 单行文案：不含税 xxx / 税额 xxx */
export function formatTaxSplitLine(gross: number, rate: number): string {
  const { net, tax } = formatTaxSplit(gross, rate);
  return `不含税 ${formatMoney(net)} / 税额 ${formatMoney(tax)}`;
}
