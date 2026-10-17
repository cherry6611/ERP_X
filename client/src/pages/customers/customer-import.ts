/**
 * 客户主数据的纯逻辑（§5.9 / F8）：Excel 导入行解析、导出列、表单 schema 与状态字典。
 *
 * ## 为什么从 `CustomersPage.tsx` 里搬出来
 *
 * 这四块合计约 120 行，**零 React 依赖**（不碰 hooks / JSX / toast / API / 路由），
 * 原先占满了页面文件开头 —— 打开 `CustomersPage.tsx` 要先读 120 行声明才看到组件。
 * 更重要的收益是它们现在**可被单测**（`customer-import.spec.ts`）：
 *
 * | 模块 | 不看单测就发现不了的行为 |
 * |---|---|
 * | `parseCustomerRow` | 它是**批量导入的唯一闸门**：一次几百行，拦不住的错误会**批量落库** |
 * | `CUSTOMER_EXPORT_COLUMNS` | 取错字段在界面上完全看不出来（导出照样成功，只是数字落在错的列里） |
 * | `customerSchema` | 改错一个 `min`/`max` 就放进脏数据（账期 0-365 是业务门槛） |
 * | `CUSTOMER_STATUS_TO_CODE` | 中文→代码映射漏一个，那条路径整表被拒 |
 *
 * ## 导入解析的四条约定（都有断言兜着）
 *
 * ① **未知取值报错，不静默用默认值** —— 信用等级与状态都必须在白名单内。
 *    静默默认是最坏的失败模式：操作员写错一个状态，客户被录成另一个状态，
 *    而他看到的是"导入成功"。本文件里的状态查表因此必须判**自有键**（见
 *    `parseCustomerRow` 内那段修复说明）。
 * ② **必填项 trim 后判空** —— Excel 里"看起来有字"的单元格常是全空格。
 * ③ **有错就 `dto: null`** —— 半成品 DTO 会被上层拿去建客户。
 * ④ **错误聚合** —— 一行里多个格子写错要一次全报，而不是让操作员改一格跑一次。
 *
 * ⚠️ 本页导入**没有日期列**，所以员工 / 供应商导入踩过的"日期只匹配正则、
 * 不校验日历有效性"那个坑在这里不存在（相应地，这里也没有可复刻的日期逻辑）。
 * 数值列（信用额度 / 账期）的范围校验与已知的服务端精度缺口见
 * `parseCustomerRow` 内的逐条注释。
 *
 * ## 默认值同源
 *
 * `CUSTOMER_EMPTY_FORM`（表单新建默认值）与 `parseCustomerRow` 的缺省值
 * （B / 30 / prospect）必须一致 —— 否则"手填一个客户"与"导入一个客户"
 * 会得到两条不同的记录。两者放同一文件、由同一批断言覆盖。
 */
import { z } from 'zod';
import type {
  ExcelImportColumnDef,
  ParsedRowResult,
} from '@client/src/components/excel/ExcelImportDialog';
import type { ExcelSheetColumn } from '@client/src/components/excel/excel-utils';
import type { CreateCustomerDto, Customer } from '@shared/api.interface';

/* ── 状态字典（代码 ↔ 中文，双向） ───────────────────────────────────────── */

export const CUSTOMER_STATUS_LABELS: Record<string, string> = {
  active: '合作中',
  inactive: '停用',
  prospect: '潜在客户',
};

/**
 * 客户状态：**同时接受代码与中文**。
 *
 * 为什么要双映射：导入模板的列头是中文（"状态"），操作员自然填中文（"合作中"）；
 * 但导出用的是 `CUSTOMER_STATUS_LABELS`，回导时表里是中文、代码两种形态都可能出现
 * （代码形态来自手工改过的文件与接口调用）。只支持一种就会让另一条路径整行被拒。
 */
export const CUSTOMER_STATUS_TO_CODE: Record<string, string> = {
  active: 'active',
  inactive: 'inactive',
  prospect: 'prospect',
  合作中: 'active',
  停用: 'inactive',
  潜在客户: 'prospect',
};

