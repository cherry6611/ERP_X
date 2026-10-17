/**
 * 数据集更新（`PATCH /api/data-asset/datasets/:id`）的**字段归并判据**。
 *
 * ## 为什么单独成模块（而不是留在 service 里的一串 `if`）
 *
 * 这个模块守的是本仓反复踩过的一类缺陷：**「客户端发得过去、服务端静默丢弃」**。
 *
 * 该模块的 controller 用了 `whitelist + forbidNonWhitelisted`，于是同一类字段
 * 有两种**表现完全不同**的失败方式：
 *
 * | 情形 | 表现 |
 * |---|---|
 * | 契约里**没有**、客户端发了 | 400 拒绝（**报错可见**，容易发现） |
 * | 契约里**有**、service 不 patch | **静默丢弃**（界面提示"已更新"，库里旧值还在） |
 *
 * 后者才是危险的：`contractId` 原先正是后者 —— `UpdateDatasetDto` 没有它（一并发就 400），
 * 而一旦只补契约、忘了在 service 里 patch，它就会**悄悄变成第二种**。
 *
 * 归并判据抽成纯函数后，`undefined` / `null` / 值的三态语义可以被 jest 直接穷举，
 * 而不需要建库、起 Nest、造数据集。
 *
 * ## 判据：一律 `!== undefined`，**禁止真值判断**
 *
 * ```
 * if (dto.source !== undefined) patch.source = dto.source;   // ✓ 空串是合法值（语义＝清空）
 * if (dto.source)               patch.source = dto.source;   // ✗ 空串被当成"没传"
 * ```
 *
 * 真值写法会把**清空操作**变成"未提供"。同理，`contractId` 的"清除关联"是用
 * 显式 `null` 表达的，真值判断同样会把 `null` 吃掉。
 *
 * 所以本模块的返回值语义刻意设计成：**返回的 `patch` 里没有的键 = 保持原值不动**，
 * `patch` 里值为 `null` 的键 = 写入 NULL。二者不能混为一谈。
 */
import type { UpdateDatasetDto } from '@shared/api.interface';

export interface DatasetUpdatePlan {
  /**
   * 需要写入 `da_dataset` 的列。
   *
   * **缺键 = 保持原值不动**；值为 `null` = 写入 NULL（显式清除）。调用方补上
   * `updatedAt` 后直接交给 drizzle 的 `.set()`。
   */
  patch: Record<string, unknown>;
  /**
   * 需要先校验"该合同确实存在"的合同 id。
   *
   * · 传了 UUID → 返回该 UUID，调用方校验失败时应以**可读中文**报错；
   * · 传了 `null`（解除关联）→ 返回 `null`，**无需校验**（没有东西要校验）；
   * · 没传 → 返回 `null`。
   *
   * 用 `null` 同时表达后两种情形是安全的：它们都**不需要**存在性校验，
   * 而"要不要写"已经由 `patch` 是否含 `contractId` 键单独表达了。
   */
  contractIdToValidate: string | null;
}

/**
 * 由 `UpdateDatasetDto` 构造更新计划。
 *
 * @param dto 已通过 class-validator 校验的请求体（也可直接被单测喂入）
 */
export function buildDatasetUpdatePlan(
  dto: UpdateDatasetDto
): DatasetUpdatePlan {
  const patch: Record<string, unknown> = {};
  if (dto.name !== undefined) patch.name = dto.name;
  if (dto.source !== undefined) patch.source = dto.source;
  if (dto.maskLevel !== undefined) patch.maskLevel = dto.maskLevel;
  if (dto.status !== undefined) patch.status = dto.status;
  if (dto.remark !== undefined) patch.remark = dto.remark;
  /*
   * `contractId` 三态：注意这里**不能**写成 `if (dto.contractId)` ——
   * `null`（解除关联）与空串都会被真值判断吞掉，清除操作静默失效。
   */
  if (dto.contractId !== undefined) patch.contractId = dto.contractId;
  return {
    patch,
    contractIdToValidate:
      typeof dto.contractId === 'string' ? dto.contractId : null,
  };
}
