/**
 * 合同**税额重算**时「上一次的税率还算不算用户选定的」这一条判据。
 *
 * ## 为什么必须独立成模块
 *
 * `updateContract` 的重算块原本是这样取"旧税率"的：
 *
 * ```
 * const existingRate = existing[0].taxRate != null ? Number(existing[0].taxRate) : null;
 * const resolved = await this.taxResolver.resolve({ explicit: dto.taxRate ?? existingRate, … });
 * ```
 *
 * 单看没问题 —— 直到把 `customerId` 的解析规则接上（`effectiveCustomerId = dto.customerId ?? 旧值`）。
 * 两条合起来就出现一个**只能靠查库发现**的缺陷：
 *
 * | 步骤 | `tax_rate` | `rate_source` | 结果 |
 * |---|---|---|---|
 * | 建合同（客户默认 6%，表单没显式选） | 6 | `counterparty` | 正确 |
 * | 改客户到默认 13% 的客户 | 13 | `counterparty` | 正确（按新客户解析） |
 * | 再改客户回默认 6% 的客户 | **13** | **`explicit`** | ❌ 6% 被忽略，且来源被"洗"成显式 |
 *
 * 第三行就是缺陷：`erp_contract.rate_source` **本来就是**用来区分「用户选的」与
 * 「系统推导的」，而重算块完全没读它 —— 于是"从客户推导出来的 13%"在下一次 PATCH 里
 * 被当成"用户显式选定 13%"，之后**永远不再跟随客户**，界面上只显示一个看起来正常的税率。
 *
 * ## 判据
 *
 * 只有 `explicit` / `upstream` / `NULL`（历史行）三种来源的税率才算"权威值"，
 * 继续按 `explicit` 传给解析器；`counterparty` / `entity` / `fallback` 是**推导值**，
 * 一律传 `null` 让解析器按（可能已变的）客户/主体重新推导。
 *
 * `NULL` 归入"权威值"是有意的**保守选择**：`rate_source` 是后加的列，
 * 早期的合同行为 NULL 且税率是人工填的；把它们当推导值会导致
 * "只改个金额就把历史合同的税率也改了"。
 *
 * ⚠️ 本文件**不写**完整的抛错语句形态（哪怕是注释里）——
 * `scripts/audit-error-messages.mjs` 用正则扫未剥离注释的原文。
 */

/** 由系统按客户/纳税主体**推导**出来的税率来源（这些值必须可被重新推导） */
export const DERIVED_RATE_SOURCES: ReadonlyArray<string> = [
  'counterparty',
  'entity',
  'fallback',
];

/**
 * 本次重算应当作为 `explicit` 传给 `TaxResolverService.resolve` 的旧税率。
 *
 * @param storedRate   库中 `erp_contract.tax_rate`
 * @param storedSource 库中 `erp_contract.rate_source`
 * @returns 旧税率（数字）或 `null`（表示"让解析器重新推导"）
 */
export function explicitRateForRecalc(
  storedRate: number | string | null | undefined,
  storedSource: string | null | undefined
): number | null {
  if (storedRate === null || storedRate === undefined) return null;
  const rate = Number(storedRate);
  if (!Number.isFinite(rate)) return null;
  if (storedSource != null && DERIVED_RATE_SOURCES.includes(storedSource)) {
    return null;
  }
  return rate;
}

/**
 * 重算后 `rate_source` 是否与传入的 `explicit` 一致（供调用方与规格共同断言）。
 *
 * 存在的意义：`rateSource` 与 `taxRate` **必须同源** —— 只要它们可能来自
 * 两个不同的判断，就会出现"税率是客户推导的、来源却写着 explicit"这种
 * 自相矛盾的行，而它正是上面那条缺陷的**唯一表征**。
 */
export function rateSourceMatchesExplicit(
  explicit: number | null | undefined,
  resolvedSource: string
): boolean {
  const hasExplicit = explicit != null && Number.isFinite(Number(explicit));
  return hasExplicit ? resolvedSource === 'explicit' : resolvedSource !== 'explicit';
}
