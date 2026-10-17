/**
 * 报价单表单的纯逻辑与共享类型（§5.9 / F8，从 `QuotationFormDialog.tsx` 拆出）。
 *
 * ## 搬走了什么
 *
 * 全是**零 React 依赖**的声明与计算，原先占主文件前 120 行：
 *   · `quoteSchema` 与两个表单类型 `QuoteFormData` / `QuoteFormInput`；
 *   · 明细行的数据形状 `QuotationItemRow` 与**行身份** `QuotationRow` / `withRowKey`；
 *   · `EMPTY_ITEM`、`toNum`、`MARGIN_RED_LINE`；
 *   · `QuotationFormPreset`（主文件仍 re-export，对外导出面不变）；
 *   · 合计与毛利红线：`computeQuotationTotals` / `isBelowMarginLine`。
 *
 * ## 为什么最该搬的是"合计"
 *
 * 这一块是**唯一算钱的地方**：报价总额、预估成本、毛利率都在浏览器里现算，
 * 而"行折扣 → 整单折扣 → 毛利"这条链路一旦算错，界面上的数字**看起来完全正常**
 * （不报错、不崩、typecheck/lint 都看不见），只是与落库值不是同一个数。
 * 搬进纯模块后它才有单测（`quotation-form.spec.ts`）：金额算法必须能逐条断言。
 *
 * ## 关于 `QuotationRow`（行身份）
 *
 * 明细行 = 明细数据 + 稳定的行身份，理由见下方 `QuotationRow` 上方的原注释
 * （逐字随代码搬来，未改写）。
 */
import { z } from 'zod';
import type { UseFormReturn } from 'react-hook-form';
import { newRowKey } from '@client/src/utils/row-key';
import type {
  CreateQuotationDto,
  QuotationItemInput,
} from '@shared/api.interface';
import { round2 } from '@shared/number';

/* ── 表单 schema ─────────────────────────────────────────────────────────── */

export const quoteSchema = z.object({
  title: z.string().min(1, '报价标题不能为空'),
  customerId: z.string().min(1, '请选择客户'),
  opportunityId: z.string(),
  quoteDate: z.string().optional(),
  validUntil: z.string().optional(),
  discountPct: z.coerce.number().min(0).max(100),
  remark: z.string(),
});

export type QuoteFormData = z.output<typeof quoteSchema>;
export type QuoteFormInput = z.input<typeof quoteSchema>;

/**
 * 父组件 `useForm<QuoteFormInput, unknown, QuoteFormData>` 的返回类型。
 *
 * 表头字段子组件（`QuotationFormFields`）需要父组件的表单实例来渲染
 * `form.control`：字段值、明细、合计、提交处理器共用同一份 `form`，
 * 复制第二份必然分叉 —— 故按类型传入，而不是让子组件自己 `useForm`。
 */
export type QuoteForm = UseFormReturn<QuoteFormInput, unknown, QuoteFormData>;

/* ── 明细行 ──────────────────────────────────────────────────────────────── */

export interface QuotationItemRow {
  itemName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  estUnitCost: number;
  remark: string;
}

export interface QuotationFormPreset {
  customerId?: string;
  opportunityId?: string;
  title?: string;
  quoteDate?: string;
  validUntil?: string;
  remark?: string;
  items?: QuotationItemInput[];
}

/** 毛利红线（%）：低于它界面标红并提示 */
export const MARGIN_RED_LINE = 20;

export const EMPTY_ITEM: QuotationItemRow = {
  itemName: '',
  unit: '人天',
  quantity: 1,
  unitPrice: 0,
  discountPct: 0,
  estUnitCost: 0,
  remark: '',
};

/**
 * 表单内的明细行 = 明细数据 + 稳定的行身份。
 *
 * P-2：报价明细可“添加/删除行”，用数组下标作 React key 时，删掉中间一行后
 * React 会按位置复用后面各行的 DOM 节点，而每行的服务项名称/数量/单价都是受控 Input，
 * 表现为“删了一行，下面几行的内容错位”——不报错，但很容易带着错数据提交。
 * 身份必须在**创建行时**生成；渲染时生成会让每次重渲染 key 都变，比下标还差。
 */
