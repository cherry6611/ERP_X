import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, desc, eq, gte, inArray, lt, lte, sum } from 'drizzle-orm';
import {
  erpApBill,
  erpLaborRate,
  erpTimesheet,
  mdEmployee,
  mdSupplier,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { inputIssueLines } from '@server/common/tax/posting';
import { TaxResolverService } from '@server/modules/tax/tax-resolver.service';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import { todayInShanghai } from '@server/common/utils/biz-date';
import type {
  GenerateVendorSettlementDto,
  GenerateVendorSettlementResult,
  VendorSettlementLine,
  VendorSettlementPreview,
} from '@shared/api.interface';

const FLEX_EMPLOYMENT_TYPES = ['part_time', 'flex'];
const PERIOD_PATTERN = /^\d{4}-\d{2}$/u;

interface PeriodRange {
  start: string;
  end: string;
  monthEnd: string;
}

interface SettlementComputation {
  supplierName: string;
  lines: VendorSettlementLine[];
  totalAmount: number;
  sourceRef: string;
}

function resolvePeriodRange(period: string): PeriodRange {
  const year: number = Number.parseInt(period.slice(0, 4), 10);
  const month: number = Number.parseInt(period.slice(5, 7), 10);
  const nextYear: number = month === 12 ? year + 1 : year;
  const nextMonth: number = month === 12 ? 1 : month + 1;
  const monthEnd: string = new Date(Date.UTC(year, month, 0))
    .toISOString()
    .slice(0, 10);
  return {
    start: `${period}-01`,
    end: `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`,
    monthEnd,
  };
}

function roundAmount(value: number): number {
  return Math.round(value * 100) / 100;
}

@Injectable()
export class VendorSettlementService {
  private readonly logger = new Logger(VendorSettlementService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly voucherHookService: VoucherHookService,
    private readonly taxResolver: TaxResolverService
  ) {}

  async preview(
    supplierId?: string,
    period?: string,
    projectId?: string
  ): Promise<VendorSettlementPreview> {
    const effectiveSupplierId: string = supplierId ?? '';
    const effectivePeriod: string = period ?? '';
    if (effectiveSupplierId === '') {
      throw new BadRequestException('supplierId 必填');
    }
    if (!PERIOD_PATTERN.test(effectivePeriod)) {
      throw new BadRequestException('period 格式必须为 YYYY-MM');
    }
    const effectiveProjectId: string | undefined =
      projectId === '' ? undefined : projectId;
    const computation = await this.compute(
      effectiveSupplierId,
      effectivePeriod,
      effectiveProjectId ?? null
    );
    const existing = await this.db
      .select({ id: erpApBill.id })
      .from(erpApBill)
      .where(eq(erpApBill.sourceRef, computation.sourceRef))
      .limit(1);
    return {
      supplierId: effectiveSupplierId,
      supplierName: computation.supplierName,
      period: effectivePeriod,
      projectId: effectiveProjectId ?? null,
      lines: computation.lines,
      totalAmount: computation.totalAmount,
      sourceRef: computation.sourceRef,
      alreadyGenerated: existing.length > 0,
    };
  }

  async generate(
    dto: GenerateVendorSettlementDto
  ): Promise<GenerateVendorSettlementResult> {
    if (!dto.supplierId) {
      throw new BadRequestException('supplierId 必填');
    }
    if (!PERIOD_PATTERN.test(dto.period)) {
      throw new BadRequestException('period 格式必须为 YYYY-MM');
    }
    const computation = await this.compute(
      dto.supplierId,
      dto.period,
      dto.projectId ?? null
    );
    if (computation.lines.length === 0) {
      throw new BadRequestException('该期间无已确认工时明细，无法生成结算');
    }
    const missingRateLine = computation.lines.find(
      (line: VendorSettlementLine) => line.rate <= 0
    );
    if (missingRateLine) {
      throw new BadRequestException(
        `角色「${missingRateLine.roleName ?? ''}」未配置生效费率，无法生成结算`
      );
    }
    const code = await generateBizCode(
      this.db,
      erpApBill,
      erpApBill.code,
      'APB'
    );
    const inserted = await this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: erpApBill.id })
        .from(erpApBill)
        .where(eq(erpApBill.sourceRef, computation.sourceRef))
        .limit(1)
        .for('update');
      if (existing.length > 0) {
        throw new ConflictException('该期间结算单已生成，请勿重复生成');
      }
      try {
        const rows = await tx
          .insert(erpApBill)
          .values({
            code,
            supplierId: dto.supplierId,
            projectId: dto.projectId ?? null,
            amount: String(computation.totalAmount),
            paidAmount: '0',
            dueDate: dto.dueDate,
            status: 'pending',
            source: 'vendor_settlement',
            sourceRef: computation.sourceRef,
            remark: `外协结算 ${dto.period}`,
          })
          .returning({
            id: erpApBill.id,
            code: erpApBill.code,
            amount: erpApBill.amount,
          });
        if (rows.length === 0) {
          throw new BadRequestException('应付单生成失败');
        }
        return rows[0];
      } catch (error) {
        // F4X-10：uq_erp_ap_bill_source_ref 并发插入时兜底
        const pgCode =
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code: unknown }).code)
            : '';
        if (pgCode === '23505') {
          throw new ConflictException('该期间结算单已生成，请勿重复生成');
        }
        throw error;
      }
    });

    // A3：外协结算补进项凭证
    const amount = Number(inserted.amount ?? 0);
    // P1-9：先把税率解析与分录取出（纯读），失败登记补偿队列时才能带上可重放的分录。
    const resolved = await this.taxResolver.resolve({
      supplierId: dto.supplierId,
      side: 'input',
    });
    const settlementLines = inputIssueLines(amount, resolved.rate);
    try {
      await this.voucherHookService.generateVoucherDraft({
        sourceType: 'ap',
        sourceRef: `ap:${inserted.code}`,
        voucherDate: dto.dueDate ?? todayInShanghai(),
        summary: `外协结算 ${dto.period} ${inserted.code}`,
        lines: settlementLines,
        taxEntityId: resolved.taxEntityId,
      });
    } catch (error) {
      this.logger.error(
        `外协结算凭证失败 ap:${inserted.code}`,
        error instanceof Error ? error.stack : String(error)
      );
      await this.voucherHookService.recordCompensation(
        'ap',
        `ap:${inserted.code}`,
        error instanceof Error ? error.message : String(error),
        settlementLines,
        dto.dueDate ?? todayInShanghai()
      );
    }

    return {
      apId: inserted.id,
      code: inserted.code,
      amount,
    };
  }

  private async compute(
    supplierId: string,
    period: string,
    projectId: string | null
  ): Promise<SettlementComputation> {
    const supplierRows = await this.db
      .select({ name: mdSupplier.name })
      .from(mdSupplier)
      .where(eq(mdSupplier.id, supplierId));
    if (supplierRows.length === 0) {
      throw new NotFoundException('供应商不存在');
    }
    const range = resolvePeriodRange(period);
    const conditions = [
      eq(mdEmployee.supplierId, supplierId),
      inArray(mdEmployee.employmentType, FLEX_EMPLOYMENT_TYPES),
      eq(erpTimesheet.status, 'confirmed'),
      gte(erpTimesheet.workDate, range.start),
      lt(erpTimesheet.workDate, range.end),
    ];
    if (projectId) {
      conditions.push(eq(erpTimesheet.projectId, projectId));
    }
    const rows = await this.db
      .select({
        employeeId: erpTimesheet.employeeId,
        employeeName: mdEmployee.name,
        roleName: erpTimesheet.roleName,
        totalHours: sum(erpTimesheet.hours),
      })
      .from(erpTimesheet)
      .innerJoin(mdEmployee, eq(erpTimesheet.employeeId, mdEmployee.id))
      .where(and(...conditions))
      .groupBy(erpTimesheet.employeeId, mdEmployee.name, erpTimesheet.roleName)
      .orderBy(mdEmployee.name);
    const roleNames: string[] = [
      ...new Set(rows.map((row) => row.roleName ?? '')),
    ];
    const rateByRole = new Map<string, number>();
    if (roleNames.length > 0) {
      const rateRows = await this.db
        .select({
          roleName: erpLaborRate.roleName,
          rate: erpLaborRate.rate,
        })
        .from(erpLaborRate)
        .where(
          and(
            inArray(erpLaborRate.roleName, roleNames),
            lte(erpLaborRate.effectiveFrom, range.monthEnd)
          )
        )
        .orderBy(desc(erpLaborRate.effectiveFrom));
      for (const rateRow of rateRows) {
        const key: string = rateRow.roleName ?? '';
        if (!rateByRole.has(key)) {
          rateByRole.set(key, Number(rateRow.rate));
        }
      }
    }
    const lines: VendorSettlementLine[] = rows.map((row) => {
      const roleName: string = row.roleName ?? '';
      const rate: number = rateByRole.get(roleName) ?? 0;
      const hours: number = roundAmount(Number(row.totalHours ?? 0));
      return {
        employeeId: row.employeeId ?? '',
        employeeName: row.employeeName ?? '',
        roleName: row.roleName,
        hours,
        rate,
        amount: roundAmount(hours * rate),
      };
    });
    const totalAmount: number = roundAmount(
      lines.reduce((acc: number, line: VendorSettlementLine) => acc + line.amount, 0)
    );
    const sourceRef = `VS:${period}:${supplierId}:${projectId || 'ALL'}`;
    return {
      supplierName: supplierRows[0].name,
      lines,
      totalAmount,
      sourceRef,
    };
  }
}
