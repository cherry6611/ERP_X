/**
 * 凭证录入的纯逻辑：表单 schema、借贷汇总与分录校验（§5.9 / F8）。
 *
 * ## 为什么这些必须能单测
 *
 * 凭证是账务的**源头单据**：一张借贷不平衡或有负数行的凭证落库后，
 * 会污染试算平衡、总账、报表，而修正需要红字冲销（有审计痕迹成本）。
 * 原实现把这些判断内联在 `onSubmit` 回调里 —— 要触达它们必须渲染整个
 * 841 行的组件、打开弹窗、逐格输入、点提交。结果是：
 *
 *   · 三段校验（负数 / 借贷同填 / 双零）在 4 年里没有任何自动化覆盖；
 *   · 借贷平衡的**容差 0.001** 是一个隐藏的业务判断（见下），
 *     没人能说清它是怎么定的、改了会怎样。
 *
 * 抽出来之后这些都是纯函数，可以直接喂边界值。
 *
 * ## 三个业务门槛（规格里各有用例钉住）
 *
 * 1. **容差 0.001 元**：借贷差额 ≤ 0.001 视为平衡。为什么不是严格相等 ——
 *    逐行金额各自 `round2` 之后求和，与"先求和再 round2"可能差 1 分以内的
 *    浮点尾数；不设容差会让合法凭证偶发提交失败（且用户看不出原因）。
 *    但容差也不能放大：0.001 元以下在会计上不存在（记账本位币最小单位是分）。
 * 2. **每行借贷不能同填**：同填意味着这笔分录方向不明，服务端也拒绝。
 * 3. **每行借贷不能双零**：双零行不会影响合计，因此**能绕过借贷平衡校验**
 *    —— 一张只有两行空分录的凭证合计为 0，若不拦就会落库成"无金额凭证"。
 */
import { z } from 'zod';
import { round2 } from '@shared/number';
import type { ExcelSheetColumn } from '@client/src/components/excel/excel-utils';
import type {
  CreateVoucherLineDto,
  VoucherItem,
  VoucherLineAuxDto,
} from '@shared/api.interface';
import {
  VOUCHER_SOURCE_LABELS,
  VOUCHER_STATUS_LABELS,
} from './VoucherBadges';

/* ── 表单 schema ─────────────────────────────────────────────────────────── */

export const lineSchema = z.object({
  accountId: z.string().min(1, '请选择科目'),
  summary: z.string(),
  debit: z.string(),
  credit: z.string(),
  /** A-05：科目要求的辅助核算维度值（dimensionCode → dimensionValue） */
  aux: z.record(z.string(), z.string()),
});

export const voucherSchema = z.object({
  voucherDate: z.string().min(1, '请选择凭证日期'),
  period: z.string().min(1, '请输入期间（YYYY-MM）'),
  summary: z.string().min(1, '请输入摘要'),
  remark: z.string(),
  /*
   * `min(2)` —— 复式记账的最小分录数。一条分录无法同时表达借贷双方，
   * 因此两行是下限而不是"建议值"。这条约束同时挡住"只有一行"的
   * 半成品提交。
   */
  lines: z.array(lineSchema).min(2, '至少需要两行分录'),
});

export type VoucherFormData = z.infer<typeof voucherSchema>;
export type VoucherLineFormValue = VoucherFormData['lines'][number];

/* ── 空表单 ──────────────────────────────────────────────────────────────── */

/**
 * 两行空分录（复式记账最小形态）。
 *
 * ## 为什么是**函数**而不是常量
 *
 * 原实现是模块级常量 `EMPTY_FORM`，其中 `lines` 是一个**在模块加载时创建、
 * 被所有使用者共享**的数组引用。它同时作为 `useForm({ defaultValues })`
 * 的初值和 `form.reset(EMPTY_FORM)` 的入参 —— 而 `reset` 之后
 * `useFieldArray` 的 `append`/`remove` 操作的是表单身处的数组。
 *
 * 现在 react-hook-form v7 的 `reset` 内部会深拷贝 `values`
 * （`_formValues = cloneObject(values)`），所以**当前不会**串数据；
 * 但这份安全性依赖第三方库的内部实现，且一旦有人把 `reset(EMPTY_FORM)`
 * 改成 `setValue('lines', EMPTY_FORM.lines)` 就会立刻踩到共享引用。
 * 改成函数让"每次拿到全新数组"成为调用方的**结构性保证**，
 * 而不是"依赖 RHF 恰好会拷贝"。
 */
export function emptyLines(): Array<{
  accountId: string;
  summary: string;
  debit: string;
  credit: string;
  aux: Record<string, string>;
}> {
  return [
    { accountId: '', summary: '', debit: '', credit: '', aux: {} },
    { accountId: '', summary: '', debit: '', credit: '', aux: {} },
  ];
}

