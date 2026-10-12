import { Injectable, NestMiddleware } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { sysRoleMember } from '@server/database/schema';
import { RAW_DATABASE } from './tokens';
import { requestDb } from './database';
import { readCookie, readSession, SESSION_COOKIE } from './jwt';
import { Inject } from '@nestjs/common';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

@Injectable()
export class SessionMiddleware implements NestMiddleware {
  constructor(@Inject(RAW_DATABASE) private readonly raw: PostgresJsDatabase) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const token = bearer ?? readCookie(req.headers.cookie, SESSION_COOKIE);
    const secret = process.env.JWT_SECRET || '';
    const claims = token && secret ? readSession(token, secret) : null;
    req.userContext = {
      userId: claims?.userId,
      userName: claims?.userName,
      roles: claims?.roles ?? [],
    };
    const userId = claims?.userId ?? '';
    void this.raw.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
      await new Promise<void>((resolve) => {
        res.once('finish', () => resolve());
        res.once('close', () => resolve());
        requestDb.run(tx, () => next());
      });
    }).catch((error: unknown) => {
      if (!res.headersSent) next(error);
    });
  }
}

export async function loadRoleCodes(db: PostgresJsDatabase, userId: string): Promise<string[]> {
  const rows = await db
    .select({ roleCode: sysRoleMember.roleCode })
    .from(sysRoleMember)
    .where(eq(sysRoleMember.userId, userId));
  return rows.map((row) => row.roleCode);
}
