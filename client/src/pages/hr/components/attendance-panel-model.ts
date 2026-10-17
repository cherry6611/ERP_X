/**
 * 考勤 / 请假面板的**声明式纯逻辑**（§5.9 / F8 拆分）。
 *
 * ## 从 `AttendancePanel.tsx` 里搬出来的是什么
 *
 * 四块，全部**零 React 依赖**（不含 hook、不含 JSX、不碰组件状态）：
 *
 * | 块 | 原位置 | 为什么必须能单测 |
 * |---|---|---|
 * | `AMENDMENT_STATUS_LABELS` | 组件顶部 | 缺一个 key，补卡表格里就直接显示英文 `approved`；文案写错（两个 code 同一个中文）则审批人**分不清**已通过与待审批 |
 * | 4 个 zod schema | 组件顶部 | 它们是**表单的唯一入口闸门**：`days`/`totalDays` 的门槛改错一位，脏数据就落库，而报错只在提交时以 toast 一闪而过 |
 * | 表单默认值 | `useForm({ defaultValues })` 与提交后 `reset(...)` **各写了一遍** | 两处字面量会**各自漂移**：初始值与提交后重置值不一致时，第二次打开弹窗的行为与第一次不同，且没人会注意到 |
 * | `balanceColumns` | 组件中部 | 列定义错了在界面上**看不出来**：「已用（天）」与「剩余（天）」互换后两列都是**合理数字**，只有逐列断言能拦住 |
 *
 * ## 为什么默认值提成常量而不是留在原处
 *
 * 原实现里考勤默认值写了 2 遍、请假默认值写了 2 遍（`useForm` 的 `defaultValues`
 * 与提交成功后的 `reset`），请假额度的「年度」还跟着 `balanceYear` 状态走。
 * 这类重复**不会**立刻出错 —— 它错在"下次只改一处"。提成常量后两处必然同源，
 * 单测再把每个字段钉死。
 *
 * `react-hook-form` 对传入的 `defaultValues` 与 `reset(values)` 都会
 * `cloneObject`（`dist/index.esm.mjs` 的 `useForm` 初始化与 `resetDefaultValues`），
 * 因此共享同一个常量对象**不会**被表单内部改写 —— 这是"共享常量"能保持
 * 与"每次新建字面量"完全等价行为的前提。
 *
 * ## 这里**没有**搬走什么（有意保留在组件里）
 *
 * `attColumns` / `amendmentColumns` / `leaveColumns` 三个 antd 列定义：
 * 它们的 `render` 里是 JSX（`<HrStatusBadge>`、`<Button>`、`<CanCapabilityWrite>`）
 * 并闭包了 `navigate` 与 `doLeaveAction` / `doAmendmentAction` —— 属于"组件状态 + JSX"，
 * 按 §5.9 的拆分判据不搬（搬走会把 React 拉进本模块，且需要改成回调注入 = 行为变更风险）。
 * 提交处理函数（`onAttSubmit` 等）同理：体是 API 调用 + `toast` + `reload`。
 *
 * ## 三处"看着该统一、实际不能统一"的门槛（单测已钉住）
 *
 * 1. `leaveSchema.days` / `balanceSchema.totalDays` 的门槛是 **> 0**（`positive()`），
 *    而天数输入框上写的是 `min={0.5} step={0.5}` —— **HTML 的 min 不是校验**
 *    （这里是受控 `onChange`，没有走 RHF 的 `register`），它只是步进提示。
 * 2. 额度天数客户端要求 **> 0**，而服务端 `SetLeaveBalanceDto.totalDays` 是
 *    `@Min(0)`（`hr-core.controller.ts`）—— 客户端更严是有意的，不要为了"对齐"
 *    把 0 放进来。
 * 3. `year` 只校验非空（`min(1)`），**不做 `^\d{4}$` 格式校验**：格式闸门在服务端
 *    （`InitLeaveBalancesDto` 有 `@Matches(/^\d{4}$/)`），本模块保持原行为。
 */
import { z } from 'zod';
import type { TableColumnsType } from 'antd';
import { LEAVE_TYPE_LABELS } from './HrStatusBadge';
import type { LeaveBalance } from '@shared/api.interface';

/* ── 补卡状态文案 ────────────────────────────────────────────────────────── */

/**
 * 补卡申请状态文案。
 *
 * 刻意**不**与 `HrStatusBadge.LEAVE_STATUS_LABELS` 合并：请假是「已批准」，
 * 补卡是「已通过」，两张表各自的行文在系统里已经固定（原实现即如此）。
 * 合并会**悄悄改掉**其中一张表的中文文案。
 */
export const AMENDMENT_STATUS_LABELS: Record<string, string> = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已驳回',
};

/* ── 表单 schema ─────────────────────────────────────────────────────────── */