/**
 * 新建凭证弹窗的初始值。
 *
 * `today`/`period` 作为参数传入而不是在模块内调 `todayIso()`：
 * 模块加载时的日期在跨零点长驻页面上会过期（页面开着一夜，
 * 第二天新建凭证的默认日期还是昨天）。由调用方在**打开弹窗时**求值，
 * 同时也让本函数成为可测的纯函数。
 */
export function createEmptyVoucherForm(
  today: string,
  period: string,
): VoucherFormData {
  return {
    voucherDate: today,
    period,
    summary: '',
    remark: '',
    lines: emptyLines(),
  };
}

/* ── PageSize ────────────────────────────────────────────────────────────── */

/**
 * 凭证列表每页条数。
 *
 * 20 而不是账簿页的 50：一张凭证展开后有若干分录行，且列表要显示来源/状态/
 * 借贷合计等宽列；20 条已能占满一屏而不出横向滚动。
 */
export const PAGE_SIZE = 20;

/* ── 借贷汇总 ────────────────────────────────────────────────────────────── */

/** 借贷合计（各自独立 `round2`，与提交时的口径一致） */
export function sumVoucherLines(
  lines: ReadonlyArray<{ debit?: string; credit?: string }> | undefined,
): { totalDebit: number; totalCredit: number } {
  const rows = lines ?? [];
  return {
    totalDebit: round2(
      rows.reduce((sum, line) => sum + Number(line.debit || 0), 0),
    ),
    totalCredit: round2(
      rows.reduce((sum, line) => sum + Number(line.credit || 0), 0),
    ),
  };
}

/**
 * 借贷平衡容差（元）。
 *
 * 0.001 元 = 1 厘，**小于记账本位币的最小单位（分）**，因此不会掩盖
 * 真实的金额差异；放大到 0.01 就会放过 1 分钱的真实不平衡。
 *
 * ⚠️ 为什么不直接写 `Math.abs(a - b) <= BALANCE_TOLERANCE` —— 见 `isBalanced`。
 */
export const BALANCE_TOLERANCE = 0.001;

/**
 * 借贷是否平衡。
 *
 * ## ⚠️ 本轮修复的真实缺陷：直接用差值比较是**量级相关**的
 *
 * 直觉写法 `Math.abs(totalDebit - totalCredit) <= 0.001` 有一个隐蔽问题：
 * IEEE-754 的减法会引入与**量级成正比**的表示误差。实测：
 *
 * | 调用 | 数学差值 | 浮点实算差值 | 直觉写法结果 |
 * |---|---|---|---|
 * | `isBalanced(1000, 1000.001)` | 0.001 | `0.00099999999997635…` | **平衡** |
 * | `isBalanced(-100, -100.001)` | 0.001 | `0.00100000000000477…` | **不平衡** |
 *
 * 两个调用在数学上完全对称，结果却相反 —— 只因为 1000 与 100 的量级不同。
 * 也就是"借贷差 1 厘算不算平"取决于金额大小，而不是业务规则。
 * 实际影响有限（`sumVoucherLines` 已把两侧各自 `round2`，合计恒为两位小数），
 * 但这属于"恰好没炸"的运气，不是设计。
 *
 * ## 修法：把判据落在**最小单位**上，而不是落在浮点差值上
 *
 * 改为"四舍五入到分之后是否相等"：`round2(a) === round2(b)`。
 * 这与差额大小无关，只与"分"这一最小单位有关，且天然满足两条要求：
 *   · 1 分钱的真实差异 **不** 被判为平衡（`round2(1000) !== round2(1000.01)`）；
 *   · 两侧合计在 `round2` 后精确相等，因此不再有浮点噪声需要"吸收"。
 *
 * `BALANCE_TOLERANCE` 保留为导出常量：它是分界线（1 厘）的**语义声明**，
 * 供文档与错误文案引用；判定本身不再依赖浮点减法。
 */
export function isBalanced(totalDebit: number, totalCredit: number): boolean {
  return round2(totalDebit) === round2(totalCredit);
}

/* ── 分录校验 ────────────────────────────────────────────────────────────── */

export interface VoucherLineError {
  /** 出错的行下标（0 基） */
  index: number;
  /** 出错字段，用于 `form.setError('lines.N.debit', …)` */
  field: 'debit' | 'credit';
  message: string;
}

/**
 * 校验一行分录，返回第一个错误（无错返回 `null`）。
 *
 * 三条规则与顺序都保留原实现的语义（顺序会影响用户先看到哪条报错）：
 *   ① 负数金额 → 报错。负数会让"借贷同填"判断失效（-100 与 100 都不为 0），
 *      进而让借贷合计出现"看起来平衡"的假象，所以必须先拦。
 *   ② 借贷同填 → 报错。方向不明。
 *   ③ 双零 → 报错。**这条最容易漏**：双零行不影响合计，因此能绕过
 *      借贷平衡校验 —— 一张两行全空的凭证合计 0 = 0，会以"无金额凭证"落库。
 */
