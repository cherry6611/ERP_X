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
  erpInvoice,
  erpProject,
  erpProjectRevenue,
  erpRevenueAdjust,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { ArService } from '@server/modules/finance/ar.service';
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
    private readonly arService: ArService
  ) {}

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
        this.logger.error(
          `收入确认生成应收失败：${code}`,
          error instanceof Error ? error.stack : String(error)
        );
      }
    }

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

  /** 收入调整（折让/退回等），状态 applied 时冲减已确认收入 */
  async createAdjust(dto: CreateRevenueAdjustDto): Promise<RevenueAdjust> {
    const revenue = await this.db
      .select({ id: erpProjectRevenue.id })
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
