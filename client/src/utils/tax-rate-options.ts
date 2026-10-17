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

/**
 * 当前税率越界时返回 `null`，**不再静默改值**。
 *
 * ## §4.7 (h)：静默替换会改写已存数据
 *
 * 审计点名本函数"把越界税率静默改成 13%/3%"。后果不是"显示不对"，而是
 * **静默改写已存数据**：一张 5% 的进项票（在库 CHECK 放开 5% 之前登记的）
 * 在编辑弹窗里被打开时，下拉会自动跳到 13%，使用者在没注意的情况下点保存
 * → **票面税率被改掉**，价税分离随之变化，进项税额凭空多出 8 个点。
 *
 * 改法：越界时**不猜**，返回 `null` 由调用方处置：
 *   · 新建场景（没有既有值）→ 调用方用 `defaultTaxRate()` 取合法默认值；
 *   · 编辑场景（库里已有白名单外的值）→ 调用方必须**显式提示用户**
 *     "当前税率 X% 不在该主体可用档位内，请重新选择"，而不是替他改。
 *
 * 用 `null` 而不是抛异常：这是纯表单工具，抛异常会让整页崩掉，
 * 而触发条件（历史数据档位不匹配）是**可恢复的配置问题**。
 */
export function coerceTaxRate(
  rate: number | null | undefined,
  entity: TaxEntity | null | undefined
): number | null {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    return null;
  }
  const options = resolveRateOptions(entity);
  if ((options as readonly number[]).includes(rate)) return rate;
  return null;
}

/**
 * 取一个**合法的默认**税率 —— 仅用于"新建"场景。
 *
 * 与 `coerceTaxRate` 的分工必须清楚：
 *   · 新建 → 没有既有值，取默认天经地义，用本函数；
 *   · 编辑 → 有既有值，越界必须让使用者看见，用 `coerceTaxRate` + 提示。
 * 把这两者混用，正是"静默改写已存数据"的来源。
 */
export function defaultTaxRate(
  entity: TaxEntity | null | undefined
): number {
  const options = resolveRateOptions(entity);
  return options[options.length - 1] ?? 6;
}

/**
 * 表单回填/主体切换时的税率取值 —— **不静默改写既有值**。
 *
 * ## 三种情形分开处置（这是本函数的全部价值）
 *
 * | 情形 | 取值 | 理由 |
 * |---|---|---|
 * | 没有既有值（新建） | 合法默认值 | 没有可保护的数据，取默认天经地义 |
 * | 既有值合法 | 原值 | 不做任何改动 |
 * | 既有值**越界** | **保留原值** | 交给 Zod / 服务端校验显式报错，让使用者看见 |
 *
 * 第三档是关键：静默改成 13% 会让"5% 的进项票"在保存后变成 13%，
 * 票面税额凭空多出 8 个点，而使用者完全没有察觉的机会。
 * 保留原值 + 校验报错，使用者会看到"税率不在允许范围内"并主动改。
 *
 * 主体切换（第二个参数变化）时同理：宁可让表单显示一个"当前主体不可用"的
 * 税率并报错，也不要替使用者猜一个新税率 —— 那等于在无声中改了合同金额构成。
 */
export function resolveFormTaxRate(
  current: number | null | undefined,
  entity: TaxEntity | null | undefined
): number {
  if (current === null || current === undefined || !Number.isFinite(current)) {
    return defaultTaxRate(entity);
  }
  const options = resolveRateOptions(entity);
  if ((options as readonly number[]).includes(current)) return current;
  // 越界：保留原值，交给校验层显式报错（见文件上方说明）
  return current;
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
