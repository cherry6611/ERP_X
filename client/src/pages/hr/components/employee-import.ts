/**
 * 员工 Excel 导入的解析与校验（§5.9 / F8）。
 *
 * ## 为什么这块最值得抽出来测
 *
 * `parseEmployeeRow` 是 **84 行的纯函数**，也是员工批量导入的**唯一入口闸门**：
 * HR 拿到一份几百行的 Excel，一次导入进来几百个员工。它拦不住的错误会**批量落库**，
 * 而且清理成本随行数线性增长。具体风险点：
 *
 * | 行为 | 若不测的后果 |
 * |---|---|
 * | 日期归一化 `2026/1/5 → 2026-01-05` | HR 用 Excel 默认的斜杠日期，全表被判格式错 |
 * | 部门/岗位按**中文名**映射成 ID | 名称拼错一个字就落错部门，或整行被拒 |
 * | 用工类型/状态按**中英文双映射** | 只支持英文时，HR 填"全职"整表被拒 |
 * | 未知取值 → 报错而不是静默用默认值 | 静默默认会把"实习"录成"全职"（薪资口径错） |
 * | 有错时 `dto: null` | 若不置 null，上层会拿着半成品 DTO 去建员工 |
 *
 * ## 为什么 `EMPTY_FORM` 与 schema 也在这里
 *
 * 它们与导入共用同一组「中英文 → 代码」映射表（`EMPLOYEE_STATUS_TO_CODE` /
 * `EMPLOYMENT_TYPE_TO_CODE`）。放在一起才能保证"Excel 导入用的映射"与
 * "表单默认值用的映射"是同一份 —— 分开就会各自漂移。
 */
import { z } from 'zod';
import type {
  ExcelImportColumnDef,
  ParsedRowResult,
} from '@client/src/components/excel/ExcelImportDialog';
import type { ExcelSheetColumn } from '@client/src/components/excel/excel-utils';
import {
  EMPLOYEE_STATUS_LABELS,
  EMPLOYMENT_TYPE_LABELS,
} from './HrStatusBadge';
import type { CreateEmployeeDto, Employee } from '@shared/api.interface';

/* ── 表单 schema ─────────────────────────────────────────────────────────── */

export const employeeSchema = z.object({
  name: z.string().min(1, '请填写姓名'),
  departmentId: z.string(),
  positionId: z.string(),
  hireDate: z.string(),
  employmentType: z.string(),
  phone: z.string(),
  platformUserId: z.string(),
  supplierId: z.string(),
  ssCityCode: z.string(),
  /*
   * ⚠️ **必须校验**，不能只写 `z.string()`。
   *
   * 本轮修复的一处**静默数据丢失**。原先这里是裸 `z.string()`，而控件是
   * 自由文本 `<Input placeholder="可选，默认按应发" />`，提交路径是：
   *
   * ```
   * values.ssBase = 'abc'                    // 用户随手敲错
   *   → Number('abc') === NaN                // EmployeeFormDialog 的 toUpdateDto
   *     → JSON.stringify({ssBase: NaN})      // axios 序列化 → {"ssBase":null}
   *       → 服务端 @IsOptional() @IsNumber() @Min(0)
   *         对 null **跳过校验**（class-validator 的 IsOptional 对 null/undefined 都跳过）
   *         → hr-core.service.ts: `...(dto.ssBase != null ? {ssBase: …} : {})`
   * ```
   *
   * 在**更新**路径上 `toUpdateDto` 给的是 `null`（不是 `undefined`），
   * 而服务端 `UpdateEmployeeDto.ssBase?: number | null` 允许 null —— 于是
   * `ssBase` 被**清空**。使用者看到的是"保存成功"，而缴费基数（一个影响
   * 社保计算的金额）被悄悄抹掉了。
   *
   * 修法是在**入口**拦住非数字输入，让使用者看到可理解的报错，
   * 而不是让一个手误变成一次静默的数据破坏。
   *
   * 判据说明：
   *   · 允许空串（`''`）—— 那是"未填"，提交时会变成 `undefined`（创建）
   *     或 `null`（更新，表示有意清空），这是**唯一**合法的清空方式；
   *   · 允许小数（缴费基数可能带两位小数）与千分位逗号（使用者会照工资单抄）；
   *   · 允许首尾空白（复制粘贴常带空格）—— **先 trim 再判**，否则
   *     `' 5000 '` 会被拒，而使用者的意图显然是 5000；
   *   · 拒绝负数（不存在负的缴费基数）、拒绝 `abc`/`1e5` 之类。
   */
  ssBase: z
    .string()
    .refine(
      (value) => {
        const trimmed = value.trim();
        if (trimmed === '') return true;
        return /^\d{1,10}(\.\d{1,2})?$/.test(trimmed.replace(/,/g, ''));
      },
      '缴费基数必须是非负数字（可含两位小数）',
    ),
  status: z.string().min(1, '请选择状态'),
});

export type EmployeeFormData = z.output<typeof employeeSchema>;
export type EmployeeFormInput = z.input<typeof employeeSchema>;

