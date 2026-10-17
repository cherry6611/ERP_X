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
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  erpContract,
  erpInvoice,
  erpProject,
  erpProjectRevenue,
  erpRevenueAdjust,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { unwrapRows } from '@server/common/utils/rows';
import { ArService } from '@server/modules/finance/ar.service';
import { InvoiceService } from '@server/modules/finance/invoice.service';
import { DataScopeService } from '@server/common/auth/data-scope.service';
import { ProjectAclService } from '@server/modules/projects/project-acl.service';
import type { RequestActor } from '@server/common/auth/actor';
import { TaxResolverService } from '@server/modules/tax/tax-resolver.service';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import { outputIssueLines, outputVoidLines } from '@server/common/tax/posting';
import { FALLBACK_RATE } from '@shared/tax';
import { todayInShanghai } from '@server/common/utils/biz-date';
import {
  assertFiscalYearOpen,
  assertPeriodOpen,
} from '@server/common/utils/period-guard';
import type {
  AdjustType,
  CreateRevenueAdjustDto,
  CreateRevenueDto,
  RevenueAdjust,
  RevenueChainGap,
  RevenueChainGapKind,
  RevenueChainReconcileResult,
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
    private readonly taxResolver: TaxResolverService,
    private readonly dataScope: DataScopeService,
    private readonly projectAcl: ProjectAclService,
    // P0-D：收入冲回/调整同步登记红字发票（增值税申报口径随账务一并冲减）
    private readonly invoiceService: InvoiceService
  ) {}

  /**
   * P0-D（T4）：登记收入侧红字发票的**唯一入口**。
   *
   * 抽成方法而不是在两处各写一遍 `createRedLetterInvoice(...)` 调用：
   * 冲回与调整两处的税率来源、幂等键命名、失败策略必须完全一致，
   * 分开写就是下一次"两处口径分叉"的起点（B5 期初现金的遗漏正是这么来的）。
   *
   * 失败**不阻断**：凭证已出、应收已冲，业务不应被发票登记卡住。
   * 但必须留痕 —— 这是"账表差异"的来源，底稿的 `output_mismatch` 会再次暴露它。
   */
  private async registerRevenueRedLetterInvoice(input: {
    sourceRef: string;
    amount: number;
    taxRate: number;
    contractId: string | null;
    projectId: string | null;
    remark: string;
    taxEntityId: string | null;
  }): Promise<void> {
    if (!(input.amount > 0)) return;
    try {
      await this.invoiceService.createRedLetterInvoice({
        direction: 'sales',
        amount: input.amount,
        taxRate: input.taxRate,
        sourceRef: input.sourceRef,
        contractId: input.contractId ?? null,
        projectId: input.projectId ?? null,
        taxEntityId: input.taxEntityId,
        remark: input.remark,
      });
    } catch (error: unknown) {
      this.logger.error(
        `红字发票登记失败 source=${input.sourceRef}：${
          error instanceof Error ? error.message : String(error)
        }（增值税底稿将报 output_mismatch，请核对后补录）`
      );
    }
  }

  /**
   * 修复 P1-10：收入凭证的税率此前直接读 erp_contract.tax_rate 并在为空时硬编码 6，
   * 绕过了 TaxResolverService（显式→上游→往来单位→纳税主体默认→兜底）。
   * 后果：合同未填税率、但客户/纳税主体已配置 13%/1% 时，凭证销项税按 6% 记，
   * 与合同、应收、发票三处口径不一致。改为统一走解析器。
   */
  private async resolveOutputTax(
    contractId: string | null | undefined
  ): Promise<{ rate: number; taxEntityId: string | null }> {
    if (!contractId) return { rate: FALLBACK_RATE, taxEntityId: null };
    const rows = await this.db
      .select({
        taxRate: erpContract.taxRate,
        taxEntityId: erpContract.taxEntityId,
        customerId: erpContract.customerId,
      })
      .from(erpContract)
      .where(eq(erpContract.id, contractId));
    const contract = rows[0];
    if (!contract) return { rate: FALLBACK_RATE, taxEntityId: null };
    const resolved = await this.taxResolver.resolve({
      explicit: contract.taxRate != null ? Number(contract.taxRate) : null,
      customerId: contract.customerId,
      taxEntityId: contract.taxEntityId,
      side: 'output',
    });
    if (resolved.warning) {
      this.logger.warn(`收入税率解析：${contractId} ${resolved.warning}`);
    }
    // P0-2：顺带把解析出的纳税主体透给凭证，避免收入凭证在报表里成为"无主体"缺口
    return { rate: resolved.rate, taxEntityId: resolved.taxEntityId ?? null };
  }

  /**
   * B-2：项目收入的可见范围（口径 = 项目）。
   *
   * 不传 `actor` 表示**系统内部调用**（如对账自检）；
   * HTTP 边界（`revenues.controller`）必须传，否则项目级隔离对这个列表就不生效。
   */
  async listRevenues(
    projectId?: string,
    period?: string,
    actor?: RequestActor
  ): Promise<RevenueItem[]> {
    const conditions = [];
    if (projectId) conditions.push(eq(erpProjectRevenue.projectId, projectId));
    if (period) conditions.push(eq(erpProjectRevenue.period, period));
    if (actor) {
      const scope = await this.dataScope.conditionFor('revenue', actor, {
        primary: erpProjectRevenue.projectId,
      });
      if (scope) {
        conditions.push(scope);
      } else {
        // revenue 未配置 sys_data_scope 时不能默认 all：回退项目可见集。
        const visibleIds = await this.projectAcl.visibleProjectIds(actor);
        if (visibleIds) {
          conditions.push(
            visibleIds.length > 0
              ? inArray(erpProjectRevenue.projectId, visibleIds)
              : sql`1 = 0`,
          );
        }
      }
    }
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
    // P2-8：收入确认会计期间必须过期间闸门。原先仅校验格式，已结账/已年结期间
    // 仍能确认收入 —— 凭证生成会被钩子拦下进补偿队列，业务数据却已落库，
    // 形成"有收入无凭证"的静默不一致。
    await assertPeriodOpen(this.db, dto.period, '确认收入');
    await assertFiscalYearOpen(this.db, dto.period);
    const contractId = project[0].contractId ?? null;
    // N-3/B-4②：销项税率与纳税主体的解析**前置于插入**。
    // 原实现在插入之后调用：解析一旦抛错，收入已落库、应收与凭证都没生成，
    // 形成"有收入、无应收、无凭证"且无任何台账的静默缺口。
    const outputTax = await this.resolveOutputTax(contractId);
    const taxRate = outputTax.rate;
    const code = await generateBizCode(
      this.db,
      erpProjectRevenue,
      erpProjectRevenue.code,
      'REV'
    );
    // N-3/B-4①：收入主表与应收纳入**同一事务边界**。
    // 原实现把 `createAr` 放在 try/catch 里只记日志（"失败不阻塞收入登记"），
    // 补偿队列只兜凭证、不兜应收 → 应收缺口无台账、无重试入口。
    // 现在两者同生共死：应收登记失败即整体回滚，调用方可直接重试，绝不静默。
    // 凭证仍留在事务外：它由 VoucherHookService 自带 comp_voucher_job 补偿队列，
    // 且需要读合同/纳税主体（跨连接读，放进事务无增益）。
    const row = await this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(erpProjectRevenue)
        .values({
          code,
          projectId: dto.projectId,
          contractId,
          period: dto.period,
          method: dto.method,
          amount: String(dto.amount),
          basis: dto.basis,
          status: 'recognized',
          remark: dto.remark,
        })
        .returning();
      if (contractId) {
        await this.arService.createArInTransaction(
          tx as unknown as PostgresJsDatabase,
          {
            contractId,
            projectId: dto.projectId,
            amount: dto.amount,
            source: 'revenue',
            sourceRef: `revenue:${code}`,
            remark: `收入确认 ${code}`,
          }
        );
      }
      return rows[0];
    });

    const lines = outputIssueLines(dto.amount, taxRate);
    const voucherResult = await this.voucherHookService.generateVoucherDraft({
      sourceType: 'revenue',
      sourceRef: `revenue:${code}`,
      voucherDate: `${dto.period}-01`,
      summary: `收入确认 ${code}`,
      lines,
      taxEntityId: outputTax.taxEntityId,
    });
    if (voucherResult === 'failed') {
      await this.voucherHookService.recordCompensation(
        'revenue',
        `revenue:${code}`,
        '收入确认凭证生成失败',
        lines,
        `${dto.period}-01`,
      );
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

    const outputTax = await this.resolveOutputTax(revenue.contractId);
    const taxRate = outputTax.rate;
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
        // P1-9：这里失败的是「应收冲减」（AR 侧），不是凭证生成 —— 补偿队列只承载
        // 可重放的凭证 payload，塞一条无分录的记录既不能重放、又会污染队列统计。
        // 故改为显式错误日志 + 稳定的可检索前缀，由运维按 sourceRef 定位补做。
        this.logger.error(
          `[需人工处理] 收入冲回应收未冲减 contract=${revenue.contractId} amount=${amount} 收入=${revenue.code}：${msg}`
        );
      }
    }
    await this.voucherHookService.generateVoucherDraft({
      sourceType: 'revenue',
      sourceRef: `revenue-reverse:${revenue.code}`,
      voucherDate: todayInShanghai(),
      summary: `收入冲回 ${revenue.code}`,
      lines: outputVoidLines(amount, taxRate),
      taxEntityId: outputTax.taxEntityId,
    });
    // P0-D（T4）：**同步登记红字发票**。
    //
    // 收入冲回原先只出红字凭证（借 6001 / 借 222101 / 贷 1122），而增值税底稿的
    // 销项 100% 来自 `erp_invoice` 台账 → 申报口径不冲减（**多缴增值税**），
    // 且底稿每月必报 `output_mismatch`（长期噪声淹没真实异常）。
    // 负金额红字发票让底稿的 `sum()` 天然完成冲减，无需在底稿里写特例分支。
    //
    // 幂等键 `revenue-reverse:<收入单号>`：与凭证同键，重复冲回不会重复冲减
    // （收入状态机的 CAS 也保证同一笔只能冲回一次）。
    await this.registerRevenueRedLetterInvoice({
      sourceRef: `revenue-reverse:${revenue.code}`,
      amount,
      taxRate,
      contractId: revenue.contractId,
      projectId: revenue.projectId,
      remark: `收入冲回红字发票（冲减 ${revenue.code}）`,
      taxEntityId: outputTax.taxEntityId,
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
      const outputTax = await this.resolveOutputTax(revenue[0].contractId);
      await this.arService.applyCredit(
        revenue[0].contractId,
        Math.abs(dto.amount),
        `收入调整冲回应 ${row.code}`
      );
      await this.voucherHookService.generateVoucherDraft({
        sourceType: 'revenue',
        sourceRef: `revenue-adjust:${row.code}`,
        voucherDate: todayInShanghai(),
        summary: `收入调整冲回 ${row.code}`,
        lines: outputVoidLines(Math.abs(dto.amount), outputTax.rate),
        taxEntityId: outputTax.taxEntityId,
      });
      // P0-D（T4）：收入调整同样要出红字发票，理由与 `reverseRevenue` 完全一致。
      // 幂等键 `revenue-adjust:<调整单号>` 是**每张调整单独立**的 ——
      // 同一笔收入可以多次折让，每次都必须各自冲减一次销项。
      await this.registerRevenueRedLetterInvoice({
        sourceRef: `revenue-adjust:${row.code}`,
        amount: Math.abs(dto.amount),
        taxRate: outputTax.rate,
        contractId: revenue[0].contractId,
        projectId: revenue[0].projectId,
        remark: `收入调整红字发票（${row.code} ${dto.adjustType}）`,
        taxEntityId: outputTax.taxEntityId,
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
      // P1-4：重置只统计**仍为 recognized** 的收入所挂的调整。
      // `reverseRevenue` 会同时（a）把收入置为 reversed、（b）写一条 adjust_type='return'
      // 的调整。若这里把 reversed 收入的调整也计入，则该笔金额被扣两次：
      // 一次是收入本身被 `status='recognized'` 过滤掉，一次是调整被减掉 → 未开票金额虚低。
      .where(
        and(
          eq(erpRevenueAdjust.status, 'applied'),
          eq(erpProjectRevenue.status, 'recognized')
        )
      )
      .groupBy(erpProjectRevenue.projectId);
    const invoiceRows = await this.db
      .select({
        projectId: erpInvoice.projectId,
        invoiced: sql<number>`coalesce(sum(${erpInvoice.amount}), 0)::float8`,
      })
      .from(erpInvoice)
      // P1-8：必须限定 `direction = 'sales'`。
      //
      // 原实现只按 `status='issued'` 汇总，而**进项发票同样可以带 `project_id`**
      // （`invoice.service.ts` 的进项开票路径会写入项目归属）。于是项目上登记的
      // 每一张进项票都会被当作"已开票"，把未开票金额**冲低甚至冲成负数** ——
      // 财务据此以为"这个项目没什么可开的了"，而实际上一分钱销项票都没开。
      //
      // 顺带修正：红字发票（负数金额）现在也会参与汇总，把退货/收入冲回冲减的
      // 部分还原回"未开票"口径 —— 这与底稿销项的口径一致（见 `createRedLetterInvoice`）。
      .where(
        and(
          eq(erpInvoice.status, 'issued'),
          eq(erpInvoice.direction, 'sales')
        )
      )
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

  /**
   * N-3/B-4③：收入 → 应收 → 凭证 三方对账自检。
   *
   * 为什么必须存在：`createRevenue` 走的是「先落收入、再补应收与凭证」的多步写入
   * （现在已把收入与应收收进同一事务）。任何一步静默失败都会留下
   * 「有收入无应收」或「有收入无凭证」的账面缺口，而缺口本身在业务列表里
   * **完全看不出来**。本方法把缺口显式枚举出来（含补偿队列中待重试的凭证），
   * 供运维/财务在界面上发现并下钻，而不是靠人肉写 SQL。
   *
   * 口径说明：
   *   - 只检查 `status = 'recognized'` 的收入（已冲回的收入本就不应再有应收/凭证）；
   *   - 无合同的收入不要求应收（收入侧允许无合同确认，此时不存在债权）；
   *   - 金额一致性用 0.005 容差（numeric 两位小数）；
   *   - `voucher_pending` 与 `missing_voucher` 分开：前者可被重试任务自愈，后者必须人工补录。
   */
  async reconcileRevenueChain(
    period?: string
  ): Promise<RevenueChainReconcileResult> {
    if (period && !/^\d{4}-\d{2}$/u.test(period)) {
      throw new BadRequestException('期间格式须为 YYYY-MM');
    }
    const rows = unwrapRows<{
      id: string;
      code: string;
      project_id: string | null;
      project_name: string | null;
      contract_id: string | null;
      period: string | null;
      amount: string | null;
      ar_id: string | null;
      ar_amount: string | null;
      voucher_id: string | null;
      job_status: string | null;
    }>(
      await this.db.execute(sql`
        SELECT r.id,
               r.code,
               r.project_id,
               p.name AS project_name,
               r.contract_id,
               r.period,
               r.amount,
               a.id AS ar_id,
               a.amount AS ar_amount,
               v.id AS voucher_id,
               j.status AS job_status
          FROM erp_project_revenue r
          LEFT JOIN erp_project p ON p.id = r.project_id
          LEFT JOIN erp_ar a ON a.source_ref = 'revenue:' || r.code
          LEFT JOIN fin_voucher v ON v.source_type = 'revenue'
               AND v.source_ref = 'revenue:' || r.code
               AND v.status <> 'voided'
          LEFT JOIN comp_voucher_job j ON j.source_type = 'revenue'
               AND j.source_ref = 'revenue:' || r.code
               AND j.status IN ('failed', 'processing')
         WHERE r.status = 'recognized'
           AND (${period ?? null}::text IS NULL OR r.period = ${period ?? null})
         ORDER BY r.code
      `)
    );

    const gaps: RevenueChainGap[] = [];
    for (const row of rows) {
      const amount = Number(row.amount ?? 0);
      const base = {
        revenueId: row.id,
        code: row.code,
        projectId: row.project_id ?? '',
        projectName: row.project_name ?? '',
        contractId: row.contract_id,
        period: row.period ?? '',
        amount,
      };
      const push = (gapKind: RevenueChainGapKind, detail: string): void => {
        gaps.push({ ...base, gapKind, detail });
      };
      if (row.contract_id) {
        if (!row.ar_id) {
          push('missing_ar', '已确认收入但查不到应收单（应收漏登记）');
        } else if (Math.abs(Number(row.ar_amount ?? 0) - amount) > 0.005) {
          push(
            'ar_amount_mismatch',
            `应收金额 ${Number(row.ar_amount ?? 0).toFixed(2)} 与收入金额 ${amount.toFixed(2)} 不一致`
          );
        }
      }
      if (!row.voucher_id) {
        if (row.job_status) {
          push(
            'voucher_pending',
            `凭证在补偿队列（${row.job_status}），等待重试任务自愈`
          );
        } else {
          push('missing_voucher', '既无凭证也不在补偿队列（凭证缺失，需人工补录）');
        }
      }
    }
    return {
      period: period ?? null,
      checked: rows.length,
      gapCount: gaps.length,
      consistent: gaps.length === 0,
      gaps,
    };
  }
}
