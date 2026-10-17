/**
 * 增值税申报底稿的 **Excel 导出列定义**（§5.9 / F8 拆分）。
 *
 * ## 为什么从 `TaxDeclarationPage.tsx` 里搬出来
 *
 * 这份列定义是**报税底稿对外的交付形状**，而它的错误在界面上完全看不出来：
 * 导出照样成功、Excel 照样打开，只是数字落在错的列里。可能的错法：
 *   · 漏一列（例如「总账口径金额」没导出）→ 接收方以为没有这一列；
 *   · 列序错（申报表金额 / 总账口径金额互换）→ **比对结论整个反过来**；
 *   · `value` 取错字段（`ledgerAmount` 写成 `amount`）→ 差异列恒为 0，
 *     底稿的勾稽功能静默失效。
 * 这三类靠读代码很难发现（两个字段名只差几个字母），必须能**逐列断言**。
 *
 * ## 为什么本文件零运行时依赖
 *
 * 与同仓先例 `finance/ledgers/ledger-export-columns.ts` 同一策略：**不 import
 * `components/excel/excel-utils`**（那样会把导出运行时拉进依赖图），
 * 只声明结构一致的本地类型 `VatExportColumn`。于是本模块可被 jest 直接加载，
 * 无需 mock 任何导出环境。结构相同即赋值兼容，`excel-utils` 侧的类型由编译器核对。
 *
 * `import type` 是编译期擦除的（不产生运行时依赖），故契约类型可以安全使用。
 */
import type { VatDeclarationLine } from '@shared/api.interface';

/** 与 `ExcelSheetColumn` 结构一致，但独立声明以保持零依赖 */
export interface VatExportColumn<TRow> {
  header: string;
  value: (row: TRow) => string | number | null | undefined;
}

/**
 * 底稿行类别中文名。
 *
 * 导出的「类别」列与页面表格的「类别」列**共用这一份**，避免两处各写一份
 * （两处不一致时，导出的 Excel 与屏幕上的底稿会互相矛盾，而这是要交给税务的）。
 */
export const VAT_CATEGORY_LABELS: Record<VatDeclarationLine['category'], string> = {
  output: '销项',
  input: '进项',
  transfer: '进项税额转出',
  credit: '留抵',
  payable: '应纳税额',
};

/**
 * 增值税申报底稿导出列（原 `TaxDeclarationPage.tsx` 的 `VAT_LINE_COLUMNS`）。
 *
 * ⚠️ 这是**导出**列，与页面表格的列定义（`tax-declaration-columns.tsx`）是两件事：
 * 页面表格有排序/筛选/固定列（`render` 返回 React 节点），导出只能出标量值。
 * 两者字段大致重叠，但**不可互相替代** —— 曾经把它们当成同一个东西是本目录
 * 拆分的最大陷阱。
 */
export const VAT_LINE_EXPORT_COLUMNS: VatExportColumn<VatDeclarationLine>[] = [
  { header: '行次', value: (row) => row.rowNo },
  { header: '项目', value: (row) => row.rowName },
  { header: '类别', value: (row) => VAT_CATEGORY_LABELS[row.category] ?? row.category },
  { header: '申报表金额', value: (row) => row.amount },
  /*
   * ⚠️ `comparable === false` 的行（第 1 行「净销售额 vs 销项税额」、
   * 第 1-1 / 25 行无账簿对应）两列**不同量纲**。导出成数字会让拿到 Excel 的人
   * 误以为"申报数与账簿数相差这么多"，所以导出 `—`（与页面表格一致）。
   */
  { header: '总账口径金额', value: (row) => (row.comparable === false ? '—' : row.ledgerAmount) },
  { header: '差异', value: (row) => (row.comparable === false ? '—' : row.difference) },
  { header: '已说明', value: (row) => (row.explained ? '是' : '否') },
];