/* ── 表单 schema 与默认值 ────────────────────────────────────────────────── */

export const customerSchema = z.object({
  name: z.string().min(1, '客户名称不能为空'),
  uscc: z.string(),
  industry: z.string(),
  creditLevel: z.string(),
  creditLimit: z.coerce.number().min(0),
  termsDays: z.coerce.number().min(0).max(365),
  status: z.string(),
  remark: z.string(),
  taxEntityId: z.string(),
  defaultTaxRate: z.string(),
});

export type CustomerFormData = z.output<typeof customerSchema>;
export type CustomerFormInput = z.input<typeof customerSchema>;

/**
 * 新建客户的表单默认值。
 *
 * 与 `parseCustomerRow` 的缺省值对齐（信用等级 B、账期 30、状态潜在客户）：
 * 两个入口给出不同的默认值，会让"手填"与"导入"出来的客户在被问到
 * "这条是导入的还是手填的"时无法自证。
 *
 * ⚠️ 调用方用 `{ ...CUSTOMER_EMPTY_FORM }` 展开而不是直接传这个对象本身：
 * react-hook-form 的 `defaultValues`/`reset` 需要一个**每次调用都全新**的对象
 * （原实现是行内字面量，天然是新的）。传同一份引用会让表单状态与这份常量
 * 共享引用，改一处等于改全局默认值。
 */
export const CUSTOMER_EMPTY_FORM: CustomerFormInput = {
  name: '',
  uscc: '',
  industry: '',
  creditLevel: 'B',
  creditLimit: 0,
  termsDays: 30,
  status: 'prospect',
  remark: '',
  taxEntityId: '',
  defaultTaxRate: '',
};

/* ── 导入列 / 导出列 ─────────────────────────────────────────────────────── */

export const CUSTOMER_IMPORT_COLUMNS: ExcelImportColumnDef[] = [
  { header: '名称', required: true },
  { header: '统一社会信用代码' },
  { header: '行业' },
  { header: '信用等级' },
  { header: '信用额度' },
  { header: '账期（天）' },
  { header: '状态' },
  { header: '备注' },
];

/**
 * 导出列。
 *
 * **为什么可空字段一律 `?? ''`**：`exportRowsToXlsx` 虽然也会把 `null`/`undefined`
 * 统一成空串（`excel-utils.ts` 的 `cell === null || cell === undefined ? '' : cell`），
 * 但这里仍逐列显式兜底 —— 导出列定义是**唯一**能表达"这一列允许为空"的地方，
 * 少一个 `?? ''` 就意味着那一列依赖下游的兜底。
 *
 * **为什么 `编号`/`信用额度`/`账期（天）` 三列没有 `?? ''`**：不是漏写。
 * `shared/api.interface.ts` 的 `Customer` 里 `code: string`、`creditLimit: number`、
 * `termsDays: number` 都**非空**（服务端 `toCustomer` 也是 `Number(row.creditLimit ?? 0)`、
 * `row.termsDays ?? 30`），这里再加兜底反而会把"契约说不会为空"这件事掩盖掉。
 * 单测对这三列显式断言了这条不对称是有意的。
 *
 * **`状态` 列为什么用 `?? row.status` 兜底**：字典里没有的代码（历史数据/接口写入）
 * 要导出**原值**而不是空串 —— 空串会让接收方分不清"没这个状态"和"导出漏了这一格"。
 * 这也顺手保证了导出→回导的闭环：字典内的值导出成中文、回导能映射回代码。
 */
