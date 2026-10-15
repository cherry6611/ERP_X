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
import { and, count, eq, notInArray, sql } from 'drizzle-orm';
import { erpContract, mdTaxEntity } from '@server/database/schema';
import {
  isVatRate,
  rateAllowed,
  TAX_ENTITY_REQUIRED_MESSAGE,
  type TaxpayerType,
} from '@shared/tax';

const USCC_PATTERN = /^[0-9A-Za-z]{15}$|^[0-9A-Za-z]{18}$|^[0-9A-Za-z]{20}$/;

export interface TaxEntityItem {
  id: string;
  code: string;
  name: string;
  uscc: string | null;
  taxpayerType: TaxpayerType;
  defaultOutputRate: number;
  defaultInputRate: number;
  /** 城建税率（百分数）；null = 未配置，附加税计提会拒绝出数 */
  urbanMaintRate: number | null;
  invoiceTitle: string | null;
  invoiceAddress: string | null;
  invoicePhone: string | null;
  invoiceBank: string | null;
  invoiceAccount: string | null;
  isDefault: boolean;
  status: 'active' | 'inactive';
  remark: string | null;
}

export interface TaxEntityInput {
  code: string;
  name: string;
  uscc?: string | null;
  taxpayerType: TaxpayerType;
  defaultOutputRate: number;
  defaultInputRate: number;
  urbanMaintRate?: number | null;
  invoiceTitle?: string | null;
  invoiceAddress?: string | null;
  invoicePhone?: string | null;
  invoiceBank?: string | null;
  invoiceAccount?: string | null;
  remark?: string | null;
}

