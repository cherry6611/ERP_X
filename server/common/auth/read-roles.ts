import { CanCapability, CanCapabilityRead, CanRole } from '@server/platform';
import type { Capability } from '@shared/rbac';

/**
 * B-01：读权限装饰器统一收敛到能力码。
 *
 * 历史上这里是"角色码硬编码"，与前端 `shared/rbac.ts` 的矩阵双轨维护，
 * 于是出现"UI 能点、后端 403"（hr_manager）与"UI 隐藏、后端放行"两类不一致。
 * 现在全部改为按能力码判定，角色→能力的结论只保留在 MATRIX 一处。
 *
 * 保留函数名是为了让既有 controller 的 import 与调用点零改动
 * （`@FinanceRead()` 的语义仍是"财务域可读"，只是判定改走矩阵）。
 */
export const FinanceRead = (): MethodDecorator & ClassDecorator =>
  CanCapabilityRead('finance');

export const HrRead = (): MethodDecorator & ClassDecorator =>
  CanCapabilityRead('hr');

export const AdminRead = (): MethodDecorator & ClassDecorator =>
  CanCapabilityRead('admin_ops');

/** 注意：云文档"编辑"权限本身即写权限，故此处用写判定 */
export const DriveEditor = (): MethodDecorator & ClassDecorator =>
  CanCapability('drive_write');

export const ProjectWrite = (): MethodDecorator & ClassDecorator =>
  CanCapability('projects_write');

/** 显式能力码快捷方式（新代码直接用这两个，语义比角色码清晰） */
export const CapabilityRead = (
  capability: Capability
): MethodDecorator & ClassDecorator => CanCapabilityRead(capability);

export const CapabilityWrite = (
  capability: Capability
): MethodDecorator & ClassDecorator => CanCapability(capability);

/**
 * 迁移期兼容：仍需要"仅 admin"语义的地方（密钥、凭证、主体配置等）保留 CanRole。
 * 新代码请优先使用 `CanCapability`。
 */
export const AdminOnly = (): MethodDecorator & ClassDecorator =>
  CanRole(['admin']);
