/**
 * 发票台账 Tab（`InvoicesTab.tsx`）的纯逻辑（§5.9 / F8 拆分）。
 *
 * ## 为什么从 `InvoicesTab.tsx` 里搬出来
 *
 * 与同目录的 `ap-schemas.ts` / `ar-schemas.ts` 同一理由：以下四块**零 React
 * 依赖**（不碰 hook / JSX / toast / API），留在 944 行（审计口径：非空行）的
 * 组件文件里有两个具体代价：
 *   ① 打开组件文件先看到一百多行声明，看不到组件本身；
 *   ② **无法单测**。而它们恰恰是最该测的 ——
 *
 * · **登记表单 schema** 是发票数据的入口闸门：金额 `0` 与 `0.01` 的区别、
 *   税率必须落在 `VAT_RATES` 内，改错一处就会放进脏数据（或让合法发票登记不进来）。
 * · **CSV 导出列**的列序 / 取值错了在界面上**完全看不出来** —— 导出照样成功、
 *   Excel 照样打开，只是「税额」列里放的是开票金额，而对账的人会据此勾稽。
 *   只有逐列断言能拦住。
 * · **展示字典**（方向 / 发票类型 / 发票状态 / 查验状态 / 认证状态）漏一个键，
 *   表格与导出会静默退化成英文 key（`vat_special` / `failed` / `deducted`）。
 * · **`toLocalDate`** 的"日历日"语义一旦被当成时区问题"修掉"，纽约用户选的
 *   10-16 会存成 10-17（详见该函数上方的注释与 `scripts/check-biz-timezone.mjs`）。
 *
 * ## 有意**没有**搬出来的东西
 *
 * `columns`（`TableColumnsType<InvoiceItem>`）留在组件里：每个 `render` 都是
 * JSX（Badge / Button / navigate / toast handler），搬出来就不满足"零 React
 * 依赖"这个前提，也无从单测。`handleExportCsv` 只保留 DOM 部分
 * （Blob / URL / `<a download>`），CSV 文本由本模块的 `buildInvoiceCsv` 生成。
 */
import { z } from 'zod';
import { VAT_RATES } from '@shared/tax';
import type { ArItem, InvoiceDirection, InvoiceItem } from '@shared/api.interface';

/* ── 展示字典（表格 render 与 CSV 导出共用同一份） ───────────────────────── */

/*
 * ⚠️ 发票类型**不要**改成从 `@client/src/utils/biz-labels` 引同名常量：
 * 那一份只有 `vat_special` / `vat_normal` **两个键**（其文件头注明"未接管字典"），
 * 而登记弹窗的类型下拉是 `Object.entries(INVOICE_TYPE_LABELS)` 渲染的 ——
 * 换过去会让「电子发票」从下拉里消失，表格与导出里也会回退成英文 key。
 * `invoice-schemas.spec.ts` 有一条断言专门钉住"三个键一个都不能少"。
 */
export const INVOICE_TYPE_LABELS: Record<string, string> = {
  vat_special: '增值税专用发票',
  vat_normal: '增值税普通发票',
  electronic: '电子发票',
};

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  issued: '已开票',
  voided: '已作废',
};

export const DIRECTION_LABELS: Record<InvoiceDirection, string> = {
  sales: '销项',
  purchase: '进项',
};

export type DirectionFilter = 'all' | InvoiceDirection;

/*
 * C-01：查验 / 认证状态展示映射。
 *
 * 这两个 `Record` 原先声明在组件体内（`handleLink` 之后）—— 每次 render 重建，
 * 且与顶部的类型字典分处两地。它们是纯常量，移到模块作用域后行为不变
 * （`handleVerify` 引用 `VERIFY_STATUS_LABELS` 时早已渲染过一次，不存在 TDZ 问题），
 * 但终于可以被"每个白名单值都有非空标签"这类断言钉住。
 */
type BadgeVariant =
  | 'warning'
  | 'success'
  | 'secondary'
  | 'destructive'
  | 'info'
  | 'default'
  | 'outline';
export const VERIFY_STATUS_LABELS: Record<string, string> = {
  unverified: '未查验',
  verifying: '查验中',
  verified: '已通过',
  failed: '查验失败',
};
export const VERIFY_STATUS_VARIANTS: Record<string, BadgeVariant> = {
  unverified: 'secondary',
  verifying: 'warning',
  verified: 'success',
  failed: 'destructive',
};
export const CERT_STATUS_LABELS: Record<string, string> = {
  uncertified: '未认证',
  certified: '已认证',
  deducted: '已抵扣',
};
export const CERT_STATUS_VARIANTS: Record<string, BadgeVariant> = {
  uncertified: 'secondary',
  certified: 'info',
  deducted: 'success',
};

/* ── 日期 / 格式小工具 ───────────────────────────────────────────────────── */

/**
 * 把**用户从日历里选的**某一天格式化为 `YYYY-MM-DD`。
 *
 * ⚠️ 这里**必须**用浏览器本地时区，不能改用 `utils/format.ts` 的
 * `todayIso()` / `Intl` + `Asia/Shanghai`：
 * 判据是**数据来源**而不是写法 —— `date.getFullYear()`（有参数）看的是"用户选的
 * 那一天"，用户选 10-16 就该存 10-16；若按上海时区格式化，纽约用户选的那天
 * 会被存成 10-17（日历日位移）。只有在**无参数**的 `new Date()` 上取年月日
 * （即"此刻"）才必须走业务时区。
 *
 * `scripts/check-biz-timezone.mjs` 正是按"有无参数"区分这两者的，本文件被搬到
 * `InvoicesTab.tsx` 之外后仍在该门禁的扫描范围内。
 */