export function validateVoucherLine(
  index: number,
  line: { debit?: string; credit?: string },
): VoucherLineError | null {
  const debit = Number(line.debit || 0);
  const credit = Number(line.credit || 0);
  if (debit < 0 || credit < 0) {
    return { index, field: 'debit', message: '金额不能为负数' };
  }
  if (debit > 0 && credit > 0) {
    return {
      index,
      field: 'credit',
      message: '借方与贷方不能同时填写金额',
    };
  }
  if (debit === 0 && credit === 0) {
    return {
      index,
      field: 'debit',
      message: '借方/贷方至少填写一个大于 0 的金额',
    };
  }
  return null;
}

/**
 * 把「科目必挂维度 → 输入值」转成后端入参（P1-2）。
 *
 * 只提交科目**声明必挂**的维度；空值不提交，由后端给出
 * 「要求填写辅助核算维度」的准确报错（而不是前端拦成一句笼统提示）。
 *
 * `account` 直接接收已找到的科目对象，而不是在函数内查表 ——
 * 查表是调用方的事，这样本函数不依赖科目列表的整体形态。
 */
export function buildLineAux(
  requiredCodes: ReadonlyArray<string> | undefined,
  aux: Record<string, string> | undefined,
): VoucherLineAuxDto[] | undefined {
  const items = (requiredCodes ?? [])
    .map((code) => ({
      dimensionCode: code,
      dimensionValue: (aux?.[code] ?? '').trim(),
    }))
    .filter((item) => item.dimensionValue.length > 0);
  return items.length > 0 ? items : undefined;
}

/**
 * 把表单行规范化成后端 DTO 行。
 *
 * ## ⚠️ 本轮修复的真实缺陷：判定必须用**取整后**的值
 *
 * 原实现是 `debit > 0 ? round2(debit) : undefined` —— 判定用**原始输入**，
 * 赋值用**取整值**。两者不一致就漏掉了一类输入：
 *
 * | 输入 | `debit > 0` | `round2(debit)` | 原实现提交 |
 * |---|---|---|---|
 * | `0.001` | **true** | `0` | `debit: 0` |
 * | `0.004` | **true** | `0` | `debit: 0` |
 *
 * `0.001` 元 = 1 厘，小于记账本位币最小单位（分），取整后就是 0。
 * 而客户端的「双零行」校验 `validateVoucherLine` 读的是**原始字符串**
 * （`Number('0.001') === 0` 为 `false`），所以**放行了**；服务端 DTO 是
 * `@Min(0)`（允许 0），也放行了。于是这张凭证带着一行 **0 元分录**过账 ——
 * 试算仍然平（0 不影响合计），但账面多了一条无意义的借贷记录。
 *
 * 修法：**先取整、再判定**，即 `round2(debit) > 0`。这样 `0.001` 落到
 * `undefined`，该行随即被「双零行」规则拦住并提示
 * 「借方/贷方至少填写一个大于 0 的金额」—— 用户拿到可理解的错误，
 * 而不是静默落库一行 0 元分录。
 */
export function normalizeVoucherLine(
  line: VoucherLineFormValue,
  requiredCodes: ReadonlyArray<string> | undefined,
): CreateVoucherLineDto {
  const debit = round2(Number(line.debit || 0));
  const credit = round2(Number(line.credit || 0));
  return {
    accountId: line.accountId,
    summary: line.summary || undefined,
    // 取整后为 0（含 1 厘级输入）→ 该侧不填，交给「双零行」校验拦下
    debit: debit > 0 ? debit : undefined,
    credit: credit > 0 ? credit : undefined,
    auxDimensions: buildLineAux(requiredCodes, line.aux),
  };
}

/* ── Excel 导出列 ────────────────────────────────────────────────────────── */


export const voucherExportColumns: ExcelSheetColumn<VoucherItem>[] = [
  { header: '凭证编号', value: (row: VoucherItem) => row.code },
  { header: '日期', value: (row: VoucherItem) => row.voucherDate ?? '' },
  { header: '期间', value: (row: VoucherItem) => row.period },
  { header: '摘要', value: (row: VoucherItem) => row.summary ?? '' },
  {
    header: '来源',
    value: (row: VoucherItem) =>
      VOUCHER_SOURCE_LABELS[row.sourceType] ?? row.sourceType,
  },
  {
    header: '状态',
    value: (row: VoucherItem) => VOUCHER_STATUS_LABELS[row.status] ?? row.status,
  },
  { header: '借方合计', value: (row: VoucherItem) => row.totalDebit },
  { header: '贷方合计', value: (row: VoucherItem) => row.totalCredit },
];
