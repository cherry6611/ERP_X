/**
 * 应付 Tab 的表单 schema 与 Excel 导出列定义（§5.9 / F8）。
 *
 * ## 为什么从 `ApTab.tsx` 里搬出来
 *
 * 这两块合计约 70 行，**都是零 React 依赖的纯声明**：
 *   · zod schema 只描述"什么样的输入算合法"；
 *   · 导出列定义只描述"哪一列取哪个字段"。
 *
 * 放在组件文件里有两个具体代价：
 *   ① 990 行的 `ApTab.tsx` 前 140 行全是声明，打开文件看不到组件；
 *   ② **无法单测**。而这两块恰恰是最该测的：
 *      - schema 的**校验边界**（金额 0 该不该拦、核销 0.01 与 0 的区别）是
 *        财务数据的入口闸门，改错一个 `min` 就会放进脏数据；
 *      - 导出列定义的错误**在界面上完全看不出来**（导出照样成功，只是
 *        数字落在错的列里），只能逐列断言。
 *
 * ## 为什么"未付"列是算出来的而不是取字段
 *
 * 见 `apExportColumns` 里的 `amount - paidAmount`：`ApItem` 没有 `unpaidAmount`
 * 字段，原实现就是现算的。保留同一算法（而不是让后端加字段）是为了
 * **行为零变更**；但也意味着"已付 > 应付"时导出会出现负数 ——
 * 这是原行为，单测里显式断言了它，以免有人"顺手改成 `Math.max(0, …)`"
 * 而不说明为什么。
 */
import { z } from 'zod';
import type { ExcelSheetColumn } from '@client/src/components/excel/excel-utils';
import { AP_STATUS_LABELS } from '@client/src/utils/biz-labels';
import type { ApItem } from '@shared/api.interface';

/* ── Excel 导出列 ────────────────────────────────────────────────────────── */

export const apExportColumns: ExcelSheetColumn<ApItem>[] = [
  { header: '应付编号', value: (row: ApItem) => row.code },
  { header: '供应商', value: (row: ApItem) => row.supplierName },
  { header: '项目', value: (row: ApItem) => row.projectName ?? '' },
  { header: '应付金额（含税）', value: (row: ApItem) => row.amount },
  { header: '已付', value: (row: ApItem) => row.paidAmount },
  {
    header: '未付',
    // 现算：`ApItem` 无 unpaidAmount 字段。见文件头关于负数的说明。
    value: (row: ApItem) => row.amount - row.paidAmount,
  },
  { header: '到期日', value: (row: ApItem) => row.dueDate ?? '' },
  {
    header: '状态',
    value: (row: ApItem) => AP_STATUS_LABELS[row.status] ?? row.status,
  },
];

/* ── 表单 schema ─────────────────────────────────────────────────────────── */

/** 新建应付单 */
export const apSchema = z.object({
  supplierId: z.string().min(1, '请选择供应商'),
  /*
   * `min(1)` 而不是 `min(0.01)`：应付单是"对供应商的负债"，
   * 金额为 0 的单据没有业务含义，且会在应付台账里占一行却永不需要付款。
   * 与核销金额的 `min(0.01)` 有意不同 —— 核销 0.01 是真实存在的最小核销。
   */
  amount: z.coerce.number().min(1, '应付金额必须大于 0'),
  dueDate: z.string().optional(),
  remark: z.string(),
});
export type ApFormData = z.output<typeof apSchema>;
export type ApFormInput = z.input<typeof apSchema>;

/** 登记付款 */
export const paymentSchema = z.object({
  apId: z.string().min(1, '请选择应付'),
  amount: z.coerce.number().min(1, '付款金额必须大于 0'),
  method: z.string(),
  remark: z.string(),
});
export type PaymentFormData = z.output<typeof paymentSchema>;
export type PaymentFormInput = z.input<typeof paymentSchema>;

/** 付款核销应付 */
export const writeoffSchema = z.object({
  apId: z.string().min(1, '请选择应付'),
  paymentId: z.string().min(1, '请选择付款'),
  /*
   * 核销金额门槛是 **0.01** 而不是 1：核销是把已有付款分摊到应付上，
   * 1 分钱的分摊是合法且必要的（尾差处理）。这与上面的"应付金额 min(1)"
   * 是两个不同的业务门槛，不要为了"统一"而改成同一个数。
   */
  amount: z.coerce.number().min(0.01, '核销金额必须大于 0'),
});
export type WriteoffFormData = z.output<typeof writeoffSchema>;
export type WriteoffFormInput = z.input<typeof writeoffSchema>;

/** 外协供应商结算（按供应商 + 月份对账已确认工时） */
export const vendorSettlementSchema = z.object({
  supplierId: z.string().min(1, '请选择供应商'),
  period: z.string().min(1, '请选择月份'),
  projectId: z.string().optional(),
  dueDate: z.string().optional(),
});
export type VendorSettlementFormData = z.output<typeof vendorSettlementSchema>;
export type VendorSettlementFormInput = z.input<
  typeof vendorSettlementSchema
>;