export type QuotationRow = QuotationItemRow & { rowKey: string };

export const withRowKey = (row: QuotationItemRow): QuotationRow => ({
  ...row,
  rowKey: newRowKey(),
});

export const toNum = (value: string): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/* ── 合计与毛利红线 ──────────────────────────────────────────────────────── */

export interface QuotationTotals {
  /** 报价总额（含整单折扣） */
  total: number;
  /** 预估成本 */
  cost: number;
  /** 毛利率（%）；总额为 0 时为 null（不是 0 —— 两者在界面上含义不同） */
  marginPct: number | null;
}

/**
 * 报价合计 —— **与服务端落库口径逐行对齐**（T11 的客户端侧收尾）。
 *
 * ## 为什么必须与服务端同口径（原先不同，实测差 1 分）
 *
 * T11 已在服务端把口径统一为「逐行乘整单折扣、逐行 `round2`、再求和」
 * （`quotation.service.ts` 的 `computeTotals`，并与
 * `convertLineAmount`（转合同）完全同口径）。但**客户端预览没跟上**：
 *
 * ```
 * 客户端（原）： total = (Σ line_i) × (1 − 整单折扣/100)          ← 一次性乘、未逐行取整
 * 服务端（T11）：total = Σ round2( line_i × (1 − 整单折扣/100) )  ← 逐行取整
 * ```
 *
 * 实测：3 行 × 33.33、整单 9 折 →
 *   客户端 `89.991`（`formatMoney` 显示 **¥89.99**），服务端落库 **90.00**。
 *
 * ## 为什么这不是"账上错了"，但仍然必须修
 *
 * `crm_quotation.total_amount` 由服务端算出并写入，所以**账不会错**。
 * 但使用者看到的是：
 *   · 编辑弹窗的「报价总额」预览，与保存后列表/详情里的金额**差几分**；
 *   · 更重要的是**毛利红线提示基于预览值触发** —— 一个"看起来 19.99% 越线"
 *     的报价，按落库金额算可能是 20.01% 不越线（或反之），
 *     于是使用者被一个不会生效的数字引导着改价。
 *
 * 预览与落库必须是同一个数，否则"预览"这个功能本身没有意义。
 *
 * ## 实现要点
 *
 *   · 逐行 `round2(line × headerFactor)`，与 `convertLineAmount` 完全一致；
 *   · `gross` 也逐行 `round2` 后累加，与服务端 `grossAmount` 一致
 *     （行金额本身要落库，必须自洽）；
 *   · 最终 `round2` 收尾 —— 原实现少了这一步，是 1 分差异的直接来源；
 *   · `cost` 不逐行取整，与服务端一致（预估成本是参考值，不落进合计链）。
 */
export const computeQuotationTotals = (
  items: QuotationRow[],
  wholeDiscountPct: unknown,
): QuotationTotals => {
  const headerFactor = 1 - Number(wholeDiscountPct ?? 0) / 100;
  let gross = 0;
  let total = 0;
  let cost = 0;
  for (const item of items) {
    const line = item.quantity * item.unitPrice * (1 - item.discountPct / 100);
    // 行金额：逐行取整（与服务端 grossAmount 同口径）
    gross += round2(line);
    // 整单折扣：逐行施加并取整 —— 与 convertLineAmount 完全同口径
    total += round2(line * headerFactor);
    cost += item.quantity * item.estUnitCost;
  }
  const roundedTotal = round2(total);
  const roundedCost = round2(cost);
  const marginPct =
    roundedTotal > 0
      ? Math.round(((roundedTotal - roundedCost) / roundedTotal) * 10000) / 100
      : null;
  return { total: roundedTotal, cost: roundedCost, marginPct };
};

/** 毛利率是否低于红线。`<` 而不是 `<=`：恰好 20.00% 不算越线（原实现即如此） */
export const isBelowMarginLine = (marginPct: number | null): boolean =>
  marginPct !== null && marginPct < MARGIN_RED_LINE;

/* ── Radix Select 的值守卫 ───────────────────────────────────────────────── */

