import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

export interface RequestActor {
  userId: string;
  userName: string;
  /**
   * 登录态角色码（B-02 数据级权限需要按角色解析 sys_data_scope）。
   * 旧调用点若手工构造 actor 可省略，`DataScopeService` 会按"未配置"处理。
   */
  roles?: string[];
}

export function actorFromRequest(req: Request): RequestActor {
  const userId: string | undefined = req.userContext?.userId;
  if (!userId) {
    throw new UnauthorizedException('未登录');
  }
  const userName: string = req.userContext?.userName ?? userId;
  return { userId, userName, roles: req.userContext?.roles ?? [] };
}