@Injectable()
export class TaxEntityService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  async list(): Promise<TaxEntityItem[]> {
    const rows = await this.db
      .select()
      .from(mdTaxEntity)
      .orderBy(mdTaxEntity.code);
    return rows.map((row) => this.toItem(row));
  }

  async countActive(): Promise<number> {
    const rows = await this.db
      .select({ total: count() })
      .from(mdTaxEntity)
      .where(eq(mdTaxEntity.status, 'active'));
    return Number(rows[0]?.total ?? 0);
  }

  async assertReadyForPosting(): Promise<void> {
    if ((await this.countActive()) === 0) {
      throw new BadRequestException(TAX_ENTITY_REQUIRED_MESSAGE);
    }
  }

  async create(dto: TaxEntityInput): Promise<TaxEntityItem> {
    this.assertPayload(dto);
    const existingCount = await this.db
      .select({ total: count() })
      .from(mdTaxEntity);
    const isFirst = Number(existingCount[0]?.total ?? 0) === 0;
    const rows = await this.db
      .insert(mdTaxEntity)
      .values({ ...this.toRow(dto), isDefault: isFirst ? 1 : 0 })
      .returning();
    return this.toItem(rows[0]);
  }

  async update(id: string, dto: Partial<TaxEntityInput>): Promise<TaxEntityItem> {
    const existing = await this.getRow(id);
    const merged: TaxEntityInput = {
      code: dto.code ?? existing.code,
      name: dto.name ?? existing.name,
      uscc: dto.uscc === undefined ? existing.uscc : dto.uscc,
      taxpayerType: (dto.taxpayerType ?? existing.taxpayerType) as TaxpayerType,
      defaultOutputRate:
        dto.defaultOutputRate ?? Number(existing.defaultOutputRate),
      defaultInputRate:
        dto.defaultInputRate ?? Number(existing.defaultInputRate),
      // 这里必须用 `=== undefined` 而非 `??`：`null` 是有效值（清除配置），
      // 用 `??` 会把显式传 null 当成"未传"，导致税率清不掉。
      urbanMaintRate:
        dto.urbanMaintRate === undefined
          ? existing.urbanMaintRate === null
            ? null
            : Number(existing.urbanMaintRate)
          : dto.urbanMaintRate,
      invoiceTitle:
        dto.invoiceTitle === undefined ? existing.invoiceTitle : dto.invoiceTitle,
      invoiceAddress:
        dto.invoiceAddress === undefined
          ? existing.invoiceAddress
          : dto.invoiceAddress,
      invoicePhone:
        dto.invoicePhone === undefined ? existing.invoicePhone : dto.invoicePhone,
      invoiceBank:
        dto.invoiceBank === undefined ? existing.invoiceBank : dto.invoiceBank,
      invoiceAccount:
        dto.invoiceAccount === undefined
          ? existing.invoiceAccount
          : dto.invoiceAccount,
      remark: dto.remark === undefined ? existing.remark : dto.remark,
    };
    this.assertPayload(merged);
    const rows = await this.db
      .update(mdTaxEntity)
      .set({ ...this.toRow(merged), updatedAt: new Date() })
      .where(eq(mdTaxEntity.id, id))
      .returning();
    return this.toItem(rows[0]);
  }

  async setDefault(id: string): Promise<TaxEntityItem> {
    return this.db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(mdTaxEntity)
        .where(eq(mdTaxEntity.id, id))
        .for('update');
      if (locked.length === 0) {
        throw new NotFoundException('纳税主体不存在');
      }
      if (locked[0].status !== 'active') {
        throw new BadRequestException('停用主体不能设为默认');
      }
      await tx
        .update(mdTaxEntity)
        .set({ isDefault: 0, updatedAt: new Date() })
        .where(eq(mdTaxEntity.isDefault, 1));
      const rows = await tx
        .update(mdTaxEntity)
        .set({ isDefault: 1, updatedAt: new Date() })
        .where(eq(mdTaxEntity.id, id))
        .returning();
      return this.toItem(rows[0]);
    });
  }

  async toggleStatus(id: string): Promise<TaxEntityItem> {
    const existing = await this.getRow(id);
    if (existing.status === 'active') {
      await this.assertCanDeactivate(id);
      if (existing.isDefault === 1) {
        throw new BadRequestException('请先指定其他默认纳税主体，再停用当前主体');
      }
    }
    const next = existing.status === 'active' ? 'inactive' : 'active';
    const rows = await this.db
      .update(mdTaxEntity)
      .set({ status: next, updatedAt: new Date() })
      .where(eq(mdTaxEntity.id, id))
      .returning();
    return this.toItem(rows[0]);
  }

  private async assertCanDeactivate(id: string): Promise<void> {
    const openContracts = await this.db
      .select({ total: count() })
      .from(erpContract)
      .where(
        and(
          eq(erpContract.taxEntityId, id),
          notInArray(erpContract.status, ['completed', 'closed', 'terminated'])
        )
      );
    if (Number(openContracts[0]?.total ?? 0) > 0) {
      throw new ConflictException('该主体仍有未完结合同，不能停用');
    }
    const unbilled = await this.db.execute(sql`
      SELECT COALESCE(SUM(
        COALESCE(c.amount, 0) - COALESCE(inv.invoiced, 0)
      ), 0)::float8 AS gap
      FROM erp_contract c
      LEFT JOIN (
        SELECT contract_id, SUM(amount) AS invoiced
        FROM erp_invoice
        WHERE status = 'issued'
        GROUP BY contract_id
      ) inv ON inv.contract_id = c.id
      WHERE c.tax_entity_id = ${id}
    `);
    const list = Array.isArray(unbilled)
      ? (unbilled as unknown as { gap: number }[])
      : (((unbilled as { rows?: { gap: number }[] }).rows) ?? []);
    if (Number(list[0]?.gap ?? 0) > 0.009) {
      throw new ConflictException('该主体仍有未开票金额，不能停用');
    }
  }

  private assertPayload(dto: TaxEntityInput): void {
    if (!dto.code.trim() || !dto.name.trim()) {
      throw new BadRequestException('编码和名称不能为空');
    }
    if (dto.taxpayerType !== 'general' && dto.taxpayerType !== 'small') {
      throw new BadRequestException('纳税人类型只能是一般纳税人或小规模纳税人');
    }
    const uscc = dto.uscc?.trim() ?? '';
    if (uscc !== '' && !USCC_PATTERN.test(uscc)) {
      throw new BadRequestException('统一社会信用代码须为 15、18 或 20 位字母数字');
    }
    if (!isVatRate(dto.defaultOutputRate) || !isVatRate(dto.defaultInputRate)) {
      throw new BadRequestException('税率必须是 0、1、3、6、9、13');
    }
    if (
      !rateAllowed(dto.taxpayerType, dto.defaultOutputRate) ||
      !rateAllowed(dto.taxpayerType, dto.defaultInputRate)
    ) {
      throw new BadRequestException('税率与纳税人类型不匹配');
    }
    // 城建税率与库约束 chk_tax_entity_urban_maint_rate 保持同一口径。
    // 入参层已校验，这里是服务层兼底：任何绕过 DTO 的调用（如脚本、内部服务）也被拦住。
    if (dto.urbanMaintRate !== null && dto.urbanMaintRate !== undefined) {
      if (!(dto.urbanMaintRate > 0 && dto.urbanMaintRate <= 100)) {
        throw new BadRequestException(
          '城建税率须大于 0 且不超过 100（百分数，如 7 表示 7%）'
        );
      }
    }
  }

  private toRow(dto: TaxEntityInput) {
    const uscc = dto.uscc?.trim() ?? '';
    return {
      code: dto.code.trim(),
      name: dto.name.trim(),
      uscc: uscc === '' ? null : uscc,
      taxpayerType: dto.taxpayerType,
      defaultOutputRate: String(dto.defaultOutputRate),
      defaultInputRate: String(dto.defaultInputRate),
      urbanMaintRate:
        dto.urbanMaintRate === null || dto.urbanMaintRate === undefined
          ? null
          : String(dto.urbanMaintRate),
      invoiceTitle: dto.invoiceTitle ?? null,
      invoiceAddress: dto.invoiceAddress ?? null,
      invoicePhone: dto.invoicePhone ?? null,
      invoiceBank: dto.invoiceBank ?? null,
      invoiceAccount: dto.invoiceAccount ?? null,
      remark: dto.remark ?? null,
    };
  }

  private async getRow(id: string) {
    const rows = await this.db
      .select()
      .from(mdTaxEntity)
      .where(eq(mdTaxEntity.id, id));
    if (rows.length === 0) throw new NotFoundException('纳税主体不存在');
    return rows[0];
  }

  private toItem(row: typeof mdTaxEntity.$inferSelect): TaxEntityItem {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      uscc: row.uscc,
      taxpayerType: row.taxpayerType as TaxpayerType,
      defaultOutputRate: Number(row.defaultOutputRate),
      defaultInputRate: Number(row.defaultInputRate),
      urbanMaintRate:
        row.urbanMaintRate === null || row.urbanMaintRate === undefined
          ? null
          : Number(row.urbanMaintRate),
      invoiceTitle: row.invoiceTitle,
      invoiceAddress: row.invoiceAddress,
      invoicePhone: row.invoicePhone,
      invoiceBank: row.invoiceBank,
      invoiceAccount: row.invoiceAccount,
      isDefault: row.isDefault === 1,
      status: (row.status ?? 'active') as 'active' | 'inactive',
      remark: row.remark,
    };
  }
}
