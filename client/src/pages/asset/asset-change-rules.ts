/**
 * 「发起资产变更」弹窗的**纯逻辑**（不依赖 React/DOM，故可单测）。
 *
 * ## 为什么把它单独拿出来
 *
 * 服务端 `AssetService.createChange` 对 `transfer`（调拨）有结构化要求：
 *
 *     if (dto.changeType === 'transfer') {
 *       if (!dto.targetDepartmentId && !dto.targetProjectId) {
 *         throw new BadRequestException('调拨必须指定目标部门或目标项目…');
 *       }
 *     }
 *
 * 而修复前的弹窗只提交 `assetId / changeType / afterValue / remark`，
 * 界面上**没有任何地方能填目标部门/目标项目** —— 于是「调拨」是
 * "界面提供了、服务端永远拒绝"的死选项（走查实测：选中调拨提交 → 400）。
 *
 * 修法是在弹窗里补两个 Select，并把"要不要填、填了能不能提"的判据收进本模块，
 * 这样"调拨必须有目标"这条规则既能被界面拦住，也能被单测钉住。
 */
import type { CreateAssetChangeDto } from '@shared/api.interface';

export type AssetChangeType = CreateAssetChangeDto['changeType'];

/** 变更类型 → 是否需要结构化目标（部门/项目至少一个） */
export function requiresTransferTarget(changeType: string): boolean {
  return changeType === 'transfer';
}

/**
 * 调拨目标的校验：返回错误文案，允许时返回 `null`。
 *
 * 文案与服务端 `createChange` 的 `BadRequestException` 保持同一口径，
 * 避免"界面放行、服务端拒绝"的两套说法。
 */
export function transferTargetError(
  changeType: string,
  targetDepartmentId?: string | null,
  targetProjectId?: string | null
): string | null {
  if (!requiresTransferTarget(changeType)) return null;
  if (targetDepartmentId || targetProjectId) return null;
  return '调拨必须至少指定目标部门或目标项目';
}

/** 表单值 → 提交给服务端的 DTO（空字符串一律转 `undefined`，避免 uuid 校验失败） */
export function buildAssetChangeDto(values: {
  assetId: string;
  changeType: string;
  targetDepartmentId?: string;
  targetProjectId?: string;
  afterValue?: string;
  remark?: string;
}): CreateAssetChangeDto {
  return {
    assetId: values.assetId,
    changeType: values.changeType as AssetChangeType,
    targetDepartmentId: values.targetDepartmentId || undefined,
    targetProjectId: values.targetProjectId || undefined,
    afterValue: values.afterValue || undefined,
    remark: values.remark || undefined,
  };
}
