import {
  BadRequestException,
  Inject,
  Injectable,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, desc, eq, sql } from 'drizzle-orm';
import { finVatDeclaration, mdTaxEntity } from '@server/database/schema';
import {
  ACCOUNT_VAT_INPUT,
  ACCOUNT_VAT_OUTPUT,
} from '@server/common/tax/account-codes';
import { LedgersService, previousPeriod } from './ledgers.service';
import type {
  ConfirmVatDeclarationDto,
  VatDeclarationLine,
  VatDeclarationResult,
} from '@shared/api.interface';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const NULL_ENTITY = '00000000-0000-0000-0000-000000000000';

/**
 * A-06：增值税申报底稿。
 *
 * 数据来源：
 *   ① 发票台账 erp_invoice（direction=sales 为销项、purchase 为进项；status='issued' 才计入）；
 *   ② 总账明细科目 222101（销项税额）/ 222102（进项税额）的本期发生额。
 *
 * 口径：本项只做"底稿生成 + 导出 + 勾稽校验"，不做直接申报（属批次二集成项）。
 */
@Injectable()
export class VatDeclarationService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly ledgers: LedgersService,
  ) {}

  private assertPeriod(period: string): void {
    if (!PERIOD_PATTERN.test(period)) {
      throw new BadRequestException('期间格式必须为 YYYY-MM');
    }
  }

  /** 发票台账税额（按方向） */
  private async invoiceTax(
    period: string,
    taxEntityId?: string
  ): Promise<{ output: number; input: number; outputCount: number; inputCount: number }> {
    const rows = await this.db.execute(sql`
      SELECT
        coalesce(sum(CASE WHEN direction = 'sales' THEN tax_amount ELSE 0 END), 0) AS output_tax,
        coalesce(sum(CASE WHEN direction = 'purchase' THEN tax_amount ELSE 0 END), 0) AS input_tax,
        count(*) FILTER (WHERE direction = 'sales')::int AS output_count,
        count(*) FILTER (WHERE direction = 'purchase')::int AS input_count
      FROM erp_invoice
      WHERE status = 'issued'
        AND to_char(invoice_date, 'YYYY-MM') = ${period}
        ${taxEntityId ? sql`AND tax_entity_id = ${taxEntityId}::uuid` : sql``}
    `);
    const list = Array.isArray(rows)
      ? (rows as Array<Record<string, unknown>>)
      : ((rows as { rows?: Array<Record<string, unknown>> }).rows ?? []);
    const row = list[0] ?? {};
    return {
      output: round2(toNumber(row.output_tax as string | number)),
      input: round2(toNumber(row.input_tax as string | number)),
      outputCount: Number(row.output_count ?? 0),
      inputCount: Number(row.input_count ?? 0),
    };
  }

  /** 总账增值税明细科目发生额 */
  private async ledgerTax(
    period: string,
    taxEntityId?: string
  ): Promise<{ output: number; input: number }> {
    const rolled = await this.ledgers.rolledBalances(period, { taxEntityId });
    const output = rolled.get(ACCOUNT_VAT_OUTPUT);
    const input = rolled.get(ACCOUNT_VAT_INPUT);
    return {
      // 销项税额在贷方，进项税额在借方
      output: round2((output?.creditOccur ?? 0) - (output?.debitOccur ?? 0)),
      input: round2((input?.debitOccur ?? 0) - (input?.creditOccur ?? 0)),
    };
  }

  /** 上期期末留抵（222102 借方余额 − 222101 贷方余额，为正即留抵） */
  private async previousCredit(
    period: string,
    taxEntityId?: string
  ): Promise<number> {
    const prev = previousPeriod(period);
    const rolled = await this.ledgers.rolledBalances(prev, { taxEntityId });
    const input = rolled.get(ACCOUNT_VAT_INPUT);
    const output = rolled.get(ACCOUNT_VAT_OUTPUT);
    const inputNet = round2(
      (input?.closingDebit ?? 0) - (input?.closingCredit ?? 0)
    );
    const outputNet = round2(
      (output?.closingCredit ?? 0) - (output?.closingDebit ?? 0)
    );
    return round2(Math.max(inputNet - outputNet, 0));
  }

  async generate(params: {
    period: string;
    taxEntityId?: string;
    userId?: string;
  }): Promise<VatDeclarationResult> {
    this.assertPeriod(params.period);
    const [invoice, ledger, previousCredit, entityRows, saved] = await Promise.all([
      this.invoiceTax(params.period, params.taxEntityId),
      this.ledgerTax(params.period, params.taxEntityId),
      this.previousCredit(params.period, params.taxEntityId),
      params.taxEntityId
        ? this.db
            .select({ name: mdTaxEntity.name })
            .from(mdTaxEntity)
            .where(eq(mdTaxEntity.id, params.taxEntityId))
            .limit(1)
        : Promise.resolve([] as Array<{ name: string }>),
      this.db
        .select()
        .from(finVatDeclaration)
        .where(
          and(
            eq(finVatDeclaration.period, params.period),
            params.taxEntityId
              ? eq(finVatDeclaration.taxEntityId, params.taxEntityId)
              : sql`${finVatDeclaration.taxEntityId} IS NULL`
          )
        )
        .limit(1),
    ]);

    const outputDifference = round2(invoice.output - ledger.output);
    const inputDifference = round2(invoice.input - ledger.input);
    const payableRaw = round2(invoice.output - invoice.input - previousCredit);
    const payableTax = round2(Math.max(payableRaw, 0));
    const closingCredit = round2(Math.max(-payableRaw, 0));

    const lines: VatDeclarationLine[] = [
      {
        rowNo: '1',
        rowName: '一、按适用税率计税销售额（不含税）',
        category: 'output',
        amount: round2(
          invoice.output > 0 ? invoice.output : 0
        ),
        ledgerAmount: ledger.output,
        difference: 0,
        explained: true,
      },
      {
        rowNo: '11',
        rowName: '销项税额',
        category: 'output',
        amount: invoice.output,
        ledgerAmount: ledger.output,
        difference: outputDifference,
        explained: outputDifference === 0 || Boolean(saved[0]?.differenceReason),
      },
      {
        rowNo: '12',
        rowName: '进项税额',
        category: 'input',
        amount: invoice.input,
        ledgerAmount: ledger.input,
        difference: inputDifference,
        explained: inputDifference === 0 || Boolean(saved[0]?.differenceReason),
      },
      {
        rowNo: '13',
        rowName: '进项税额转出',
        category: 'transfer',
        amount: 0,
        ledgerAmount: 0,
        difference: 0,
        explained: true,
      },
      {
        rowNo: '17',
        rowName: '上期留抵税额',
        category: 'credit',
        amount: previousCredit,
        ledgerAmount: previousCredit,
        difference: 0,
        explained: true,
      },
      {
        rowNo: '19',
        rowName: '应纳税额',
        category: 'payable',
        amount: payableTax,
        ledgerAmount: payableTax,
        difference: 0,
        explained: true,
      },
      {
        rowNo: '20',
        rowName: '期末留抵税额',
        category: 'credit',
        amount: closingCredit,
        ledgerAmount: closingCredit,
        difference: 0,
        explained: true,
      },
    ];

    const differences: VatDeclarationResult['differences'] = [];
    if (outputDifference !== 0) {
      differences.push({
        code: 'output_mismatch',
        label: '销项税额与 222101 科目发生额不一致',
        amount: outputDifference,
        reason: saved[0]?.differenceReason ?? null,
      });
    }
    if (inputDifference !== 0) {
      differences.push({
        code: 'input_mismatch',
        label: '进项税额与 222102 科目发生额不一致',
        amount: inputDifference,
        reason: saved[0]?.differenceReason ?? null,
      });
    }

    return {
      period: params.period,
      taxEntityId: params.taxEntityId ?? null,
      taxEntityName: entityRows[0]?.name ?? null,
      status: (saved[0]?.status as 'draft' | 'confirmed') ?? 'draft',
      lines,
      outputTaxFromInvoices: invoice.output,
      inputTaxFromInvoices: invoice.input,
      outputTaxFromLedger: ledger.output,
      inputTaxFromLedger: ledger.input,
      previousCredit,
      payableTax,
      closingCredit,
      reconciled: differences.length === 0,
      differences,
      generatedAt: new Date().toISOString(),
      generatedBy: saved[0]?.generatedBy ?? params.userId ?? null,
    };
  }

  /**
   * A-06 ③：确认申报底稿（勾稽不一致时必须填写差异说明）。
   * 采用 upsert，重复确认为幂等更新。
   */
  async confirm(
    dto: ConfirmVatDeclarationDto,
    userId: string
  ): Promise<VatDeclarationResult> {
    this.assertPeriod(dto.period);
    const result = await this.generate({
      period: dto.period,
      taxEntityId: dto.taxEntityId,
      userId,
    });
    if (!result.reconciled) {
      const reason = dto.differenceReason?.trim();
      if (!reason || reason.length < 4) {
        throw new BadRequestException(
          `申报底稿与总账勾稽存在差异（${result.differences
            .map((item) => `${item.label} ${item.amount}`)
            .join('；')}），请填写不少于 4 个字的差异说明后再确认`
        );
      }
    }
    const payload = {
      period: dto.period,
      taxEntityId: dto.taxEntityId ?? null,
      status: 'confirmed' as const,
      outputTax: String(result.outputTaxFromInvoices),
      inputTax: String(result.inputTaxFromInvoices),
      transferOut: '0',
      previousCredit: String(result.previousCredit),
      payableTax: String(result.payableTax),
      closingCredit: String(result.closingCredit),
      ledgerOutputTax: String(result.outputTaxFromLedger),
      ledgerInputTax: String(result.inputTaxFromLedger),
      differenceReason: dto.differenceReason?.trim() ?? null,
      generatedBy: userId,
      generatedAt: new Date(),
    };
    const existing = await this.db
      .select({ id: finVatDeclaration.id })
      .from(finVatDeclaration)
      .where(
        and(
          eq(finVatDeclaration.period, dto.period),
          dto.taxEntityId
            ? eq(finVatDeclaration.taxEntityId, dto.taxEntityId)
            : sql`${finVatDeclaration.taxEntityId} IS NULL`
        )
      )
      .limit(1);
    if (existing.length > 0) {
      await this.db
        .update(finVatDeclaration)
        .set(payload)
        .where(eq(finVatDeclaration.id, existing[0].id));
    } else {
      await this.db.insert(finVatDeclaration).values(payload);
    }
    return this.generate({
      period: dto.period,
      taxEntityId: dto.taxEntityId,
      userId,
    });
  }

  /** 已确认的申报底稿清单 */
  async list(limit = 24): Promise<
    Array<{
      period: string;
      taxEntityId: string | null;
      taxEntityName: string | null;
      status: string;
      outputTax: number;
      inputTax: number;
      payableTax: number;
      closingCredit: number;
      reconciled: boolean;
      differenceReason: string | null;
      generatedBy: string | null;
      generatedAt: string | null;
    }>
  > {
    const rows = await this.db
      .select({
        period: finVatDeclaration.period,
        taxEntityId: finVatDeclaration.taxEntityId,
        status: finVatDeclaration.status,
        outputTax: finVatDeclaration.outputTax,
        inputTax: finVatDeclaration.inputTax,
        payableTax: finVatDeclaration.payableTax,
        closingCredit: finVatDeclaration.closingCredit,
        ledgerOutputTax: finVatDeclaration.ledgerOutputTax,
        ledgerInputTax: finVatDeclaration.ledgerInputTax,
        differenceReason: finVatDeclaration.differenceReason,
        generatedBy: finVatDeclaration.generatedBy,
        generatedAt: finVatDeclaration.generatedAt,
      })
      .from(finVatDeclaration)
      .orderBy(desc(finVatDeclaration.period))
      .limit(limit);
    const entityIds = Array.from(
      new Set(rows.map((row) => row.taxEntityId).filter((id): id is string => Boolean(id)))
    );
    const entities = entityIds.length
      ? await this.db
          .select({ id: mdTaxEntity.id, name: mdTaxEntity.name })
          .from(mdTaxEntity)
          .where(sql`${mdTaxEntity.id} = ANY(${sql.raw(
            `ARRAY[${entityIds.map((id) => `'${id}'`).join(',')}]`
          )}::uuid[])`)
      : [];
    const entityName = new Map(entities.map((row) => [row.id, row.name]));
    return rows.map((row) => ({
      period: row.period,
      taxEntityId: row.taxEntityId ?? null,
      taxEntityName: row.taxEntityId ? (entityName.get(row.taxEntityId) ?? null) : null,
      status: row.status,
      outputTax: toNumber(row.outputTax),
      inputTax: toNumber(row.inputTax),
      payableTax: toNumber(row.payableTax),
      closingCredit: toNumber(row.closingCredit),
      reconciled:
        round2(toNumber(row.outputTax) - toNumber(row.ledgerOutputTax)) === 0 &&
        round2(toNumber(row.inputTax) - toNumber(row.ledgerInputTax)) === 0,
      differenceReason: row.differenceReason ?? null,
      generatedBy: row.generatedBy ?? null,
      generatedAt: row.generatedAt ? row.generatedAt.toISOString() : null,
    }));
  }
}
