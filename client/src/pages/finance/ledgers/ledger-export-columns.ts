/**
 * 账簿页的 **Excel 导出列定义**（§5.9 / F8 拆分）。
 *
 * ## 为什么列定义单独成文件（而不是留在 `ledger-exports.ts` 里）
 *
 * 本文件**零运行时依赖** —— 不 import `excel-utils`、不 import `exceljs`、
 * 不碰 DOM。于是它可以被单测直接加载，而不用 mock 掉整个导出运行时。
 *
 * 这一点是有实际价值的：列定义恰恰是"看着没问题、错了很难发现"的地方 ——
 * 漏一列、列序错、把「期末贷方」配到「期末借方」的值。
 * 这类错误在界面上完全看不出来（导出照样成功，只是数字错位），
 * 只有逐列断言才能拦住。
 *
 * `Value` 的取值函数签名与 `ExcelSheetColumn.value` 一致，
 * 但**不 import 那个类型** —— 那样会把 `excel-utils` 拉进本模块的依赖图，
 * 失去"零依赖可单测"这个性质。结构相同即可赋值兼容。
 */

/** 与 `ExcelSheetColumn` 结构一致，但独立声明以保持零依赖 */
export interface LedgerExportColumn<TRow> {
  header: string;
  value: (row: TRow) => string | number | null | undefined;
}

/** 借贷方向中文名；页面表格与导出共用同一份，避免两处各写一份 */
export const DIRECTION_LABELS: Record<string, string> = {
  debit: '借',
  credit: '贷',
};

/** 凭证日期只取日期段（后端给的是完整时间戳） */
export function voucherDate(value: string | null): string {
  if (!value) return '-';
  return value.slice(0, 10);
}

/* 行类型用**结构**而非 import 契约类型 —— 同样是为零依赖。
 * 契约类型来自 `@shared/api.interface`（纯类型，编译期擦除），
 * import type 不会产生运行时依赖，因此这里可以安全使用。 */
import type {
  AccountBalanceRow,
  AuxBalanceRow,
  DetailLedgerLine,
  GeneralLedgerRow,
} from '@shared/api.interface';

export function balanceExportColumns(
  period: string,
): LedgerExportColumn<AccountBalanceRow>[] {
  return [
    { header: '期间', value: () => period },
    { header: '科目编码', value: (row) => row.accountCode },
    { header: '科目名称', value: (row) => row.accountName },
    { header: '级次', value: (row) => row.level },
    {
      header: '方向',
      value: (row) => DIRECTION_LABELS[row.direction] ?? row.direction,
    },
    { header: '期初借方', value: (row) => row.openingDebit },
    { header: '期初贷方', value: (row) => row.openingCredit },
    { header: '本期发生借方', value: (row) => row.debitOccur },
    { header: '本期发生贷方', value: (row) => row.creditOccur },
    { header: '期末借方', value: (row) => row.closingDebit },
    { header: '期末贷方', value: (row) => row.closingCredit },
  ];
}

export function generalExportColumns(
  period: string,
): LedgerExportColumn<GeneralLedgerRow>[] {
  return [
    { header: '期间', value: () => period },
    { header: '科目编码', value: (row) => row.accountCode },
    { header: '科目名称', value: (row) => row.accountName },
    {
      header: '方向',
      value: (row) => DIRECTION_LABELS[row.direction] ?? row.direction,
    },
    { header: '期初借方', value: (row) => row.openingDebit },
    { header: '期初贷方', value: (row) => row.openingCredit },
    { header: '本期发生借方', value: (row) => row.debitOccur },
    { header: '本期发生贷方', value: (row) => row.creditOccur },
    { header: '期末借方', value: (row) => row.closingDebit },
    { header: '期末贷方', value: (row) => row.closingCredit },
    { header: '下级科目数', value: (row) => row.childCount },
  ];
}

/**
 * 明细账列定义。
 *
 * `accountLabel` 显式传入而不是从行里取：明细账的行可能只有对方科目信息，
 * 科目名来自**查询结果的外层**（`detail.data.accountCode/accountName`），
 * 从行里取会得到空字符串。
 */
export function detailExportColumns(
  period: string,
  accountLabel: string,
): LedgerExportColumn<DetailLedgerLine>[] {
  return [
    { header: '期间', value: () => period },
    { header: '科目', value: () => accountLabel },
    { header: '日期', value: (row) => voucherDate(row.voucherDate) },
    { header: '凭证号', value: (row) => row.voucherCode },
    { header: '摘要', value: (row) => row.summary ?? '' },
    { header: '对方科目', value: (row) => row.counterpartAccounts.join('、') },
    { header: '借方', value: (row) => row.debit },
    { header: '贷方', value: (row) => row.credit },
    { header: '余额', value: (row) => row.balance },
    {
      header: '方向',
      value: (row) => DIRECTION_LABELS[row.balanceSide] ?? row.balanceSide,
    },
    {
      header: '辅助核算',
      value: (row) =>
        row.aux
          .map((item) => `${item.dimensionCode}:${item.dimensionValue ?? '-'}`)
          .join('；'),
    },
  ];
}

export function auxExportColumns(
  period: string,
  dimensionName: string,
): LedgerExportColumn<AuxBalanceRow>[] {
  return [
    { header: '期间', value: () => period },
    { header: '维度', value: () => dimensionName },
    { header: '维度值', value: (row) => row.dimensionValue ?? '' },
    { header: '科目编码', value: (row) => row.accountCode },
    { header: '科目名称', value: (row) => row.accountName },
    { header: '期初借方', value: (row) => row.openingDebit },
    { header: '期初贷方', value: (row) => row.openingCredit },
    { header: '本期发生借方', value: (row) => row.debitOccur },
    { header: '本期发生贷方', value: (row) => row.creditOccur },
    { header: '期末借方', value: (row) => row.closingDebit },
    { header: '期末贷方', value: (row) => row.closingCredit },
  ];
}