export const toLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/** 勾选认证的"税款所属期"格式：`YYYY-MM`，月份必须落在 01–12 */
export const isValidTaxPeriod = (period: string): boolean =>
  /^\d{4}-(0[1-9]|1[0-2])$/.test(period);

/** CSV 单元格：始终加引号，内部引号按 RFC 4180 双写转义 */
export const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return `"${s.replace(/"/gu, '""')}"`;
};

/* ── 台账 CSV 导出 ───────────────────────────────────────────────────────── */

/*
 * 表头与取值是**两条并列的字面量列表**，顺序必须逐一对应 —— 这正是"错位在界面上
 * 看不出来"的地方，所以两条都导出成函数，规格里按列头 zip 起来逐列断言，
 * 并额外断言两侧列数相等（只往一边加列的改动会让整行错位）。
 */
export const invoiceCsvHeaderLine = (): string =>
  [
    '申请编号',
    '方向',
    '往来方',
    '合同',
    '发票类型',
    '发票号码',
    '关联应收',
    '开票金额（含税）',
    '税率',
    '税额',
    '开票日期',
    '状态',
    '备注',
  ]
    .map(csvCell)
    .join(',');

export const invoiceCsvRowLine = (it: InvoiceItem): string =>
  [
    it.code,
    DIRECTION_LABELS[it.direction] ?? it.direction,
    /*
     * 销项取客户名、进项取供应商名。契约里 `customerName: string`（非空），
     * `supplierName: string | null` —— 服务端 `toInvoiceItem` 已把客户名兜底为
     * `row.customerName ?? ''`，因此销项侧不需要 `?? ''`；这条不对称是**契约
     * 决定**的，不是漏写（`invoice-schemas.spec.ts` 有断言登记）。
     */
    it.direction === 'sales' ? it.customerName : (it.supplierName ?? ''),
    it.contractName ?? '',
    INVOICE_TYPE_LABELS[it.invoiceType] ?? it.invoiceType,
    it.invoiceNo ?? '',
    it.arCode ?? '',
    it.amount,
    it.taxRate,
    it.taxAmount,
    it.invoiceDate ?? '',
    INVOICE_STATUS_LABELS[it.status] ?? it.status,
    it.remark ?? '',
  ]
    .map(csvCell)
    .join(',');

/** 完整 CSV 文本（含 UTF-8 BOM，Excel 打开中文不乱码）。DOM 部分留在组件里。 */
export const buildInvoiceCsv = (invoices: InvoiceItem[]): string =>
  `\uFEFF${[invoiceCsvHeaderLine(), ...invoices.map(invoiceCsvRowLine)].join('\n')}`;

/* ── 派生计算 ────────────────────────────────────────────────────────────── */

/**
 * 可关联的应收单：**仅开放中 / 部分回款**。
 *
 * 已核销完毕（`settled`）或已作废（`voided`）的应收不可再关联开票 ——
 * 这个白名单错了不会有报错，只会让下拉里多出/少掉选项。
 */
export const filterLinkableArs = (ars: ArItem[] | undefined): ArItem[] =>
  (ars ?? []).filter((a: ArItem) => a.status === 'open' || a.status === 'partial');

/** 按方向汇总税额（顶部两张 StatCard：销项税额合计 / 进项可抵扣税额合计） */
export const sumTaxAmountByDirection = (
  invoices: readonly InvoiceItem[],
  direction: InvoiceDirection
): number =>
  invoices
    .filter((it: InvoiceItem) => it.direction === direction)
    .reduce((sum: number, it: InvoiceItem) => sum + it.taxAmount, 0);

/* ── 发票登记表单 schema ─────────────────────────────────────────────────── */

export const invoiceSchema = z
  .object({
    direction: z.enum(['sales', 'purchase']),
    contractId: z.string(),
    supplierId: z.string(),
    invoiceType: z.string().min(1, '请选择发票类型'),
    /*
     * `min(0.01)` 是"> 0"的落地写法（开票金额两位小数，0.01 即最小正值）。
     * 与下方 `taxRate` 的 `VAT_RATES` 白名单**有意不同**：金额不接受 0，
     * 而税率**必须**接受 0（0% 是免税/出口等真实档位，见 `shared/tax.ts`）。
     */
    amount: z.coerce.number().min(0.01, '开票金额必须大于 0'),
    taxRate: z.coerce
      .number()
      .refine((value) => (VAT_RATES as readonly number[]).includes(value), '请选择合法税率'),
    arId: z.string(),
    invoiceNo: z.string(),
    invoiceDate: z.string(),
    remark: z.string(),
  })
  .superRefine((val, ctx) => {
    if (val.direction === 'sales' && !val.contractId) {
      ctx.addIssue({ code: 'custom', path: ['contractId'], message: '请选择合同' });
    }
    if (val.direction === 'purchase' && !val.supplierId) {
      ctx.addIssue({ code: 'custom', path: ['supplierId'], message: '请选择供应商' });
    }
  });

export type InvoiceFormData = z.output<typeof invoiceSchema>;
export type InvoiceFormInput = z.input<typeof invoiceSchema>;

export const FORM_DEFAULTS: InvoiceFormInput = {
  direction: 'sales',
  contractId: '',
  supplierId: '',
  invoiceType: 'vat_special',
  amount: 0,
  taxRate: 6,
  arId: 'none',
  invoiceNo: '',
  invoiceDate: '',
  remark: '',
};
