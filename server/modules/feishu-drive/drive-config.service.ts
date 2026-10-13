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
import { invalidateFeishuToken } from './feishu-token';

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
  private cachedAt = 0;

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
      return this.envFallback();
    }
    const stamp: number = row.updatedAt.getTime();
    if (this.cachedConfig && this.cachedStamp === stamp && Date.now() - this.cachedAt < 60_000) {
      return this.cachedConfig;
    }
    if (!isEncryptedSecret(row.appSecret)) {
      throw new ServiceUnavailableException('应用密钥不是加密密文，请在配置接口重新写入');
    }
    const key: string | undefined = secretKeyFromEnv();
    const plainSecret: string = decryptSecret(row.appSecret, key);
    const config: FeishuDriveConfig = {
      appId: row.appId,
      appSecret: plainSecret,
      rootFolderToken: row.rootFolderToken,
      wikiSpaceId: row.wikiSpaceId,
    };
    this.cachedConfig = config;
    this.cachedStamp = stamp;
    this.cachedAt = Date.now();
    return config;
  }

  private envFallback(): FeishuDriveConfig {
    const appId = process.env.FEISHU_APP_ID ?? '';
    const appSecret = process.env.FEISHU_APP_SECRET ?? '';
    if (!appId || !appSecret) {
      throw new ServiceUnavailableException('飞书云空间应用凭证未配置，请联系管理员在配置接口写入');
    }
    return {
      appId,
      appSecret,
      rootFolderToken: process.env.FEISHU_ROOT_FOLDER_TOKEN ?? '',
      wikiSpaceId: process.env.FEISHU_WIKI_SPACE_ID ?? '',
    };
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
    this.cachedAt = 0;
    invalidateFeishuToken();
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
        throw new ServiceUnavailableException('请配置环境变量 SECRET_ENC_KEY 后再写入应用密钥');
      }
      const current = await this.db
        .select({ appSecret: compFeishuDriveConfig.appSecret, secretKeyVersion: compFeishuDriveConfig.secretKeyVersion })
        .from(compFeishuDriveConfig)
        .limit(1);
      if (current[0]?.appSecret) {
        updateValues.appSecretPrev = current[0].appSecret;
        updateValues.secretPrevVersion = current[0].secretKeyVersion;
        updateValues.secretKeyVersion = current[0].secretKeyVersion + 1;
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
    this.cachedAt = 0;
    invalidateFeishuToken();
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
