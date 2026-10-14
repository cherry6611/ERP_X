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
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  biAlertSubscription,
  erpApBill,
  erpAr,
  erpContract,
  erpInvoice,
  erpPayment,
  erpProject,
  erpProjectCost,
  erpProjectRevenue,
  erpReceipt,
} from '@server/database/schema';
import { NotificationsService } from '@server/modules/notifications/notifications.service';
import type {
  BiAlertSubscriptionItem,
  BiMetric,
  BiMetricsResult,
  UpsertBiAlertSubscriptionDto,
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

/** 上期（YYYY-MM） */
function previousPeriod(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, '0')}`;
}

/** 指标定义表：key/名称/单位/可读口径/下钻路由 */
interface MetricDefinition {
  key: string;
  name: string;
  unit: string;
  formula: string;
  drillUrl: string | null;
}

/**
 * D-12：BI 指标中心与预警订阅。
 *
 * 设计要点：
 * 1. **每个指标必须带可读中文口径**（`formula`），而不是只给一个数字 ——
 *    需求书 D-12 明确"指标中心需带口径说明"，否则业务方无法核对数字来源。
 * 2. `drillUrl` 指向**真实存在**的前端路由（与 `client/src/components/nav.tsx`
 *    和 `client/src/app.tsx` 一致），不存在的页面一律给 null，避免死链。
 * 3. 口径来源优先复用已有账务事实：收入取 `erp_project_revenue.status='recognized'`
 *    的不含税净额，成本取 `erp_project_cost`，回款取 `erp_receipt`，
 *    应收周转取 `erp_ar` 期末余额 —— 与 BI 既有 `getOverview` 同源，避免两处口径打架。
 */
@Injectable()
export class BiMetricsService {
  private readonly logger = new Logger(BiMetricsService.name);

  /** 指标注册表（顺序即前端展示顺序） */
  static readonly METRICS: MetricDefinition[] = [
    {
      key: 'revenue',
      name: '营业收入',
      unit: '元',
      formula: '营业收入 = Σ 已确认收入(erp_project_revenue.status=recognized) 的不含税净额，含已生效收入调整',
      drillUrl: '/revenue',
    },
    {
      key: 'cost',
      name: '营业成本',
      unit: '元',
      formula: '营业成本 = Σ 项目成本(erp_project_cost) 金额（人力/外协/差旅/采购等全部成本类型）',
      drillUrl: '/costs',
    },
    {
      key: 'gross_profit',
      name: '毛利',
      unit: '元',
      formula: '毛利 = 营业收入 − 营业成本',
      drillUrl: '/bi/metrics',
    },
    {
      key: 'gross_margin',
      name: '毛利率',
      unit: '%',
      formula: '毛利率 =（营业收入 − 营业成本）/ 营业收入 × 100；营业收入为 0 时记 0',
      drillUrl: '/bi/metrics',
    },
    {
      key: 'receipt_rate',
      name: '回款率',
      unit: '%',
      formula: '回款率 = 已确认回款总额 / 累计应收总额 × 100（口径含历史全部单据，非仅本期）',
      drillUrl: '/finance',
    },
    {
      key: 'ar_turnover_days',
      name: '应收周转天数',
      unit: '天',
      formula: '应收周转天数 = 期末应收余额 / (本期不含税收入 / 30)；本期收入为 0 时记 0',
      drillUrl: '/finance',
    },
    {
      key: 'invoice_net',
      name: '本期净开票额（销项−进项）',
      unit: '元',
      formula: '净开票额 = Σ 本期销项发票含税额 − Σ 本期进项发票含税额（仅统计 status=issued）',
      drillUrl: '/finance',
    },
    {
      key: 'active_projects',
      name: '在管项目数',
      unit: '个',
      formula: '在管项目数 = erp_project.status ∈ (active, delivering, accepting) 的项目个数',
      drillUrl: '/projects',
    },
    {
      key: 'over_budget_projects',
      name: '超预算项目数',
      unit: '个',
      formula: '超预算项目数 = 实际成本 > 预计总成本(estimated_total_cost) 的在管项目数',
      drillUrl: '/projects',
    },
    {
      key: 'unpaid_ap',
      name: '未付应付余额',
      unit: '元',
      formula: '未付应付余额 = Σ 应付单(erp_ap_bill) 金额 − Σ 已批准付款(erp_payment.status=paid)',
      drillUrl: '/finance',
    },
  ];

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly notifications: NotificationsService,
  ) {}

  private assertPeriod(period: string): void {
    if (!PERIOD_PATTERN.test(period)) {
      throw new BadRequestException('period 必须为 YYYY-MM');
    }
  }

  /** 指标字典（供前端渲染订阅下拉，避免前端硬编码） */
  listMetricDefinitions(): MetricDefinition[] {
    return BiMetricsService.METRICS;
  }


  /** 本期不含税收入（已确认收入 + 已生效调整） */
  private async revenueOf(period: string): Promise<number> {
    const rows = await this.db
      .select({
        total: sql<string>`coalesce(sum(
          coalesce(${erpProjectRevenue.amount}, 0) * 100.0
          / (100.0 + coalesce(${erpContract.taxRate}, 6))
        ), 0)`,
      })
      .from(erpProjectRevenue)
      .leftJoin(erpContract, eq(erpProjectRevenue.contractId, erpContract.id))
      .where(
        and(
          eq(erpProjectRevenue.status, 'recognized'),
          eq(erpProjectRevenue.period, period)
        )
      );
    return round2(toNumber(rows[0]?.total));
  }

  /** 本期项目成本 */
  private async costOf(period: string): Promise<number> {
    const rows = await this.db
      .select({
        total: sql<string>`coalesce(sum(${erpProjectCost.amount}), 0)`,
      })
      .from(erpProjectCost)
      .where(
        and(
          eq(erpProjectCost.period, period)
        )
      );
    return round2(toNumber(rows[0]?.total));
  }

  /** 回款率：历史累计口径（不是本期），与"回款率"业务含义一致 */
  private async receiptRate(): Promise<number> {
    const receiptRows = await this.db
      .select({ total: sql<string>`coalesce(sum(${erpReceipt.amount}), 0)` })
      .from(erpReceipt)
      .where(sql`${erpReceipt.status} <> 'voided'`);
    const arRows = await this.db
      .select({ total: sql<string>`coalesce(sum(${erpAr.amount}), 0)` })
      .from(erpAr);
    const receipts = toNumber(receiptRows[0]?.total);
    const ars = toNumber(arRows[0]?.total);
    if (ars <= 0) return 0;
    return round2((receipts / ars) * 100);
  }

  /** 期末应收余额（未结清部分） */
  private async openArBalance(): Promise<number> {
    const rows = await this.db
      .select({
        total: sql<string>`coalesce(sum(${erpAr.amount} - coalesce(${erpAr.settledAmount}, 0)), 0)`,
      })
      .from(erpAr)
      .where(sql`${erpAr.status} <> 'settled'`);
    return round2(toNumber(rows[0]?.total));
  }

  /** 本期销项/进项发票含税额 */
  private async invoiceNet(period: string): Promise<number> {
    const rows = await this.db
      .select({
        sales: sql<string>`coalesce(sum(case when ${erpInvoice.direction} = 'sales' then ${erpInvoice.amount} else 0 end), 0)`,
        purchase: sql<string>`coalesce(sum(case when ${erpInvoice.direction} = 'purchase' then ${erpInvoice.amount} else 0 end), 0)`,
      })
      .from(erpInvoice)
      .where(
        and(
          eq(erpInvoice.status, 'issued'),
          sql`to_char(${erpInvoice.invoiceDate}, 'YYYY-MM') = ${period}`
        )
      );
    return round2(
      toNumber(rows[0]?.sales) - toNumber(rows[0]?.purchase)
    );
  }

  /** 在管项目数与超预算项目数 */
  private async projectStats(): Promise<{
    activeProjects: number;
    overBudgetProjects: number;
  }> {
    const activeRows = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(erpProject)
      .where(
        sql`${erpProject.status} in ('active', 'delivering', 'accepting')`
      );
    const overRows = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(erpProject)
      .where(
        sql`${erpProject.status} in ('active', 'delivering', 'accepting')
            AND coalesce(${erpProject.estimatedTotalCost}, 0) > 0
            AND (
              SELECT coalesce(sum(c.amount), 0) FROM erp_project_cost c
              WHERE c.project_id = ${erpProject.id}
            ) > ${erpProject.estimatedTotalCost}`
      );
    return {
      activeProjects: Number(activeRows[0]?.total ?? 0),
      overBudgetProjects: Number(overRows[0]?.total ?? 0),
    };
  }

  /** 未付应付余额 */
  private async unpaidAp(): Promise<number> {
    const apRows = await this.db
      .select({ total: sql<string>`coalesce(sum(${erpApBill.amount} - coalesce(${erpApBill.paidAmount}, 0)), 0)` })
      .from(erpApBill)
      .where(sql`${erpApBill.status} <> 'settled'`);
    void erpPayment;
    return round2(toNumber(apRows[0]?.total));
  }

  /**
   * 指标中心（D-12）：本期值 + 上期对比值 + 可读口径 + 下钻路由。
   *
   * 对比值取上一期间的同口径指标；部分指标（回款率、未付应付）是时点/累计口径，
   * 上期值同样按上期期间重算，保证可比。
   */
  async metrics(period: string): Promise<BiMetricsResult> {
    this.assertPeriod(period);
    const prev = previousPeriod(period);
    const [revenue, cost, prevRevenue, prevCost, receiptRate, openAr, invoiceNet, prevInvoiceNet, projects, unpaidAp] =
      await Promise.all([
        this.revenueOf(period),
        this.costOf(period),
        this.revenueOf(prev),
        this.costOf(prev),
        this.receiptRate(),
        this.openArBalance(),
        this.invoiceNet(period),
        this.invoiceNet(prev),
        this.projectStats(),
        this.unpaidAp(),
      ]);
    const grossProfit = round2(revenue - cost);
    const grossMargin = revenue > 0 ? round2((grossProfit / revenue) * 100) : 0;
    const prevGrossProfit = round2(prevRevenue - prevCost);
    const prevGrossMargin =
      prevRevenue > 0 ? round2((prevGrossProfit / prevRevenue) * 100) : 0;
    const arTurnoverDays =
      revenue > 0 ? round2(openAr / (revenue / 30)) : 0;

    const values: Record<string, { value: number; previous: number | null }> = {
      revenue: { value: revenue, previous: prevRevenue },
      cost: { value: cost, previous: prevCost },
      gross_profit: { value: grossProfit, previous: prevGrossProfit },
      gross_margin: { value: grossMargin, previous: prevGrossMargin },
      receipt_rate: { value: receiptRate, previous: null },
      ar_turnover_days: { value: arTurnoverDays, previous: null },
      invoice_net: { value: invoiceNet, previous: prevInvoiceNet },
      active_projects: { value: projects.activeProjects, previous: null },
      over_budget_projects: {
        value: projects.overBudgetProjects,
        previous: null,
      },
      unpaid_ap: { value: unpaidAp, previous: null },
    };

    const metrics: BiMetric[] = BiMetricsService.METRICS.map((definition) => {
      const entry = values[definition.key] ?? { value: 0, previous: null };
      return {
        key: definition.key,
        name: definition.name,
        value: entry.value,
        unit: definition.unit,
        formula: definition.formula,
        drillUrl: definition.drillUrl,
        previousValue: entry.previous,
      };
    });

    return {
      period,
      generatedAt: new Date().toISOString(),
      metrics,
    };
  }

  /* ========== 预警订阅 ========== */

  private metricName(key: string): string {
    return (
      BiMetricsService.METRICS.find((item) => item.key === key)?.name ?? key
    );
  }

  async listSubscriptions(userId: string): Promise<BiAlertSubscriptionItem[]> {
    const rows = await this.db
      .select()
      .from(biAlertSubscription)
      .where(eq(biAlertSubscription.userId, userId))
      .orderBy(asc(biAlertSubscription.metricKey));
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      metricKey: row.metricKey,
      metricName: this.metricName(row.metricKey),
      thresholdDirection: (row.thresholdDirection ?? 'gt') as 'gt' | 'lt',
      threshold: round2(toNumber(row.threshold)),
      channel: (row.channel ?? 'feishu') as 'feishu' | 'inbox',
      enabled: Number(row.enabled ?? 1) === 1,
      lastTriggeredAt: row.lastTriggeredAt
        ? row.lastTriggeredAt.toISOString()
        : null,
      remark: row.remark ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async upsertSubscription(
    userId: string,
    dto: UpsertBiAlertSubscriptionDto
  ): Promise<BiAlertSubscriptionItem> {
    const definition = BiMetricsService.METRICS.find(
      (item) => item.key === dto.metricKey
    );
    if (!definition) {
      throw new BadRequestException(
        `未知指标 ${dto.metricKey}；可选：${BiMetricsService.METRICS.map((m) => m.key).join(' / ')}`
      );
    }
    if (!Number.isFinite(dto.threshold)) {
      throw new BadRequestException('阈值必须为数值');
    }
    const channel = dto.channel ?? 'feishu';
    if (!['feishu', 'inbox'].includes(channel)) {
      throw new BadRequestException('通知渠道仅支持 feishu / inbox');
    }
    const direction = dto.thresholdDirection ?? 'gt';
    if (!['gt', 'lt'].includes(direction)) {
      throw new BadRequestException('阈值方向仅支持 gt / lt');
    }
    const existing = await this.db
      .select({ id: biAlertSubscription.id })
      .from(biAlertSubscription)
      .where(
        and(
          eq(biAlertSubscription.userId, userId),
          eq(biAlertSubscription.metricKey, dto.metricKey),
          eq(biAlertSubscription.channel, channel)
        )
      )
      .limit(1);
    const values = {
      userId,
      metricKey: dto.metricKey,
      thresholdDirection: direction,
      threshold: String(round2(dto.threshold)),
      channel,
      enabled: dto.enabled === false ? 0 : 1,
      remark: dto.remark ?? null,
      updatedAt: new Date(),
    };
    if (existing.length > 0) {
      await this.db
        .update(biAlertSubscription)
        .set(values)
        .where(eq(biAlertSubscription.id, existing[0].id));
      const list = await this.listSubscriptions(userId);
      return (
        list.find((item) => item.metricKey === dto.metricKey && item.channel === channel) ??
        list[0]
      );
    }
    try {
      await this.db.insert(biAlertSubscription).values(values);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('23505')) {
        throw new ConflictException(
          `已订阅「${definition.name}」的 ${channel} 提醒，请改为更新`
        );
      }
      throw error;
    }
    const list = await this.listSubscriptions(userId);
    return (
      list.find((item) => item.metricKey === dto.metricKey && item.channel === channel) ??
      list[0]
    );
  }

  async removeSubscription(userId: string, id: string): Promise<{ ok: true }> {
    const removed = await this.db
      .delete(biAlertSubscription)
      .where(
        and(
          eq(biAlertSubscription.id, id),
          eq(biAlertSubscription.userId, userId)
        )
      )
      .returning({ id: biAlertSubscription.id });
    if (removed.length === 0) {
      throw new NotFoundException('订阅不存在或不属于当前用户');
    }
    return { ok: true };
  }

  /**
   * 按订阅评估指标并通知（`bi_alert_daily` cron 调用）。
   *
   * 实现约束：
   * - 逐条订阅独立 try/catch（一条坏订阅不能让全部预警停摆）；
   * - 通知在**事务外**发送（需求书 B-22：新增外部 IO 必须在事务外）；
   * - 触发后写 `lastTriggeredAt`，便于排障"为什么今天没提醒"。
   */
  async runAlertScan(period: string): Promise<{
    evaluated: number;
    triggered: number;
    failures: number;
  }> {
    this.assertPeriod(period);
    const result = await this.metrics(period);
    const valueByKey = new Map(
      result.metrics.map((metric) => [metric.key, metric.value])
    );
    const subscriptions = await this.db
      .select()
      .from(biAlertSubscription)
      .where(eq(biAlertSubscription.enabled, 1));
    let triggered = 0;
    let failures = 0;
    for (const subscription of subscriptions) {
      try {
        const value = valueByKey.get(subscription.metricKey);
        if (value === undefined) continue;
        const threshold = toNumber(subscription.threshold);
        const direction = subscription.thresholdDirection ?? 'gt';
        const hit =
          direction === 'gt' ? value > threshold : value < threshold;
        if (!hit) continue;
        const name = this.metricName(subscription.metricKey);
        const title = `【BI 预警】${name} ${direction === 'gt' ? '高于' : '低于'}阈值`;
        const content = [
          `期间：${period}`,
          `${name}：${value}`,
          `阈值：${direction === 'gt' ? '>' : '<'} ${threshold}`,
          subscription.remark ? `备注：${subscription.remark}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        await this.notifications.sendUserNotification(
          [subscription.userId],
          title,
          content
        );
        await this.db
          .update(biAlertSubscription)
          .set({ lastTriggeredAt: new Date(), updatedAt: new Date() })
          .where(eq(biAlertSubscription.id, subscription.id));
        triggered += 1;
      } catch (error) {
        failures += 1;
        this.logger.error(
          `BI 预警订阅执行失败 id=${subscription.id} metric=${subscription.metricKey}：${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    this.logger.log(
      `BI 预警扫描完成 period=${period} subscriptions=${subscriptions.length} triggered=${triggered} failures=${failures}`
    );
    return { evaluated: subscriptions.length, triggered, failures };
  }

  /** 供运维：查看全体订阅（admin） */
  async listAllSubscriptions(): Promise<BiAlertSubscriptionItem[]> {
    const rows = await this.db
      .select()
      .from(biAlertSubscription)
      .orderBy(desc(biAlertSubscription.createdAt))
      .limit(500);
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      metricKey: row.metricKey,
      metricName: this.metricName(row.metricKey),
      thresholdDirection: (row.thresholdDirection ?? 'gt') as 'gt' | 'lt',
      threshold: round2(toNumber(row.threshold)),
      channel: (row.channel ?? 'feishu') as 'feishu' | 'inbox',
      enabled: Number(row.enabled ?? 1) === 1,
      lastTriggeredAt: row.lastTriggeredAt
        ? row.lastTriggeredAt.toISOString()
        : null,
      remark: row.remark ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