export const attendanceSchema = z.object({
  employeeId: z.string().min(1, '请选择员工'),
  workDate: z.string().min(1, '请选择日期'),
  status: z.string().min(1, '请选择状态'),
  remark: z.string(),
});

export const leaveSchema = z.object({
  employeeId: z.string().min(1, '请选择员工'),
  leaveType: z.string().min(1, '请选择假别'),
  startDate: z.string().min(1, '请选择开始日期'),
  endDate: z.string().min(1, '请选择结束日期'),
  days: z.coerce.number().positive('请假天数必须大于 0'),
  reason: z.string(),
});

export const balanceSchema = z.object({
  employeeId: z.string().min(1, '请选择员工'),
  leaveType: z.string().min(1, '请选择假别'),
  year: z.string().min(1, '请填写年份'),
  totalDays: z.coerce.number().positive('额度天数必须大于 0'),
});

export const amendmentSchema = z.object({
  workDate: z.string().min(1, '请选择日期'),
  reason: z.string().min(1, '请填写补卡原因'),
});

/**
 * `useForm<TFieldValues, TContext, TTransformedValues>` 的类型位：
 * 前两位用 `XxxFormInput`（`z.input`，受控 input 给的是字符串），
 * 第三位用 `XxxFormData`（`z.output`，`coerce` 之后的真实类型）。
 */
export type AttendanceFormInput = z.input<typeof attendanceSchema>;
export type AttendanceFormData = z.output<typeof attendanceSchema>;
export type LeaveFormInput = z.input<typeof leaveSchema>;
export type LeaveFormData = z.output<typeof leaveSchema>;
export type BalanceFormInput = z.input<typeof balanceSchema>;
export type BalanceFormData = z.output<typeof balanceSchema>;
export type AmendmentFormInput = z.input<typeof amendmentSchema>;
export type AmendmentFormData = z.output<typeof amendmentSchema>;

/* ── 表单默认值 ──────────────────────────────────────────────────────────── */

/**
 * 登记考勤的默认值：状态预设「正常出勤」。
 *
 * 不预设状态会让选择框停在占位符上，用户忘了选就被 `请选择状态` 拦下 ——
 * 而"补登考勤"绝大多数就是正常出勤。
 */
export const ATTENDANCE_FORM_DEFAULTS: AttendanceFormInput = {
  employeeId: '',
  workDate: '',
  status: 'present',
  remark: '',
};

/**
 * 新建请假的默认值：假别预设「年假」、天数预设 1。
 *
 * 天数默认 **1** 而不是 0：`leaveSchema` 的门槛是 `> 0`，默认 0 会让弹窗
 * **一打开就是红的**（"请假天数必须大于 0"），并被用户当成系统报错。
 */
export const LEAVE_FORM_DEFAULTS: LeaveFormInput = {
  employeeId: '',
  leaveType: 'annual',
  startDate: '',
  endDate: '',
  days: 1,
  reason: '',
};

/**
 * 请假额度设置的默认值。
 *
 * 年度**跟随入参**而不是硬编码：`hr_leave_balance` 按「(员工, 假别, 年)」唯一，
 * 写错年份会给错的年份建额度，而正确年份仍为空 —— 员工请年假时后端会因
 * 「请假余额记录不存在」直接拒绝。
 */
export function balanceFormDefaults(year: string): BalanceFormInput {
  return { employeeId: '', leaveType: 'annual', year, totalDays: 5 };
}

/** 提交补卡的默认值（补卡不带员工：后端按当前登录账号绑定的员工落库） */
export const AMENDMENT_FORM_DEFAULTS: AmendmentFormInput = {
  workDate: '',
  reason: '',
};

/* ── 请假余额表格列 ─────────────────────────────────────────────────────── */

/**
 * 请假余额表列定义（**纯**：无 JSX、无闭包，故可搬出组件并逐列断言）。
 *
 * 列的字段映射错位在这里尤其危险：「已用（天）」与「剩余（天）」互换后，
 * 两列都显示**合理的数字**（余额表里 `usedDays + remainingDays === totalDays`），
 * HR 据此判断"谁还有额度"会直接判错。
 */
export const balanceColumns: TableColumnsType<LeaveBalance> = [
  { title: '员工', dataIndex: 'employeeName', fixed: 'left', width: 130 },
  {
    title: '类型',
    dataIndex: 'leaveType',
    width: 90,
    render: (v: string) => LEAVE_TYPE_LABELS[v] ?? v,
  },
  { title: '年度', dataIndex: 'year', width: 80 },
  { title: '总额度（天）', dataIndex: 'totalDays', width: 110 },
  { title: '已用（天）', dataIndex: 'usedDays', width: 100 },
  { title: '剩余（天）', dataIndex: 'remainingDays', width: 100 },
];
