import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@server/platform';
import { compFeishuDriveConfig } from '@server/database/schema';
import type { FeishuDriveConfigResponse } from '@shared/api.interface';
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  secretKeyFromEnv,
} from '@server/common/security/secret-box';

export interface FeishuDriveConfig {
  appId: string;
  appSecret: string;
  rootFolderToken: string;
  wikiSpaceId: string;
}

@Injectable()
export class DriveConfigService {
  private readonly logger = new Logger(DriveConfigService.name);
  private cachedConfig: FeishuDriveConfig | null = null;
  private cachedStamp = 0;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async getConfig(): Promise<FeishuDriveConfig> {
    const rows = await this.db
      .select({
        id: compFeishuDriveConfig.id,
        appId: compFeishuDriveConfig.appId,
        appSecret: compFeishuDriveConfig.appSecret,
        rootFolderToken: compFeishuDriveConfig.rootFolderToken,
        wikiSpaceId: compFeishuDriveConfig.wikiSpaceId,
        updatedAt: compFeishuDriveConfig.updatedAt,
      })
      .from(compFeishuDriveConfig)
      .limit(1);
    const row = rows[0];
    if (!row || !row.appId || !row.appSecret) {
      throw new ServiceUnavailableException(
        '飞书云空间应用凭证未配置，请联系管理员在配置接口写入',
      );
    }
    const stamp: number = row.updatedAt.getTime();
    if (this.cachedConfig && this.cachedStamp === stamp) {
      return this.cachedConfig;
    }
    const key: string | undefined = secretKeyFromEnv();
    let plainSecret: string = decryptSecret(row.appSecret, key);
    if (key && !isEncryptedSecret(row.appSecret)) {
      const encrypted: string = encryptSecret(plainSecret, key);
      await this.db
        .update(compFeishuDriveConfig)
        .set({ appSecret: encrypted, updatedAt: new Date() })
        .where(eq(compFeishuDriveConfig.id, row.id));
      this.cachedConfig = null;
      plainSecret = decryptSecret(encrypted, key);
    }
    const config: FeishuDriveConfig = {
      appId: row.appId,
      appSecret: plainSecret,
      rootFolderToken: row.rootFolderToken,
      wikiSpaceId: row.wikiSpaceId,
    };
    this.cachedConfig = config;
    this.cachedStamp = key && !isEncryptedSecret(row.appSecret) ? 0 : stamp;
    if (this.cachedStamp === 0) {
      const refreshed = await this.db
        .select({ updatedAt: compFeishuDriveConfig.updatedAt })
        .from(compFeishuDriveConfig)
        .where(eq(compFeishuDriveConfig.id, row.id))
        .limit(1);
      this.cachedStamp = refreshed[0]?.updatedAt.getTime() ?? Date.now();
    }
    return config;
  }

  async getConfigForAdmin(): Promise<FeishuDriveConfigResponse> {
    const rows = await this.db
      .select({
        appId: compFeishuDriveConfig.appId,
        appSecret: compFeishuDriveConfig.appSecret,
        rootFolderToken: compFeishuDriveConfig.rootFolderToken,
        wikiSpaceId: compFeishuDriveConfig.wikiSpaceId,
        updatedAt: compFeishuDriveConfig.updatedAt,
      })
      .from(compFeishuDriveConfig)
      .limit(1);
    const config = rows[0];
    if (!config) {
      throw new ServiceUnavailableException(
        '飞书云空间尚未配置，请先通过配置接口写入应用凭证',
      );
    }
    const key: string | undefined = secretKeyFromEnv();
    let storedSecret: string = config.appSecret;
    let plain = '****';
    try {
      const decoded: string = decryptSecret(storedSecret, key);
      plain =
        decoded.length > 6
          ? `${'*'.repeat(Math.min(decoded.length - 4, 8))}${decoded.slice(-4)}`
          : '****';
    } catch (error: unknown) {
      const message: string =
        error instanceof Error ? error.message : String(error);
      this.logger.warn(`应用密钥脱敏失败 ${message}`);
      plain = '****';
    }
    return {
      appId: config.appId,
      appSecretMasked: plain,
      rootFolderToken: config.rootFolderToken,
      wikiSpaceId: config.wikiSpaceId,
      updatedAt: config.updatedAt.toISOString(),
    };
  }

  async updateConfig(
    patch: {
      appId?: string;
      appSecret?: string;
      rootFolderToken?: string;
      wikiSpaceId?: string;
    },
    userId: string,
  ): Promise<void> {
    this.cachedConfig = null;
    this.cachedStamp = 0;
    const existing = await this.db
      .select({ id: compFeishuDriveConfig.id })
      .from(compFeishuDriveConfig)
      .limit(1);
    const updateValues: Partial<typeof compFeishuDriveConfig.$inferInsert> = {
      updatedAt: new Date(),
      updatedBy: userId,
    };
    if (patch.appId !== undefined) updateValues.appId = patch.appId;
    if (patch.appSecret !== undefined) {
      const key: string | undefined = secretKeyFromEnv();
      if (!key) {
        throw new ServiceUnavailableException(
          '请配置环境变量 SECRET_ENC_KEY 后再写入应用密钥',
        );
      }
      updateValues.appSecret = encryptSecret(patch.appSecret, key);
    }
    if (patch.rootFolderToken !== undefined) {
      updateValues.rootFolderToken = patch.rootFolderToken;
    }
    if (patch.wikiSpaceId !== undefined) {
      updateValues.wikiSpaceId = patch.wikiSpaceId;
    }
    if (existing.length === 0) {
      const key: string | undefined = secretKeyFromEnv();
      if (!key) {
        throw new ServiceUnavailableException(
          '请配置环境变量 SECRET_ENC_KEY 后再写入应用密钥',
        );
      }
      await this.db.insert(compFeishuDriveConfig).values({
        appId: patch.appId ?? '',
        appSecret: encryptSecret(patch.appSecret ?? '', key),
        rootFolderToken: patch.rootFolderToken ?? '',
        wikiSpaceId: patch.wikiSpaceId ?? '',
        ...updateValues,
      });
      await this.markRotated(userId);
      return;
    }
    await this.db
      .update(compFeishuDriveConfig)
      .set(updateValues)
      .where(eq(compFeishuDriveConfig.id, existing[0].id));
    if (patch.appSecret !== undefined) await this.markRotated(userId);
    this.cachedConfig = null;
    this.cachedStamp = 0;
  }

  private async markRotated(userId: string): Promise<void> {
    try {
      await this.db.execute(sql`
        UPDATE comp_feishu_drive_config
        SET secret_rotated_at = CURRENT_TIMESTAMP,
            secret_rotated_by = ${userId}
      `);
    } catch (error: unknown) {
      const message: string =
        error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `密钥轮换字段未写入（可执行 2026-10-13-security.sql）${message}`,
      );
    }
  }
}
