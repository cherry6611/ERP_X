/**
 * §5.9 拆分：工时登记表单的**模型**从 `TimesheetsTab` 抽出。
 *
 * ## 为什么这几行值得单独成文件
 *
 * 工时表单里有一个**单位换算的口径陷阱**，历史上出过误判：
 *
 * 本仓的「角色费率」是**日费率**（`erp_labor_rate`），而使用者填的是**小时数**。
 * 成本归集侧的换算是 `金额 = 工时 × 费率`（不除 8）—— 因为费率表里存的
 * 实际是"每小时费率"口径（页面文案与实现曾不一致，见
 * `server/modules/costs/` 的确认逻辑）。
 *
 * 表单侧能钉住的、且出错看不出的是 `hours` 的取值范围：
 *   · `z.coerce.number()` —— 输入框给的是字符串，不 coerce 会把 `'8'` 判成非数字；
 *   · `.min(0.5)` —— 允许半小时起报（真实场景有半天/半小时的粒度）；
 *   · `.max(24)` —— 一天不可能超过 24 小时。**少了这条上限**，误输 `240` 会
 *     直接把 10 倍成本归集进项目，而界面上只显示"工时已登记"。
 *
 * 这些边界在页面上要点开弹窗、填数字、提交才走得到；独立后可直接断言。
 */
import { z } from 'zod';

/**
 * 工时登记表单校验。
 *
 * ⚠️ `hours` 的上下限是**业务约束不是界面偏好**，见文件头。
 */
export const timesheetSchema = z.object({
  projectId: z.string().min(1, '请选择项目'),
  employeeId: z.string().min(1, '请选择员工'),
  roleName: z.string().min(1, '请选择角色'),
  workDate: z.string().min(1, '请选择工作日期'),
  hours: z.coerce.number().min(0.5).max(24),
  remark: z.string(),
});

export type TimesheetFormData = z.output<typeof timesheetSchema>;
export type TimesheetFormInput = z.input<typeof timesheetSchema>;
