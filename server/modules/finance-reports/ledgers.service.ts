import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import {
  finAccount,
  finAuxDimension,
  finVoucher,
  finVoucherLine,
  finVoucherLineAux,
} from '@server/database/schema';
import type {
  AccountBalanceRow,
  AccountBalanceSheet,
  AuxBalanceRow,
  AuxBalanceSheet,
  DetailLedgerLine,
  DetailLedgerResult,
  GeneralLedgerRow,
  GeneralLedgerSheet,
  LedgerQueryParams,
} from '@shared/api.interface';
import { unwrapRows } from '@server/common/utils/rows';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

interface RawBalanceRow {
  account_code: string;
  account_name: string | null;
  opening_debit: string | number;
  opening_credit: string | number;
  debit_occur: string | number;
  credit_occur: string | number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 上一期间（YYYY-MM） */
export function previousPeriod(period: string): string {
  const [yearText, monthText] = period.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  if (month === 1) return `${year - 1}-12`;
  return `${year}-${String(month - 1).padStart(2, '0')}`;
}

/** 同年度 1 月（用于累计发生额） */
export function fiscalYearStart(period: string): string {
  return `${period.slice(0, 4)}-01`;
}

export interface PeriodRange {
  from: string;
  to: string;
}

@Injectable()
export class LedgersService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  private assertPeriod(period: string, field: string): void {
    if (!PERIOD_PATTERN.test(period)) {
      throw new BadRequestException(`${field} 期间格式必须为 YYYY-MM`);
    }
  }

  /**
   * P0-2：凭证状态过滤。
   * 默认【只取已过账】——未过账草稿不参与账簿/报表取数，保证「过账」控制有意义；
   * includeDraft=true 时降级为「含草稿预览」口径（已过账 + 草稿），供财务提交前预览。
   * SQL 里 fin_voucher 的别名统一为 v。
   */
  private statusCondition(includeDraft?: boolean) {
    return includeDraft
      ? sql`v.status IN ('posted', 'draft')`
      : sql`v.status = 'posted'`;
  }

  /** 科目维度余额（期初 / 本期发生 / 期末），仅统计已过账凭证（草稿不参与账簿/报表取数） */
  async rawBalances(
    period: string,
    options: {
      taxEntityId?: string;
      from?: string;
      to?: string;
      includeDraft?: boolean;
    } = {}
  ): Promise<Map<string, RawBalanceRow>> {
    const from = options.from ?? period;
    const to = options.to ?? period;
    const result = new Map<string, RawBalanceRow>();
    const rows = await this.db.execute(sql`
      WITH opening AS (
        SELECT l.account_code AS account_code,
               max(l.account_code) AS account_code_dummy,
               coalesce(sum(l.debit), 0) AS opening_debit,
               coalesce(sum(l.credit), 0) AS opening_credit
        FROM fin_voucher_line l
        JOIN fin_voucher v ON v.id = l.voucher_id
        WHERE ${this.statusCondition(options.includeDraft)}
          AND v.period < ${from}
          AND l.account_code IS NOT NULL
          ${options.taxEntityId ? sql`AND v.tax_entity_id = ${options.taxEntityId}::uuid` : sql``}
        GROUP BY l.account_code
      ),
      movement AS (
        SELECT l.account_code AS account_code,
               coalesce(sum(l.debit), 0) AS debit_occur,
               coalesce(sum(l.credit), 0) AS credit_occur
        FROM fin_voucher_line l
        JOIN fin_voucher v ON v.id = l.voucher_id
        WHERE ${this.statusCondition(options.includeDraft)}
          AND v.period >= ${from}
          AND v.period <= ${to}
          AND l.account_code IS NOT NULL
          ${options.taxEntityId ? sql`AND v.tax_entity_id = ${options.taxEntityId}::uuid` : sql``}
        GROUP BY l.account_code
      )
      SELECT coalesce(o.account_code, m.account_code) AS account_code,
             coalesce(o.opening_debit, 0) AS opening_debit,
             coalesce(o.opening_credit, 0) AS opening_credit,
             coalesce(m.debit_occur, 0) AS debit_occur,
             coalesce(m.credit_occur, 0) AS credit_occur
      FROM opening o
      FULL OUTER JOIN movement m ON m.account_code = o.account_code
      WHERE coalesce(o.account_code, m.account_code) IS NOT NULL
    `);
    const list = this.unwrap<RawBalanceRow>(rows);
    for (const row of list) {
      result.set(row.account_code, row);
    }
    return result;
  }