export const EMPTY_FORM: EmployeeFormInput = {
  name: '',
  departmentId: '',
  positionId: '',
  hireDate: '',
  employmentType: 'full_time',
  phone: '',
  platformUserId: '',
  supplierId: '',
  ssCityCode: '',
  ssBase: '',
  status: 'probation',
};

/* ── Excel 中英文 → 代码 映射 ────────────────────────────────────────────── */

/**
 * 员工状态：**同时接受代码与中文**。
 *
 * 为什么要双映射：Excel 模板里列头是中文（"状态"），HR 自然填中文（"在职"），
 * 但导出/回导的表格里是代码（`active`）。只支持一种就会让另一条路径整表被拒。
 */
export const EMPLOYEE_STATUS_TO_CODE: Record<string, string> = {
  probation: 'probation',
  active: 'active',
  resigned: 'resigned',
  试用期: 'probation',
  在职: 'active',
  已离职: 'resigned',
};

/** 用工类型：同上，双映射 */
export const EMPLOYMENT_TYPE_TO_CODE: Record<string, string> = {
  full_time: 'full_time',
  part_time: 'part_time',
  flex: 'flex',
  intern: 'intern',
  dispatch: 'dispatch',
  全职: 'full_time',
  兼职: 'part_time',
  灵活用工: 'flex',
  实习: 'intern',
  劳务派遣: 'dispatch',
};

/* ── 导入列 / 导出列 ─────────────────────────────────────────────────────── */

export const EMPLOYEE_IMPORT_COLUMNS: ExcelImportColumnDef[] = [
  { header: '姓名', required: true },
  { header: '部门' },
  { header: '岗位' },
  { header: '入职日期' },
  { header: '用工类型' },
  { header: '状态' },
  { header: '手机号' },
  { header: '备注' },
];

export const EMPLOYEE_EXPORT_COLUMNS: ExcelSheetColumn<Employee>[] = [
  { header: '编号', value: (row: Employee) => row.code },
  { header: '姓名', value: (row: Employee) => row.name },
  { header: '部门', value: (row: Employee) => row.departmentName ?? '' },
  { header: '岗位', value: (row: Employee) => row.position ?? '' },
  { header: '入职日期', value: (row: Employee) => row.hireDate ?? '' },
  {
    header: '用工类型',
    value: (row: Employee) =>
      (row.employmentType && EMPLOYMENT_TYPE_LABELS[row.employmentType]) ||
      row.employmentType ||
      '',
  },
  {
    header: '状态',
    value: (row: Employee) => EMPLOYEE_STATUS_LABELS[row.status] ?? row.status,
  },
  { header: '手机号', value: (row: Employee) => row.phone ?? '' },
];

/* ── 单行解析 ────────────────────────────────────────────────────────────── */

/**
 * 将一行 Excel 原始数据映射为创建 DTO，部门/岗位按名称映射为 ID。
 *
 * @param raw              一行原始单元格（列头 → 文本值）
 * @param departmentByName 部门中文名 → ID
 * @param positionByName   岗位中文名 → ID
 */
/*
 * ── 安全查表 ──────────────────────────────────────────────────────────────
 *
 * ⚠️ **不要改回 `TABLE[key]`。** 用方括号查字面量对象会命中
 * `Object.prototype` 上的继承属性，而它们**都是真值**：
 *
 * ```
 * EMPLOYEE_STATUS_TO_CODE['constructor']      // [Function: Object]  ← 真值
 * EMPLOYEE_STATUS_TO_CODE['toString']         // [Function: toString] ← 真值
 * EMPLOYEE_STATUS_TO_CODE['__proto__']        // [object Object]      ← 真值
 * ```
 *
 * 于是 `if (mapped) status = mapped;` 这条分支被走通，**不报错**，
 * 并把一个**函数**塞进 `status` 字段。而契约是 `status: string`，
 * 函数在 `JSON.stringify` 时被**静默丢弃**（axios 用它序列化请求体），
 * 服务端 `@IsOptional() @IsString()` 收到的就是"没传"，
 * 最终落库为默认值（员工→`probation`，客户→`active`）——
 * **操作者看到导入成功、零错误，而那一列的值被换成了默认值**。
 *
 * 实测（修复前，`parseEmployeeRow`）：
 * ```
 * 用工类型='constructor' → errors=0, employmentType=function Object() { [native code] }
 * ```
 *
 * 修法是只认**自有键**。对全部合法取值（代码与中文标签）行为完全一致 ——
 * 它们本来就是自有键，所以这是一次纯安全性修正，不改变任何正常路径。
 */
