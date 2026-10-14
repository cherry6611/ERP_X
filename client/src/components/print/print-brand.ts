import type { BrandConfig, PrintHeader } from '@shared/api.interface';

/** 与 A-12 报表打印包（reports.service.ts `printHeader`）保持同一套降级规则 */
export const PRINT_BRAND_FALLBACK = '晟笙 ERP';

/**
 * 品牌抬头：数据源必须是 settings 接口（`GET /api/settings/brand`），不得硬编码。
 *
 * @param brand `getBrand()` 的结果；未加载完成时传 null，此时只降级品牌名
 */
export function buildPrintHeader(
  brand: BrandConfig | null,
  title: string,
  subtitle: string | null,
): PrintHeader {
  return {
    brandName: brand?.brandName?.trim() || PRINT_BRAND_FALLBACK,
    logoUrl: brand?.logoUrl ?? null,
    title,
    subtitle,
  };
}
