/**
 * 成本 Tab 的表单 schema（§5.9 / F8）。
 *
 * ## 为什么从 `CostsTab.tsx` 里搬出来
 *
 * 与 `finance/ap-schemas.ts` 同一判据：这块是**零 React 依赖的纯声明**，
 * 只描述"什么样的输入算合法"。放在 530 行的组件文件里有两个代价：
 *   ① 打开文件先看到的是声明而不是组件；
 *   ② **无法单测** —— 而金额闸门恰恰是最该逐条断言的部分
 *      （`min(1)` 改错就会静默放进 0 元成本）。
 *
 * ⚠️ **行为零变更**：`costSchema` 与两个类型是原块的**逐字搬运**，
 * 只做了一件事：`costSchema` / `CostFormData` / `CostFormInput` 加上 `export`。
 *
 * ## 关于 `amount` 用 `z.coerce.number()`
 *
 * `z.coerce.number()` 对 `''` / `'abc'` 会得到 `NaN`，再经 `min(1, …)` 判定为
 * 不通过 → 表单显示「金额必须大于 0」，**不会**静默提交。这一点是必要的：
 * `JSON.stringify({ amount: NaN })` 会写成 `null`，而服务端
 * `CreateCostBodyDto.amount` 是 `@IsNumber()` + `@Min(0)` 的**必填**字段
 * （`server/modules/costs/costs.controller.ts:73`），收到 `null` 会 400 ——
 * 不会被当成 `@IsOptional()` 静默跳过。这里的前端校验只是把失败提前到本地。
 */
import { z } from 'zod';

export const costSchema = z.object({
  projectId: z.string().min(1, '请选择项目'),
  costType: z.string().min(1, '请选择成本类型'),
  amount: z.coerce.number().min(1, '金额必须大于 0'),
  sourceRef: z.string().min(1, '请填写来源摘要'),
  remark: z.string(),
});

export type CostFormData = z.output<typeof costSchema>;
export type CostFormInput = z.input<typeof costSchema>;
