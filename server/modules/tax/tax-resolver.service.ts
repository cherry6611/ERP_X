import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, eq } from 'drizzle-orm';
import { mdCustomer, mdSupplier, mdTaxEntity } from '@server/database/schema';
import {
  FALLBACK_RATE,
  isVatRate,
  rateAllowed,
  type TaxpayerType,
  type VatRate,
} from '@shared/tax';

export interface ResolvedTax {
  rate: VatRate;
  source: 'explicit' | 'upstream' | 'counterparty' | 'entity' | 'fallback';
  taxEntityId: string | null;
  warning?: string;
}

export interface ResolveTaxInput {
  explicit?: number | null;
  upstream?: number | null;
  customerId?: string | null;
  supplierId?: string | null;
  taxEntityId?: string | null;
  side: 'output' | 'input';
}

@Injectable()
export class TaxResolverService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  async resolve(input: ResolveTaxInput): Promise<ResolvedTax> {
    const entity = await this.resolveEntity(input);
    const counterpartyRate = await this.counterpartyRate(input);
    let rate: number | null = null;
    let source: ResolvedTax['source'] = 'fallback';
    if (input.explicit != null && Number.isFinite(input.explicit)) {
      rate = input.explicit;
      source = 'explicit';
    } else if (input.upstream != null && Number.isFinite(input.upstream)) {
      rate = input.upstream;
      source = 'upstream';
    } else if (counterpartyRate != null) {
      rate = counterpartyRate;
      source = 'counterparty';
    } else if (entity) {
      rate = Number(
        input.side === 'output'
          ? entity.defaultOutputRate
          : entity.defaultInputRate
      );
      source = 'entity';
    }
    if (rate == null) {
      return {
        rate: FALLBACK_RATE,
        source: 'fallback',
        taxEntityId: entity?.id ?? null,
        warning: '未配置税率，已按 6% 暂估',
      };
    }
    if (!isVatRate(rate)) {
      throw new BadRequestException(
        `非法税率 ${rate}，允许值为 0/1/3/6/9/13`
      );
    }
    if (entity && !rateAllowed(entity.taxpayerType as TaxpayerType, rate)) {
      throw new BadRequestException('税率与纳税主体类型不匹配');
    }
    return { rate, source, taxEntityId: entity?.id ?? null };
  }

  private async counterpartyRate(
    input: ResolveTaxInput
  ): Promise<number | null> {
    if (input.customerId) {
      const rows = await this.db
        .select({ rate: mdCustomer.defaultTaxRate })
        .from(mdCustomer)
        .where(eq(mdCustomer.id, input.customerId));
      const rate = Number(rows[0]?.rate ?? NaN);
      if (isVatRate(rate)) return rate;
    }
    if (input.supplierId) {
      const rows = await this.db
        .select({ rate: mdSupplier.defaultTaxRate })
        .from(mdSupplier)
        .where(eq(mdSupplier.id, input.supplierId));
      const rate = Number(rows[0]?.rate ?? NaN);
      if (isVatRate(rate)) return rate;
    }
    return null;
  }

  private async resolveEntity(input: ResolveTaxInput) {
    if (input.taxEntityId) {
      const rows = await this.db
        .select()
        .from(mdTaxEntity)
        .where(eq(mdTaxEntity.id, input.taxEntityId));
      if (rows.length === 0) {
        throw new BadRequestException('指定纳税主体不存在');
      }
      if (rows[0].status !== 'active') {
        throw new BadRequestException('指定纳税主体已停用，请更换后再开票');
      }
      return rows[0];
    }
    if (input.customerId) {
      const rows = await this.db
        .select({ taxEntityId: mdCustomer.taxEntityId })
        .from(mdCustomer)
        .where(eq(mdCustomer.id, input.customerId));
      if (rows[0]?.taxEntityId) {
        const entity = await this.requireActiveEntity(
          rows[0].taxEntityId,
          '客户绑定的纳税主体已停用'
        );
        if (entity) return entity;
      }
    }
    if (input.supplierId) {
      const rows = await this.db
        .select({ taxEntityId: mdSupplier.taxEntityId })
        .from(mdSupplier)
        .where(eq(mdSupplier.id, input.supplierId));
      if (rows[0]?.taxEntityId) {
        const entity = await this.requireActiveEntity(
          rows[0].taxEntityId,
          '供应商绑定的纳税主体已停用'
        );
        if (entity) return entity;
      }
    }
    const defaults = await this.db
      .select()
      .from(mdTaxEntity)
      .where(
        and(eq(mdTaxEntity.isDefault, 1), eq(mdTaxEntity.status, 'active'))
      )
      .limit(1);
    return defaults[0] ?? null;
  }

  /** 绑定主体必须可用；停用不静默换默认主体（T-08） */
  private async requireActiveEntity(id: string, inactiveMessage: string) {
    const rows = await this.db
      .select()
      .from(mdTaxEntity)
      .where(eq(mdTaxEntity.id, id));
    if (rows.length === 0) return null;
    if (rows[0].status !== 'active') {
      throw new BadRequestException(inactiveMessage);
    }
    return rows[0];
  }

}
