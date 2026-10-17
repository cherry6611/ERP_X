import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  hasCapability,
  hasWriteCapability,
  type Capability,
} from '@shared/rbac';
// S1：无注解端点的兜底能力解析（34 条"路由前缀 → 能力码"规则）。
// 原先 `resolveCapability` 全仓零调用方，兜底表只是文档 —— 现在真正接线。
import { resolveCapability } from '@server/common/auth/route-capability';

export const NEED_LOGIN_KEY = 'authnpaas:needLogin';
export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'authz:roles';
export const CAPABILITY_KEY = 'authz:capability';

export const NeedLogin = (loginPath?: string): MethodDecorator & ClassDecorator =>
  SetMetadata(NEED_LOGIN_KEY, loginPath ?? '/login');

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export const CanRole = (role: string[] | string): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, Array.isArray(role) ? role : [role]);

/**
 * B-01：按能力码（Capability）判定权限，与前端 `shared/rbac.ts` 使用**同一份矩阵**，
 * 避免前后端双维护导致"UI 能点、后端 403"。
 *
 * 语义：
 * - `CanCapability(cap)` 表示"**拥有该能力的写权限**"（矩阵中该角色对该能力为 `rw`）。
 *   仅当矩阵里存在"只读角色"（例如 finance_viewer 对 finance 为 `r`）而接口本身只读时，
 *   才改用 `CanCapabilityRead(cap)`。
 * - 之所以默认按写权限判定而不是按后缀猜：`settings_brand` / `audit` / `admin_ops`
 *   这类能力的 `_default` 是 `r`，若默认按读判定会让任何登录用户获得写权限（越权）。
 */
export const CanCapability = (
  capability: Capability
): MethodDecorator & ClassDecorator =>
  SetMetadata(CAPABILITY_KEY, { capability, access: 'rw' });

/** 只读接口：只要矩阵中该能力为 `r` 或 `rw` 即放行 */
export const CanCapabilityRead = (
  capability: Capability
): MethodDecorator & ClassDecorator =>
  SetMetadata(CAPABILITY_KEY, { capability, access: 'r' });

interface CapabilityRequirement {
  capability: Capability;
  access: 'r' | 'rw';
}

/**
 * S1：把 HTTP 方法映射为能力语义（读 / 写）。
 *
 * 单独抽出并导出，是为了让"哪些方法算写"这件事**可被单测钉死** ——
 * 这是一个安全边界，不能散落在守卫的 if 里靠肉眼确认。
 */
export function httpMethodAccess(method: string): 'r' | 'rw' {
  // 空/缺失方法按 GET 处理（真实 Express 请求一定有 method；此处只为不抛错）。
  // 注意不能用 `method ?? 'GET'` —— 空字符串不是 nullish，`??` 不会兜底。
  const verb: string = (method || 'GET').toUpperCase();
  return verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS' ? 'r' : 'rw';
}

/**
 * S1：无注解端点的兜底能力解析。
 *
 * 返回 `undefined` 表示**既没有注解、也解析不出能力码** —— 调用方必须
 * **fail-closed**（拒绝），而不是放行。返回 `null` 表示"无需兜底"
 * （已有注解，或已有 `@CanRole`，或未登录 —— 未登录由 `LoginGuard` 负责）。
 *
 * ## 为什么必须有这个函数
 *
 * `RolesGuard` 的 `allowsRequest` 在 `requiredRoles` 与 `requiredCapability`
 * **都为空**时返回 `'ok'`（放行）。而 `route-capability.ts` 精心维护的 34 条
 * "路由前缀 → 能力码"规则此前**零调用方**，兜底机制形同不存在。
 *
 * 于是"新增一个敏感接口但忘记加注解"这条路径是**静默**的：守卫放行、
 * CI 全绿、评审无感。当前 14 处无注解端点之所以安全，靠的是每处在服务层
 * 手写 ACL（如 `attachment.service.ts` 的"仅上传人或管理员可删除附件"）——
 * 那是约定而不是机制。
 */
export function fallbackCapabilityFor(input: {
  controllerPath: string;
  httpMethod: string;
  hasAnnotation: boolean;
  hasExplicitRoles: boolean;
  userId?: string;
}): CapabilityRequirement | null | undefined {
  if (input.hasAnnotation || input.hasExplicitRoles) return null;
  // 未登录时交给 LoginGuard；此处不制造"越权"语义（否则登录页也会 403）
  if (!input.userId) return null;
  const access = httpMethodAccess(input.httpMethod);
  const capability: Capability | undefined = resolveCapability(
    input.controllerPath,
    access === 'r' ? 'read' : 'write'
  );
  // 解析不出 → undefined → 调用方 fail-closed
  if (!capability) return undefined;
  return { capability, access };
}

