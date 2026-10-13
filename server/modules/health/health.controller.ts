import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { NeedLogin, Public } from '@server/platform';
import { DRIZZLE_DATABASE } from '@server/platform/tokens';

@NeedLogin()
@Public()
@Controller('api/health')
export class HealthController {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  @Get()
  async check(): Promise<{
    ok: boolean;
    db: boolean;
    scheduler: boolean;
    feishuConfigured: boolean;
  }> {
    // U-26：深度健康 —— DB + 调度开关 + 飞书凭证是否配置（不探活外网）
    const scheduler =
      (process.env.ENABLE_SCHEDULER ?? 'true').toLowerCase() !== 'false';
    const feishuConfigured = Boolean(
      process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET
    );
    try {
      await this.db.execute(sql`select 1`);
      return { ok: true, db: true, scheduler, feishuConfigured };
    } catch {
      throw new ServiceUnavailableException({
        ok: false,
        db: false,
        scheduler,
        feishuConfigured,
      });
    }
  }
}
