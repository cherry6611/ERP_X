/**
 * 供应商 Excel 导入/导出的纯逻辑（§5.9 / F8）。
 *
 * ## 为什么这块要单独成文件
 *
 * 原 `SuppliersPage.tsx` 的前 136 行全是**零 React 依赖的声明式代码**：
 * 4 张标签/映射表、导入列、导出列、单行解析器、zod schema。它们与组件状态
 * 无关，却因为住在组件文件里而**无法单测** —— 而它们恰恰是最该测的：
 *
 * | 行为 | 若不测的后果 |
 * |---|---|
 * | 未知「类型」→ 报错而不是静默用 `outsource` | 静默默认会把"算力资源"录成"外包服务"，供应商分类与对账口径错 |
 * | 未知「状态」→ 报错而不是静默用 `active` | 静默启用一个本该停用的供应商，可被继续用于新采购 |
 * | 评级非数字 → 报错（`Number('4星')` 是 `NaN`） | `NaN` 走到 `INSERT` 后由服务端 `numeric` 抛错，操作员只看到"导入失败" |
 * | 有错时 `dto: null` | 若不置 null，上层会拿着半成品 DTO 去建供应商 |
 * | 导出列的 `?? ''` | 漏一个就会导出空白格，收表人无法区分"空"与"漏填" |
 *
 * ## 谁在用这些映射表
 *
 * `SUPPLIER_TYPE_LABELS` / `SUPPLIER_STATUS_LABELS` **同时**被三处消费：
 * ① 页面表格列与表单下拉（中文文案）；② `SUPPLIER_EXPORT_COLUMNS`（导出中文）；
 * ③ `SUPPLIER_TYPE_TO_CODE` / `SUPPLIER_STATUS_TO_CODE`（导入时中文→代码）。
 * 分开存放必然漂移 —— 例如导出写了"算力资源"而导入表里没这个词，回导就整表被拒。
 * 放在同一文件里，`supplier-import.spec.ts` 的**导出→回导闭环**断言才能成立。
 */
import { z } from 'zod';
import type {
  ExcelImportColumnDef,
  ParsedRowResult,
} from '@client/src/components/excel/ExcelImportDialog';
import type { ExcelSheetColumn } from '@client/src/components/excel/excel-utils';
import type { CreateSupplierDto, Supplier } from '@shared/api.interface';

/* ── 标签与代码映射 ──────────────────────────────────────────────────────── */

export const SUPPLIER_TYPE_LABELS: Record<string, string> = {
  outsource: '外包服务',
  compute: '算力资源',
  storage: '存储资源',
  tool: '工具软件',
  travel: '差旅服务',
  other: '其他',
};

export const SUPPLIER_STATUS_LABELS: Record<string, string> = {
  active: '合作中',
  inactive: '停用',
};

/**
 * 供应商类型：**同时接受中文标签与英文代码**。
 *
 * 为什么要双映射：Excel 模板的列头是中文（"类型"），填表人自然写中文
 * （"算力资源"）；而**导出**的表格里「类型」列也是中文（`SUPPLIER_TYPE_LABELS`）。
 * 但同一列也可能被手填成代码（`compute`）—— 只支持一种就会让另一条路径整表被拒。
 */
export const SUPPLIER_TYPE_TO_CODE: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(SUPPLIER_TYPE_LABELS).map((
      entry: [string, string],
    ) => [entry[1], entry[0]]),
  ),
  outsource: 'outsource',
  compute: 'compute',
  storage: 'storage',
  tool: 'tool',
  travel: 'travel',
  other: 'other',
};

export const SUPPLIER_STATUS_TO_CODE: Record<string, string> = {
  active: 'active',
  inactive: 'inactive',
  合作中: 'active',
  停用: 'inactive',
};

/* ── 导入列 / 导出列 ─────────────────────────────────────────────────────── */

