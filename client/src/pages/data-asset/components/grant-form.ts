/**
 * §5.9 拆分：数据集授权的**表单模型**从 `GrantPanel` 抽出。
 *
 * 抽出的收益：这里有一条**跨字段校验**（结束日期不能早于开始日期），
 * 它只在"两个日期都填了、且顺序颠倒"时才触发 —— 页面上要点开弹窗、
 * 选两个日期、提交一次才看得到。独立成模块后可被直接断言。
 *
 * ⚠️ 保留原实现的判据细节：
 *   · `!values.startDate || !values.endDate || …` 先判空再比大小。
 *     少了这两个 `!` 前置判断，空字符串也会参与字符串比较
 *     （`'' >= '2026-10-01'` 为 false），于是"只填了结束日期"也会报错。
 *   · 日期用 `>=` 而非 `>`：同一天开始并结束是合法授权（当天有效）。
 */
import { z } from 'zod';

export const grantSchema = z
  .object({
    datasetId: z.string().min(1, '请选择数据集'),
    customerId: z.string(),
    projectId: z.string(),
    scope: z.string(),
    startDate: z.string().min(1, '请选择开始日期'),
    endDate: z.string().min(1, '请选择结束日期'),
    remark: z.string(),
  })
  .refine(
    (values) => !values.startDate || !values.endDate || values.endDate >= values.startDate,
    { message: '结束日期不能早于开始日期', path: ['endDate'] },
  );

export type GrantFormData = z.output<typeof grantSchema>;
export type GrantFormInput = z.input<typeof grantSchema>;

/**
 * 空表单初值。
 *
 * 全部字段为 `''` 而不是 `undefined`：它们绑定受控 `<Input>`/`Select`，
 * `undefined` 会让 React 在"受控 ↔ 非受控"之间切换并打印警告。
 */
export const EMPTY_GRANT_FORM: GrantFormInput = {
  datasetId: '',
  customerId: '',
  projectId: '',
  scope: '',
  startDate: '',
  endDate: '',
  remark: '',
};
