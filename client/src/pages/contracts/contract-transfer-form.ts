/**
 * §5.9 拆分：合同「转项目」表单的**表单模型**从 `ContractsPage` 抽出。
 *
 * 抽出的收益：这是一段**纯逻辑**（校验规则 + 空表单初值），不依赖 React/DOM，
 * 因此可以配 spec 断言 —— 而"必填项漏了一个"这类问题在页面上要点开弹窗、
 * 提交一次才看得见。表单模型独立后，规则可以被直接逐条断言。
 */

import { z } from 'zod';

/**
 * 转项目表单。
 *
 * ⚠️ 除 `name` 外全部是**可空字符串**而不是 `optional()`：
 * 这些字段绑定到受控 `<Input>`，值为 `undefined` 会让 React 在
 * "受控 → 非受控"之间切换并打印警告。空表单初值必须是 `''`。
 *
 * `budget` 故意用 `z.string()` 而非 `z.coerce.number()`：
 * 输入过程中会短暂出现 `''` 或 `'1.'`，用数字校验会在**用户还没输完**时报错。
 * 真正的数字校验在提交前由调用方处理。
 */
export const transferSchema = z.object({
  name: z.string().min(1, '请输入项目名称'),
  budget: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  pm: z.string(),
  deptName: z.string(),
  remark: z.string(),
});

export type TransferFormData = z.infer<typeof transferSchema>;

/** 空表单初值：每个字段都必须是字符串（见上方关于受控输入的说明） */
export const EMPTY_TRANSFER_FORM: TransferFormData = {
  name: '',
  budget: '',
  startDate: '',
  endDate: '',
  pm: '',
  deptName: '',
  remark: '',
};
