import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { erpBankImportMapping } from '@server/database/schema';
import type {
  BankImportMappingItem,
  BankStatementMapping,
  SaveBankImportMappingDto,
} from '@shared/api.interface';

/**
 * C-02 导入字段映射模板：不同银行列名不同，映射可保存后复用。
 * 唯一键 name：重名保存返回 409（幂等要求：同请求重复提交不会产生第二条记录）。
 */
@Injectable()
export class BankImportMappingService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  private toItem(row: {
    id: string;
    name: string;
    bankName: string | null;
    mapping: unknown;
    remark: string | null;
    createdAt: Date;
  }): BankImportMappingItem {
    return {
      id: row.id,
      name: row.name,
      bankName: row.bankName,
      mapping: (row.mapping ?? {}) as BankStatementMapping,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listMappings(): Promise<BankImportMappingItem[]> {
    const rows = await this.db
      .select()
      .from(erpBankImportMapping)
      .orderBy(asc(erpBankImportMapping.name));
    return rows.map((row) => this.toItem(row));
  }

  async saveMapping(dto: SaveBankImportMappingDto): Promise<BankImportMappingItem> {
    if (!dto.mapping?.transactionDate || !dto.mapping?.amount) {
      throw new BadRequestException('mapping 必须包含 transactionDate 与 amount 列名');
    }
    const existing = await this.db
      .select({ id: erpBankImportMapping.id })
      .from(erpBankImportMapping)
      .where(eq(erpBankImportMapping.name, dto.name))
      .limit(1);
    if (existing.length > 0) {
      throw new ConflictException(`映射模板「${dto.name}」已存在，请改名或先删除`);
    }
    const inserted = await this.db
      .insert(erpBankImportMapping)
      .values({
        name: dto.name,
        bankName: dto.bankName ?? null,
        mapping: dto.mapping,
        remark: dto.remark ?? null,
      })
      .returning();
    return this.toItem(inserted[0]);
  }
}