export function allowsRequest(input: {
  isPublic: boolean;
  needLogin: boolean;
  userId?: string;
  requiredRoles?: string[];
  userRoles?: string[];
  requiredCapability?: CapabilityRequirement;
}): 'ok' | 'unauthorized' | 'forbidden' {
  if (input.isPublic) return 'ok';
  if (input.needLogin && !input.userId) return 'unauthorized';
  if (input.requiredRoles && input.requiredRoles.length > 0) {
    const owned = input.userRoles ?? [];
    if (!input.requiredRoles.some((role) => owned.includes(role))) return 'forbidden';
  }
  if (input.requiredCapability) {
    const roles = input.userRoles ?? [];
    const { capability, access } = input.requiredCapability;
    const allowed =
      access === 'rw'
        ? hasWriteCapability(roles, capability)
        : hasCapability(roles, capability);
    if (!allowed) return 'forbidden';
  }
  return 'ok';
}

@Injectable()
export class LoginGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const needLogin = this.reflector.getAllAndOverride<string>(NEED_LOGIN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<Request>();
    const decision = allowsRequest({
      isPublic: Boolean(isPublic),
      needLogin: Boolean(needLogin),
      userId: req.userContext?.userId,
    });
    if (decision === 'unauthorized') throw new UnauthorizedException('请先登录');
    return true;
  }
}

/** mfaPending 会话允许访问的最小路径集合（绑定/查看状态/退出）。 */
function isMfaSetupPath(path: string): boolean {
  const normalized = (path || '').split('?')[0] ?? '';
  return (
    normalized === '/api/auth/me' ||
    normalized === '/api/auth/logout' ||
    normalized === '/api/auth/mfa/status' ||
    normalized === '/api/auth/mfa/setup' ||
    normalized === '/api/auth/mfa/confirm'
  );
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    let requiredCapability = this.reflector.getAllAndOverride<CapabilityRequirement>(
      CAPABILITY_KEY,
      [context.getHandler(), context.getClass()]
    );
    const req = context.switchToHttp().getRequest<Request>();
    /*
     * 强制 MFA 但尚未绑定的用户：登录时拿到的是受限会话（mfaPending）。
     * 只允许访问绑定 MFA 所需的最小接口；其余一律 403，避免"先放进来再说"
     * 把强制 MFA 变成可绕过的装饰。
     */
    if (req.userContext?.mfaPending && !isMfaSetupPath(req.path)) {
      throw new ForbiddenException('请先完成 MFA 绑定后再使用系统');
    }
    // ── S1：方法级/类级都没注解时的**兜底解析**（fail-closed）────────────────
    //
    // 原实现：`requiredRoles` 与 `requiredCapability` **都为空**时，
    // `allowsRequest` 走完全部判断后 `return 'ok'` —— 即**放行**。
    // 而 `server/common/auth/route-capability.ts` 里精心维护的 34 条
    // "路由前缀 → 能力码"规则，其 `resolveCapability()` 在全仓只有一处匹配
    // （它自己的定义），**零调用方**。
    //
    // 后果不是"当前有漏洞"，而是**结构性风险**：将来新增一个涉及敏感数据的
    // 接口而忘记加注解时，守卫会直接放行、CI 全绿、评审无感。
    // 当前的 14 处无注解端点之所以安全，靠的是**每处在服务层手工写了 ACL**
    // （如 `attachment.service.ts` 的"仅上传人或管理员可删除附件"）——
    // 那是"约定"而不是"机制"。
    //
    // 现在接上兜底表：能解析出能力码就按它判定；解析不出就**拒绝**。
    // 判定逻辑抽成 `fallbackCapabilityFor`（纯函数、可单测），守卫只负责
    // 把 Nest 的反射结果喂进去。
    const controllerPath: string = req.baseUrl || req.path || '';
    const fallback = fallbackCapabilityFor({
      controllerPath,
      httpMethod: req.method ?? 'GET',
      hasAnnotation: Boolean(requiredCapability),
      hasExplicitRoles: Boolean(required && required.length > 0),
      userId: req.userContext?.userId,
    });
    if (fallback === undefined) {
      throw new ForbiddenException(
        `接口 ${(req.method ?? 'GET').toUpperCase()} ${controllerPath} ` +
          `未登记访问能力，且无方法级/类级权限注解；为避免越权，默认拒绝。` +
          `请在 controller 上补 @CanCapability / @CanCapabilityRead，` +
          `或在 server/common/auth/route-capability.ts 登记该前缀`
      );
    }
    if (fallback) requiredCapability = fallback;
    const decision = allowsRequest({
      isPublic: false,
      needLogin: false,
      userId: req.userContext?.userId,
      requiredRoles: required,
      userRoles: req.userContext?.roles,
      requiredCapability,
    });
    if (decision === 'forbidden') {
      throw new ForbiddenException(
        requiredCapability
          ? `没有访问权限（缺少能力：${requiredCapability.capability}）`
          : '没有访问权限'
      );
    }
    return true;
  }
}
