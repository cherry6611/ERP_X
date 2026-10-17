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
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  finAccount,
  finPeriodClose,
  finVoucher,
  finVoucherLine,
  finYearEndClose,
  finYearEndLog,
  mdTaxEntity,
} from '@server/database/schema';
import {
  ACCOUNT_CURRENT_YEAR_PROFIT,
} from '@server/common/tax/account-codes';
import { generateBizCode } from '@server/common/utils/biz-code';
import { unwrapRows } from '@server/common/utils/rows';
import { assertFiscalYearOpen } from '@server/common/utils/period-guard';
import { LedgersService } from './ledgers.service';
import { buildCarryForwardLines } from './year-end-lines';
import {
  PERIOD_FORMAT_MESSAGE,
  isValidPeriod,
  lastDayOfMonth as computeLastDayOfMonth,
  yearOfPeriod,
} from './period-utils';
import { round2 } from '@server/common/utils/number';
import type {
  PeriodCarryForwardPreview,
  YearEndCloseResult,
  YearEndStatusItem,
} from '@shared/api.interface';

/** 损益类科目类型（用于结转损益） */
const PROFIT_LOSS_TYPES = ['income', 'revenue', 'expense', 'cost'];


const NULL_ENTITY = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class YearEndService {
  private readonly logger = new Logger(YearEndService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly ledgers: LedgersService,
  ) {}

  /* §5.9：期间闸门与月末计算已抽到 `./period-utils`（纯函数 + 15 条断言） */
  private assertPeriod(period: string): void {
    if (!isValidPeriod(period)) {
      throw new BadRequestException(PERIOD_FORMAT_MESSAGE);
    }
  }

  private yearOf(period: string): number {
    return yearOfPeriod(period);
  }

  /** A-04 ①②：结转损益预览（含前置校验清单） */
  async previewCarryForward(params: {
    period: string;
    taxEntityId?: string;
  }): Promise<PeriodCarryForwardPreview> {
    this.assertPeriod(params.period);
    const fiscalYear = this.yearOf(params.period);
    const [accounts, closedRows, draftRows, trial] = await Promise.all([
      this.profitLossBalances(params.period, params.taxEntityId),
      this.db
        .select({ id: finYearEndClose.id })
        .from(finYearEndClose)
        .where(
          and(
            eq(finYearEndClose.fiscalYear, fiscalYear),
            // 必须只认 status='closed'：反年结把行改成 'open' 后**行仍然存在**，
            // 若不过滤状态，反年结之后 alreadyCarried 仍为真 → 永远无法重新年结，
            // 年结退化成一次性不可逆操作。
            eq(finYearEndClose.status, 'closed'),
            this.entityCondition(params.taxEntityId)
          )
        )
        .limit(1),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(finVoucher)
        .where(
          and(
            eq(finVoucher.status, 'draft'),
            sql`${finVoucher.period} like ${`${fiscalYear}-%`}`
          )
        ),
      this.ledgers.trialBalance(params.period),
    ]);

    // 损益类科目本期发生额结转：收入类贷方余额转出（借收入），费用类借方余额转出（贷费用）
    const items: PeriodCarryForwardPreview['items'] = [];
    let totalRevenue = 0;
    let totalExpense = 0;
    for (const account of accounts) {
      const net = round2(account.debitOccur - account.creditOccur);
      if (net === 0) continue;
      const isRevenue =
        account.accountType === 'income' || account.accountType === 'revenue';
      if (isRevenue) {
        totalRevenue = round2(totalRevenue + Math.abs(net));
      } else {
        totalExpense = round2(totalExpense + Math.abs(net));
      }
      items.push({
        accountCode: account.code,
        accountName: account.name,
        accountType: account.accountType,
        debitOccur: account.debitOccur,
        creditOccur: account.creditOccur,
        carryAmount: Math.abs(net),
        // 收入类有贷方余额 → 结转到本年利润时借记收入；费用类有借方余额 → 贷记费用
        carryDirection: net > 0 ? 'credit' : 'debit',
      });
    }
    const netProfit = round2(totalRevenue - totalExpense);

    const draftCount = Number(draftRows[0]?.total ?? 0);
    const checks: PeriodCarryForwardPreview['checks'] = [
      {
        code: 'no_draft_voucher',
        label: '本年度不存在未过账（草稿）凭证',
        passed: draftCount === 0,
        message:
          draftCount === 0
            ? '通过'
            : `存在 ${draftCount} 张草稿凭证，请先过账或作废后再结转`,
      },
      {
        code: 'trial_balanced',
        label: `期间 ${params.period} 试算平衡`,
        passed: trial.balanced,
        message: trial.balanced
          ? '通过'
          : `借方合计 ${trial.totalDebit}，贷方合计 ${trial.totalCredit}，不相等`,
      },
      {
        code: 'not_closed',
        label: '本年度尚未年结',
        passed: closedRows.length === 0,
        message: closedRows.length === 0 ? '通过' : '本年度已年结，如需重做请先反年结',
      },
      {
        code: 'has_profit_loss',
        label: '存在待结转的损益类科目',
        passed: items.length > 0,
        message: items.length > 0 ? `共 ${items.length} 个科目` : '本年度无损益发生额',
      },
    ];
    const canCarry =
      closedRows.length === 0 && draftCount === 0 && items.length > 0;

    return {
      period: params.period,
      taxEntityId: params.taxEntityId ?? null,
      items,
      totalRevenue,
      totalExpense,
      netProfit,
      checks,
      canCarry,
      alreadyCarried: closedRows.length > 0,
    };
  }

  private entityCondition(taxEntityId?: string) {
    return taxEntityId
      ? eq(finYearEndClose.taxEntityId, taxEntityId)
      : sql`${finYearEndClose.taxEntityId} IS NULL`;
  }

  /** 本年度损益类科目的借方/贷方发生额（从 1 月累计到 12 月） */
  /**
   * 本年度损益类科目的借方/贷方发生额（从 1 月累计到 12 月）。
   *
   * P2-4：必须按纳税主体隔离。原实现不区分 `tax_entity_id`，把同一年度**所有主体**的
   * 损益合并进一张结转凭证，且凭证自身不落主体 —— 多主体下各主体损益被互相冲平
   * （A 主体盈利、B 主体亏损 ⇒ 结转后谁都看不出真实损益），本年利润也无法按主体归属。
   */
  private async profitLossBalances(
    period: string,
    taxEntityId?: string
  ): Promise<
    Array<{
      code: string;
      name: string;
      accountType: string;
      debitOccur: number;
      creditOccur: number;
    }>
  > {
    const year = period.slice(0, 4);
    // 未指定主体时只结转「无主体」凭证（与凭证/报表的 NULL 语义一致），
    // 而不是把有无主体的凭证混在一起 —— 混算正是本条缺陷的根源。
    const entityFilter = taxEntityId
      ? sql`AND v.tax_entity_id = ${taxEntityId}::uuid`
      : sql`AND v.tax_entity_id IS NULL`;
    const rows = await this.db.execute(sql`
      SELECT l.account_code AS code,
             coalesce(max(a.name), '') AS name,
             coalesce(max(a.account_type), 'expense') AS account_type,
             coalesce(sum(l.debit), 0) AS debit_occur,
             coalesce(sum(l.credit), 0) AS credit_occur
      FROM fin_voucher_line l
      JOIN fin_voucher v ON v.id = l.voucher_id
      LEFT JOIN fin_account a ON a.id = l.account_id
      WHERE v.status <> 'voided'
        AND v.period LIKE ${`${year}-%`}
        AND l.account_code IS NOT NULL
        AND l.account_code NOT LIKE '4103%'
        ${entityFilter}
        AND coalesce(a.account_type, 'expense') = ANY(${sql.raw(
          `ARRAY[${PROFIT_LOSS_TYPES.map((type) => `'${type}'`).join(',')}]`
        )}::varchar[])
      GROUP BY l.account_code
      HAVING coalesce(sum(l.debit), 0) <> coalesce(sum(l.credit), 0)
      ORDER BY l.account_code
    `);
    const list = unwrapRows<{
      code: string;
      name: string;
      account_type: string;
      debit_occur: string | number;
      credit_occur: string | number;
    }>(rows);
    return list.map((row) => ({
      code: row.code,
      name: row.name,
      accountType: row.account_type,
      debitOccur: Number(row.debit_occur ?? 0),
      creditOccur: Number(row.credit_occur ?? 0),
    }));
  }

  /** A-04 ①：执行结转损益（生成结转凭证） */
  async carryForward(params: {
    period: string;
    taxEntityId?: string;
    userId: string;
  }): Promise<YearEndCloseResult> {
    this.assertPeriod(params.period);
    const fiscalYear = this.yearOf(params.period);
    const preview = await this.previewCarryForward({
      period: params.period,
      taxEntityId: params.taxEntityId,
    });
    if (preview.alreadyCarried) {
      throw new ConflictException(`会计年度 ${fiscalYear} 已完成年结，不可重复结转`);
    }
    const failed = preview.checks.filter(
      (check) => !check.passed && check.code !== 'not_closed' && check.code !== 'has_profit_loss'
    );
    if (failed.length > 0) {
      throw new BadRequestException(
        `结转前校验未通过：${failed.map((check) => check.message).join('；')}`
      );
    }
    if (preview.items.length === 0) {
      throw new BadRequestException('本年度无损益发生额，无需结转');
    }
    const profitAccount = await this.db
      .select({ id: finAccount.id, code: finAccount.code, name: finAccount.name })
      .from(finAccount)
      .where(eq(finAccount.code, ACCOUNT_CURRENT_YEAR_PROFIT))
      .limit(1);
    if (profitAccount.length === 0) {
      throw new NotFoundException(
        `科目 ${ACCOUNT_CURRENT_YEAR_PROFIT} 本年利润不存在，请先执行科目表迁移`
      );
    }

    // 用该月真实最后一天，而不是硬拼 '-31'（2/4/6/9/11 月不存在 31 日，
    // 直接插入会让 PG 抛 date out of range，年结在 2 月结账时必然失败）
    const safeDate = this.lastDayOfMonth(params.period);
    // 先按科目编码解析出 accountId；科目表里没有的科目无法入账，跳过并在下面兜底报错
    const accountIdByCode = new Map<string, string>();
    for (const item of preview.items) {
      const accountRow = await this.db
        .select({ id: finAccount.id })
        .from(finAccount)
        .where(eq(finAccount.code, item.accountCode))
        .limit(1);
      if (accountRow.length > 0) {
        accountIdByCode.set(item.accountCode, accountRow[0].id);
      }
    }
    const resolvable = preview.items.filter((item) =>
      accountIdByCode.has(item.accountCode)
    );
    if (resolvable.length === 0) {
      throw new BadRequestException('待结转科目均不存在于科目表，请先补齐科目');
    }

    // 分录构造走纯函数 `buildCarryForwardLines`（唯一实现，含双向单测），
    // 避免 service 里再留一份方向判断导致两处漂移。
    const built = buildCarryForwardLines(
      resolvable.map((item) => ({
        accountCode: item.accountCode,
        accountName: item.accountName,
        carryAmount: item.carryAmount,
        carryDirection: item.carryDirection,
      })),
      profitAccount[0].code,
      fiscalYear
    );
    if (!built.balanced) {
      throw new BadRequestException(
        `结转凭证借贷不平衡：借 ${built.totalDebit}，贷 ${built.totalCredit}`
      );
    }
    const lines = built.lines.map((line) => ({
      accountId:
        line.accountCode === profitAccount[0].code
          ? profitAccount[0].id
          : (accountIdByCode.get(line.accountCode) ?? ''),
      accountCode: line.accountCode,
      summary: line.summary,
      debit: line.debit,
      credit: line.credit,
    }));

    const code = await generateBizCode(
      this.db,
      finVoucher,
      finVoucher.code,
      'VCH'
    );
    const sourceRef = `year-end:${fiscalYear}:${params.taxEntityId ?? 'ALL'}`;
    let voucherId = '';
    await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(finVoucher)
        .values({
          code,
          voucherDate: safeDate,
          period: params.period,
          summary: `${fiscalYear} 年度结转损益`,
          sourceType: 'manual',
          sourceRef,
          status: 'posted',
          // P2-4：结转凭证必须落在被结转的主体上，否则凭证自身游离在主体之外，
          // 按主体出的报表看不到它，而按总额看的报表又看得到它。
          taxEntityId: params.taxEntityId ?? null,
          remark: `年结自动生成，操作人 ${params.userId}`,
        })
        .returning({ id: finVoucher.id });
      voucherId = inserted[0].id;
      await tx.insert(finVoucherLine).values(
        lines.map((line) => ({
          voucherId,
          accountId: line.accountId,
          accountCode: line.accountCode,
          summary: line.summary,
          debit: line.debit,
          credit: line.credit,
        }))
      );
      await tx.insert(finYearEndClose).values({
        fiscalYear,
        period: params.period,
        taxEntityId: params.taxEntityId ?? null,
        status: 'closed',
        profitAmount: String(preview.netProfit),
        carryVoucherId: voucherId,
        closedBy: params.userId,
        remark: `自动生成结转凭证 ${code}`,
      });
      await tx.insert(finYearEndLog).values({
        fiscalYear,
        action: 'close',
        actorUserId: params.userId,
        reason: `年结结转损益，净利润 ${preview.netProfit}`,
        snapshot: JSON.stringify({
          code,
          netProfit: preview.netProfit,
          itemCount: preview.items.length,
        }),
      });
    });

    return {
      fiscalYear,
      period: params.period,
      taxEntityId: params.taxEntityId ?? null,
      status: 'closed',
      profitAmount: preview.netProfit,
      carryVoucherId: voucherId,
      carryVoucherCode: code,
      message: `年结完成：生成结转凭证 ${code}，本年净利润 ${preview.netProfit}`,
    };
  }

  private lastDayOfMonth(period: string): string {
    return computeLastDayOfMonth(period);
  }

  /** A-04 ④：反年结（需审批留痕；红冲结转凭证） */
  async reverseYearEnd(params: {
    fiscalYear: number;
    taxEntityId?: string;
    userId: string;
    reason: string;
    approved: boolean;
  }): Promise<YearEndCloseResult> {
    if (!params.reason || params.reason.trim().length < 4) {
      throw new BadRequestException('反年结必须填写不少于 4 个字的原因（用于留痕）');
    }
    if (!params.approved) {
      throw new BadRequestException(
        '反年结需经审批确认；请由审批人确认后携带 approved=true 重试'
      );
    }
    const rows = await this.db
      .select()
      .from(finYearEndClose)
      .where(
        and(
          eq(finYearEndClose.fiscalYear, params.fiscalYear),
          params.taxEntityId
            ? eq(finYearEndClose.taxEntityId, params.taxEntityId)
            : sql`${finYearEndClose.taxEntityId} IS NULL`
        )
      )
      .limit(1);
    if (rows.length === 0) {
      throw new NotFoundException(`会计年度 ${params.fiscalYear} 未年结`);
    }
    const record = rows[0];
    if (record.status !== 'closed') {
      throw new BadRequestException(`会计年度 ${params.fiscalYear} 当前状态为 ${record.status}，不可反年结`);
    }
    const voucherId = record.carryVoucherId;

    await this.db.transaction(async (tx) => {
      if (voucherId) {
        // 作废结转凭证（若已过账则红冲：作废后余额自然回退，因为账务取数排除 voided）
        await tx
          .update(finVoucher)
          .set({
            status: 'voided',
            remark: `反年结作废：${params.reason}`,
            updatedAt: new Date(),
          })
          .where(eq(finVoucher.id, voucherId));
      }
      await tx
        .update(finYearEndClose)
        .set({
          status: 'open',
          reopenedAt: new Date(),
          reopenedBy: params.userId,
          remark: `反年结：${params.reason}`,
        })
        .where(eq(finYearEndClose.id, record.id));
      await tx.insert(finYearEndLog).values({
        fiscalYear: params.fiscalYear,
        action: 'reopen',
        actorUserId: params.userId,
        reason: params.reason,
        snapshot: JSON.stringify({ voidedVoucherId: voucherId }),
      });
    });

    this.logger.warn(
      `反年结 fiscalYear=${params.fiscalYear} by=${params.userId} reason=${params.reason}`
    );
    return {
      fiscalYear: params.fiscalYear,
      period: record.period,
      taxEntityId: record.taxEntityId ?? null,
      status: 'open',
      profitAmount: Number(record.profitAmount ?? 0),
      carryVoucherId: voucherId ?? null,
      carryVoucherCode: null,
      message: `已反年结：原结转凭证已作废，请重新核对后再次年结`,
    };
  }

  /** 年结状态清单 */
  async listStatus(taxEntityId?: string): Promise<YearEndStatusItem[]> {
    const rows = await this.db
      .select({
        fiscalYear: finYearEndClose.fiscalYear,
        period: finYearEndClose.period,
        taxEntityId: finYearEndClose.taxEntityId,
        status: finYearEndClose.status,
        profitAmount: finYearEndClose.profitAmount,
        carryVoucherId: finYearEndClose.carryVoucherId,
        closedAt: finYearEndClose.closedAt,
        closedBy: finYearEndClose.closedBy,
        reopenedAt: finYearEndClose.reopenedAt,
        reopenedBy: finYearEndClose.reopenedBy,
      })
      .from(finYearEndClose)
      .where(taxEntityId ? eq(finYearEndClose.taxEntityId, taxEntityId) : undefined)
      .orderBy(desc(finYearEndClose.fiscalYear));
    const voucherIds = rows
      .map((row) => row.carryVoucherId)
      .filter((id): id is string => Boolean(id));
    const codes = voucherIds.length
      ? await this.db
          .select({ id: finVoucher.id, code: finVoucher.code })
          .from(finVoucher)
          .where(inArray(finVoucher.id, voucherIds))
      : [];
    const codeById = new Map(codes.map((row) => [row.id, row.code]));
    return rows.map((row) => ({
      fiscalYear: Number(row.fiscalYear),
      period: row.period,
      taxEntityId: row.taxEntityId ?? null,
      status: (row.status ?? 'closed') as 'closed' | 'open',
      profitAmount: Number(row.profitAmount ?? 0),
      carryVoucherId: row.carryVoucherId ?? null,
      carryVoucherCode: row.carryVoucherId
        ? (codeById.get(row.carryVoucherId) ?? null)
        : null,
      closedAt: row.closedAt ? row.closedAt.toISOString() : null,
      closedBy: row.closedBy ?? null,
      reopenedAt: row.reopenedAt ? row.reopenedAt.toISOString() : null,
      reopenedBy: row.reopenedBy ?? null,
    }));
  }

  /** 年结留痕清单（A-04 审计要求） */
  async listLog(fiscalYear?: number): Promise<
    Array<{
      id: string;
      fiscalYear: number;
      action: string;
      actorUserId: string | null;
      reason: string | null;
      createdAt: string;
    }>
  > {
    const rows = await this.db
      .select({
        id: finYearEndLog.id,
        fiscalYear: finYearEndLog.fiscalYear,
        action: finYearEndLog.action,
        actorUserId: finYearEndLog.actorUserId,
        reason: finYearEndLog.reason,
        createdAt: finYearEndLog.createdAt,
      })
      .from(finYearEndLog)
      .where(fiscalYear ? eq(finYearEndLog.fiscalYear, fiscalYear) : undefined)
      .orderBy(desc(finYearEndLog.createdAt))
      .limit(200);
    return rows.map((row) => ({
      id: row.id,
      fiscalYear: Number(row.fiscalYear),
      action: row.action,
      actorUserId: row.actorUserId ?? null,
      reason: row.reason ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * 年结后的期间只读校验：本年度已年结的期间不允许再新增/过账凭证。
   *
   * P0-3：真正的接线在 `assertFiscalYearOpen`（`common/utils/period-guard.ts`），
   * 由 VoucherService 与 VoucherHookService 调用；此处保留同名方法供年结模块内部
   * 与既有调用复用，委托到同一实现，避免两处规则漂移。
   */
  async assertPeriodWritable(period: string): Promise<void> {
    await assertFiscalYearOpen(this.db, period);
  }

  /** 纳税主体名称（供前端展示） */
  async taxEntityNames(): Promise<Array<{ id: string; name: string }>> {
    const rows = await this.db
      .select({ id: mdTaxEntity.id, name: mdTaxEntity.name })
      .from(mdTaxEntity)
      .orderBy(asc(mdTaxEntity.name));
    return rows;
  }

  /** 期间是否已结账（供年结前置校验复用） */
  async closedPeriods(fiscalYear: number): Promise<string[]> {
    const rows = await this.db
      .select({ period: finPeriodClose.period })
      .from(finPeriodClose)
      .where(
        and(
          sql`${finPeriodClose.period} like ${`${fiscalYear}-%`}`,
          ne(finPeriodClose.period, '')
        )
      );
    return rows.map((row) => row.period);
  }
}