export const CUSTOMER_EXPORT_COLUMNS: ExcelSheetColumn<Customer>[] = [
  { header: '编号', value: (row: Customer) => row.code },
  { header: '名称', value: (row: Customer) => row.name },
  { header: '统一社会信用代码', value: (row: Customer) => row.uscc ?? '' },
  { header: '行业', value: (row: Customer) => row.industry ?? '' },
  { header: '信用等级', value: (row: Customer) => row.creditLevel ?? '' },
  { header: '信用额度', value: (row: Customer) => row.creditLimit },
  { header: '账期（天）', value: (row: Customer) => row.termsDays },
  {
    header: '状态',
    value: (row: Customer) => CUSTOMER_STATUS_LABELS[row.status] ?? row.status,
  },
  { header: '备注', value: (row: Customer) => row.remark ?? '' },
];

/* ── 单行解析 ────────────────────────────────────────────────────────────── */

/**
 * 导入判重键：**trim 过的名称**。
 *
 * 与页面传进来的 `existingKeys`（`data.items.map(row => row.name.trim())`）必须是
 * 同一个算法 —— 两边不一致会造成"列表里已有这个客户，但导入说没重复"，
 * 于是同一个客户被建两次（`md_customer` 只有 `code` 唯一，`name` 不唯一）。
 * 返回空串表示"无法判重"（名称为空的行本来就会被解析器拒掉）。
 */
export function customerImportRowKey(raw: Record<string, string>): string {
  return (raw['名称'] ?? '').trim();
}

/**
 * 将一行 Excel 原始数据映射为创建 DTO。
 *
 * 缺省值（与 `CUSTOMER_EMPTY_FORM` 同源）：信用等级 `B`、账期 `30` 天、状态 `潜在客户`；
 * 非必填文本列留空时给 `undefined`（空串会被服务端当成"填了个空值"）。
 */
