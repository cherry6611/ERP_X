/**
 * 「编辑项目」页的提交模型（纯逻辑，不依赖 React/DOM，故可直接单测）。
 *
 * ## 为什么这一小块必须单独成模块
 *
 * 原实现把 DTO 直接拼在 `handleSubmit` 里，其中三行是**静默丢字段**的经典写法：
 *
 * ```
 * pm: values.pm || undefined,
 * budget: values.budget || undefined,
 * remark: values.remark || undefined,
 * ```
 *
 * `|| undefined` 在**新建**路径上无害（字段本来就空），在 **PATCH** 路径上却是缺陷：
 * 使用者把「项目经理」清空、点保存，界面 toast 报"项目信息已更新"、
 * 列表里那一格看起来也空了（受控表单的值确实变成空串），
 * **但库里的值一个字符都没变** —— 刷新页面原值就回来了。
 * 这条路径只能靠查库发现，所以判据必须能脱离浏览器被断言。
 *
 * ## 逐字段规则
 *
 * | 字段 | 何时下发 | 清空语义 |
 * |---|---|---|
 * | `pm` / `remark` | **总是**下发 | 空串原样下发（服务端落空串） |
 * | `budget` / `progress` | **总是**下发 | 表单是数字输入，清空即时变 0 |
 * | `estimatedTotalCost` | **总是**下发 | 清空下发 `0`（见下） |
 * | `endDate` | 有值才下发 | ⚠️ **清空仍会被丢弃** —— 见「已知限制」 |
 * | `wonQuotationId` | **总是**下发 | 空值下发 `null`（服务端显式清除） |
 *
 * ## 为什么 `estimatedTotalCost` 清空是 0 而不是 null
 *
 * `UpdateProjectDto.estimatedTotalCost` 是 `@IsNumber()`（没有 null 通道），
 * 而 `shared/api.interface.ts` 不在本次改动范围内。既然"清空"必须有一个
 * 库值能表达，就取 0 —— 界面上 0 与"未填"显示一致（都是 ¥0.00 / 空）。
 * 这与原实现的区别不是显示，而是**库里到底变没变**。
 *
 * ## 已知限制（诚实标注，不是本轮引入的）
 *
 * `endDate` 清空无法在本模块修好：`DateField` 清空后给 `undefined`，
 * 而 `UpdateProjectDto.endDate` 是 `@IsDateString()`（空串会被 400 拒），
 * 要真正支持"清除结束日期"必须把该字段放宽成 `string | null` ——
 * 那要同时改 `shared/api.interface.ts`（本次改动范围之外）。
 * 因此这里保持原行为，并在走查报告里作为**未修缺陷**列出，而不是假装已解决。
 */
import type { ProjectDetail, UpdateProjectDto } from '@shared/api.interface';

/** 编辑表单的值（与 `ProjectEditPage` 的 zod 输出结构一致，刻意不反向 import 组件） */
export interface ProjectEditFormValues {
  pm: string;
  budget: number;
  estimatedTotalCost?: number;
  progress: number;
  endDate?: string;
  remark: string;
  wonQuotationId?: string;
}

/**
 * 表单值 → `UpdateProjectDto`。
 *
 * `_project` 只在需要"与现值比对"时才用得上；当前所有字段都**总是**下发
 * （服务端 PATCH 语义是幂等的），保留参数是为了让调用点与规格都能显式传入现值、
 * 并在将来加"只下发改动字段"时不必改签名。
 */
export function buildProjectUpdateDto(
  values: ProjectEditFormValues,
  _project?: ProjectDetail
): UpdateProjectDto {
  return {
    pm: values.pm,
    budget: values.budget,
    estimatedTotalCost: values.estimatedTotalCost ?? 0,
    progress: values.progress,
    endDate: values.endDate,
    remark: values.remark,
    wonQuotationId: values.wonQuotationId ? values.wonQuotationId : null,
  };
}

/** 编辑提交所需的接口面（只声明 updateProject：编辑提交绝不能走新建） */
export interface ProjectWriteApi {
  updateProject(id: string, dto: UpdateProjectDto): Promise<unknown>;
}

/** 编辑提交：构造 DTO 并 PATCH，返回实际下发的 DTO 便于调用方与规格断言 */
export async function submitProjectEdit(
  api: ProjectWriteApi,
  projectId: string,
  values: ProjectEditFormValues,
  project?: ProjectDetail
): Promise<UpdateProjectDto> {
  const dto = buildProjectUpdateDto(values, project);
  await api.updateProject(projectId, dto);
  return dto;
}
