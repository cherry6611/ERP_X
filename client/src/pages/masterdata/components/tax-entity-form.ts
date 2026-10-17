/**
 * 纳税主体表单的纯逻辑（§5.9 拆分规则：零 React 依赖的先搬出来）。
 *
 * ## 为什么必须存在这个模块
 *
 * `TaxEntities.tsx` 的 `save()` 里有**两处"改错了界面上完全看不出来"**的计算，
 * 它们原先都内联在组件里，既无法单测，也没有任何断言拦着：
 *
 * ### ① 更新请求带上了 `code` → 整次保存被 400 拒绝
 *
 * 组件把同一份 payload 同时用于新建与编辑（`{...form, code: parsed.data.code, …}`），
 * 但服务端 `UpdateTaxEntityDto` **没有 `code` 字段**，而全局 `ValidationPipe`
 * 开了 `forbidNonWhitelisted`。于是：
 *
 * | 操作 | 结果 |
 * |---|---|
 * | 新建纳税主体 | 正常 |
 * | **编辑**纳税主体 | `400 code: property code should not exist` |
 *
 * 实测（浏览器走查）：编辑弹窗里改任何一个字段都会保存失败，界面上看到的是一句
 * 英文校验提示。**整个"编辑纳税主体"功能是坏的**，而 typecheck / lint 全绿 ——
 * 因为 `updateTaxEntity` 的入参类型是 `Partial<TaxEntity>`，`code` 在类型上合法。
 * 修法：编辑路径**不带 `code`**（编码是主键性标识，服务端本就不允许改）。
 *
 * ### ② 城建税率填成 `7%` → `Number('7%') = NaN` → JSON 里变成 `null` → **静默清空**
 *
 * `JSON.stringify({ urbanMaintRate: NaN })` 产出 `{"urbanMaintRate":null}`；
 * 服务端 `UpdateTaxEntityDto.urbanMaintRate` 的 `@IsOptional() @ValidateIf(v => v !== null)`
 * 对 `null` **跳过校验**，而 service 用 `=== undefined` 判"未传"，
 * 于是 `null` 被当成**显式清空**写库。
 *
 * 后果不是"填错没生效"，而是**把已配置好的城建税率悄悄抹掉** ——
 * 之后增值税底稿的附加税费会拒绝出数，而使用者那一刻看到的是"保存成功"。
 * `7%` 恰恰是最自然的输入（界面提示写着"市区 7"）。
 *
 * 修法：提交前**先解析**，非数字直接拦下并给出可读原因（`parseUrbanMaintRate`），
 * 绝不让 `NaN` 走进 `JSON.stringify`。
 *
 * 两处的共同点是：**都不报错、都不崩、typecheck 与 lint 都看不见**，
 * 因此它们必须落在一个能被 spec 逐条断言的地方。
 */
import { ALLOWED_RATES, type TaxpayerType } from '@shared/tax';
import type { TaxEntity } from '@shared/api.interface';

/** 纳税主体表单的可编辑状态（与 `TaxEntities.tsx` 的 `EMPTY` 同形） */
export interface TaxEntityFormState {
  code: string;
  name: string;
  uscc: string;
  taxpayerType: TaxpayerType;
  defaultOutputRate: number;
  defaultInputRate: number;
  vatFilingCycle: '' | 'monthly' | 'quarterly';
  /** 自由文本：留空 = 未配置；必须能被解析成 1 / 5 / 7 之一 */
  urbanMaintRate: string;
  vatExemptionEnabled: boolean;
  citSmallMicro: boolean | null;
  invoiceTitle: string;
  invoiceAddress: string;
  invoicePhone: string;
  invoiceBank: string;
  invoiceAccount: string;
  remark: string;
}

/** 新建/更新请求体（与 `masterDataApi.createTaxEntity` 的入参同形） */
export type TaxEntityPayload = Omit<TaxEntity, 'id' | 'isDefault' | 'status'>;

export type UrbanMaintParse =
  | { ok: true; value: number | null; message?: undefined }
  | { ok: false; value?: undefined; message: string };

/**
 * 城建税率解析。与服务端 DTO 的 `@IsIn([1, 5, 7])` 同口径 ——
 * 前端先拦一次，是为了把"静默清空"变成"看得见的拒绝"。
 *
 * 判据：**只要填了东西，就必须是一个能解析成 1/5/7 的数**；
 * 解析不出来一律 `ok: false`（而不是回落成 `null`）。
 */
