/**
 * 能力码装饰器适配层（批次二新增模块自包含所需）。
 *
 * 背景：需求书要求写接口用 `@CanCapability('finance_write')`，并说明该装饰器已由
 * `server/platform/guards.ts` 实现。但当前工作区里 `server/platform` **尚未导出**
 * `CanCapability`（B-01 的能力矩阵改造仍在进行中，仓库里已有 6 个既有 controller
 * 引用它，属于同批次的未完成项）。
 *
 * 为避免"批次二模块挂载后整个服务无法启动"，这里做一层**可降级适配**：
 *  - `@server/platform` 已导出 `CanCapability` 时：直接转发，语义与 B-01 完全一致；
 *  - 尚未导出时：退化为 `@CanRole(['admin'])`（fail-closed，宁严不宽），
 *    并在启动日志中给出明确告警，提示该模块当前按 admin-only 兜底。
 *
 * 注意：本文件是**类型无关**的适配层（用命名空间导入 + Object 索引），
 * 因此无论 platform 是否导出该成员，批次二模块都能通过 `tsc` 并正常编译。
 */

import { Logger } from '@nestjs/common';
import { CanRole } from '@server/platform';
import * as platformNs from '@server/platform';

type Decorator = MethodDecorator & ClassDecorator;

/** 与 shared/rbac.ts 的 Capability 子集保持一致（仅本批次用到的能力码） */
export type IntegrationCapability =
  | 'dashboard'
  | 'finance'
  | 'finance_write'
  | 'audit';

const logger = new Logger('IntegrationsAuthz');

let warned = false;

/**
 * 按能力码鉴权；platform 未实现能力码判定时降级为 admin-only 并告警（仅首次）。
 */
export function CanCapability(capability: IntegrationCapability): Decorator {
  const platformDecorator = (
    platformNs as unknown as {
      CanCapability?: (capability: string) => Decorator;
    }
  ).CanCapability;
  if (typeof platformDecorator === 'function') {
    return platformDecorator(capability);
  }
  if (!warned) {
    warned = true;
    logger.warn(
      `@server/platform 尚未导出 CanCapability，批次二模块的写/读权限暂时降级为 admin-only（缺失能力：${capability}）。` +
        'B-01 完成后本层自动恢复按能力矩阵判定。'
    );
  }
  return CanRole(['admin']) as Decorator;
}
