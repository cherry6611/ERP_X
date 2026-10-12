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

export const NEED_LOGIN_KEY = 'authnpaas:needLogin';
export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'authz:roles';

export const NeedLogin = (loginPath?: string): MethodDecorator & ClassDecorator =>
  SetMetadata(NEED_LOGIN_KEY, loginPath ?? '/login');

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export const CanRole = (role: string[] | string): MethodDecorator =>
  SetMetadata(ROLES_KEY, Array.isArray(role) ? role : [role]);

export function allowsRequest(input: {
  isPublic: boolean;
  needLogin: boolean;
  userId?: string;
  requiredRoles?: string[];
  userRoles?: string[];
}): 'ok' | 'unauthorized' | 'forbidden' {
  if (input.isPublic) return 'ok';
  if (input.needLogin && !input.userId) return 'unauthorized';
  if (input.requiredRoles && input.requiredRoles.length > 0) {
    const owned = input.userRoles ?? [];
    if (!input.requiredRoles.some((role) => owned.includes(role))) return 'forbidden';
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
    const req = context.switchToHttp().getRequest<Request>();
    const decision = allowsRequest({
      isPublic: false,
      needLogin: false,
      userId: req.userContext?.userId,
      requiredRoles: required,
      userRoles: req.userContext?.roles,
    });
    if (decision === 'forbidden') throw new ForbiddenException('没有访问权限');
    return true;
  }
}
