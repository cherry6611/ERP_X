import { round2 } from './number';

/**
 * 全量增值税税率 / 征收率档位（百分数）。
 *
 * ## 为什么必须包含 5%
 *
 * 原档位是 `[0, 1, 3, 6, 9, 13]`，**缺 5% 征收率**。而 5% 是现行有效档位：
 *   · 一般纳税人**简易计税**：不动产经营租赁、销售自行开发的房地产老项目、
 *     劳务派遣差额计税等；
 *   · 小规模纳税人销售/出租不动产。
 *
 * 缺这一档的后果是**双向的**：
 *   ① 前端下拉里选不到 5%，使用者只能"就近选 6%" → 价税分离算错 → 少缴或多缴；
 *   ② 库层 `chk_invoice_tax_rate` / `chk_contract_tax_rate` 等 CHECK 也按本数组口径
 *      写死，于是**合法的 5% 专票根本登记不进来**（被约束拒绝）。
 *
 * ## 5% 归属哪一类纳税人
 *
 * 5% 对**两类主体都可能适用**（一般纳税人走简易计税、小规模走不动产征收率），
 * 因此 `ALLOWED_RATES` 两侧都要放开 —— 原实现"一般纳税人禁用简易计税"
 * （`ALLOWED_RATES.general` 不含 1/3/5）本身就是审计点名的缺陷：
 * 一般纳税人选择简易计税是法定权利，系统不该拦。
 *
 * ⚠️ 放开档位不改变任何计算逻辑：`splitTax` 只按传入税率做价税分离，
 * 与档位集合无关。放开的是"**能不能选/能不能存**"，不是"怎么算"。
 */
export const VAT_RATES = [0, 1, 3, 5, 6, 9, 13] as const;

/** B-08：税率档位字典的 fallback（正式来源为 sys_dict 的 tax_rate 类型） */
export const TAX_RATE_DICTIONARY = VAT_RATES;

export type VatRate = (typeof VAT_RATES)[number];

export type TaxpayerType = 'general' | 'small';

/**
 * 各类纳税人**依法可用**的档位。
 *
 * - `general`（一般纳税人）：0/3/5/6/9/13。
 *   5% 来自**简易计税**（不动产经营租赁、房地产老项目、劳务派遣差额计税等），
 *   是一般纳税人的法定选择权；3% 是简易计税的法定征收率（一般纳税人也可适用）。
 * - `small`（小规模纳税人）：0/1/3/5。
 *   1% 是阶段性优惠征收率，3% 是法定征收率，5% 适用于不动产相关业务。
 *
 * 注意 1% 仍然**不**对一般纳税人放开：它是小规模纳税人的阶段性优惠，
 * 一般纳税人简易计税用 3% 或 5%。
 */
export const ALLOWED_RATES: Record<TaxpayerType, readonly VatRate[]> = {
  general: [0, 3, 5, 6, 9, 13],
  small: [0, 1, 3, 5],
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
 *
 * 取整统一走 `round2`（十进制、对负数对称）：红冲时 `splitTax(-a)` 与
 * `splitTax(a)` 必须互为相反数，否则红冲凭证与原凭证合计不为 0、借贷差 1 分。
 */
export function splitTax(amount: number, rate: number): TaxSplit {
  const tax = round2((amount * rate) / (100 + rate));
  const net = round2(amount - tax);
  return { net, tax };
}

/** 含税行金额：round(数量 × 单价 × (1 - 折扣%/100), 2)。 */
export function lineAmount(
  quantity: number,
  unitPrice: number,
  discountPct: number
): number {
  return round2(quantity * unitPrice * (1 - discountPct / 100));
}
