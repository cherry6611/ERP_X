import { Controller, Get } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { NeedLogin, Public } from '@server/platform';
import { DRIZZLE_DATABASE } from '@server/platform/tokens';

@NeedLogin()
@Public()
@Controller('api/health')
export class HealthController {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  @Get()
  async check(): Promise<{ ok: boolean; db: boolean }> {
    try {
      await this.db.execute(sql`select 1`);
      return { ok: true, db: true };
    } catch {
      return { ok: false, db: false };
    }
  }
}