export const SUPPLIER_IMPORT_COLUMNS: ExcelImportColumnDef[] = [
  { header: '名称', required: true },
  { header: '类型' },
  { header: '联系人' },
  { header: '联系电话' },
  { header: '银行账户' },
  { header: '评级' },
  { header: '状态' },
  { header: '备注' },
];

export const SUPPLIER_EXPORT_COLUMNS: ExcelSheetColumn<Supplier>[] = [
  { header: '编号', value: (row: Supplier) => row.code },
  { header: '名称', value: (row: Supplier) => row.name },
  {
    header: '类型',
    value: (row: Supplier) =>
      row.type ? (SUPPLIER_TYPE_LABELS[row.type] ?? row.type) : '',
  },
  { header: '联系人', value: (row: Supplier) => row.contactName ?? '' },
  { header: '联系电话', value: (row: Supplier) => row.contactPhone ?? '' },
  { header: '银行账户', value: (row: Supplier) => row.bankAccount ?? '' },
  /*
   * ⚠️ 这里与同组其它列**有意不同**：没有 `?? ''`。
   *
   * 因为 `Supplier.rating` 是 `number`（非空），且服务端 `mapSupplier` 用
   * `Number(row.rating ?? 0)` 兜底、DB 列 `md_supplier.rating` 有 `default('0')`
   * —— `null` 在契约层就不可达，`?? ''` 是死代码。
   * 与核销/账龄那类"派生金额可能为 null"的列不同，这条不是漏写。
   * 另注：本列返回 **number** 而非 string，`exportRowsToXlsx` 会原样写入数值
   * 单元格，落进 Excel 后仍是数字（可参与求和）；若改成 `String(...)` 会让
   * 「评级」列在 Excel 里变成文本，失去排序语义。单测里对两者都做了断言。
   */
  { header: '评级', value: (row: Supplier) => row.rating },
  {
    header: '状态',
    value: (row: Supplier) => SUPPLIER_STATUS_LABELS[row.status] ?? row.status,
  },
  { header: '备注', value: (row: Supplier) => row.remark ?? '' },
];

/* ── 单行解析 ────────────────────────────────────────────────────────────── */

/**
 * 将一行 Excel 原始数据（中文表头 → 文本）映射为创建 DTO。
 *
 * 本文件**没有任何日期列**（供应商主数据不含日期字段），因此不存在
 * `employee-import.ts` 里那类"日期只匹配正则、不校验日历有效性"的风险面。
 * 有取值风险的是「评级」（数值范围）与两个枚举列（未知取值必须报错）。
 */
/*
 * ── 安全查表 ──────────────────────────────────────────────────────────────
 *
 * ⚠️ **不要改回 `TABLE[key]`。** 用方括号查字面量对象会命中
 * `Object.prototype` 上的继承属性，而它们**都是真值**：
 *
 * ```
 * SUPPLIER_STATUS_TO_CODE['constructor']   // [Function: Object]  ← 真值
 * SUPPLIER_STATUS_TO_CODE['toString']      // [Function: toString] ← 真值
 * SUPPLIER_STATUS_TO_CODE['__proto__']     // [object Object]      ← 真值
 * ```
 *
 * 于是 `if (mapped) status = mapped;` 被走通、**不报错**，并把一个**函数**
 * 塞进 `status`。契约是 `status: string`，而函数在 `JSON.stringify` 时被
 * **静默丢弃**（axios 用它序列化请求体），服务端 `@IsOptional() @IsString()`
 * 收到的是"没传" → 落库为默认值。**操作者看到导入成功、零错误，
 * 而那一列的值被换成了默认值。**
 *
 * 实测（修复前，`parseSupplierRow`）：`类型='constructor'` → `errors=0`，
 * DTO 的 `type` 是 `function Object() { [native code] }`。
 *
 * 对全部合法取值行为完全一致（它们本来就是自有键）—— 纯安全性修正。
 */
function lookupOwn(
  table: Record<string, string>,
  key: string,
): string | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

