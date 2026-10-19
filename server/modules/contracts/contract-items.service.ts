import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, eq, sql, sum } from 'drizzle-orm';
import {
  crmQuotationItem,
  erpContract,
  erpContractItem,
} from '@server/database/schema';
import { isVatRate, lineAmount, splitTax } from '@shared/tax';

export interface ContractItemInput {
  itemName: string;
  unit?: string;
  quantity: number;
  unitPrice: number;
  discountPct?: number;
  taxRate: number;
  estUnitCost?: number;
  sourceType?: 'quotation' | 'manual' | 'change';
  sourceItemId?: string | null;
}

export interface ContractItemWriteResult {
  item?: ContractItemView;
  headerAmount: number;
  itemSum: number;
  differs: boolean;
}

export interface ContractItemView {
  id: string;
  contractId: string;
  versionNo: number;
  seq: number;
  itemName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  taxRate: number;
  amount: number;
  netAmount: number;
  taxAmount: number;
  estUnitCost: number;
  sourceType: string;
}

@Injectable()
export class ContractItemsService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  async list(contractId: string): Promise<ContractItemView[]> {
    const rows = await this.db
      .select()
      .from(erpContractItem)
      .where(
        and(
          eq(erpContractItem.contractId, contractId),
          eq(erpContractItem.isCurrent, 1)
        )
      )
      .orderBy(erpContractItem.seq);
    return rows.map((row) => this.toView(row));
  }

  async create(
    contractId: string,
    dto: ContractItemInput
  ): Promise<ContractItemWriteResult> {
    return this.db.transaction(async (tx) => {
      const contract = await this.requireDraft(contractId, tx);
      const seqRows = await tx
        .select({ seq: erpContractItem.seq })
        .from(erpContractItem)
        .where(
          and(
            eq(erpContractItem.contractId, contractId),
            eq(erpContractItem.isCurrent, 1)
          )
        )
        .for('update');
      const seq =
        seqRows.reduce((max, row) => Math.max(max, row.seq ?? 0), 0) + 1;
      const rows = await tx
        .insert(erpContractItem)
        .values(this.toInsert(contractId, seq, contract.version, dto))
        .returning();
      return this.writeResult(contractId, this.toView(rows[0]), tx);
    });
  }

  async update(
    contractId: string,
    itemId: string,
    dto: ContractItemInput
  ): Promise<ContractItemWriteResult> {
    await this.requireDraft(contractId);
    const rows = await this.db
      .update(erpContractItem)
      .set({ ...this.amounts(dto), updatedAt: new Date() })
      .where(
        and(
          eq(erpContractItem.id, itemId),
          eq(erpContractItem.contractId, contractId),
          eq(erpContractItem.isCurrent, 1)
        )
      )
      .returning();
    if (rows.length === 0) throw new NotFoundException('合同明细不存在');
    return this.writeResult(contractId, this.toView(rows[0]));
  }

  async remove(contractId: string, itemId: string): Promise<ContractItemWriteResult> {
    await this.requireDraft(contractId);
    // 软删除：保留历史版本行，仅取消当前标记（T-03）
    const rows = await this.db
      .update(erpContractItem)
      .set({ isCurrent: 0, updatedAt: new Date() })
      .where(
        and(
          eq(erpContractItem.id, itemId),
          eq(erpContractItem.contractId, contractId),
          eq(erpContractItem.isCurrent, 1)
        )
      )
      .returning({ id: erpContractItem.id });
    if (rows.length === 0) throw new NotFoundException('合同明细不存在');
    return this.writeResult(contractId);
  }

  private async writeResult(
    contractId: string,
    item?: ContractItemView,
    db: PostgresJsDatabase = this.db,
  ): Promise<ContractItemWriteResult> {
    const headerRows = await db
      .select({ amount: erpContract.amount })
      .from(erpContract)
      .where(eq(erpContract.id, contractId))
      .limit(1);
    const sumRows = await db
      .select({ total: sum(erpContractItem.amount) })
      .from(erpContractItem)
      .where(and(eq(erpContractItem.contractId, contractId), eq(erpContractItem.isCurrent, 1)));
    const headerAmount = Number(headerRows[0]?.amount ?? 0);
    const itemSum = Number(sumRows[0]?.total ?? 0);
    return {
      item,
      headerAmount,
      itemSum,
      differs: Math.abs(headerAmount - itemSum) > 0.01,
    };
  }

  async importQuotation(
    contractId: string,
    quotationId: string
  ): Promise<ContractItemView[]> {
    const contract = await this.requireDraft(contractId);
    const items = await this.db
      .select()
      .from(crmQuotationItem)
      .where(eq(crmQuotationItem.quotationId, quotationId))
      .orderBy(crmQuotationItem.seq);
    if (items.length === 0) {
      throw new BadRequestException('报价单没有明细');
    }
    const rate = Number(contract.taxRate ?? 6);
    await this.db.transaction(async (tx) => {
      await tx
        .update(erpContractItem)
        .set({ isCurrent: 0, updatedAt: new Date() })
        .where(
          and(
            eq(erpContractItem.contractId, contractId),
            eq(erpContractItem.isCurrent, 1)
          )
        );
      let sum = 0;
      for (const item of items) {
        const input: ContractItemInput = {
          itemName: item.itemName,
          unit: item.unit,
          quantity: Number(item.quantity ?? 0),
          unitPrice: Number(item.unitPrice ?? 0),
          discountPct: Number(item.discountPct ?? 0),
          taxRate: rate,
          estUnitCost: Number(item.estUnitCost ?? 0),
          sourceType: 'quotation',
          sourceItemId: item.id,
        };
        sum += lineAmount(input.quantity, input.unitPrice, input.discountPct ?? 0);
        await tx
          .insert(erpContractItem)
          .values(this.toInsert(contractId, item.seq, contract.version, input));
      }
      const header = Number(contract.amount ?? 0);
      if (Math.abs(sum - header) > 0.01) {
        throw new BadRequestException(
          `报价明细合计 ${sum} 与合同金额 ${header} 不一致，已回滚`
        );
      }
    });
    return this.list(contractId);
  }

  /*
   * T10：明细与合同头的一致性校验**只有一处实现** —— 见
   * contracts.service.ts 的 assertItemSum（私有方法，在 submit/approve 时调用）。
   *
   * 本文件原先另有一份 assertMatchesHeader，全仓**零调用方**。
   * 两份实现做同一件事的必然结果是口径分叉（同一次收紧只落到其中一处，
   * 另一处静默保持旧口径）—— 那正是"改了一处、漏了另一处"这类缺陷的成因。
   * 因此删除重复实现，只保留活着的那一处。
   */

  private async requireDraft(
    contractId: string,
    db: PostgresJsDatabase = this.db
  ) {
    const rows = await db
      .select()
      .from(erpContract)
      .where(eq(erpContract.id, contractId))
      .for('update');
    if (rows.length === 0) throw new NotFoundException('合同不存在');
    if ((rows[0].status ?? 'draft') !== 'draft') {
      throw new BadRequestException('只有草稿合同可以修改明细');
    }
    const versionRows = await db.execute(sql`
      SELECT COALESCE(MAX(version_no), 1)::int AS version_no
      FROM erp_contract_version
      WHERE contract_id = ${contractId}
    `);
    const list = Array.isArray(versionRows)
      ? (versionRows as unknown as { version_no: number }[])
      : (((versionRows as { rows?: { version_no: number }[] }).rows) ?? []);
    return {
      amount: rows[0].amount,
      taxRate: rows[0].taxRate,
      version: Number(list[0]?.version_no ?? 1),
    };
  }

  private amounts(dto: ContractItemInput) {
    if (!isVatRate(dto.taxRate)) {
      throw new BadRequestException('税率必须是 0、1、3、6、9、13');
    }
    const discount = dto.discountPct ?? 0;
    const amount = lineAmount(dto.quantity, dto.unitPrice, discount);
    const split = splitTax(amount, dto.taxRate);
    return {
      itemName: dto.itemName,
      unit: dto.unit ?? '项',
      quantity: String(dto.quantity),
      unitPrice: String(dto.unitPrice),
      discountPct: String(discount),
      taxRate: String(dto.taxRate),
      amount: String(amount),
      netAmount: String(split.net),
      taxAmount: String(split.tax),
      estUnitCost: String(dto.estUnitCost ?? 0),
      sourceType: dto.sourceType ?? 'manual',
      sourceItemId: dto.sourceItemId ?? null,
    };
  }

  private toInsert(
    contractId: string,
    seq: number,
    versionNo: number,
    dto: ContractItemInput
  ) {
    return {
      contractId,
      versionNo,
      isCurrent: 1,
      seq,
      ...this.amounts(dto),
    };
  }

  private toView(row: typeof erpContractItem.$inferSelect): ContractItemView {
    return {
      id: row.id,
      contractId: row.contractId,
      versionNo: row.versionNo,
      seq: row.seq,
      itemName: row.itemName,
      unit: row.unit,
      quantity: Number(row.quantity ?? 0),
      unitPrice: Number(row.unitPrice ?? 0),
      discountPct: Number(row.discountPct ?? 0),
      taxRate: Number(row.taxRate ?? 0),
      amount: Number(row.amount ?? 0),
      netAmount: Number(row.netAmount ?? 0),
      taxAmount: Number(row.taxAmount ?? 0),
      estUnitCost: Number(row.estUnitCost ?? 0),
      sourceType: row.sourceType,
    };
  }
}
