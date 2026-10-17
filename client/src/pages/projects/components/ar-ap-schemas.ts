/**
 * §5.9 二次拆分：应收/应付**表单 schema** 从 `ar-ap-model.ts` 抽出。
 *
 * ## 为什么再拆一次
 *
 * `ar-ap-model.ts` 装了三类东西（schema / 状态标签 / 列结构），合计超过 500 行门槛。
 * 按 `AGENTS.md` §5.9 的判据，拆分单位应当是**一类关注点**而不是"一个页面一个文件"：
 *   · schema 是**财务数据的入口闸门**（改错一个 `min` 就放进脏数据）；
 *   · 标签表是**展示映射**（漏一个键 → 界面显示英文码）；
 *   · 列结构是**表格契约**（取错字段 → 数字落在错的列里）。
 * 三者改动的原因完全不同，放在一起会让每次改动都翻整份文件。
 *
 * ## 一条容易被"统一"掉的判据
 *
 * 这里的 `min(1)` 与 `pages/finance/ar-schemas.ts` 的 `min(0.01)` **不同，且必须不同**：
 *   · **登记**应收/应付 → `min(1)`：0 元单据没有业务含义，却会在台账里占一行、
 *     永远不需要回款，并让"未回款合计"失去意义；
 *   · **核销**金额 → `min(0.01)`：尾差分摊必须能合法表达（例如 0.01 元的差额）。
 * 不要为了"一致"把两处改成同一个数。
 */
import { z } from 'zod';

/**
 * 登记应收单（挂在**合同**上）。
 *
 * `amount` 用 `min(1)` 而不是 `min(0.01)`：见文件头关于两种门槛的说明。
 */
export const arSchema = z.object({
  amount: z.coerce.number().min(1, '应收金额必须大于 0'),
  dueDate: z.string().optional(),
  ownerUserId: z.string().optional(),
  remark: z.string(),
});

export type ArFormData = z.output<typeof arSchema>;
export type ArFormInput = z.input<typeof arSchema>;

/** 登记回款单（挂在**客户**上）。`arId` 必填：回款必须指定要冲哪张应收单 */
export const receiptSchema = z.object({
  arId: z.string().min(1, '请选择应收单'),
  amount: z.coerce.number().min(1, '回款金额必须大于 0'),
  receiptDate: z.string().optional(),
  method: z.string(),
  remark: z.string(),
});

export type ReceiptFormData = z.output<typeof receiptSchema>;
export type ReceiptFormInput = z.input<typeof receiptSchema>;

/** 登记应付单（挂在**供应商**上）。与 `arSchema` 同一 `min(1)` 门槛 */
export const apSchema = z.object({
  supplierId: z.string().min(1, '请选择供应商'),
  amount: z.coerce.number().min(1, '应付金额必须大于 0'),
  dueDate: z.string().optional(),
  remark: z.string(),
});

export type ApFormData = z.output<typeof apSchema>;
export type ApFormInput = z.input<typeof apSchema>;

/** 登记付款申请（挂在**应付单**上）。`apId` 必填，理由同 `receiptSchema` */
export const paymentSchema = z.object({
  apId: z.string().min(1, '请选择应付单'),
  amount: z.coerce.number().min(1, '付款金额必须大于 0'),
  payDate: z.string().optional(),
  method: z.string(),
  remark: z.string(),
});

export type PaymentFormData = z.output<typeof paymentSchema>;
export type PaymentFormInput = z.input<typeof paymentSchema>;
