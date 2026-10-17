/**
 * 账簿页的 Excel 导出（§5.9 / F8 拆分）。
 *
 * ## 为什么从 `LedgersPage.tsx` 里搬出来
 *
 * 四个导出函数原本内联在页面组件里，合计约 130 行，**且与组件状态零耦合**：
 * 只依赖「期间 / 科目 / 维度」三个标量 + 各自的当前行数据，全部可参数化。
 * 放在组件里有两个具体代价：
 *   ① 页面骨架被淹没 —— 打开 `LedgersPage.tsx` 先看到 130 行列定义；
 *   ② **无法被单测覆盖**（组件内的闭包要渲染整页才能触达），
 *      而列定义恰是"容易写错且影响面大"的地方：漏一列、列序错、
 *      把「期末贷方」配到「期末借方」的值 —— 导出照样成功，只是数字错位。
 *
 * 列定义进一步拆到 `./ledger-export-columns`（零运行时依赖），
 * 使它可以被 jest 直接加载而不必 mock 整个导出运行时。
 *
 * ## 空数据为什么返回 `false` 而不是抛错
 *
 * 调用方（页面按钮）要区分"导出了"与"没数据可导"以便提示使用者。
 * 返回布尔比抛异常更贴合语义 —— 空数据不是错误，只是没什么可做。
 * toast 文案留在调用方：文案属于 UI 层，导出模块不该依赖 `sonner`。
 */
import {
  exportRowsToXlsx,
  type ExcelSheetColumn,
} from '@client/src/components/excel/excel-utils';
import type {
  AccountBalanceRow,
  AuxBalanceRow,
  DetailLedgerLine,
  GeneralLedgerRow,
} from '@shared/api.interface';
import {
  auxExportColumns,
  balanceExportColumns,
  detailExportColumns,
  generalExportColumns,
} from './ledger-export-columns';

// 供页面直接引用的共享 helper（页面表格与导出共用同一份）
export { DIRECTION_LABELS, voucherDate } from './ledger-export-columns';

/**
 * 把零依赖模块产出的列定义转成 `excel-utils` 期望的类型。
 *
 * 两者**结构完全一致**，因此这个转换在类型层面是恒等的；
 * 之所以还需要它，是因为 `ledger-export-columns` 有意不 import
 * `ExcelSheetColumn`（那样会把 `excel-utils` 拉进它的依赖图，
 * 失去"零依赖可单测"这个性质）。这里做一次显式窄化，
 * 让"结构相同"这件事由编译器验证，而不是靠人记。
 */
function asSheetColumns<TRow>(
  columns: Array<{
    header: string;
    value: (row: TRow) => string | number | null | undefined;
  }>,
): ExcelSheetColumn<TRow>[] {
  return columns;
}

/** 科目余额表 */
export function exportBalance(
  period: string,
  rows: AccountBalanceRow[],
): boolean {
  if (rows.length === 0) return false;
  exportRowsToXlsx(
    `科目余额表_${period}.xlsx`,
    '科目余额表',
    asSheetColumns(balanceExportColumns(period)),
    rows,
  );
  return true;
}

/** 总账（按一级科目汇总） */
export function exportGeneral(
  period: string,
  rows: GeneralLedgerRow[],
): boolean {
  if (rows.length === 0) return false;
  exportRowsToXlsx(
    `总账_${period}.xlsx`,
    '总账',
    asSheetColumns(generalExportColumns(period)),
    rows,
  );
  return true;
}

/** 明细账（**仅当前页**，与界面分页一致） */
export function exportDetail(
  period: string,
  accountCode: string,
  accountLabel: string,
  rows: DetailLedgerLine[],
): boolean {
  if (rows.length === 0) return false;
  exportRowsToXlsx(
    `明细账_${accountCode}_${period}.xlsx`,
    '明细账',
    asSheetColumns(detailExportColumns(period, accountLabel)),
    rows,
  );
  return true;
}

/** 辅助余额表 */
export function exportAux(
  period: string,
  dimension: string,
  dimensionName: string,
  rows: AuxBalanceRow[],
): boolean {
  if (rows.length === 0) return false;
  exportRowsToXlsx(
    `辅助余额表_${dimension}_${period}.xlsx`,
    '辅助余额表',
    asSheetColumns(auxExportColumns(period, dimensionName)),
    rows,
  );
  return true;
}
