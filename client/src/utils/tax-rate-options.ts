import {
  ALLOWED_RATES,
  VAT_RATES,
  type TaxpayerType,
  type VatRate,
} from '@shared/tax';
import type { TaxEntity } from '@shared/api.interface';

/** 按纳税主体类型过滤可选税率；无主体时给全字典。 */
export function resolveRateOptions(
  entity: TaxEntity | null | undefined
): readonly VatRate[] {
  if (!entity) return VAT_RATES;
  return ALLOWED_RATES[entity.taxpayerType as TaxpayerType] ?? VAT_RATES;
}

/** 当前税率越界时重置为该类型白名单最后一个。 */
export function coerceTaxRate(
  rate: number,
  entity: TaxEntity | null | undefined
): number {
  const options = resolveRateOptions(entity);
  if ((options as readonly number[]).includes(rate)) return rate;
  return options[options.length - 1] ?? 6;
}

/**
 * 解析「当前生效的纳税主体」，优先级必须与后端 TaxResolverService.resolveEntity 一致：
 *   显式 taxEntityId → 客户/供应商绑定的 taxEntityId → 默认主体 → 第一个主体
 *
 * 后端 `tax-resolver.service.ts` 在税率与主体纳税人类型不匹配时会直接抛 400，
 * 前端若只看「显式选择 + 默认主体」，就会出现「下拉里能选 6%，保存却被拒」的情况。
 */
export function resolveTaxEntity(params: {
  taxEntityId?: string | null;
  customerId?: string | null;
  supplierId?: string | null;
  taxEntities: readonly TaxEntity[];
  customerTaxEntityId?: string | null;
  supplierTaxEntityId?: string | null;
}): TaxEntity | null {
  const list = params.taxEntities ?? [];
  const byId = (id?: string | null): TaxEntity | undefined =>
    id ? list.find((row) => row.id === id) : undefined;

  return (
    byId(params.taxEntityId) ??
    byId(params.customerTaxEntityId ?? params.supplierTaxEntityId) ??
    list.find((row) => row.isDefault) ??
    list[0] ??
    null
  );
}
