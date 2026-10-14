import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { compFeishuBitableConfig, compStoredFile, sysBrandConfig } from '@server/database/schema';
import { DRIZZLE_DATABASE } from '@server/platform/tokens';

export interface BrandPublic {
  brandName: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  logoFileId: string | null;
}

@Injectable()
export class SettingsService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async getBrand(): Promise<BrandPublic> {
    const rows = await this.db.select().from(sysBrandConfig).orderBy(desc(sysBrandConfig.updatedAt)).limit(1);
    const row = rows[0];
    if (!row) {
      return { brandName: '晟笙 ERP', logoUrl: null, faviconUrl: null, logoFileId: null };
    }
    return {
      brandName: row.brandName || '晟笙 ERP',
      logoUrl: row.logoFileId ? `/api/settings/brand/logo` : null,
      faviconUrl: row.faviconFileId || row.logoFileId ? `/api/settings/brand/logo` : null,
      logoFileId: row.logoFileId,
    };
  }

  async getLogoFile(): Promise<{ storagePath: string; mime: string | null; fileName: string } | null> {
    const brand = await this.getBrand();
    if (!brand.logoFileId) return null;
    const rows = await this.db
      .select()
      .from(compStoredFile)
      .where(eq(compStoredFile.id, brand.logoFileId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { storagePath: row.storagePath, mime: row.mime, fileName: row.fileName };
  }

  async updateBrand(
    actorUserId: string,
    dto: { brandName?: string; logoFileId?: string | null; faviconFileId?: string | null },
  ): Promise<BrandPublic> {
    if (dto.logoFileId) await this.assertFile(dto.logoFileId);
    if (dto.faviconFileId) await this.assertFile(dto.faviconFileId);

    const existing = await this.db.select().from(sysBrandConfig).orderBy(desc(sysBrandConfig.updatedAt)).limit(1);
    if (existing[0]) {
      await this.db
        .update(sysBrandConfig)
        .set({
          brandName: dto.brandName?.trim() || existing[0].brandName,
          logoFileId: dto.logoFileId === undefined ? existing[0].logoFileId : dto.logoFileId,
          faviconFileId: dto.faviconFileId === undefined ? existing[0].faviconFileId : dto.faviconFileId,
          updatedBy: actorUserId,
          updatedAt: new Date(),
        })
        .where(eq(sysBrandConfig.id, existing[0].id));
    } else {
      await this.db.insert(sysBrandConfig).values({
        brandName: dto.brandName?.trim() || '晟笙 ERP',
        logoFileId: dto.logoFileId ?? null,
        faviconFileId: dto.faviconFileId ?? null,
        updatedBy: actorUserId,
      });
    }
    return this.getBrand();
  }

  async getQuotationBitableConfig(): Promise<{
    configured: boolean;
    appToken?: string;
    tableId?: string;
    fieldMap: Record<string, string>;
    enabled: boolean;
  }> {
    const rows = await this.db
      .select()
      .from(compFeishuBitableConfig)
      .where(eq(compFeishuBitableConfig.bizType, 'quotation'))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return { configured: false, fieldMap: {}, enabled: false };
    }
    let fieldMap: Record<string, string> = {};
    if (row.fieldMap) {
      try {
        fieldMap = JSON.parse(row.fieldMap) as Record<string, string>;
      } catch {
        fieldMap = {};
      }
    }
    return {
      configured: true,
      appToken: row.appToken,
      tableId: row.tableId,
      fieldMap,
      enabled: row.enabled !== 0,
    };
  }

  async upsertQuotationBitableConfig(dto: {
    appToken: string;
    tableId: string;
    fieldMap?: Record<string, string>;
    enabled?: boolean;
  }): Promise<{
    configured: boolean;
    appToken: string;
    tableId: string;
    fieldMap: Record<string, string>;
    enabled: boolean;
  }> {
    const appToken = dto.appToken.trim();
    const tableId = dto.tableId.trim();
    if (!appToken || !tableId) {
      throw new BadRequestException('appToken 与 tableId 不能为空');
    }
    const fieldMap = dto.fieldMap ?? {};
    const enabled = dto.enabled === false ? 0 : 1;
    const existing = await this.db
      .select()
      .from(compFeishuBitableConfig)
      .where(eq(compFeishuBitableConfig.bizType, 'quotation'))
      .limit(1);
    if (existing[0]) {
      await this.db
        .update(compFeishuBitableConfig)
        .set({
          appToken,
          tableId,
          fieldMap: JSON.stringify(fieldMap),
          enabled,
        })
        .where(eq(compFeishuBitableConfig.id, existing[0].id));
    } else {
      await this.db.insert(compFeishuBitableConfig).values({
        bizType: 'quotation',
        appToken,
        tableId,
        fieldMap: JSON.stringify(fieldMap),
        enabled,
      });
    }
    return {
      configured: true,
      appToken,
      tableId,
      fieldMap,
      enabled: enabled !== 0,
    };
  }

  private async assertFile(id: string): Promise<void> {
    const rows = await this.db.select({ id: compStoredFile.id }).from(compStoredFile).where(eq(compStoredFile.id, id)).limit(1);
    if (!rows[0]) throw new NotFoundException('文件不存在');
  }
}