/**
 * Radix Select → react-hook-form 的值守卫。
 *
 * ## 被钉死的缺陷（浏览器实测复现，不是推测）
 *
 * 编辑报价单（`/crm/quotations/:id/edit`）时，**表单里的「客户」会被自动清空**，
 * 于是「保存修改」被必填校验拦住、提示"请选择客户"，**只有手动重选一次客户才能保存**。
 *
 * 实测日志（`console.log` 打点，随后已移除）：
 *
 * ```
 * customerId field render { value: "ba85266d-…", n: 0 }   ← form.reset 已回填；下拉里 0 个选项
 * customerId onValueChange ""                              ← Radix 自己回调了空值！
 * render              { customerId: "" }                   ← 刚回填的客户被抹掉
 * ```
 *
 * 机理：`customers` 是异步拉的。首帧下拉里**没有与该 `value` 匹配的
 * `SelectItem`**，Radix Select 会把"无法解析当前值"当成一次变更，
 * 主动回调 `onValueChange('')`；而这里 `onValueChange` 直接就是 `field.onChange`
 * —— 于是服务端刚读回来的客户 ID 被写成了空串。
 *
 * `关联商机` 同理（它的值也会被抹成空串，只是它非必填，所以只在保存后
 * 才看得出"关联商机丢了"）。
 *
 * ## 判据
 *
 * **一个没有"清空/不指定"选项的 Select，不允许回调空值** ——
 * 空值只可能来自 Radix 的解析失败，不可能来自用户操作。
 * 因此 `allowEmpty: false` 时忽略 `''`，保留当前值。
 */
export const applySelectChange = (
  incoming: string,
  current: string,
  options: { allowEmpty: boolean },
): string => (incoming === '' && !options.allowEmpty ? current : incoming);

/* ── 提交体 ─────────────────────────────────────────────────────────────── */

/**
 * 由表单值 + 明细行构造报价单提交体。
 *
 * ## 为什么必须区分"新建"与"编辑"
 *
 * 原实现两者共用同一个字面量，可选字段一律写成 `values.x || undefined`：
 *
 * ```ts
 * quoteDate: values.quoteDate || undefined,
 * validUntil: values.validUntil || undefined,
 * remark: values.remark || undefined,
 * ```
 *
 * `|| undefined` 把**"用户清空了"与"用户没填"折叠成同一个值**，而服务端
 * `update()` 的 PATCH 语义是 `if (dto.x !== undefined)` —— 于是**清空被静默丢弃**：
 * 使用者删掉备注、点保存、toast 报"报价单已更新"，打开还是旧备注。
 * 这正是本仓已确认的缺陷类型（`values.x || undefined`）。
 *
 * 编辑时改为**原样传空串**：服务端 `patch.quoteDate = dto.quoteDate || null`
 * 与 `patch.remark = dto.remark || null` 会把空串落成 NULL（"清空"是有效意图）。
 * 新建时保持 `|| undefined`：空串对 `date` 列是非法输入，不能进 INSERT。
 */
export const buildQuotationPayload = (params: {
  values: QuoteFormData;
  items: QuotationItemRow[];
  isEdit: boolean;
}): CreateQuotationDto => {
  const { values, items, isEdit } = params;
  const emptyToNull = (value: string | undefined) =>
    isEdit ? value : value || undefined;
  const dto: CreateQuotationDto = {
    customerId: values.customerId,
    title: values.title,
    quoteDate: emptyToNull(values.quoteDate),
    validUntil: emptyToNull(values.validUntil),
    discountPct: values.discountPct,
    remark: emptyToNull(values.remark),
    items: items.map(
      (item: QuotationItemRow): QuotationItemInput => ({
        itemName: item.itemName.trim(),
        unit: item.unit || undefined,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountPct: item.discountPct,
        estUnitCost: item.estUnitCost,
        remark: item.remark || undefined,
      }),
    ),
  };
  /*
   * `opportunityId`：编辑时必须把"清空"表达出来。Select 没有"不关联"选项，
   * 因此这里只在有值时传 —— 与改动前一致（避免把一个不存在的 UUID 传上去）。
   */
  if (values.opportunityId) dto.opportunityId = values.opportunityId;
  return dto;
};
