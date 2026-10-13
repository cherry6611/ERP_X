import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  erpContract,
  erpInvoice,
  erpProject,
  erpProjectRevenue,
  erpRevenueAdjust,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { ArService } from '@server/modules/finance/ar.service';
import { TaxResolverService } from '@server/modules/tax/tax-resolver.service';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import { outputIssueLines, outputVoidLines } from '@server/common/tax/posting';
import { FALLBACK_RATE } from '@shared/tax';
import type {
  AdjustType,
  CreateRevenueAdjustDto,
  CreateRevenueDto,
  RevenueAdjust,
  RevenueItem,
  RevenueMethod,
  UnbilledItem,
} from '@shared/api.interface';

@Injectable()
export class RevenuesService {
  private readonly logger = new Logger(RevenuesService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly arService: ArService,
    private readonly voucherHookService: VoucherHookService,
    private readonly taxResolver: TaxResolverService
  ) {}

  /**
   * 修复 P1-10：收入凭证的税率此前直接读 erp_contract.tax_rate 并在为空时硬编码 6，
   * 绕过了 TaxResolverService（显式→上游→往来单位→纳税主体默认→兜底）。
   * 后果：合同未填税率、但客户/纳税主体已配置 13%/1% 时，凭证销项税按 6% 记，
   * 与合同、应收、发票三处口径不一致。改为统一走解析器。
   */
  private async resolveOutputRate(
    contractId: string | null | undefined
  ): Promise<number> {
    if (!contractId) return FALLBACK_RATE;
    const rows = await this.db
      .select({
        taxRate: erpContract.taxRate,
        taxEntityId: erpContract.taxEntityId,
        customerId: erpContract.customerId,
      })
      .from(erpContract)
      .where(eq(erpContract.id, contractId));
    const contract = rows[0];
    if (!contract) return FALLBACK_RATE;
    const resolved = await this.taxResolver.resolve({
      explicit: contract.taxRate != null ? Number(contract.taxRate) : null,
      customerId: contract.customerId,
      taxEntityId: contract.taxEntityId,
      side: 'output',
    });
    if (resolved.warning) {
      this.logger.warn(`收入税率解析：${contractId} ${resolved.warning}`);
    }
    return resolved.rate;
  }

