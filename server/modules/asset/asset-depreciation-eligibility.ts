/**
 * 固定资产是否应在指定期间计提折旧。
 *
 * 准则：当月增加的固定资产当月不提折旧，下月起提。
 * 例：2026-03 购入 → 2026-03 不计提，2026-04 起计提。
 * 缺 purchase_date 的历史数据保持原行为（计提），避免上线后突然全部停提。
 */
export function isDepreciableInPeriod(
  purchaseDate: string | null | undefined,
  period: string,
): boolean {
  if (!purchaseDate) return true;
  return period > purchaseDate.slice(0, 7);
}
