import { Inject, Injectable } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, desc, eq, inArray, isNull, sql, sum } from 'drizzle-orm';
import dayjs from 'dayjs';
import { round2 } from '@server/common/utils/number';
import { resolveOpeningCash } from './opening-cash';
import {
  erpApBill,
  erpAr,
  finExpenseClaim,
  hrPayroll,
} from '@server/database/schema';
import type {
  CashFlowForecast,
  CashFlowWeek,
} from '@shared/api.interface';

const TZ_OFFSET = 8;


@Injectable()
export class CashFlowService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  /** 13 周滚动现金流预测：应收到期落周为流入，应付/工资/报销为流出 */
  async getForecast(weekCount: number): Promise<CashFlowForecast> {
    const inflow: number[] = Array.from(
      { length: weekCount },
      (): number => 0
    );
    const outflow: number[] = Array.from(
      { length: weekCount },
      (): number => 0
    );
    const today: string = dayjs().utcOffset(TZ_OFFSET).format('YYYY-MM-DD');
    const todayDay = dayjs(today);
    // dayjs 默认周日起始，换算到周一
    const anchor: dayjs.Dayjs = todayDay.subtract(
      (todayDay.day() + 6) % 7,
      'day'
    );
    const anchorStr: string = anchor.format('YYYY-MM-DD');
    const windowDays: number = weekCount * 7;

    // 期初现金口径统一走 `resolveOpeningCash`（B5）。
    // 原实现在这里**漏了 `status <> 'voided'`**：作废回款仍被算作已收，
    // 13 周曲线整体高估。口径分叉的根因已由抽函数消除，不要再在此处内联。
    const openingCash: number = await resolveOpeningCash(this.db);

    const arRows = await this.db
      .select({
        amount: erpAr.amount,
        settledAmount: erpAr.settledAmount,
        dueDate: erpAr.dueDate,
      })
      .from(erpAr)
      .where(inArray(erpAr.status, ['open', 'partial']));
    for (const row of arRows) {
      const open: number = round2(
        Number(row.amount ?? 0) - Number(row.settledAmount ?? 0)
      );
      if (open <= 0) continue;
      const idx: number = this.weekIndexOf(row.dueDate, anchorStr, windowDays);
      if (idx >= 0 && idx < weekCount) inflow[idx] += open;
    }

    const apRows = await this.db
      .select({
        amount: erpApBill.amount,
        paidAmount: erpApBill.paidAmount,
        dueDate: erpApBill.dueDate,
      })
      .from(erpApBill)
      .where(inArray(erpApBill.status, ['pending', 'approved', 'partial']));
    for (const row of apRows) {
      const open: number = round2(
        Number(row.amount ?? 0) - Number(row.paidAmount ?? 0)
      );
      if (open <= 0) continue;
      const idx: number = this.weekIndexOf(row.dueDate, anchorStr, windowDays);
      if (idx >= 0 && idx < weekCount) outflow[idx] += open;
    }

    // 已审批未支付的报销单据视为即付，落第一周。
    //
    // B-13：必须排除**已经生成了应付单**的报销 —— `fin-expense.service.ts:719`
    // 在报销审批通过时同事务插入 `erp_ap_bill`（`source_ref = 'expense:<单号>'`），
    // 所以同一笔钱会**既在 outflow[0]（报销）又在 apRows（应付落周）被计两次**，
    // 现金流预测凭空多出一份流出。原先用 `status = 'approved'` 全额汇总，
    // 正是踩了这个重复；这里用 LEFT JOIN 只取"尚无对应应付单"的部分。
    const claimRows = await this.db
      .select({ total: sum(finExpenseClaim.amount) })
      .from(finExpenseClaim)
      .leftJoin(
        erpApBill,
        eq(erpApBill.sourceRef, sql`'expense:' || ${finExpenseClaim.code}`)
      )
      .where(
        and(
          eq(finExpenseClaim.status, 'approved'),
          isNull(erpApBill.id)
        )
      );
    if (weekCount > 0) {
      outflow[0] += Number(claimRows[0]?.total ?? 0);
    }

    // 最近一个已审批工资周期的应发总额，在未来窗口内每月 1 日所在周重复
    const payrollTotal: number = await this.latestApprovedPayrollTotal();
    if (payrollTotal > 0) {
      const monthSpan: number = Math.ceil(windowDays / 28) + 2;
      for (let m = 0; m <= monthSpan; m += 1) {
        const firstStr: string = anchor
          .add(m, 'month')
          .startOf('month')
          .format('YYYY-MM-DD');
        if (firstStr < anchorStr) continue;
        const idx: number = this.weekIndexOf(
          firstStr,
          anchorStr,
          windowDays
        );
        if (idx >= 0 && idx < weekCount) outflow[idx] += payrollTotal;
      }
    }

    const weeks: CashFlowWeek[] = [];
    let cumulative: number = openingCash;
    for (let i = 0; i < weekCount; i += 1) {
      const weekInflow: number = round2(inflow[i]);
      const weekOutflow: number = round2(outflow[i]);
      const netFlow: number = round2(weekInflow - weekOutflow);
      cumulative = round2(cumulative + netFlow);
      weeks.push({
        weekStart: anchor.add(i * 7, 'day').format('YYYY-MM-DD'),
        inflow: weekInflow,
        outflow: weekOutflow,
        netFlow,
        cumulativeCash: cumulative,
      });
    }
    return { openingCash, weeks };
  }

  /** null 或已过期落第一周；超出窗口返回 -1 */
  private weekIndexOf(
    dueDate: string | null,
    anchorStr: string,
    windowDays: number
  ): number {
    if (!dueDate) return 0;
    const diff: number = dayjs(dueDate).diff(dayjs(anchorStr), 'day');
    if (diff >= windowDays) return -1;
    if (diff < 0) return 0;
    return Math.floor(diff / 7);
  }

  private async latestApprovedPayrollTotal(): Promise<number> {
    const periodRows = await this.db
      .select({ period: hrPayroll.period })
      .from(hrPayroll)
      // 已发放（paid）说明该月工资标准已确认，仍应作为未来月份的固定流出参考；
      // 只查 approved 会在工资发放后把整块工资流出从预测里抹掉。
      .where(inArray(hrPayroll.status, ['approved', 'paid']))
      .orderBy(desc(hrPayroll.period))
      .limit(1);
    const period: string | null = periodRows[0]?.period ?? null;
    if (!period) return 0;
    // 应发总额口径：基本工资 + 绩效 + 津贴
    const rows = await this.db
      .select({
        total: sql<number>`coalesce(sum(coalesce(${hrPayroll.baseSalary}, 0) + coalesce(${hrPayroll.perfSalary}, 0) + coalesce(${hrPayroll.allowance}, 0)), 0)::float8`,
      })
      .from(hrPayroll)
      .where(
        and(
          inArray(hrPayroll.status, ['approved', 'paid']),
          eq(hrPayroll.period, period)
        )
      );
    return Number(rows[0]?.total ?? 0);
  }
}
