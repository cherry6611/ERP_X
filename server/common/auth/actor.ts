import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

export interface RequestActor {
  userId: string;
  userName: string;
}

export function actorFromRequest(req: Request): RequestActor {
  const userId: string | undefined = req.userContext?.userId;
  if (!userId) {
    throw new UnauthorizedException('未登录');
  }
  const userName: string = req.userContext?.userName ?? userId;
  return { userId, userName };
}
