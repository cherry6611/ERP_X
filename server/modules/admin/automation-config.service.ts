import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import type { AutomationConfigItem } from '@shared/api.interface';
import { compAutomationConfig } from '@server/database/schema';

const CACHE_TTL_MS = 60_000;

@Injectable()
export class AutomationConfigService {
  private readonly logger = new Logger(AutomationConfigService.name);
  private epoch = '';
  private epochAt = 0;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Inject(CACHE_MANAGER) private readonly cache: Cache
  ) {}

  /** 任务未登记时默认启用。缓存键带上全表更新时间，多实例在 1 秒内对齐。 */
  async isEnabled(taskKey: string): Promise<boolean> {
    const epoch: string = await this.currentEpoch();
    const cacheKey = `automation:${epoch}:${taskKey}`;
    const cached: boolean | undefined = await this.cache.get<boolean>(cacheKey);
    if (typeof cached === 'boolean') return cached;

    const rows: Array<{ enabled: boolean }> = await this.db
      .select({ enabled: compAutomationConfig.enabled })
      .from(compAutomationConfig)
      .where(eq(compAutomationConfig.taskKey, taskKey))
      .limit(1);
    const value: boolean = rows.length === 0 ? true : rows[0].enabled;
    await this.cache.set(cacheKey, value, CACHE_TTL_MS);
    return value;
  }

  async listAll(): Promise<AutomationConfigItem[]> {
    const rows = await this.db
      .select({
        taskKey: compAutomationConfig.taskKey,
        taskName: compAutomationConfig.taskName,
        description: compAutomationConfig.description,
        enabled: compAutomationConfig.enabled,
        updatedAt: compAutomationConfig.updatedAt,
      })
      .from(compAutomationConfig)
      .orderBy(compAutomationConfig.taskKey);
    return rows.map(
      (row): AutomationConfigItem => ({
        taskKey: row.taskKey,
        taskName: row.taskName,
        description: row.description,
        enabled: row.enabled,
        updatedAt:
          row.updatedAt instanceof Date
            ? row.updatedAt.toISOString()
            : String(row.updatedAt),
      })
    );
  }

  async setEnabled(
    taskKey: string,
    enabled: boolean,
    userId: string
  ): Promise<AutomationConfigItem> {
    const updated = await this.db
      .update(compAutomationConfig)
      .set({ enabled, updatedAt: new Date(), updatedBy: userId })
      .where(eq(compAutomationConfig.taskKey, taskKey))
      .returning({
        taskKey: compAutomationConfig.taskKey,
        taskName: compAutomationConfig.taskName,
        description: compAutomationConfig.description,
        enabled: compAutomationConfig.enabled,
        updatedAt: compAutomationConfig.updatedAt,
      });
    if (updated.length === 0) {
      throw new NotFoundException(`自动化任务不存在：${taskKey}`);
    }
    const row = updated[0];
    this.epoch = '';
    this.epochAt = 0;
    this.logger.log(`自动化任务开关更新 task=${taskKey} enabled=${String(enabled)}`);
    return {
      taskKey: row.taskKey,
      taskName: row.taskName,
      description: row.description,
      enabled: row.enabled,
      updatedAt:
        row.updatedAt instanceof Date
          ? row.updatedAt.toISOString()
          : String(row.updatedAt),
    };
  }

  private async currentEpoch(): Promise<string> {
    const now: number = Date.now();
    if (this.epoch && now - this.epochAt < 1000) return this.epoch;
    const rows: unknown = await this.db.execute(
      sql`SELECT COALESCE(MAX(_updated_at)::text, '0') AS stamp FROM comp_automation_config`
    );
    const list = Array.isArray(rows)
      ? (rows as { stamp: string }[])
      : ((rows as { rows?: { stamp: string }[] }).rows ?? []);
    this.epoch = list[0]?.stamp ?? '0';
    this.epochAt = now;
    return this.epoch;
  }
}