export function parseUrbanMaintRate(raw: string): UrbanMaintParse {
  const text = String(raw ?? '').trim();
  // 留空是合法语义：未配置（附加税计提会拒绝出数，这是有意的严格口径）
  if (text === '') return { ok: true, value: null };
  // 显式只接受十进制数字（可带两位小数），`7%` / `7％` / `abc` 一律拒绝
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return {
      ok: false,
      message:
        '城建税率只能填 7（市区）、5（县镇）或 1（其他）；请填百分数而非小数（7% 填 7，不是 0.07，也不要带 %）',
    };
  }
  const value = Number(text);
  if (!Number.isFinite(value) || ![1, 5, 7].includes(value)) {
    return {
      ok: false,
      message: '城建税率只能填 7（市区）、5（县镇）或 1（其他）；留空表示未配置',
    };
  }
  return { ok: true, value };
}

/**
 * 构造纳税主体请求体。
 *
 * 两个入口分开（而不是一个 `isEdit` 开关返回联合类型），是为了让
 * **"编辑请求体里没有 `code`"这件事在类型层面成立**，而不用在调用点写 `as`：
 *   · `buildTaxEntityCreatePayload` → 带 `code`（`CreateTaxEntityDto` 有该字段）；
 *   · `buildTaxEntityUpdatePayload` → **不带 `code`**（`UpdateTaxEntityDto` 没有该字段，
 *     `forbidNonWhitelisted` 会把整次请求打成 400）。
 *
 * 其余归一化：
 *   · `uscc` / `vatFilingCycle`：空串在契约里是 `null`，不能让 `''` 落库；
 *   · 五个开票信息字段与 `remark`：同样空串 → `null`；
 *   · `urbanMaintRate` 必须**已经过 `parseUrbanMaintRate`**，故类型是 `number | null`
 *     —— `NaN` 在类型层面就进不来（这正是 ② 的根因所在）。
 */
interface TaxEntityPayloadArgs {
  form: TaxEntityFormState;
  core: {
    code: string;
    name: string;
    taxpayerType: TaxpayerType;
    defaultOutputRate: number;
    defaultInputRate: number;
  };
  urbanMaintRate: number | null;
}

/** 新建/更新共用的字段（**不含 `code`**） */
function basePayload({
  form,
  core,
  urbanMaintRate,
}: TaxEntityPayloadArgs): Omit<TaxEntityPayload, 'code'> {
  const orNull = (value: string): string | null => {
    const text = String(value ?? '').trim();
    return text === '' ? null : text;
  };
  return {
    name: core.name.trim(),
    uscc: orNull(form.uscc),
    taxpayerType: core.taxpayerType,
    defaultOutputRate: core.defaultOutputRate,
    defaultInputRate: core.defaultInputRate,
    vatFilingCycle: form.vatFilingCycle === '' ? null : form.vatFilingCycle,
    urbanMaintRate,
    vatExemptionEnabled: form.vatExemptionEnabled,
    citSmallMicro: form.citSmallMicro,
    invoiceTitle: orNull(form.invoiceTitle),
    invoiceAddress: orNull(form.invoiceAddress),
    invoicePhone: orNull(form.invoicePhone),
    invoiceBank: orNull(form.invoiceBank),
    invoiceAccount: orNull(form.invoiceAccount),
    remark: orNull(form.remark),
  };
}

/** 新建：带 `code` */
export function buildTaxEntityCreatePayload(
  args: TaxEntityPayloadArgs,
): TaxEntityPayload {
  return { ...basePayload(args), code: args.core.code.trim() };
}

/** 更新：**不带 `code`**（带上会被 forbidNonWhitelisted 打成 400，见文件头 ①） */
export function buildTaxEntityUpdatePayload(
  args: TaxEntityPayloadArgs,
): Omit<TaxEntityPayload, 'code'> {
  return basePayload(args);
}

/** 当前纳税人类型下可选的税率档位（与后端 `ALLOWED_RATES` 同源） */
export const allowedRatesFor = (type: TaxpayerType): readonly number[] =>
  ALLOWED_RATES[type];