  async listRevenues(
    projectId?: string,
    period?: string
  ): Promise<RevenueItem[]> {
    const conditions = [];
    if (projectId) conditions.push(eq(erpProjectRevenue.projectId, projectId));
    if (period) conditions.push(eq(erpProjectRevenue.period, period));
    const rows = await this.db
      .select({ revenue: erpProjectRevenue, projectName: erpProject.name })
      .from(erpProjectRevenue)
      .leftJoin(erpProject, eq(erpProjectRevenue.projectId, erpProject.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(erpProjectRevenue.createdAt));
    return rows.map((row) => ({
      id: row.revenue.id,
      code: row.revenue.code,
      projectId: row.revenue.projectId ?? '',
      projectName: row.projectName ?? '',
      contractId: row.revenue.contractId,
      period: row.revenue.period ?? '',
      method: (row.revenue.method ?? 'progress') as RevenueMethod,
      amount: Number(row.revenue.amount ?? 0),
      basis: row.revenue.basis,
      status: row.revenue.status ?? 'recognized',
      remark: row.revenue.remark,
      createdAt: row.revenue.createdAt.toISOString(),
    }));
  }

  async createRevenue(dto: CreateRevenueDto): Promise<RevenueItem> {
    if (dto.amount <= 0) {
      throw new BadRequestException('收入金额必须大于 0');
    }
    const project = await this.db
      .select({ id: erpProject.id, name: erpProject.name, contractId: erpProject.contractId })
      .from(erpProject)
      .where(eq(erpProject.id, dto.projectId));
    if (project.length === 0) throw new NotFoundException('项目不存在');
    if (!/^\d{4}-\d{2}$/u.test(dto.period)) {
      throw new BadRequestException('期间格式须为 YYYY-MM');
    }
    const code = await generateBizCode(
      this.db,
      erpProjectRevenue,
      erpProjectRevenue.code,
      'REV'
    );
    const rows = await this.db
      .insert(erpProjectRevenue)
      .values({
        code,
        projectId: dto.projectId,
        contractId: project[0].contractId,
        period: dto.period,
        method: dto.method,
        amount: String(dto.amount),
        basis: dto.basis,
        status: 'recognized',
        remark: dto.remark,
      })
      .returning();
    const row = rows[0];

    /* 收入确认成功 → 自动生成应收单，失败不阻塞收入登记本身 */
    const taxRate = await this.resolveOutputRate(row.contractId);
    if (row.contractId) {
      try {
        await this.arService.createAr({
          contractId: row.contractId,
          projectId: dto.projectId,
          amount: dto.amount,
          source: 'revenue',
          remark: `收入确认 ${code}`,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`收入确认生成应收失败：${code} ${reason}`);
        await this.voucherHookService.recordCompensation(
          'revenue-ar',
          `revenue-ar:${code}`,
          reason
        );
      }
    }
    await this.voucherHookService.generateVoucherDraft({
      sourceType: 'revenue',
      sourceRef: `revenue:${code}`,
      voucherDate: `${dto.period}-01`,
      summary: `收入确认 ${code}`,
      lines: outputIssueLines(dto.amount, taxRate),
    });

    return {
      id: row.id,
      code: row.code,
      projectId: row.projectId ?? '',
      projectName: project[0].name,
      contractId: row.contractId,
      period: row.period ?? '',
      method: (row.method ?? 'progress') as RevenueMethod,
      amount: Number(row.amount ?? 0),
      basis: row.basis,
      status: row.status ?? 'recognized',
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listAdjusts(revenueId?: string): Promise<RevenueAdjust[]> {
    const rows = await this.db
      .select()
      .from(erpRevenueAdjust)
      .where(revenueId ? eq(erpRevenueAdjust.revenueId, revenueId) : undefined)
      .orderBy(desc(erpRevenueAdjust.createdAt));
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      revenueId: row.revenueId ?? '',
      adjustType: (row.adjustType ?? 'discount') as AdjustType,
      amount: Number(row.amount ?? 0),
      reason: row.reason,
      status: row.status ?? 'applied',
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * F3/B2：冲回已确认收入。
   * AR 已全额结清时仍允许冲回（凭证照开，applyCredit 失败登记补偿）。
   */
  async reverseRevenue(id: string, reason?: string): Promise<RevenueItem> {
    const revenueRows = await this.db
      .select({ revenue: erpProjectRevenue, projectName: erpProject.name })
      .from(erpProjectRevenue)
      .leftJoin(erpProject, eq(erpProjectRevenue.projectId, erpProject.id))
      .where(eq(erpProjectRevenue.id, id));
    if (revenueRows.length === 0) throw new NotFoundException('收入记录不存在');
    const revenue = revenueRows[0].revenue;
    if ((revenue.status ?? '') !== 'recognized') {
      throw new BadRequestException('仅已确认收入可冲回');
    }
    const amount = Number(revenue.amount ?? 0);
    if (!(amount > 0)) {
      throw new BadRequestException('收入金额无效，无法冲回');
    }

    const adjustCode = await generateBizCode(
      this.db,
      erpRevenueAdjust,
      erpRevenueAdjust.code,
      'ADJ'
    );
    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(erpProjectRevenue)
        .set({
          status: 'reversed',
          remark: [revenue.remark, reason ? `冲回：${reason}` : '冲回']
            .filter(Boolean)
            .join('；'),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(erpProjectRevenue.id, id),
            eq(erpProjectRevenue.status, 'recognized')
          )
        )
        .returning({ id: erpProjectRevenue.id });
      if (updated.length === 0) {
        throw new BadRequestException('收入状态已变更，请勿重复冲回');
      }
      await tx.insert(erpRevenueAdjust).values({
        code: adjustCode,
        revenueId: id,
        adjustType: 'return',
        amount: String(amount),
        reason: reason ?? `冲回收入 ${revenue.code}`,
        status: 'applied',
      });
    });

    const taxRate = await this.resolveOutputRate(revenue.contractId);
    if (revenue.contractId) {
      try {
        await this.arService.applyCredit(
          revenue.contractId,
          amount,
          `收入冲回 ${revenue.code}`
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `收入冲回 applyCredit 失败（仍继续开红冲凭证）：${revenue.code} ${msg}`
        );
        await this.voucherHookService.recordCompensation(
          'revenue-reverse-ar',
          `revenue-reverse-ar:${revenue.code}`,
          msg
        );
      }
    }
    await this.voucherHookService.generateVoucherDraft({
      sourceType: 'revenue',
      sourceRef: `revenue-reverse:${revenue.code}`,
      voucherDate: new Date().toISOString().slice(0, 10),
      summary: `收入冲回 ${revenue.code}`,
      lines: outputVoidLines(amount, taxRate),
    });

    const items = await this.listRevenues(revenue.projectId ?? undefined);
    const found = items.find((item) => item.id === id);
    if (!found) throw new NotFoundException('冲回后未能读回收入记录');
    return found;
  }

  /** 收入调整（折让/退回等），状态 applied 时冲减已确认收入 */
  async createAdjust(dto: CreateRevenueAdjustDto): Promise<RevenueAdjust> {
    if (!(dto.amount > 0)) {
      throw new BadRequestException('调整金额必须大于 0');
    }
    const revenue = await this.db
      .select()
      .from(erpProjectRevenue)
      .where(eq(erpProjectRevenue.id, dto.revenueId));
    if (revenue.length === 0) throw new NotFoundException('收入记录不存在');
    const code = await generateBizCode(
      this.db,
      erpRevenueAdjust,
      erpRevenueAdjust.code,
      'ADJ'
    );
    const rows = await this.db
      .insert(erpRevenueAdjust)
      .values({
        code,
        revenueId: dto.revenueId,
        adjustType: dto.adjustType,
        amount: String(dto.amount),
        reason: dto.reason,
        status: 'applied',
      })
      .returning();
    const row = rows[0];
    if (revenue[0].contractId) {
      const taxRate = await this.resolveOutputRate(revenue[0].contractId);
      await this.arService.applyCredit(
        revenue[0].contractId,
        Math.abs(dto.amount),
        `收入调整冲回应 ${row.code}`
      );
      await this.voucherHookService.generateVoucherDraft({
        sourceType: 'revenue',
        sourceRef: `revenue-adjust:${row.code}`,
        voucherDate: new Date().toISOString().slice(0, 10),
        summary: `收入调整冲回 ${row.code}`,
        lines: outputVoidLines(Math.abs(dto.amount), taxRate),
      });
    }
    return {
      id: row.id,
      code: row.code,
      revenueId: row.revenueId ?? '',
      adjustType: (row.adjustType ?? 'discount') as AdjustType,
      amount: Number(row.amount ?? 0),
      reason: row.reason,
      status: row.status ?? 'applied',
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** 未开票收入台账：已确认收入（净额） − 已开票金额 */
  async listUnbilled(): Promise<UnbilledItem[]> {
    const revenueRows = await this.db
      .select({
        projectId: erpProjectRevenue.projectId,
        projectName: erpProject.name,
        recognized: sql<number>`coalesce(sum(${erpProjectRevenue.amount}), 0)::float8`,
      })
      .from(erpProjectRevenue)
      .leftJoin(erpProject, eq(erpProjectRevenue.projectId, erpProject.id))
      .where(eq(erpProjectRevenue.status, 'recognized'))
      .groupBy(erpProjectRevenue.projectId, erpProject.name);
    const adjustRows = await this.db
      .select({
        projectId: erpProjectRevenue.projectId,
        adjusted: sql<number>`coalesce(sum(${erpRevenueAdjust.amount}), 0)::float8`,
      })
      .from(erpRevenueAdjust)
      .innerJoin(
        erpProjectRevenue,
        eq(erpRevenueAdjust.revenueId, erpProjectRevenue.id)
      )
      .where(eq(erpRevenueAdjust.status, 'applied'))
      .groupBy(erpProjectRevenue.projectId);
    const invoiceRows = await this.db
      .select({
        projectId: erpInvoice.projectId,
        invoiced: sql<number>`coalesce(sum(${erpInvoice.amount}), 0)::float8`,
      })
      .from(erpInvoice)
      .where(eq(erpInvoice.status, 'issued'))
      .groupBy(erpInvoice.projectId);
    const adjustMap = new Map<string, number>();
    for (const row of adjustRows) {
      adjustMap.set(row.projectId ?? '', Number(row.adjusted ?? 0));
    }
    const invoiceMap = new Map<string, number>();
    for (const row of invoiceRows) {
      invoiceMap.set(row.projectId ?? '', Number(row.invoiced ?? 0));
    }
    const result: UnbilledItem[] = [];
    for (const row of revenueRows) {
      const projectId = row.projectId ?? '';
      const recognizedAmount = Number(row.recognized ?? 0);
      const invoicedAmount = invoiceMap.get(projectId) ?? 0;
      const unbilledAmount =
        recognizedAmount - (adjustMap.get(projectId) ?? 0) - invoicedAmount;
      result.push({
        projectId,
        projectName: row.projectName ?? '',
        recognizedAmount,
        invoicedAmount,
        unbilledAmount,
      });
    }
    return result;
  }
}
