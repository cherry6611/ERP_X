/** 价税合计口径。税率是百分数，0 表示免税。 */
export const VAT_RATES = [0, 1, 3, 6, 9, 13] as const;

/** B-08：税率档位字典的 fallback（正式来源为 sys_dict 的 tax_rate 类型） */
export const TAX_RATE_DICTIONARY = VAT_RATES;

export type VatRate = (typeof VAT_RATES)[number];

export type TaxpayerType = 'general' | 'small';

export const ALLOWED_RATES: Record<TaxpayerType, readonly VatRate[]> = {
  general: [0, 6, 9, 13],
  small: [0, 1, 3],
};

export const FALLBACK_RATE: VatRate = 6;

export const TAX_ENTITY_REQUIRED_MESSAGE = '请先在纳税主体管理中创建主体';

export interface TaxSplit {
  net: number;
  tax: number;
}

export function isVatRate(value: number): value is VatRate {
  return (VAT_RATES as readonly number[]).includes(value);
}

export function rateAllowed(type: TaxpayerType, rate: number): boolean {
  return (ALLOWED_RATES[type] as readonly number[]).includes(rate);
}

/**
 * 价税合计拆分。
 * tax = round(amount * rate / (100 + rate), 2)，net = amount - tax。
 */
export function splitTax(amount: number, rate: number): TaxSplit {
  const tax = Math.round(((amount * rate) / (100 + rate)) * 100) / 100;
  const net = Math.round((amount - tax) * 100) / 100;
  return { net, tax };
}

/** 含税行金额：round(数量 × 单价 × (1 - 折扣%/100), 2)。 */
export function lineAmount(
  quantity: number,
  unitPrice: number,
  discountPct: number
): number {
  return (
    Math.round(quantity * unitPrice * (1 - discountPct / 100) * 100) / 100
  );
}