function lookupOwn(
  table: Record<string, string>,
  key: string,
): string | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}
export function parseEmployeeRow(
  raw: Record<string, string>,
  departmentByName: Map<string, string>,
  positionByName: Map<string, string>,
): ParsedRowResult<CreateEmployeeDto> {
  const errors: string[] = [];
  const name: string = (raw['姓名'] ?? '').trim();
  if (!name) errors.push('姓名不能为空');

  const departmentName: string = (raw['部门'] ?? '').trim();
  let departmentId: string | undefined;
  if (departmentName) {
    const matched: string | undefined = departmentByName.get(departmentName);
    if (matched) {
      departmentId = matched;
    } else {
      // 名称对不上就报错而不是留空：留空会建出"无部门员工"，
      // 而部门影响费用归属与审批链，静默缺失比导入失败严重
      errors.push(`部门「${departmentName}」不存在`);
    }
  }

  const positionName: string = (raw['岗位'] ?? '').trim();
  let positionId: string | undefined;
  if (positionName) {
    const matched: string | undefined = positionByName.get(positionName);
    if (matched) {
      positionId = matched;
    } else {
      errors.push(`岗位「${positionName}」不存在`);
    }
  }

  const hireDateRaw: string = (raw['入职日期'] ?? '').trim();
  let hireDate: string | undefined;
  if (hireDateRaw) {
    /*
     * 归一化分隔符：Excel 的日期单元格常被导出成 `2026/1/5` 或 `2026.1.5`，
     * 而契约要求 `YYYY-MM-DD`。不归一化会让 HR"照模板填"却整表被拒。
     * 同时补零（`2026-1-5` → `2026-01-05`）—— 服务端按字符串比较日期，
     * 不补零会让 `2026-1-5 < 2026-01-05` 这类比较出错。
     */
    const normalized: string = hireDateRaw.replace(/[/.]/g, '-');
    const matched: RegExpMatchArray | null = normalized.match(
      /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
    );
    if (!matched) {
      errors.push('入职日期格式应为 YYYY-MM-DD');
    } else {
      const year = Number(matched[1]);
      const month = Number(matched[2]);
      const day = Number(matched[3]);
      /*
       * ⚠️ 只做正则匹配是不够的 —— 正则只约束"是 4-2-2 位数字"，
       * **不约束取值范围**。原实现因此放过了 `2026-13-01`（13 月）与
       * `2026-02-31`（2 月 31 日）这类**不存在的日期**，它们会以字符串
       * 形式一路走到 `INSERT`，再由 PostgreSQL 的 `date` 类型在**服务端**
       * 抛错。后果：
       *   · HR 只看到"导入失败"，不知道是哪一行哪一列 ——
       *     逐行解析器本可以指出"第 37 行 入职日期 2026-13-01 不存在"；
       *   · 整批导入因为一行脏日期而全部回滚，而正确的那几百行也白填了。
       *
       * 这里补齐范围校验，并用 **Date 回环**拦住"月份合法但该月没有这一天"
       * （`2026-02-31`）：`Date` 会把越界日期**顺延**（2 月 31 日 → 3 月 3 日），
       * 因此"构造后再读回来是否与原值一致"就是最省事的日历有效性判据 ——
       * 比手写闰年表可靠（闰年规则本身容易写错，2100 年不是闰年）。
       *
       * 用 `Date.UTC` 而不是 `new Date(y, m, d)`：后者按**本地时区**构造，
       * 某些时区偏移下回环比较会偏一天。与 `utils/format.ts` 同一思路 ——
       * 日期运算不依赖运行环境时区。
       */
      const probe = new Date(Date.UTC(year, month - 1, day));
      const isRealDate =
        probe.getUTCFullYear() === year &&
        probe.getUTCMonth() === month - 1 &&
        probe.getUTCDate() === day;
      if (!isRealDate) {
        errors.push(
          `入职日期「${hireDateRaw}」不是一个真实存在的日期（请检查月份与日期）`,
        );
      } else {
        hireDate = `${matched[1]}-${matched[2].padStart(2, '0')}-${matched[3].padStart(2, '0')}`;
      }
    }
  }

  const employmentTypeRaw: string = (raw['用工类型'] ?? '').trim();
  let employmentType: string = 'full_time';
  if (employmentTypeRaw) {
    const mapped: string | undefined = lookupOwn(
      EMPLOYMENT_TYPE_TO_CODE,
      employmentTypeRaw,
    );
    if (mapped) {
      employmentType = mapped;
    } else {
      // 未知取值报错而**不是**沿用默认值：静默默认会把"实习"录成"全职"，
      // 而用工类型决定成本归集口径（灵活用工进 flex_labor）
      errors.push(
        `用工类型「${employmentTypeRaw}」无效，应为 全职/兼职/灵活用工/实习/劳务派遣`,
      );
    }
  }

  const statusRaw: string = (raw['状态'] ?? '').trim();
  let status: string = 'probation';
  if (statusRaw) {
    const mapped: string | undefined = lookupOwn(
      EMPLOYEE_STATUS_TO_CODE,
      statusRaw,
    );
    if (mapped) {
      status = mapped;
    } else {
      errors.push(`状态「${statusRaw}」无效，应为 试用期/在职/已离职`);
    }
  }

  const phone: string = (raw['手机号'] ?? '').trim();
  const remark: string = (raw['备注'] ?? '').trim();

  // 有任何错误就**不返回 DTO**：半成品 DTO 会被上层误用去建员工
  if (errors.length > 0) return { dto: null, errors };
  return {
    dto: {
      name,
      departmentId,
      positionId,
      hireDate,
      employmentType,
      phone: phone || undefined,
      status,
      remark: remark || undefined,
    },
    errors: [],
  };
}
