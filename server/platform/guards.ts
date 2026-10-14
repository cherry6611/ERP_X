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
    const requiredCapability = this.reflector.getAllAndOverride<CapabilityRequirement>(
      CAPABILITY_KEY,
      [context.getHandler(), context.getClass()]
    );
    const req = context.switchToHttp().getRequest<Request>();
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
