/**
 * 账簿页的共享格式化与聚合 helper（§5.9 / F8）。
 *
 * ## 为什么单独成模块
 *
 * 这些函数原先是 `LedgersPage.tsx` 的模块级函数，被四个 Tab 共用。
 * 抽出 Tab 组件后它们必须有个共同的家 —— 复制四份会让"小计规则只改了一个 Tab"，
 * 而小计口径不一致是账表对不上的直接原因。
 *
 * ## 为什么从 `./ledger-export-columns` 取 `DIRECTION_LABELS`
 *
 * 方向中文名必须唯一：导出用一份、页面用另一份，就会出现
 * "Excel 里是「借」而界面是「Debit」"这类分叉。该模块已经是它的定义处。
 *
 * ## ⚠️ 本文件内容是**逐字搬运**
 *
 * 不是重新实现 —— 例如 `buildLeafSubtotals` 只在小计行的子科目
 * **多于 1 个**时才登记（`leafChildren.length > 1`），少于两个不显示小计行。
 * 这类阈值是业务判断，重写时极易丢掉。搬运由脚本从原文件切片完成。
 */
import { formatMoney } from '@client/src/utils/format';
import type { AccountBalanceRow } from '@shared/api.interface';
import { DIRECTION_LABELS } from './ledger-export-columns';

export const PAGE_SIZE = 50;

/** 借贷余额按方向拼前缀，避免金额正负号在账簿里产生歧义 */
export function sideAmount(value: number, side: string): string {
  if (!value) return '-';
  return `${DIRECTION_LABELS[side] ?? ''} ${formatMoney(Math.abs(value))}`.trim();
}

export function amount(value: number | null | undefined): string {
  return value ? formatMoney(value) : '-';
}

/** 科目余额表小计：按编码前缀分组，仅当父行存在且子行不全为叶子时才有意义 */
export function buildLeafSubtotals(items: AccountBalanceRow[]): Map<string, AccountBalanceRow[]> {
  const subtotals = new Map<string, AccountBalanceRow[]>();
  for (const parent of items) {
    if (parent.isLeaf) continue;
    const children = items.filter(
      (row) => row.accountCode !== parent.accountCode && row.accountCode.startsWith(parent.accountCode),
    );
    const leafChildren = children.filter((row) => row.isLeaf);
    if (leafChildren.length > 1) subtotals.set(parent.accountCode, leafChildren);
  }
  return subtotals;
}

export function sumRows(rows: AccountBalanceRow[]): {
  openingDebit: number;
  openingCredit: number;
  debitOccur: number;
  creditOccur: number;
  closingDebit: number;
  closingCredit: number;
} {
  return rows.reduce(
    (acc, row) => ({
      openingDebit: acc.openingDebit + row.openingDebit,
      openingCredit: acc.openingCredit + row.openingCredit,
      debitOccur: acc.debitOccur + row.debitOccur,
      creditOccur: acc.creditOccur + row.creditOccur,
      closingDebit: acc.closingDebit + row.closingDebit,
      closingCredit: acc.closingCredit + row.closingCredit,
    }),
    {
      openingDebit: 0,
      openingCredit: 0,
      debitOccur: 0,
      creditOccur: 0,
      closingDebit: 0,
      closingCredit: 0,
    },
  );
}