  private unwrap<T>(rows: unknown): T[] {
    return unwrapRows<T>(rows);
  }

  /** 科目树（用于逐级汇总） */
  private async loadAccountTree(): Promise<
    Array<{
      id: string;
      code: string;
      name: string;
      accountType: string;
      parentCode: string | null;
      level: number;
      isLeaf: boolean;
      direction: string;
      sortNo: number;
      status: string;
    }>
  > {
    const rows = await this.db
      .select({
        id: finAccount.id,
        code: finAccount.code,
        name: finAccount.name,
        accountType: finAccount.accountType,
        parentCode: finAccount.parentCode,
        level: finAccount.level,
        isLeaf: finAccount.isLeaf,
        direction: finAccount.direction,
        sortNo: finAccount.sortNo,
        status: finAccount.status,
      })
      .from(finAccount)
      .orderBy(asc(finAccount.sortNo), asc(finAccount.code));
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      accountType: row.accountType ?? 'asset',
      parentCode: row.parentCode ?? null,
      level: Number(row.level ?? 1),
      isLeaf: Number(row.isLeaf ?? 1) === 1,
      direction: row.direction ?? 'debit',
      sortNo: Number(row.sortNo ?? 0),
      status: row.status ?? 'active',
    }));
  }

  /**
   * 把末级科目的余额逐级上卷到父科目；返回的 map 里每个科目都包含自身 + 全部下级的合计，
   * 因此报表公式可以直接按一级科目编码取数。
   */
  async rolledBalances(
    period: string,
    options: {
      taxEntityId?: string;
      includeDraft?: boolean;
      /** 期初截止期间（不含）：累计口径取数时传「年初前一期间」 */
      from?: string;
      /** 发生额截止期间（含） */
      to?: string;
    } = {}
  ): Promise<
    Map<
      string,
      {
        openingDebit: number;
        openingCredit: number;
        debitOccur: number;
        creditOccur: number;
        closingDebit: number;
        closingCredit: number;
        name: string;
        level: number;
        isLeaf: boolean;
        direction: string;
        accountType: string;
        children: string[];
      }
    >
  > {
    const raw = await this.rawBalances(period, options);
    const tree = await this.loadAccountTree();
    const byCode = new Map(tree.map((node) => [node.code, node]));
    type Agg = {
      openingDebit: number;
      openingCredit: number;
      debitOccur: number;
      creditOccur: number;
      closingDebit: number;
      closingCredit: number;
    };
    const agg = new Map<string, Agg>();
    for (const node of tree) {
      const own = raw.get(node.code);
      agg.set(node.code, {
        openingDebit: toNumber(own?.opening_debit),
        openingCredit: toNumber(own?.opening_credit),
        debitOccur: toNumber(own?.debit_occur),
        creditOccur: toNumber(own?.credit_occur),
        closingDebit: 0,
        closingCredit: 0,
      });
    }
    // 自底向上上卷：按 level 降序处理
    const ordered = [...tree].sort((a, b) => b.level - a.level);
    for (const node of ordered) {
      const self = agg.get(node.code);
      if (!self) continue;
      self.closingDebit = round2(self.openingDebit + self.debitOccur);
      self.closingCredit = round2(self.openingCredit + self.creditOccur);
      if (!node.parentCode) continue;
      const parent = agg.get(node.parentCode);
      if (!parent) continue;
      parent.openingDebit = round2(parent.openingDebit + self.openingDebit);
      parent.openingCredit = round2(parent.openingCredit + self.openingCredit);
      parent.debitOccur = round2(parent.debitOccur + self.debitOccur);
      parent.creditOccur = round2(parent.creditOccur + self.creditOccur);
    }
    const childrenMap = new Map<string, string[]>();
    for (const node of tree) {
      if (!node.parentCode) continue;
      childrenMap.set(node.parentCode, [
        ...(childrenMap.get(node.parentCode) ?? []),
        node.code,
      ]);
    }
    const result = new Map<
      string,
      {
        openingDebit: number;
        openingCredit: number;
        debitOccur: number;
        creditOccur: number;
        closingDebit: number;
        closingCredit: number;
        name: string;
        level: number;
        isLeaf: boolean;
        direction: string;
        accountType: string;
        children: string[];
      }
    >();
    for (const node of tree) {
      const values = agg.get(node.code);
      if (!values) continue;
      result.set(node.code, {
        ...values,
        name: node.name,
        level: node.level,
        isLeaf: node.isLeaf,
        direction: node.direction,
        accountType: node.accountType,
        children: childrenMap.get(node.code) ?? [],
      });
    }
    // 容错：分录引用了不在 fin_account 里的编码（历史脏数据），也一并返回
    for (const [code, row] of raw) {
      if (result.has(code)) continue;
      const openingDebit = toNumber(row.opening_debit);
      const openingCredit = toNumber(row.opening_credit);
      const debitOccur = toNumber(row.debit_occur);
      const creditOccur = toNumber(row.credit_occur);
      result.set(code, {
        openingDebit,
        openingCredit,
        debitOccur,
        creditOccur,
        closingDebit: round2(openingDebit + debitOccur),
        closingCredit: round2(openingCredit + creditOccur),
        name: '',
        level: 1,
        isLeaf: true,
        direction: 'debit',
        accountType: 'asset',
        children: [],
      });
    }
    return result;
  }

  /** A-03 ①：科目余额表（多级科目逐级汇总） */
  async accountBalance(params: LedgerQueryParams): Promise<AccountBalanceSheet> {
    this.assertPeriod(params.period, 'period');
    const rolled = await this.rolledBalances(params.period, {
      taxEntityId: params.taxEntityId,
      includeDraft: params.includeDraft,
    });
    const maxLevel = params.level && params.level > 0 ? params.level : 6;
    const items: AccountBalanceRow[] = [];
    for (const [code, values] of rolled) {
      if (values.level > maxLevel) continue;
      // P0-3 / P2-5：余额按科目方向轧差后【单侧列示】。
      // 同一科目同时出现借贷双侧余额（如 1122 期末借 127,200 与期末贷 63,600）
      // 会误导阅读，且使「期末借方合计 ≠ 期末贷方合计」误报不平衡。
      // 轧差后每个科目只在净额方向列示，全表期末借合计 = 期末贷合计 自动成立。
      // 发生额保持借贷双侧原值（发生额本身就是双侧口径）。
      const openingNet = round2(values.openingDebit - values.openingCredit);
      const closingNet = round2(values.closingDebit - values.closingCredit);
      items.push({
        accountCode: code,
        accountName: values.name,
        level: values.level,
        isLeaf: values.isLeaf,
        direction: values.direction as AccountBalanceRow['direction'],
        accountType: values.accountType,
        openingDebit: openingNet > 0 ? openingNet : 0,
        openingCredit: openingNet < 0 ? round2(-openingNet) : 0,
        debitOccur: values.debitOccur,
        creditOccur: values.creditOccur,
        closingDebit: closingNet > 0 ? closingNet : 0,
        closingCredit: closingNet < 0 ? round2(-closingNet) : 0,
        closingNet,
        closingSide: closingNet === 0 ? 'flat' : closingNet > 0 ? 'debit' : 'credit',
      });
    }
    items.sort((a, b) => (a.accountCode < b.accountCode ? -1 : a.accountCode > b.accountCode ? 1 : 0));
    let totalOpeningDebit = 0;
    let totalOpeningCredit = 0;
    let totalDebitOccur = 0;
    let totalCreditOccur = 0;
    let totalClosingDebit = 0;
    let totalClosingCredit = 0;
    for (const item of items) {
      if (!item.isLeaf) continue;
      totalOpeningDebit += item.openingDebit;
      totalOpeningCredit += item.openingCredit;
      totalDebitOccur += item.debitOccur;
      totalCreditOccur += item.creditOccur;
      totalClosingDebit += item.closingDebit;
      totalClosingCredit += item.closingCredit;
    }
    return {
      period: params.period,
      level: maxLevel,
      items,
      totals: {
        openingDebit: round2(totalOpeningDebit),
        openingCredit: round2(totalOpeningCredit),
        debitOccur: round2(totalDebitOccur),
        creditOccur: round2(totalCreditOccur),
        closingDebit: round2(totalClosingDebit),
        closingCredit: round2(totalClosingCredit),
      },
      // 余额表"平衡"以凭证行级借贷合计为权威口径（与试算平衡一致），
      // 不受非末级科目发生额被 Leaf 汇总排除的影响，避免误报不平衡。
      balanced: await this.isPeriodBalanced(
        params.period,
        params.taxEntityId,
        params.includeDraft
      ),
    };
  }

  /** 凭证行级借贷合计（仅已过账），用于余额表/试算平衡的一致性校验 */
  private async isPeriodBalanced(
    period: string,
    taxEntityId?: string,
    includeDraft?: boolean
  ): Promise<boolean> {
    this.assertPeriod(period, 'period');
    const rows = await this.db
      .select({
        debit: sql<string>`coalesce(sum(${finVoucherLine.debit}), 0)`,
        credit: sql<string>`coalesce(sum(${finVoucherLine.credit}), 0)`,
      })
      .from(finVoucherLine)
      .innerJoin(finVoucher, eq(finVoucherLine.voucherId, finVoucher.id))
      .where(
        and(
          eq(finVoucher.period, period),
          includeDraft
            ? inArray(finVoucher.status, ['posted', 'draft'])
            : eq(finVoucher.status, 'posted'),
          taxEntityId
            ? sql`${finVoucher.taxEntityId} = ${taxEntityId}::uuid`
            : sql``
        )
      );
    const debit = round2(toNumber(rows[0]?.debit));
    const credit = round2(toNumber(rows[0]?.credit));
    return debit === credit;
  }

  /** A-03 ④：辅助余额表（按辅助维度 + 维度值汇总） */
  async auxBalance(params: {
    period: string;
    dimensionCode: string;
    dimensionId?: string;
    taxEntityId?: string;
    includeDraft?: boolean;
  }): Promise<AuxBalanceSheet> {
    this.assertPeriod(params.period, 'period');
    const dimensionRows = await this.db
      .select({ code: finAuxDimension.code, name: finAuxDimension.name })
      .from(finAuxDimension)
      .where(eq(finAuxDimension.code, params.dimensionCode))
      .limit(1);
    if (dimensionRows.length === 0) {
      throw new BadRequestException(`辅助核算维度 ${params.dimensionCode} 不存在`);
    }
    const from = params.period;
    const rows = await this.db.execute(sql`
      WITH opening AS (
        SELECT a.dimension_id AS dimension_id,
               a.dimension_value AS dimension_value,
               l.account_code AS account_code,
               coalesce(sum(l.debit), 0) AS opening_debit,
               coalesce(sum(l.credit), 0) AS opening_credit
        FROM fin_voucher_line_aux a
        JOIN fin_voucher_line l ON l.id = a.line_id
        JOIN fin_voucher v ON v.id = l.voucher_id
        WHERE a.dimension_code = ${params.dimensionCode}
          AND ${this.statusCondition(params.includeDraft)}
          AND v.period < ${from}
          ${params.dimensionId ? sql`AND a.dimension_id = ${params.dimensionId}::uuid` : sql``}
          ${params.taxEntityId ? sql`AND v.tax_entity_id = ${params.taxEntityId}::uuid` : sql``}
        GROUP BY a.dimension_id, a.dimension_value, l.account_code
      ),
      movement AS (
        SELECT a.dimension_id AS dimension_id,
               a.dimension_value AS dimension_value,
               l.account_code AS account_code,
               coalesce(sum(l.debit), 0) AS debit_occur,
               coalesce(sum(l.credit), 0) AS credit_occur
        FROM fin_voucher_line_aux a
        JOIN fin_voucher_line l ON l.id = a.line_id
        JOIN fin_voucher v ON v.id = l.voucher_id
        WHERE a.dimension_code = ${params.dimensionCode}
          AND ${this.statusCondition(params.includeDraft)}
          AND v.period = ${from}
          ${params.dimensionId ? sql`AND a.dimension_id = ${params.dimensionId}::uuid` : sql``}
          ${params.taxEntityId ? sql`AND v.tax_entity_id = ${params.taxEntityId}::uuid` : sql``}
        GROUP BY a.dimension_id, a.dimension_value, l.account_code
      )
      SELECT coalesce(o.dimension_id, m.dimension_id) AS dimension_id,
             coalesce(o.dimension_value, m.dimension_value) AS dimension_value,
             coalesce(o.account_code, m.account_code) AS account_code,
             coalesce(o.opening_debit, 0) AS opening_debit,
             coalesce(o.opening_credit, 0) AS opening_credit,
             coalesce(m.debit_occur, 0) AS debit_occur,
             coalesce(m.credit_occur, 0) AS credit_occur
      FROM opening o
      FULL OUTER JOIN movement m
        ON m.dimension_id IS NOT DISTINCT FROM o.dimension_id
       AND m.dimension_value IS NOT DISTINCT FROM o.dimension_value
       AND m.account_code = o.account_code
    `);
    const list = this.unwrap<{
      dimension_id: string | null;
      dimension_value: string | null;
      account_code: string;
      opening_debit: string | number;
      opening_credit: string | number;
      debit_occur: string | number;
      credit_occur: string | number;
    }>(rows);
    const accountNames = await this.loadAccountTree();
    const nameByCode = new Map(accountNames.map((node) => [node.code, node.name]));
    const items: AuxBalanceRow[] = list.map((row) => {
      const openingDebit = toNumber(row.opening_debit);
      const openingCredit = toNumber(row.opening_credit);
      const debitOccur = toNumber(row.debit_occur);
      const creditOccur = toNumber(row.credit_occur);
      const closingDebit = round2(openingDebit + debitOccur);
      const closingCredit = round2(openingCredit + creditOccur);
      // P2-5：与科目余额表同口径，期末余额按方向轧差后单侧列示
      const openingNet = round2(openingDebit - openingCredit);
      const closingNet = round2(closingDebit - closingCredit);
      return {
        dimensionCode: params.dimensionCode,
        dimensionId: row.dimension_id,
        dimensionValue: row.dimension_value,
        accountCode: row.account_code,
        accountName: nameByCode.get(row.account_code) ?? '',
        openingDebit: openingNet > 0 ? openingNet : 0,
        openingCredit: openingNet < 0 ? round2(-openingNet) : 0,
        debitOccur,
        creditOccur,
        closingDebit: closingNet > 0 ? closingNet : 0,
        closingCredit: closingNet < 0 ? round2(-closingNet) : 0,
        closingNet,
        closingSide: closingNet === 0 ? 'flat' : closingNet > 0 ? 'debit' : 'credit',
      };
    });
    items.sort((a, b) => {
      const left = `${a.dimensionValue ?? a.dimensionId ?? ''}${a.accountCode}`;
      const right = `${b.dimensionValue ?? b.dimensionId ?? ''}${b.accountCode}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const totals = items.reduce(
      (acc, item) => ({
        debitOccur: round2(acc.debitOccur + item.debitOccur),
        creditOccur: round2(acc.creditOccur + item.creditOccur),
        closingDebit: round2(acc.closingDebit + item.closingDebit),
        closingCredit: round2(acc.closingCredit + item.closingCredit),
      }),
      { debitOccur: 0, creditOccur: 0, closingDebit: 0, closingCredit: 0 }
    );
    return {
      period: params.period,
      dimensionCode: params.dimensionCode,
      dimensionName: dimensionRows[0].name,
      items,
      totals,
      balanced: totals.closingDebit === totals.closingCredit,
    };
  }

  /** A-03 ③：总账（一级科目汇总） */
  async generalLedger(params: LedgerQueryParams): Promise<GeneralLedgerSheet> {
    this.assertPeriod(params.period, 'period');
    const rolled = await this.rolledBalances(params.period, {
      taxEntityId: params.taxEntityId,
      includeDraft: params.includeDraft,
    });
    const items: GeneralLedgerRow[] = [];
    for (const [code, values] of rolled) {
      if (values.level !== 1) continue;
      // P2-5：期末/期初余额按方向轧差后单侧列示（与科目余额表同口径）
      const openingNet = round2(values.openingDebit - values.openingCredit);
      const closingNet = round2(values.closingDebit - values.closingCredit);
      items.push({
        accountCode: code,
        accountName: values.name,
        direction: values.direction as GeneralLedgerRow['direction'],
        accountType: values.accountType,
        openingDebit: openingNet > 0 ? openingNet : 0,
        openingCredit: openingNet < 0 ? round2(-openingNet) : 0,
        debitOccur: values.debitOccur,
        creditOccur: values.creditOccur,
        closingDebit: closingNet > 0 ? closingNet : 0,
        closingCredit: closingNet < 0 ? round2(-closingNet) : 0,
        closingNet,
        closingSide: closingNet === 0 ? 'flat' : closingNet > 0 ? 'debit' : 'credit',
        childCount: values.children.length,
      });
    }
    items.sort((a, b) => (a.accountCode < b.accountCode ? -1 : 1));
    const totals = items.reduce(
      (acc, item) => ({
        debitOccur: round2(acc.debitOccur + item.debitOccur),
        creditOccur: round2(acc.creditOccur + item.creditOccur),
        closingDebit: round2(acc.closingDebit + item.closingDebit),
        closingCredit: round2(acc.closingCredit + item.closingCredit),
      }),
      { debitOccur: 0, creditOccur: 0, closingDebit: 0, closingCredit: 0 }
    );
    return {
      period: params.period,
      items,
      totals,
      balanced: totals.closingDebit === totals.closingCredit,
    };
  }

  /**
   * A-03 ②：明细账。
   * 余额滚动规则：期初余额 + 逐行累计；`对方科目` 从同一凭证的其他行推导。
   */
  async detailLedger(params: {
    accountCode: string;
    period: string;
    page: number;
    pageSize: number;
    taxEntityId?: string;
    includeChildren?: boolean;
    includeDraft?: boolean;
  }): Promise<DetailLedgerResult> {
    this.assertPeriod(params.period, 'period');
    const rolled = await this.rolledBalances(params.period, {
      taxEntityId: params.taxEntityId,
      includeDraft: params.includeDraft,
    });
    const self = rolled.get(params.accountCode);
    if (!self) {
      throw new BadRequestException(`科目 ${params.accountCode} 不存在`);
    }
    const codes = params.includeChildren
      ? [params.accountCode, ...this.collectDescendants(rolled, params.accountCode)]
      : [params.accountCode];

    const conditions = [
      inArray(finVoucherLine.accountCode, codes),
      eq(finVoucher.period, params.period),
      params.includeDraft
        ? inArray(finVoucher.status, ['posted', 'draft'])
        : eq(finVoucher.status, 'posted'),
    ];

    const totalRows = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(finVoucherLine)
      .innerJoin(finVoucher, eq(finVoucherLine.voucherId, finVoucher.id))
      .where(and(...conditions));
    const total = Number(totalRows[0]?.total ?? 0);

    const rows = await this.db
      .select({
        lineId: finVoucherLine.id,
        voucherId: finVoucher.id,
        voucherCode: finVoucher.code,
        voucherDate: finVoucher.voucherDate,
        summary: finVoucherLine.summary,
        voucherSummary: finVoucher.summary,
        sourceType: finVoucher.sourceType,
        sourceRef: finVoucher.sourceRef,
        debit: finVoucherLine.debit,
        credit: finVoucherLine.credit,
      })
      .from(finVoucherLine)
      .innerJoin(finVoucher, eq(finVoucherLine.voucherId, finVoucher.id))
      .where(and(...conditions))
      .orderBy(
        asc(finVoucher.voucherDate),
        asc(finVoucher.code),
        asc(finVoucherLine.createdAt),
        asc(finVoucherLine.id)
      )
      .limit(params.pageSize)
      .offset((params.page - 1) * params.pageSize);

    const voucherIds = Array.from(new Set(rows.map((row) => row.voucherId)));
    const counterpartMap = await this.loadCounterparts(voucherIds, codes);
    const lineIds = rows.map((row) => row.lineId);
    const auxMap = await this.loadLineAux(lineIds);

    // 翻页时的起始余额：期初 + 全量顺序中本页第一行之前所有行的净额
    const openingBalance = round2(self.openingDebit - self.openingCredit);
    let running = openingBalance;
    let priorDebit = 0;
    let priorCredit = 0;
    if (params.page > 1 && rows.length > 0) {
      const firstLineId = rows[0].lineId;
      const before = await this.db.execute(sql`
        WITH ordered AS (
          SELECT l.id AS id,
                 coalesce(l.debit, 0) AS debit,
                 coalesce(l.credit, 0) AS credit,
                 row_number() OVER (
                   ORDER BY v.voucher_date, v.code, l._created_at, l.id
                 ) AS rn
          FROM fin_voucher_line l
          JOIN fin_voucher v ON v.id = l.voucher_id
          WHERE l.account_code = ANY(${sql.raw(`ARRAY[${codes.map((code) => `'${code.replace(/'/g, "''")}'`).join(',')}]`)}::varchar[])
            AND v.period = ${params.period}
            AND ${this.statusCondition(params.includeDraft)}
            ${params.taxEntityId ? sql`AND v.tax_entity_id = ${params.taxEntityId}::uuid` : sql``}
        )
        SELECT coalesce(sum(debit), 0) AS debit, coalesce(sum(credit), 0) AS credit
        FROM ordered
        WHERE rn < (SELECT rn FROM ordered WHERE id = ${firstLineId}::uuid)
      `);
      const beforeRow = this.unwrap<{
        debit: string | number;
        credit: string | number;
      }>(before)[0];
      priorDebit = toNumber(beforeRow?.debit);
      priorCredit = toNumber(beforeRow?.credit);
    }
    running = round2(running + priorDebit - priorCredit);

    const items: DetailLedgerLine[] = [];
    let pageDebit = 0;
    let pageCredit = 0;
    for (const row of rows) {
      const debit = toNumber(row.debit);
      const credit = toNumber(row.credit);
      running = round2(running + debit - credit);
      pageDebit += debit;
      pageCredit += credit;
      items.push({
        lineId: row.lineId,
        voucherId: row.voucherId,
        voucherCode: row.voucherCode,
        voucherDate: row.voucherDate,
        summary: row.summary ?? row.voucherSummary,
        counterpartAccounts: counterpartMap.get(row.lineId) ?? [],
        debit,
        credit,
        balance: running,
        balanceSide: running === 0 ? 'flat' : running > 0 ? 'debit' : 'credit',
        sourceType: row.sourceType,
        sourceRef: row.sourceRef,
        aux: auxMap.get(row.lineId) ?? [],
      });
    }

    return {
      period: params.period,
      accountCode: params.accountCode,
      accountName: self.name,
      direction: self.direction as DetailLedgerResult['direction'],
      openingBalance: round2(self.openingDebit - self.openingCredit),
      openingDebit: self.openingDebit,
      openingCredit: self.openingCredit,
      closingBalance: round2(self.closingDebit - self.closingCredit),
      closingDebit: self.closingDebit,
      closingCredit: self.closingCredit,
      periodDebit: self.debitOccur,
      periodCredit: self.creditOccur,
      items,
      total,
      page: params.page,
      pageSize: params.pageSize,
      pageDebit: round2(pageDebit),
      pageCredit: round2(pageCredit),
    };
  }

  private collectDescendants(
    rolled: Map<string, { children: string[] }>,
    code: string
  ): string[] {
    const result: string[] = [];
    const walk = (parent: string): void => {
      for (const child of rolled.get(parent)?.children ?? []) {
        result.push(child);
        walk(child);
      }
    };
    walk(code);
    return result;
  }

  /** 对方科目：同一凭证中该行之外的其他科目编码 */
  private async loadCounterparts(
    voucherIds: string[],
    ownCodes: string[]
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (voucherIds.length === 0) return result;
    const rows = await this.db
      .select({
        id: finVoucherLine.id,
        voucherId: finVoucherLine.voucherId,
        accountCode: finVoucherLine.accountCode,
        accountName: finAccount.name,
      })
      .from(finVoucherLine)
      .leftJoin(finAccount, eq(finVoucherLine.accountId, finAccount.id))
      .where(inArray(finVoucherLine.voucherId, voucherIds));
    const own = new Set(ownCodes);
    const byVoucher = new Map<string, Array<{ code: string; name: string }>>();
    for (const row of rows) {
      const key = row.voucherId ?? '';
      byVoucher.set(key, [
        ...(byVoucher.get(key) ?? []),
        { code: row.accountCode ?? '', name: row.accountName ?? '' },
      ]);
    }
    for (const row of rows) {
      const others = (byVoucher.get(row.voucherId ?? '') ?? []).filter(
        (item) => !own.has(item.code)
      );
      const labels = Array.from(new Set(others.map((item) => item.name || item.code)));
      result.set(row.id, labels.length > 0 ? labels : ['-']);
    }
    return result;
  }

  private async loadLineAux(
    lineIds: string[]
  ): Promise<Map<string, Array<{ dimensionCode: string; dimensionValue: string | null }>>> {
    const result = new Map<
      string,
      Array<{ dimensionCode: string; dimensionValue: string | null }>
    >();
    if (lineIds.length === 0) return result;
    const rows = await this.db
      .select({
        lineId: finVoucherLineAux.lineId,
        dimensionCode: finVoucherLineAux.dimensionCode,
        dimensionValue: finVoucherLineAux.dimensionValue,
        dimensionId: finVoucherLineAux.dimensionId,
      })
      .from(finVoucherLineAux)
      .where(inArray(finVoucherLineAux.lineId, lineIds));
    for (const row of rows) {
      const key = row.lineId ?? '';
      result.set(key, [
        ...(result.get(key) ?? []),
        {
          dimensionCode: row.dimensionCode,
          dimensionValue: row.dimensionValue ?? row.dimensionId ?? null,
        },
      ]);
    }
    return result;
  }

  /** 试算平衡（供报表校验与期间结账复核） */
  async trialBalance(period: string): Promise<{
    period: string;
    totalDebit: number;
    totalCredit: number;
    balanced: boolean;
  }> {
    this.assertPeriod(period, 'period');
    const rows = await this.db
      .select({
        debit: sql<string>`coalesce(sum(${finVoucherLine.debit}), 0)`,
        credit: sql<string>`coalesce(sum(${finVoucherLine.credit}), 0)`,
      })
      .from(finVoucherLine)
      .innerJoin(finVoucher, eq(finVoucherLine.voucherId, finVoucher.id))
      .where(
        and(
          eq(finVoucher.period, period),
          sql`${finVoucher.status} = 'posted'`
        )
      );
    const totalDebit = round2(toNumber(rows[0]?.debit));
    const totalCredit = round2(toNumber(rows[0]?.credit));
    return {
      period,
      totalDebit,
      totalCredit,
      balanced: totalDebit === totalCredit,
    };
  }

  /** 损益类科目本期发生额（供利润表 / 结转损益复用） */
  async profitAndLossAccounts(period: string): Promise<
    Array<{
      code: string;
      name: string;
      accountType: string;
      direction: string;
      debitOccur: number;
      creditOccur: number;
      net: number;
    }>
  > {
    const rolled = await this.rolledBalances(period);
    const result: Array<{
      code: string;
      name: string;
      accountType: string;
      direction: string;
      debitOccur: number;
      creditOccur: number;
      net: number;
    }> = [];
    for (const [code, values] of rolled) {
      if (!values.isLeaf) continue;
      if (!['income', 'revenue', 'expense', 'cost'].includes(values.accountType)) {
        continue;
      }
      result.push({
        code,
        name: values.name,
        accountType: values.accountType,
        direction: values.direction,
        debitOccur: values.debitOccur,
        creditOccur: values.creditOccur,
        net: round2(values.debitOccur - values.creditOccur),
      });
    }
    result.sort((a, b) => (a.code < b.code ? -1 : 1));
    return result;
  }
}
