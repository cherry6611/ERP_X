/**
 * §5.9 拆分：合同列表的 Excel 导出列定义从 `ContractsPage` 抽出。
 *
 * ## 为什么列定义必须单独成文件
 *
 * `AGENTS.md` §5.9 把它列为**收益最高的拆分项之一**：列定义常有上百行，而
 * "漏一列 / 列序错 / `value` 取错字段"在界面上**完全看不出来** ——
 * 导出照样成功，只是数字错位或列缺失。只有单独成文件才可能逐列断言。
 *
 * 另外两个刻意的选择（改的人容易误改）：
 *   · 计费模式与状态导出**中文标签**而不是原始枚举值 —— 导出件是给业务看的，
 *     出现 `fixed_price` / `active` 这类内部值等于没做本地化；
 *     同时保留 `?? row.x` 兜底：将来新增枚举值而忘了补标签时，
 *     导出件里会出现原始值（**可见的缺陷**）而不是空白（不可见的丢数）。
 *   · 日期字段用 `?? ''` 而非 `?? '-'` —— 空值进 Excel 应当是空单元格，
 *     否则 `-` 会被当成文本参与求和/筛选。
 */
import type { ExcelSheetColumn } from '@client/src/components/excel/excel-utils';
import { BILLING_MODEL_LABELS, CONTRACT_STATUS_LABELS } from '@client/src/utils/biz-labels';
import type { Contract } from '@shared/api.interface';

/** 合同列表导出的列定义（顺序即导出件列序） */
export const CONTRACT_EXPORT_COLUMNS: ExcelSheetColumn<Contract>[] = [
  { header: '合同编号', value: (row: Contract) => row.code },
  { header: '客户名称', value: (row: Contract) => row.customerName },
  { header: '合同名称', value: (row: Contract) => row.name },
  {
    header: '计费模式',
    value: (row: Contract) => BILLING_MODEL_LABELS[row.billingModel] ?? row.billingModel,
  },
  { header: '金额（含税）', value: (row: Contract) => row.amount },
  {
    header: '状态',
    value: (row: Contract) => CONTRACT_STATUS_LABELS[row.status] ?? row.status,
  },
  { header: '签订日期', value: (row: Contract) => row.signDate ?? '' },
  { header: '开始日期', value: (row: Contract) => row.startDate ?? '' },
  { header: '结束日期', value: (row: Contract) => row.endDate ?? '' },
  { header: '负责人', value: (row: Contract) => row.owner ?? '' },
];
