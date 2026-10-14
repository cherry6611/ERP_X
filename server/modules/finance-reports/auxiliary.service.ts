import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { asc, eq } from 'drizzle-orm';
import { finAuxDimension } from '@server/database/schema';
import type { AuxDimensionItem } from '@shared/api.interface';

const SOURCE_TYPES = [
  'department',
  'project',
  'customer',
  'supplier',
  'employee',
  'custom',
] as const;
type SourceType = (typeof SOURCE_TYPES)[number];

/** A-05：辅助核算维度维护 */
@Injectable()
export class AuxiliaryService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  private toItem(row: {
    id: string;
    code: string;
    name: string;
    sourceType: string;
    enabled: number;
    sortNo: number;
    remark: string | null;
  }): AuxDimensionItem {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      sourceType: (SOURCE_TYPES.includes(row.sourceType as SourceType)
        ? row.sourceType
        : 'custom') as AuxDimensionItem['sourceType'],
      enabled: Number(row.enabled ?? 1) === 1,
      sortNo: Number(row.sortNo ?? 0),
      remark: row.remark,
    };
  }

  async listDimensions(): Promise<AuxDimensionItem[]> {
    const rows = await this.db
      .select({
        id: finAuxDimension.id,
        code: finAuxDimension.code,
        name: finAuxDimension.name,
        sourceType: finAuxDimension.sourceType,
        enabled: finAuxDimension.enabled,
        sortNo: finAuxDimension.sortNo,
        remark: finAuxDimension.remark,
      })
      .from(finAuxDimension)
      .orderBy(asc(finAuxDimension.sortNo), asc(finAuxDimension.code));
    return rows.map((row) => this.toItem(row));
  }

  async createDimension(dto: {
    code: string;
    name: string;
    sourceType?: string;
    remark?: string;
  }): Promise<AuxDimensionItem> {
    const code = dto.code?.trim();
    const name = dto.name?.trim();
    if (!code || !/^[a-z][a-z0-9_]{1,31}$/.test(code)) {
      throw new BadRequestException(
        '维度编码必须为小写字母开头、仅含小写字母/数字/下划线，长度 2~32'
      );
    }
    if (!name) throw new BadRequestException('维度名称必填');
    const sourceType = dto.sourceType ?? 'custom';
    if (!SOURCE_TYPES.includes(sourceType as SourceType)) {
      throw new BadRequestException(`维度来源非法：${sourceType}`);
    }
    const dup = await this.db
      .select({ id: finAuxDimension.id })
      .from(finAuxDimension)
      .where(eq(finAuxDimension.code, code))
      .limit(1);
    if (dup.length > 0) {
      throw new ConflictException(`辅助核算维度 ${code} 已存在`);
    }
    const inserted = await this.db
      .insert(finAuxDimension)
      .values({ code, name, sourceType, enabled: 1, remark: dto.remark })
      .returning({
        id: finAuxDimension.id,
        code: finAuxDimension.code,
        name: finAuxDimension.name,
        sourceType: finAuxDimension.sourceType,
        enabled: finAuxDimension.enabled,
        sortNo: finAuxDimension.sortNo,
        remark: finAuxDimension.remark,
      });
    return this.toItem(inserted[0]);
  }

  async setEnabled(code: string, enabled: boolean): Promise<AuxDimensionItem> {
    const updated = await this.db
      .update(finAuxDimension)
      .set({ enabled: enabled ? 1 : 0, updatedAt: new Date() })
      .where(eq(finAuxDimension.code, code))
      .returning({
        id: finAuxDimension.id,
        code: finAuxDimension.code,
        name: finAuxDimension.name,
        sourceType: finAuxDimension.sourceType,
        enabled: finAuxDimension.enabled,
        sortNo: finAuxDimension.sortNo,
        remark: finAuxDimension.remark,
      });
    if (updated.length === 0) {
      throw new NotFoundException(`辅助核算维度 ${code} 不存在`);
    }
    return this.toItem(updated[0]);
  }
}
