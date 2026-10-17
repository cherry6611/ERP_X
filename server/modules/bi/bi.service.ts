import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  like,
  lt,
  lte,
  ne,
  or,
  sql,
  sum,
} from 'drizzle-orm';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { todayInShanghai } from '@server/common/utils/biz-date';
import { round2 } from '@server/common/utils/number';
import {
  astAsset,
  astChange,
  daDataset,
  daGrant,
  erpAdminBill,
  erpApBill,
  erpAr,
  erpContract,
  erpCostAllocation,
  erpProject,
  erpProjectCost,
  erpProjectMilestone,
  erpInvoice,
  erpProjectRevenue,
  erpRevenueAdjust,
  mdTaxEntity,
  erpTimesheet,
  hrDepartment,
  hrPayroll,
  mdCustomer,
  mdEmployee,
} from '@server/database/schema';
import { computeEvm } from '@server/common/utils/evm';
import {
  ACTIVE_PROJECT_STATUSES,
  classifyProjectHealth,
  projectedFinalCost,
  remainingMonthsUntil,
} from './project-health';
import type {
  AlertItem,
  AlertsResult,
  BiOverview,
  BiProjectCostBreakdownItem,
  CustomerContribution,
  DepartmentHeadcount,
  HeadcountPoint,
  HrOverview,
  LaborCostPoint,
  MonthlyTrend,
  ProjectFinancialHealthItem,
  ProjectFinancialHealthSummary,
  ProjectHealthLevel,
  ProjectMargin,
} from '@shared/api.interface';

dayjs.extend(utc);

/*
 * 在管项目状态白名单已抽到 `./project-health`（与指标中心共用一份）。
 * 原先这里写 `['initiating','executing']`、指标中心内联
 * `('active','delivering','accepting')` —— 后者里的 `'active'` 是**合同**状态，
 * 于是指标中心那两个项目数指标恒为 0，与看板自相矛盾。详见该文件注释。
 */

