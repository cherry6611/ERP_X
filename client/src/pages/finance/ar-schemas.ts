/**
 * 应收 Tab 的表单 schema 与 Excel 导出列定义（§5.9 / F8）。
 *
 * 与 `ap-schemas.ts` 同一拆分理由（见该文件头）：两块都是**零 React 依赖的
 * 纯声明**，搬出来后既可单测、也让 `ArTab.tsx` 的组件骨架前移。
 *
 * ## 应收与应付的两处**有意不对称**（不要在"统一"时抹掉）
 *
 * | | 应付（AP） | 应收（AR） |
 * |---|---|---|
 * | 单据主体字段 | `supplierId`（供应商） | `contractId`（**合同**） |
 * | 收付款对方 | 无 | `customerId`（客户） |
 *
 * 应收单挂在**合同**上（收入按合同确认，回款按合同追溯），
 * 而回款单挂在**客户**上（客户可能一次付多个合同的钱，由核销分摊）。
 * 应付侧没有这个区分：应付单与付款都直接对供应商。
 * 因此两边看似对称的 schema 实际字段不同 —— 规格里各有断言钉住。
 */
import { z } from 'zod';
import type { ExcelSheetColumn } from '@client/src/components/excel/excel-utils';
import { AR_STATUS_LABELS } from '@client/src/utils/biz-labels';
import type { ArItem } from '@shared/api.interface';

/* ── Excel 导出列 ────────────────────────────────────────────────────────── */

export const arExportColumns: ExcelSheetColumn<ArItem>[] = [
  { header: '应收编号', value: (row: ArItem) => row.code },
  { header: '客户', value: (row: ArItem) => row.customerName },
  /*
   * `?? ''` 是必需的：契约里 `contractName: string | null` —— 手工登记的应收单
   * 可能不挂合同（`contractId` 也为 null）。**原实现在这里漏了空值兜底**，
   * 于是那一列会导出成**空白单元格**，而同一行的「到期日」有 `?? ''`、
   * 应付侧的「项目」也有 `?? ''`。空值兜底在同一个文件里不一致，
   * 接收方无法区分"没有合同"与"数据丢了"。
   */
  { header: '合同', value: (row: ArItem) => row.contractName ?? '' },
  { header: '应收金额（含税）', value: (row: ArItem) => row.amount },
  { header: '已核销', value: (row: ArItem) => row.settledAmount },
  {
    header: '未核销',
    // 现算：`ArItem` 无 unsettledAmount 字段（与应付的"未付"同一做法）
    value: (row: ArItem) => row.amount - row.settledAmount,
  },
  { header: '到期日', value: (row: ArItem) => row.dueDate ?? '' },
  {
    header: '状态',
    value: (row: ArItem) => AR_STATUS_LABELS[row.status] ?? row.status,
  },
  // 应收独有的「逾期」列：应付没有到期提醒语义（欠供应商的钱晚付不是"逾期收入"）
  { header: '逾期', value: (row: ArItem) => (row.overdue ? '是' : '否') },
];

/* ── 表单 schema ─────────────────────────────────────────────────────────── */

/** 登记应收单（挂在**合同**上） */
export const arSchema = z.object({
  contractId: z.string().min(1, '请选择合同'),
  amount: z.coerce.number().min(1, '应收金额必须大于 0'),
  dueDate: z.string().optional(),
  remark: z.string(),
});
export type ArFormData = z.output<typeof arSchema>;
export type ArFormInput = z.input<typeof arSchema>;

/** 登记回款单（挂在**客户**上） */
export const receiptSchema = z.object({
  customerId: z.string().min(1, '请选择客户'),
  amount: z.coerce.number().min(1, '回款金额必须大于 0'),
  method: z.string(),
  remark: z.string(),
});
export type ReceiptFormData = z.output<typeof receiptSchema>;
export type ReceiptFormInput = z.input<typeof receiptSchema>;

/** 回款核销应收 */
export const writeoffSchema = z.object({
  arId: z.string().min(1, '请选择应收'),
  receiptId: z.string().min(1, '请选择回款'),
  // 与应付侧同一门槛 0.01：1 分钱的尾差分摊必须能核销
  amount: z.coerce.number().min(0.01, '核销金额必须大于 0'),
});
export type WriteoffFormData = z.output<typeof writeoffSchema>;
export type WriteoffFormInput = z.input<typeof writeoffSchema>;