export function parseCustomerRow(raw: Record<string, string>): ParsedRowResult<CreateCustomerDto> {
  const errors: string[] = [];
  const name: string = (raw['名称'] ?? '').trim();
  if (!name) errors.push('名称不能为空');
  const uscc: string = (raw['统一社会信用代码'] ?? '').trim();
  const industry: string = (raw['行业'] ?? '').trim();
  const creditLevelRaw: string = (raw['信用等级'] ?? '').trim();
  let creditLevel: string = 'B';
  if (creditLevelRaw) {
    const upper: string = creditLevelRaw.toUpperCase();
    if (upper === 'A' || upper === 'B' || upper === 'C') {
      creditLevel = upper;
    } else {
      errors.push(`信用等级「${creditLevelRaw}」无效，只能为 A、B、C`);
    }
  }
  /*
   * 信用额度：`Number()` 而不是 `parseFloat` —— `parseFloat('100abc')` 会得到 100
   * 而不报错，`Number('100abc')` 得到 NaN，正好落进下面的报错分支。
   *
   * ⚠️ 已知的服务端精度缺口（本次**未**在解析器里补，理由见下）：
   *   · 列是 `numeric(18,2)`（金额档，`server/database/schema.ts` 的 `md_customer.credit_limit`），
   *     所以 `100.555` 会被数据库**静默四舍五入**成 `100.56`，`0.001` 会变成 `0.00`；
   *   · 更新接口 `UpdateCustomerDto` 有 `@IsNumber({ maxDecimalPlaces: 2 })`，
   *     而导入走的 `CreateCustomerDto`（`master-data.dto.ts`）只有 `@IsNumber() @Min(0)` —— 
   *     服务端自己就没拦。
   * 为什么不在解析器里加"最多 2 位小数"：**表单走的也是同一个 Create 接口与同一个
   * 宽松 schema**（`customerSchema.creditLimit` 只有 `min(0)`），只收紧导入会让
   * "手填 0.001"照样成功、"导入 0.001"被拒 —— 不一致比现状更难解释。
   * 真正的修法是在 `server/modules/master-data/master-data.dto.ts` 的
   * `CreateCustomerDto.creditLimit` / `termsDays` 上补齐与 Update 同款的校验
   * （小数点位数 + `numeric(18,2)` 能容纳的量级上界），那不在本次「页面拆分」的
   * 改动范围内 —— 表单与导入会同时被那次修改修好。
   */
  const creditLimitRaw: string = (raw['信用额度'] ?? '').trim();
  let creditLimit: number = 0;
  if (creditLimitRaw) {
    const parsed: number = Number(creditLimitRaw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      errors.push('信用额度需为不小于 0 的数字');
    } else {
      creditLimit = parsed;
    }
  }
  /*
   * 账期：0-365 的**整数**。上限 365 比服务端的校验更严（Create 只有 `@Min(0)`，
   * Update 是 `@Max(3650)`），这是页面自己的业务门槛 —— 表单输入框
   * `max={365}` 与 `customerSchema.termsDays` 也是同一个数，三处必须一致。
   * `Number.isInteger` 顺带拦住 `NaN`（`Number.isInteger(NaN) === false`）。
   */
  const termsDaysRaw: string = (raw['账期（天）'] ?? '').trim();
  let termsDays: number = 30;
  if (termsDaysRaw) {
    const parsed: number = Number(termsDaysRaw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 365) {
      errors.push('账期需为 0-365 的整数');
    } else {
      termsDays = parsed;
    }
  }
  const statusRaw: string = (raw['状态'] ?? '').trim();
  let status: string = 'prospect';
  if (statusRaw) {
    /*
     * ⚠️ 缺陷修复（本轮）：必须判"**自有键**命中"，不能只看查表结果是否为真值。
     *
     * `CUSTOMER_STATUS_TO_CODE` 声明成 `Record<string, string>`，运行期却仍是普通对象：
     * **继承自 `Object.prototype` 的键**（`constructor` / `toString` / `valueOf` /
     * `hasOwnProperty` / `__proto__` …）会被查出来，而且都是**真值**：
     *
     *     CUSTOMER_STATUS_TO_CODE['constructor']  →  [Function: Object]   // truthy
     *
     * 于是 `mapped` 为真、走 `status = mapped` 分支、**不报错**，返回的 DTO 里
     * `status` 是一个**函数**。而 `ParsedRowResult<CreateCustomerDto>` 声明的是
     * `CreateCustomerDto`，`shared/api.interface.ts` 写明 `status?: string` ——
     * 即解析器返回了**违反自身声明类型**的对象。
     *
     * 危害链（"白名单外的取值静默变成某个状态"，可复现）：
     *   ① `client/src/api/master-data/index.ts` 的 `createCustomer` 用 axios `post`
     *      发送该 DTO，axios 默认 `JSON.stringify` 序列化请求体；
     *   ② `JSON.stringify({ status: [Function] })` → `{}`，**函数值被整个丢弃**；
     *   ③ 服务端 `master-data.dto.ts` 的 `status` 是 `@IsOptional() @IsString()`，
     *      收到 `undefined` 视为"没填"，**不报 400**；
     *   ④ `master-data.service.ts` 的 `createCustomer` 回落 `dto.status ?? 'active'`
     *      → 客户被静默建成**合作中**。
     * 全程 0 条错误：导入预览显示"校验通过"、结果列显示"导入成功"。
     *
     * 修法只影响"非自有键"这一种输入：合法取值（三个代码与三个中文标签）都是自有键，
     * 走同一分支、得到同一结果，**行为零变更**；白名单外的取值则落到
     * `else` 分支报错 —— 也就是这段代码本来就想要的语义。
     */
    const mapped: string | undefined = Object.prototype.hasOwnProperty.call(
      CUSTOMER_STATUS_TO_CODE,
      statusRaw,
    )
      ? CUSTOMER_STATUS_TO_CODE[statusRaw]
      : undefined;
    if (mapped) {
      status = mapped;
    } else {
      errors.push(`状态「${statusRaw}」无效，应为 合作中/停用/潜在客户`);
    }
  }
  const remark: string = (raw['备注'] ?? '').trim();
  if (errors.length > 0) return { dto: null, errors };
  return {
    dto: {
      name,
      uscc: uscc || undefined,
      industry: industry || undefined,
      creditLevel,
      creditLimit,
      termsDays,
      status,
      remark: remark || undefined,
    },
    errors: [],
  };
}