@Injectable()
export class BiService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  async getOverview(): Promise<BiOverview> {
    const contractRows = await this.db
      .select({
        total: sql<number>`coalesce(sum(${erpContract.amount}), 0)::float8`,
        activeCount: sql<number>`count(*) filter (where ${erpContract.status} in ('active', 'performing'))::int`,
      })
      .from(erpContract);
    // T2：毛利按不含税净收入 = amount * 100/(100+tax_rate)，税率取关联合同
    const revenueRows = await this.db
      .select({
        total: sql<number>`coalesce(sum(
          coalesce(${erpProjectRevenue.amount}, 0) * 100.0
          / (100.0 + coalesce(${erpContract.taxRate}, 6))
        ), 0)::float8`,
      })
      .from(erpProjectRevenue)
      .leftJoin(erpContract, eq(erpProjectRevenue.contractId, erpContract.id))
      .where(eq(erpProjectRevenue.status, 'recognized'));
    const adjustRows = await this.db
      .select({
        total: sql<number>`coalesce(sum(
          coalesce(${erpRevenueAdjust.amount}, 0) * 100.0
          / (100.0 + coalesce(${erpContract.taxRate}, 6))
        ), 0)::float8`,
      })
      .from(erpRevenueAdjust)
      .innerJoin(
        erpProjectRevenue,
        eq(erpRevenueAdjust.revenueId, erpProjectRevenue.id)
      )
      .leftJoin(erpContract, eq(erpProjectRevenue.contractId, erpContract.id))
      .where(eq(erpRevenueAdjust.status, 'applied'));
    const costRows = await this.db
      .select({
        total: sql<number>`coalesce(sum(${erpProjectCost.amount}), 0)::float8`,
      })
      .from(erpProjectCost);
    const arRows = await this.db
      .select({
        amount: erpAr.amount,
        settledAmount: erpAr.settledAmount,
      })
      .from(erpAr)
      // B1：白名单化 —— `ne('settled')` 会把新终态 `'voided'` 算进来，
      // 作废的应收仍在经营看板里占额度。新增状态默认不可见（fail-closed）。
      .where(inArray(erpAr.status, ['open', 'partial']));
    const apRows = await this.db
      .select({
        amount: erpApBill.amount,
        paidAmount: erpApBill.paidAmount,
      })
      .from(erpApBill)
      .where(inArray(erpApBill.status, ['pending', 'approved', 'partial']));
    const projectRows = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(erpProject)
      .where(inArray(erpProject.status, ACTIVE_PROJECT_STATUSES));
    // 修复 P1-10：工资分摊在 hr-pay 里同时写入 erp_cost_allocation 与 erp_project_cost，
    // 而 totalCost 已经 SUM(erp_project_cost) 扣过一次；这里若再计入 periodExpense
    // 就是第二次扣减 → 营业利润被低估整整一个工资总额。
    // 与 fixedAllocRows 一致：只统计「没有对应项目成本行」的分摊。
    const payrollAllocRows = await this.db
      .select({
        total: sql<number>`coalesce(sum(${erpCostAllocation.amount}), 0)::float8`,
      })
      .from(erpCostAllocation)
      .where(
        and(
          like(erpCostAllocation.sourceRef, 'payroll:%'),
          sql`NOT EXISTS (
            SELECT 1 FROM erp_project_cost c
            WHERE c.source_ref = ${erpCostAllocation.sourceRef}
          )`
        )
      );
    const assetAllocRows = await this.db
      .select({
        total: sql<number>`coalesce(sum(${erpCostAllocation.amount}), 0)::float8`,
      })
      .from(erpCostAllocation)
      .where(like(erpCostAllocation.sourceRef, 'asset:%'));
    const adminBillRows = await this.db
      .select({
        total: sql<number>`coalesce(sum(${erpAdminBill.amount}), 0)::float8`,
      })
      .from(erpAdminBill)
      .where(inArray(erpAdminBill.status, ['approved', 'paid']));
    const customerRows = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(mdCustomer);
    const recognizedRevenue =
      Number(revenueRows[0]?.total ?? 0) - Number(adjustRows[0]?.total ?? 0);
    const totalCost = Number(costRows[0]?.total ?? 0);
    const grossMargin = recognizedRevenue - totalCost;
    const marginRate =
      recognizedRevenue > 0
        ? Math.round((grossMargin / recognizedRevenue) * 10000) / 100
        : 0;
    let openArAmount = 0;
    for (const row of arRows) {
      openArAmount += Number(row.amount) - Number(row.settledAmount ?? 0);
    }
    let openApAmount = 0;
    for (const row of apRows) {
      openApAmount += Number(row.amount) - Number(row.paidAmount ?? 0);
    }
    const periodExpenseTotal =
      Number(payrollAllocRows[0]?.total ?? 0) +
      Number(assetAllocRows[0]?.total ?? 0) +
      Number(adminBillRows[0]?.total ?? 0);
    return {
      contractAmount: Number(contractRows[0]?.total ?? 0),
      recognizedRevenue,
      totalCost,
      grossMargin,
      marginRate,
      openArAmount,
      openApAmount,
      activeProjectCount: Number(projectRows[0]?.total ?? 0),
      activeContractCount: Number(contractRows[0]?.activeCount ?? 0),
      customerCount: Number(customerRows[0]?.total ?? 0),
      periodExpenseTotal,
      operatingProfit: grossMargin - periodExpenseTotal,
    };
  }

  async getProjectMargins(): Promise<ProjectMargin[]> {
    const projects = await this.db
      .select({
        id: erpProject.id,
        code: erpProject.code,
        name: erpProject.name,
        pm: erpProject.pm,
      })
      .from(erpProject);
    // T2：项目毛利用合同税率拆出净收入
    const revenueRows = await this.db
      .select({
        projectId: erpProjectRevenue.projectId,
        total: sql<number>`coalesce(sum(
          coalesce(${erpProjectRevenue.amount}, 0) * 100.0
          / (100.0 + coalesce(${erpContract.taxRate}, 6))
        ), 0)::float8`,
      })
      .from(erpProjectRevenue)
      .leftJoin(erpContract, eq(erpProjectRevenue.contractId, erpContract.id))
      .where(eq(erpProjectRevenue.status, 'recognized'))
      .groupBy(erpProjectRevenue.projectId);
    const adjustRows = await this.db
      .select({
        projectId: erpProjectRevenue.projectId,
        total: sql<number>`coalesce(sum(
          coalesce(${erpRevenueAdjust.amount}, 0) * 100.0
          / (100.0 + coalesce(${erpContract.taxRate}, 6))
        ), 0)::float8`,
      })
      .from(erpRevenueAdjust)
      .innerJoin(
        erpProjectRevenue,
        eq(erpRevenueAdjust.revenueId, erpProjectRevenue.id)
      )
      .leftJoin(erpContract, eq(erpProjectRevenue.contractId, erpContract.id))
      .where(eq(erpRevenueAdjust.status, 'applied'))
      .groupBy(erpProjectRevenue.projectId);
    const costRows = await this.db
      .select({
        projectId: erpProjectCost.projectId,
        total: sql<number>`coalesce(sum(${erpProjectCost.amount}), 0)::float8`,
      })
      .from(erpProjectCost)
      .groupBy(erpProjectCost.projectId);
    const fixedAllocRows = await this.db
      .select({
        projectId: erpCostAllocation.targetProjectId,
        total: sql<number>`coalesce(sum(${erpCostAllocation.amount}), 0)::float8`,
      })
      .from(erpCostAllocation)
      .where(sql`
        NOT EXISTS (
          SELECT 1 FROM erp_project_cost c
          WHERE c.source_ref = erp_cost_allocation.source_ref
            AND c.project_id = erp_cost_allocation.target_project_id
            AND c.source_ref IS NOT NULL
        )
      `)
      .groupBy(erpCostAllocation.targetProjectId);
    const revenueMap = new Map<string, number>();
    for (const row of revenueRows) {
      revenueMap.set(row.projectId ?? '', Number(row.total ?? 0));
    }
    const adjustMap = new Map<string, number>();
    for (const row of adjustRows) {
      adjustMap.set(row.projectId ?? '', Number(row.total ?? 0));
    }
    const costMap = new Map<string, number>();
    for (const row of costRows) {
      costMap.set(row.projectId ?? '', Number(row.total ?? 0));
    }
    const fixedAllocMap = new Map<string, number>();
    for (const row of fixedAllocRows) {
      fixedAllocMap.set(row.projectId ?? '', Number(row.total ?? 0));
    }
    const result: ProjectMargin[] = projects.map((project) => {
      const recognizedRevenue =
        (revenueMap.get(project.id) ?? 0) - (adjustMap.get(project.id) ?? 0);
      const totalCost = costMap.get(project.id) ?? 0;
      const grossMargin = recognizedRevenue - totalCost;
      const marginRate =
        recognizedRevenue > 0
          ? Math.round((grossMargin / recognizedRevenue) * 10000) / 100
          : 0;
      const allocatedFixedCost = fixedAllocMap.get(project.id) ?? 0;
      return {
        projectId: project.id,
        code: project.code,
        name: project.name,
        pm: project.pm,
        recognizedRevenue,
        totalCost,
        grossMargin,
        marginRate,
        allocatedFixedCost,
        contributionMargin: grossMargin - allocatedFixedCost,
      };
    });
    return result.sort((a, b) => b.grossMargin - a.grossMargin);
  }

  async getProjectFinancialHealth(): Promise<ProjectFinancialHealthSummary> {
    const projects = await this.db
      .select({
        id: erpProject.id,
        code: erpProject.code,
        name: erpProject.name,
        pm: erpProject.pm,
        budget: erpProject.budget,
        estimatedTotalCost: erpProject.estimatedTotalCost,
        endDate: erpProject.endDate,
      })
      .from(erpProject);
    const revenueRows = await this.db
      .select({
        projectId: erpProjectRevenue.projectId,
        total: sql<number>`coalesce(sum(${erpProjectRevenue.amount}), 0)::float8`,
      })
      .from(erpProjectRevenue)
      .where(eq(erpProjectRevenue.status, 'recognized'))
      .groupBy(erpProjectRevenue.projectId);
    const adjustRows = await this.db
      .select({
        projectId: erpProjectRevenue.projectId,
        total: sql<number>`coalesce(sum(${erpRevenueAdjust.amount}), 0)::float8`,
      })
      .from(erpRevenueAdjust)
      .innerJoin(
        erpProjectRevenue,
        eq(erpRevenueAdjust.revenueId, erpProjectRevenue.id)
      )
      .where(eq(erpRevenueAdjust.status, 'applied'))
      .groupBy(erpProjectRevenue.projectId);
    const costRows = await this.db
      .select({
        projectId: erpProjectCost.projectId,
        total: sql<number>`coalesce(sum(${erpProjectCost.amount}), 0)::float8`,
      })
      .from(erpProjectCost)
      .groupBy(erpProjectCost.projectId);
    const now = dayjs().utcOffset(8);
    const recentStart: string = now
      .subtract(2, 'month')
      .startOf('month')
      .format('YYYY-MM-DD');
    const recentEnd: string = now.add(1, 'day').format('YYYY-MM-DD');
    const recentCostRows = await this.db
      .select({
        projectId: erpProjectCost.projectId,
        total: sql<number>`coalesce(sum(${erpProjectCost.amount}), 0)::float8`,
      })
      .from(erpProjectCost)
      .where(
        and(
          gte(erpProjectCost.occurredDate, recentStart),
          lt(erpProjectCost.occurredDate, recentEnd)
        )
      )
      .groupBy(erpProjectCost.projectId);
    const revenueMap = new Map<string, number>();
    for (const row of revenueRows) {
      revenueMap.set(row.projectId ?? '', Number(row.total ?? 0));
    }
    const adjustMap = new Map<string, number>();
    for (const row of adjustRows) {
      adjustMap.set(row.projectId ?? '', Number(row.total ?? 0));
    }
    const costMap = new Map<string, number>();
    for (const row of costRows) {
      costMap.set(row.projectId ?? '', Number(row.total ?? 0));
    }
    const recentCostMap = new Map<string, number>();
    for (const row of recentCostRows) {
      recentCostMap.set(row.projectId ?? '', Number(row.total ?? 0));
    }
    const milestoneRows = await this.db
      .select({
        projectId: erpProjectMilestone.projectId,
        status: erpProjectMilestone.status,
        weightPct: erpProjectMilestone.weightPct,
        baselineDate: erpProjectMilestone.baselineDate,
        forecastDate: erpProjectMilestone.forecastDate,
      })
      .from(erpProjectMilestone);
    const milestoneMap = new Map<
      string,
      Array<{
        status: string | null;
        weightPct: string | null;
        baselineDate: string | null;
        forecastDate: string | null;
      }>
    >();
    for (const row of milestoneRows) {
      const key = row.projectId ?? '';
      milestoneMap.set(key, [...(milestoneMap.get(key) ?? []), {
        status: row.status,
        weightPct: row.weightPct,
        baselineDate: row.baselineDate,
        forecastDate: row.forecastDate,
      }]);
    }
    const today: string = now.format('YYYY-MM-DD');
    const items: ProjectFinancialHealthItem[] = [];
    let overBudgetCount = 0;
    let watchCount = 0;
    for (const project of projects) {
      const budget: number = Number(project.budget ?? 0);
      const estimatedTotalCost: number = Number(
        project.estimatedTotalCost ?? 0
      );
      const actualCost: number = costMap.get(project.id) ?? 0;
      const recognizedRevenue: number =
        (revenueMap.get(project.id) ?? 0) - (adjustMap.get(project.id) ?? 0);
      const monthlyAvgCost: number = (recentCostMap.get(project.id) ?? 0) / 3;
      const remainingMonths = remainingMonthsUntil(project.endDate, now);
      const projectedFinalCostValue: number = projectedFinalCost(
        actualCost,
        monthlyAvgCost,
        remainingMonths
      );
      /*
       * 健康等级判定（含 unreachable > over_budget > watch 的优先级）已抽到
       * `./project-health` 的纯函数，可逐条单测 —— 生产库里不一定有
       * over_budget / unreachable 样本，靠真实数据观测不到优先级。
       */
      const verdict = classifyProjectHealth({
        budget,
        estimatedTotalCost,
        actualCost,
        projectedFinalCost: projectedFinalCostValue,
      });
      let healthLevel: ProjectHealthLevel = verdict.level;
      let healthReason: string | null = verdict.reason;
      if (verdict.overBudget) overBudgetCount += 1;
      if (verdict.watch) watchCount += 1;
      const evm = computeEvm(
        budget,
        actualCost,
        milestoneMap.get(project.id) ?? [],
        today
      );
      // B3：权重未配平时 SPI/CPI 不再等价于"完成百分比"，必须在健康度上
      // 单独暴露。原先 `evm.spi` 会在权重和 = 30 时返回 1.00，
      // 报表呈现"进度成本双达标"而实际只完成 30% —— 周预警因此集体失明。
      // 这里与其它健康等级**并列**（取更高优先级），而不是覆盖已有的
      // unreachable/over_budget：那些是资金问题，不能被一个配置问题盖掉。
      if (!evm.balanced && evm.totalWeight > 0 && healthReason === null) {
        healthLevel = 'watch';
        healthReason =
          `里程碑权重合计 ${evm.totalWeight}%（应为 100%），` +
          `SPI/CPI 已按实际权重归一化，但进度基准未配平，请先修正权重`;
        watchCount += 1;
      }
      const overdueMilestoneCount = (milestoneMap.get(project.id) ?? []).filter(
        (m) =>
          (m.status ?? 'pending') !== 'reached' &&
          m.forecastDate !== null &&
          m.forecastDate < today
      ).length;
      items.push({
        projectId: project.id,
        code: project.code,
        name: project.name,
        pm: project.pm,
        budget,
        estimatedTotalCost,
        actualCost,
        recognizedRevenue,
        projectedFinalCost: projectedFinalCostValue,
        healthLevel,
        healthReason,
        spi: evm.spi,
        cpi: evm.cpi,
        eac: evm.eac,
        overdueMilestoneCount,
        milestoneWeightTotal: evm.totalWeight,
        milestoneWeightBalanced: evm.balanced,
      });
    }
    return { items, overBudgetCount, watchCount };
  }

  async getProjectCostBreakdown(
    projectId: string
  ): Promise<BiProjectCostBreakdownItem[]> {
    const projectRows = await this.db
      .select({ id: erpProject.id })
      .from(erpProject)
      .where(eq(erpProject.id, projectId));
    if (projectRows.length === 0) {
      throw new NotFoundException('项目不存在');
    }
    const rows = await this.db
      .select({
        costType: erpProjectCost.costType,
        totalAmount: sql<number>`coalesce(sum(${erpProjectCost.amount}), 0)::float8`,
      })
      .from(erpProjectCost)
      .where(eq(erpProjectCost.projectId, projectId))
      .groupBy(erpProjectCost.costType);
    const total = rows.reduce(
      (acc: number, row: { totalAmount: number | null }) =>
        acc + Number(row.totalAmount ?? 0),
      0
    );
    const items: BiProjectCostBreakdownItem[] = rows.map(
      (row: { costType: string | null; totalAmount: number | null }) => {
        const totalAmount = Number(row.totalAmount ?? 0);
        return {
          costType: row.costType ?? 'labor',
          totalAmount,
          ratio:
            total > 0
              ? Math.round((totalAmount / total) * 1000) / 10
              : 0,
        };
      }
    );
    return items.sort((a: BiProjectCostBreakdownItem, b: BiProjectCostBreakdownItem) =>
      b.totalAmount - a.totalAmount
    );
  }

  async getCustomerContributions(): Promise<CustomerContribution[]> {
    const customers = await this.db
      .select({ id: mdCustomer.id, name: mdCustomer.name })
      .from(mdCustomer);
    const contractRows = await this.db
      .select({
        customerId: erpContract.customerId,
        total: sql<number>`coalesce(sum(${erpContract.amount}), 0)::float8`,
      })
      .from(erpContract)
      .groupBy(erpContract.customerId);
    const revenueRows = await this.db
      .select({
        customerId: erpContract.customerId,
        total: sql<number>`coalesce(sum(${erpProjectRevenue.amount}), 0)::float8`,
      })
      .from(erpProjectRevenue)
      .leftJoin(
        erpContract,
        eq(erpProjectRevenue.contractId, erpContract.id)
      )
      .where(eq(erpProjectRevenue.status, 'recognized'))
      .groupBy(erpContract.customerId);
    const adjustRows = await this.db
      .select({
        customerId: erpContract.customerId,
        total: sql<number>`coalesce(sum(${erpRevenueAdjust.amount}), 0)::float8`,
      })
      .from(erpRevenueAdjust)
      .innerJoin(
        erpProjectRevenue,
        eq(erpRevenueAdjust.revenueId, erpProjectRevenue.id)
      )
      .leftJoin(
        erpContract,
        eq(erpProjectRevenue.contractId, erpContract.id)
      )
      .where(eq(erpRevenueAdjust.status, 'applied'))
      .groupBy(erpContract.customerId);
    const arRows = await this.db
      .select({
        customerId: erpAr.customerId,
        amount: erpAr.amount,
        settledAmount: erpAr.settledAmount,
        status: erpAr.status,
      })
      .from(erpAr)
      /*
       * B1（同类缺陷）：与 `getOverview` 同口径白名单化。
       *
       * 原先这里**没有任何状态过滤**，下游用 `if (row.status === 'settled') continue`
       * 排除已结清 —— 那是一个**黑名单**，必然漏掉新增终态 `'voided'`
       * （`ArStatus = 'open' | 'partial' | 'settled' | 'voided'`）。
       * 后果：作废的应收被计入客户贡献表的「应收余额」，而同一块看板的
       * 概览 KPI（`getOverview`）与应收账龄分布（`ArService.listAging`）
       * 都已排除 —— **同一个屏幕上的两个数字对不上，差额恰为作废金额**。
       *
       * 改成白名单后，"新增状态默认不可见"（fail-closed），与 B1 的判据一致：
       * 将来再加应收状态时，这里不会静默把它算进余额。
       */
      .where(inArray(erpAr.status, ['open', 'partial']));
    const contractMap = new Map<string, number>();
    for (const row of contractRows) {
      contractMap.set(row.customerId ?? '', Number(row.total ?? 0));
    }
    const revenueMap = new Map<string, number>();
    for (const row of revenueRows) {
      revenueMap.set(row.customerId ?? '', Number(row.total ?? 0));
    }
    const adjustMap = new Map<string, number>();
    for (const row of adjustRows) {
      adjustMap.set(row.customerId ?? '', Number(row.total ?? 0));
    }
    const arMap = new Map<string, number>();
    for (const row of arRows) {
      /*
       * 状态过滤已上移到查询层（白名单 `open`/`partial`），此处不再重复判断 ——
       * 两处各判一次会让"哪些状态算未结"出现两个真相来源，而黑名单正是
       * 本次缺陷的成因（漏掉新增终态）。
       * `row.status` 仍在 select 里保留：它参与 `ArCustomerContribution` 的映射。
       */
      const open = Number(row.amount) - Number(row.settledAmount ?? 0);
      const key = row.customerId ?? '';
      arMap.set(key, (arMap.get(key) ?? 0) + open);
    }
    return customers.map((customer) => ({
      customerId: customer.id,
      name: customer.name,
      contractAmount: contractMap.get(customer.id) ?? 0,
      recognizedRevenue:
        (revenueMap.get(customer.id) ?? 0) -
        (adjustMap.get(customer.id) ?? 0),
      openArAmount: arMap.get(customer.id) ?? 0,
    }));
  }

  /** 近 6 个月收入/成本月度趋势 */
  async getMonthlyTrends(): Promise<MonthlyTrend[]> {
    const revenueRows = await this.db
      .select({
        period: erpProjectRevenue.period,
        total: sql<number>`coalesce(sum(${erpProjectRevenue.amount}), 0)::float8`,
      })
      .from(erpProjectRevenue)
      .where(eq(erpProjectRevenue.status, 'recognized'))
      .groupBy(erpProjectRevenue.period);
    const costRows = await this.db
      .select({
        period: erpProjectCost.period,
        total: sql<number>`coalesce(sum(${erpProjectCost.amount}), 0)::float8`,
      })
      .from(erpProjectCost)
      .groupBy(erpProjectCost.period);
    const payrollAllocRows = await this.db
      .select({
        period: erpCostAllocation.period,
        total: sql<number>`coalesce(sum(${erpCostAllocation.amount}), 0)::float8`,
      })
      .from(erpCostAllocation)
      .where(like(erpCostAllocation.sourceRef, 'payroll:%'))
      .groupBy(erpCostAllocation.period);
    const assetAllocRows = await this.db
      .select({
        period: erpCostAllocation.period,
        total: sql<number>`coalesce(sum(${erpCostAllocation.amount}), 0)::float8`,
      })
      .from(erpCostAllocation)
      .where(like(erpCostAllocation.sourceRef, 'asset:%'))
      .groupBy(erpCostAllocation.period);
    const adminBillRows = await this.db
      .select({
        period: erpAdminBill.period,
        total: sql<number>`coalesce(sum(${erpAdminBill.amount}), 0)::float8`,
      })
      .from(erpAdminBill)
      .where(inArray(erpAdminBill.status, ['approved', 'paid']))
      .groupBy(erpAdminBill.period);
    const revenueMap = new Map<string, number>();
    for (const row of revenueRows) {
      revenueMap.set(row.period ?? '', Number(row.total ?? 0));
    }
    const costMap = new Map<string, number>();
    for (const row of costRows) {
      costMap.set(row.period ?? '', Number(row.total ?? 0));
    }
    const expenseMap = new Map<string, number>();
    for (const row of [...payrollAllocRows, ...assetAllocRows, ...adminBillRows]) {
      const key = row.period ?? '';
      expenseMap.set(key, (expenseMap.get(key) ?? 0) + Number(row.total ?? 0));
    }
    const trends: MonthlyTrend[] = [];
    const now = new Date();
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      trends.push({
        period,
        revenue: revenueMap.get(period) ?? 0,
        cost: costMap.get(period) ?? 0,
        periodExpense: expenseMap.get(period) ?? 0,
      });
    }
    return trends;
  }

  /** 人力 BI 概览：在册/试用/本年入离职、近 12 个月在册趋势、人均产值 */
  async getHrOverview(): Promise<HrOverview> {
    const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const year: number = now.getUTCFullYear();
    const month: number = now.getUTCMonth() + 1;
    const yearStart = `${year}-01-01`;
    const nextYearStart = `${year + 1}-01-01`;
    const employees = await this.db
      .select({
        status: mdEmployee.status,
        hireDate: mdEmployee.hireDate,
        resignDate: mdEmployee.resignDate,
      })
      .from(mdEmployee);
    let activeCount = 0;
    let probationCount = 0;
    let hiredThisYear = 0;
    let resignedThisYear = 0;
    for (const emp of employees) {
      const status: string = emp.status ?? 'active';
      if (status === 'active') activeCount += 1;
      if (status === 'probation') probationCount += 1;
      if (
        emp.hireDate !== null &&
        emp.hireDate >= yearStart &&
        emp.hireDate < nextYearStart
      ) {
        hiredThisYear += 1;
      }
      if (
        emp.resignDate !== null &&
        emp.resignDate >= yearStart &&
        emp.resignDate < nextYearStart
      ) {
        resignedThisYear += 1;
      }
    }
    const headcountTrend: HeadcountPoint[] = [];
    const periods: string[] = [];
    for (let i = 11; i >= 0; i -= 1) {
      let m = month - i;
      let y = year;
      while (m <= 0) {
        m += 12;
        y -= 1;
      }
      const mm = String(m).padStart(2, '0');
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const monthEnd = `${y}-${mm}-${String(lastDay).padStart(2, '0')}`;
      let headcount = 0;
      for (const emp of employees) {
        if (emp.hireDate === null || emp.hireDate > monthEnd) continue;
        if (emp.resignDate !== null && emp.resignDate <= monthEnd) continue;
        headcount += 1;
      }
      periods.push(`${y}-${mm}`);
      headcountTrend.push({ month: `${y}-${mm}`, count: headcount });
    }
    const revenueRows = await this.db
      .select({
        total: sql<number>`coalesce(sum(${erpProjectRevenue.amount}), 0)::float8`,
      })
      .from(erpProjectRevenue)
      .where(
        and(
          eq(erpProjectRevenue.status, 'recognized'),
          inArray(erpProjectRevenue.period, periods)
        )
      );
    const revenue = Number(revenueRows[0]?.total ?? 0);
    const headcount = activeCount + probationCount;
    const revenuePerHead =
      headcount > 0 ? round2(revenue / headcount) : 0;

    const laborRows = await this.db
      .select({
        period: hrPayroll.period,
        total: sql<number>`coalesce(sum(coalesce(${hrPayroll.netSalary}, 0) + coalesce(${hrPayroll.socialInsurance}, 0) + coalesce(${hrPayroll.housingFund}, 0)), 0)::float8`,
      })
      .from(hrPayroll)
      .where(eq(hrPayroll.status, 'approved'))
      .groupBy(hrPayroll.period)
      .orderBy(desc(hrPayroll.period))
      .limit(1);
    const latestLaborCostPeriod: string | null =
      laborRows.length > 0 ? laborRows[0].period ?? null : null;
    const latestLaborCost: number =
      laborRows.length > 0 ? Number(laborRows[0].total ?? 0) : 0;

    const today: string = todayInShanghai();
    const hoursCutoff: string = new Date(Date.parse(today) - 30 * 86400000)
      .toISOString()
      .slice(0, 10);
    const hoursRows = await this.db
      .select({
        total: sql<number>`coalesce(sum(${erpTimesheet.hours}), 0)::float8`,
      })
      .from(erpTimesheet)
      .where(
        and(
          eq(erpTimesheet.status, 'confirmed'),
          gte(erpTimesheet.workDate, hoursCutoff)
        )
      );
    const totalHours: number = Number(hoursRows[0]?.total ?? 0);
    const avgProjectHoursPerHead =
      headcount > 0
        ? round2(totalHours / headcount)
        : 0;

    const deptRows = await this.db
      .select({
        departmentName: sql<string>`coalesce(${hrDepartment.name}, '未分配')`,
        total: sql<number>`count(*)::int`,
      })
      .from(mdEmployee)
      .leftJoin(hrDepartment, eq(mdEmployee.departmentId, hrDepartment.id))
      .where(inArray(mdEmployee.status, ['active', 'probation']))
      .groupBy(sql`coalesce(${hrDepartment.name}, '未分配')`)
      .orderBy(desc(sql`count(*)`));
    const departmentDistribution: DepartmentHeadcount[] = deptRows.map(
      (row) => ({
        departmentName: row.departmentName,
        count: Number(row.total ?? 0),
      })
    );

    const recentPeriods: string[] = [];
    for (let i = 5; i >= 0; i -= 1) {
      let pm = month - i;
      let py = year;
      while (pm <= 0) {
        pm += 12;
        py -= 1;
      }
      recentPeriods.push(`${py}-${String(pm).padStart(2, '0')}`);
    }
    const payrollCostRows = await this.db
      .select({
        period: hrPayroll.period,
        total: sql<number>`coalesce(sum(coalesce(${hrPayroll.netSalary}, 0) + coalesce(${hrPayroll.socialInsurance}, 0) + coalesce(${hrPayroll.housingFund}, 0)), 0)::float8`,
      })
      .from(hrPayroll)
      .where(
        and(
          eq(hrPayroll.status, 'approved'),
          inArray(hrPayroll.period, recentPeriods)
        )
      )
      .groupBy(hrPayroll.period);
    const projectCostRows = await this.db
      .select({
        period: erpCostAllocation.period,
        total: sql<number>`coalesce(sum(${erpCostAllocation.amount}), 0)::float8`,
      })
      .from(erpCostAllocation)
      .where(
        and(
          eq(erpCostAllocation.costType, 'labor'),
          inArray(erpCostAllocation.period, recentPeriods)
        )
      )
      .groupBy(erpCostAllocation.period);
    const payrollCostMap = new Map<string, number>();
    for (const row of payrollCostRows) {
      payrollCostMap.set(row.period ?? '', Number(row.total ?? 0));
    }
    const projectCostMap = new Map<string, number>();
    for (const row of projectCostRows) {
      projectCostMap.set(row.period ?? '', Number(row.total ?? 0));
    }
    const laborCostTrend: LaborCostPoint[] = recentPeriods.map(
      (period: string) => ({
        period,
        payrollCost: payrollCostMap.get(period) ?? 0,
        projectLaborCost: projectCostMap.get(period) ?? 0,
      })
    );

    return {
      activeCount,
      probationCount,
      hiredThisYear,
      resignedThisYear,
      revenuePerHead,
      headcountTrend,
      latestLaborCostPeriod,
      latestLaborCost,
      avgProjectHoursPerHead,
      departmentDistribution,
      laborCostTrend,
    };
  }

  /** 逾期与预警汇总：应收逾期 / 授权到期 / 资产待报废（业务时区 Asia/Shanghai 自然日） */
  async getAlerts(): Promise<AlertsResult> {
    const today: string = todayInShanghai();
    const horizon: string = new Date(Date.parse(today) + 30 * 86400000)
      .toISOString()
      .slice(0, 10);
    const dayDiff = (from: string, to: string): number =>
      Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

    const items: AlertItem[] = [];

    // 1. 应收逾期：未核销且未作废（B1 白名单：作废的应收不再产生逾期提醒）
    const arRows = await this.db
      .select({
        code: erpAr.code,
        amount: erpAr.amount,
        settledAmount: erpAr.settledAmount,
        dueDate: erpAr.dueDate,
        customerName: mdCustomer.name,
      })
      .from(erpAr)
      .leftJoin(mdCustomer, eq(erpAr.customerId, mdCustomer.id))
      .where(
        and(
          inArray(erpAr.status, ['open', 'partial']),
          isNotNull(erpAr.dueDate),
          lt(erpAr.dueDate, today)
        )
      );
    for (const row of arRows) {
      const open: number =
        Number(row.amount ?? 0) - Number(row.settledAmount ?? 0);
      if (open <= 0) continue;
      items.push({
        category: 'ar_overdue',
        refCode: row.code,
        title: `客户「${row.customerName ?? '未知'}」应收账款逾期未回款，未回款金额 ${open.toFixed(2)} 元`,
        days: -dayDiff(today, row.dueDate ?? today),
        severity: 'danger',
      });
    }

    // 2. 授权到期：active 且 30 天内到期（含已过期）
    const grantRows = await this.db
      .select({
        code: daGrant.code,
        scope: daGrant.scope,
        endDate: daGrant.endDate,
        datasetName: daDataset.name,
      })
      .from(daGrant)
      .leftJoin(daDataset, eq(daGrant.datasetId, daDataset.id))
      .where(
        and(
          eq(daGrant.status, 'active'),
          isNotNull(daGrant.endDate),
          lte(daGrant.endDate, horizon)
        )
      );
    for (const row of grantRows) {
      const days: number = dayDiff(today, row.endDate ?? today);
      items.push({
        category: 'grant_expiring',
        refCode: row.code,
        title: `数据授权「${row.datasetName ?? row.scope ?? row.code}」${days < 0 ? '已到期' : '即将到期'}`,
        days,
        severity: days < 0 ? 'danger' : 'warning',
      });
    }

    // 3. 资产待报废：报废变更审批中（ast_change: changeType=scrap 且 status=pending）
    const scrapRows = await this.db
      .select({
        assetCode: astAsset.code,
        assetName: astAsset.name,
        createdAt: astChange.createdAt,
      })
      .from(astChange)
      .innerJoin(astAsset, eq(astChange.assetId, astAsset.id))
      .where(
        and(
          eq(astChange.changeType, 'scrap'),
          eq(astChange.status, 'pending')
        )
      );
    for (const row of scrapRows) {
      const created: Date | null = row.createdAt;
      const days: number = created
        ? Math.floor((Date.now() - created.getTime()) / 86400000)
        : 0;
      items.push({
        category: 'asset_scrapping',
        refCode: row.assetCode,
        title: `资产「${row.assetName}」报废流程待审批`,
        days,
        severity: 'warning',
      });
    }

    items.sort((a: AlertItem, b: AlertItem) => {
      if (a.severity !== b.severity) {
        return a.severity === 'danger' ? -1 : 1;
      }
      return a.days - b.days;
    });
    return { items };
  }

  /** 按纳税主体汇总已开票价税合计。 */
  async getTaxDistribution(): Promise<
    { taxEntityId: string | null; taxEntityName: string; amount: number; taxAmount: number }[]
  > {
    const rows = await this.db
      .select({
        taxEntityId: erpInvoice.taxEntityId,
        taxEntityName: mdTaxEntity.name,
        amount: sql<number>`coalesce(sum(${erpInvoice.amount}), 0)::float8`,
        taxAmount: sql<number>`coalesce(sum(${erpInvoice.taxAmount}), 0)::float8`,
      })
      .from(erpInvoice)
      .leftJoin(mdTaxEntity, eq(erpInvoice.taxEntityId, mdTaxEntity.id))
      .where(eq(erpInvoice.status, 'issued'))
      .groupBy(erpInvoice.taxEntityId, mdTaxEntity.name);
    return rows.map((row) => ({
      taxEntityId: row.taxEntityId,
      taxEntityName: row.taxEntityName ?? '未指定主体',
      amount: Number(row.amount ?? 0),
      taxAmount: Number(row.taxAmount ?? 0),
    }));
  }
}