export function parseSupplierRow(raw: Record<string, string>): ParsedRowResult<CreateSupplierDto> {
  const errors: string[] = [];
  const name: string = (raw['名称'] ?? '').trim();
  if (!name) errors.push('名称不能为空');
  const typeRaw: string = (raw['类型'] ?? '').trim();
  let type: string = 'outsource';
  if (typeRaw) {
    const mapped: string | undefined = lookupOwn(SUPPLIER_TYPE_TO_CODE, typeRaw);
    if (mapped) {
      type = mapped;
    } else {
      // 未知取值报错**而不是**沿用默认值：静默默认会把"算力资源"录成
      // "外包服务"，而供应商类型决定成本归集与对账口径
      errors.push(
        `类型「${typeRaw}」无效，应为 外包服务/算力资源/存储资源/工具软件/差旅服务/其他`,
      );
    }
  }
  const contactName: string = (raw['联系人'] ?? '').trim();
  const contactPhone: string = (raw['联系电话'] ?? '').trim();
  const bankAccount: string = (raw['银行账户'] ?? '').trim();
  const ratingRaw: string = (raw['评级'] ?? '').trim();
  let rating: number = 0;
  if (ratingRaw) {
    const parsed: number = Number(ratingRaw);
    // `Number('4星')` 是 NaN —— `Number.isFinite` 一并拦住 NaN 与 Infinity，
    // 否则 NaN 会走到 INSERT 再由服务端 numeric 抛错（操作员看不到行号）
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 5) {
      errors.push('评级需为 0-5 的数字');
    } else {
      rating = parsed;
    }
  }
  const statusRaw: string = (raw['状态'] ?? '').trim();
  let status: string = 'active';
  if (statusRaw) {
    const mapped: string | undefined = lookupOwn(SUPPLIER_STATUS_TO_CODE, statusRaw);
    if (mapped) {
      status = mapped;
    } else {
      // 同理：静默默认 `active` 会让"停用"的供应商被重新启用并可用于新采购
      errors.push(`状态「${statusRaw}」无效，应为 合作中/停用`);
    }
  }
  const remark: string = (raw['备注'] ?? '').trim();
  // 有任何错误就**不返回 DTO**：半成品 DTO 会被上层误用去建供应商
  if (errors.length > 0) return { dto: null, errors };
  return {
    dto: {
      name,
      type,
      // 空串转 undefined：空串会被服务端当成"填了个空联系人"，
      // undefined 才是"没填"
      contactName: contactName || undefined,
      contactPhone: contactPhone || undefined,
      bankAccount: bankAccount || undefined,
      rating,
      status,
      remark: remark || undefined,
    },
    errors: [],
  };
}

/* ── 表单 schema ─────────────────────────────────────────────────────────── */

export const supplierSchema = z.object({
  name: z.string().min(1, '供应商名称不能为空'),
  type: z.string().min(1, '请选择供应商类型'),
  contactName: z.string(),
  contactPhone: z.string(),
  bankAccount: z.string(),
  rating: z.coerce.number().min(0).max(5),
  status: z.string(),
  remark: z.string(),
  taxEntityId: z.string(),
  defaultTaxRate: z.string(),
});

export type SupplierFormData = z.output<typeof supplierSchema>;
export type SupplierFormInput = z.input<typeof supplierSchema>;

/**
 * 新建供应商表单的空值。
 *
 * 原先这段字面量在组件里**出现两次**（`useForm` 的 `defaultValues` 与
 * `openCreate` 里的 `form.reset`）。两份内容必须逐字相同，否则"新建"按钮
 * 是否重置成初始值会随打开路径而变（先编辑再新建就会残留上一次的值）。
 * 提到这里之后只剩一份，测试也就能钉住它。
 */
export const EMPTY_FORM: SupplierFormInput = {
  name: '',
  type: 'outsource',
  contactName: '',
  contactPhone: '',
  bankAccount: '',
  rating: 0,
  status: 'active',
  remark: '',
  taxEntityId: '',
  defaultTaxRate: '',
};
