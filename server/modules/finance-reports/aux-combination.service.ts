import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { asc, sql } from 'drizzle-orm';
import { finAuxDimension } from '@server/database/schema';
import { unwrapRows } from '@server/common/utils/rows';
import { round2 } from '@server/common/utils/number';
import {
  allocateAmount,
  assessCombinationCoverage,
  buildCombinations,
  buildCrossDimensionRows,
  netOfTax,
  validateCombinationRequest,
  type AuxLineForCombination,
  type DimensionValue,
} from './aux-combination-rules';
import type {
  AuxAllocationPreview,
  AuxCrossDimensionResult,
  AuxMultiDimensionBalance,
  AuxPeriodValue,
} from '@shared/api.interface';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;


function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * D-03：辅助核算深化（多维度组合账 / 跨维度分析 / 成本分摊）。
 *
 * 与 A-05（`AuxiliaryService`）的分工：
 *   - A-05：**维度本身**的维护（建维度、启停）+ 单维度余额表；
 *   - D-03（本服务）：**维度组合**的分析 —— 多维度组合余额、跨维度结构对比、
 *     按维度权重的成本分摊。
 *
 * 为什么单开一个服务而不是塞进 `LedgersService`：组合分析的 SQL 与单维度
 * 余额表完全是两种形状（前者按多维度 tuple 分组，后者按单维度分组），
 * 混在一起会让两边都难读；而规则内核已抽到 `aux-combination-rules.ts`，
 * 这里只负责取数与装配。
 */
@Injectable()
export class AuxCombinationService {
  private readonly logger = new Logger(AuxCombinationService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  /** 校验期间 */
  private assertPeriod(period: string | undefined, field = 'period'): string {
    if (!period || !PERIOD_PATTERN.test(period)) {
      throw new BadRequestException(`${field} 必填且格式为 YYYY-MM`);
    }
    return period;
  }

  /** 读取全部维度（含启用状态），供组合校验使用 */
  private async dimensions(): Promise<
    Array<{ code: string; name: string; enabled: boolean }>
  > {
    const rows = await this.db
      .select({
        code: finAuxDimension.code,
        name: finAuxDimension.name,
        enabled: finAuxDimension.enabled,
      })
      .from(finAuxDimension)
      .orderBy(asc(finAuxDimension.sortNo), asc(finAuxDimension.code));
    return rows.map((row) => ({
      code: row.code,
      name: row.name,
      enabled: Number(row.enabled ?? 1) === 1,
    }));
  }

  /**
   * 区间内挂辅助核算的分录行（含每行挂的多个维度）。
   *
   * 为什么一次取全部维度而不是按需 JOIN：一行可能挂 3 个维度，
   * 逐个维度 JOIN 会产生笛卡尔积与重复计数；这里用聚合把同一行的维度
   * **合并成数组**（`array_agg`），每行只出现一次，从根上避免重复计量。
   */
  private async loadLines(params: {
    from: string;
    to: string;
    dimensionCodes: string[];
    taxEntityId?: string;
    accountCode?: string;
  }): Promise<AuxLineForCombination[]> {
    const codes = params.dimensionCodes;
    // 维度编码来自服务端校验过的白名单，这里仍做转义，避免拼接注入
    const codesLiteral = sql.raw(
      `ARRAY[${codes.map((c) => `'${c.replace(/'/g, "''")}'`).join(',')}]::varchar[]`
    );
    const accountFilter = params.accountCode
      ? sql` AND l.account_code LIKE ${`${params.accountCode}%`}`
      : sql``;
    const entityFilter = params.taxEntityId
      ? sql` AND v.tax_entity_id = ${params.taxEntityId}::uuid`
      : sql``;
    const rows = unwrapRows<{
      line_id: string;
      account_code: string;
      debit: string | null;
      credit: string | null;
      dimensions: Array<{
        dimension_code: string;
        dimension_id: string | null;
        dimension_value: string | null;
      }> | null;
    }>(
      await this.db.execute(sql`
        SELECT l.id AS line_id,
               l.account_code,
               coalesce(l.debit, 0) AS debit,
               coalesce(l.credit, 0) AS credit,
               jsonb_agg(jsonb_build_object(
                 'dimension_code', a.dimension_code,
                 'dimension_id', a.dimension_id,
                 'dimension_value', a.dimension_value
               )) AS dimensions
        FROM fin_voucher_line l
        JOIN fin_voucher v ON v.id = l.voucher_id
        JOIN fin_voucher_line_aux a ON a.line_id = l.id
        WHERE v.status <> 'voided'
          AND v.period >= ${params.from}
          AND v.period <= ${params.to}
          AND a.dimension_code = ANY(${codesLiteral})
          ${accountFilter}
          ${entityFilter}
        GROUP BY l.id, l.account_code, l.debit, l.credit
      `)
    );
    return rows.map((row) => ({
      lineId: row.line_id,
      accountCode: row.account_code,
      debit: toNumber(row.debit),
      credit: toNumber(row.credit),
      dimensions: (row.dimensions ?? []).map((item) => ({
        dimensionCode: item.dimension_code,
        dimensionId: item.dimension_id,
        dimensionValue: item.dimension_value,
      })) as DimensionValue[],
    }));
  }

  /**
   * 多维度组合余额。
   *
   * 返回组合单元格 + **覆盖度**。覆盖度必须一起返回：组合金额之和通常小于
   * 科目总额（因为部分分录只挂了部分维度），不告知覆盖率就是给使用者一份
   * 看似完整实则缺口的表。
   */
  async multiDimensionBalance(params: {
    period: string;
    dimensionCodes: string[];
    taxEntityId?: string;
    accountCode?: string;
  }): Promise<AuxMultiDimensionBalance> {
    const period = this.assertPeriod(params.period);
    const requested = (params.dimensionCodes ?? []).filter(Boolean);
    const available = await this.dimensions();
    const errors = validateCombinationRequest(requested, available);
    if (errors.length > 0) throw new BadRequestException(errors.join('；'));

    const codes = [...new Set(requested)];
    const lines = await this.loadLines({
      from: period,
      to: period,
      dimensionCodes: codes,
      taxEntityId: params.taxEntityId,
      accountCode: params.accountCode,
    });
    const combination = buildCombinations(lines, codes);
    const coverage = assessCombinationCoverage(combination);

    return {
      period,
      dimensionCodes: codes,
      dimensionNames: codes.map(
        (code) => available.find((d) => d.code === code)?.name ?? code
      ),
      cells: combination.cells.map((cell) => ({
        key: cell.key,
        values: cell.values.map((value) => ({
          dimensionCode: value.dimensionCode,
          dimensionId: value.dimensionId,
          dimensionValue: value.dimensionValue,
        })),
        debit: cell.debit,
        credit: cell.credit,
        balance: cell.balance,
        lineCount: cell.lineCount,
      })),
      covered: combination.covered,
      uncovered: combination.uncovered,
      total: combination.total,
      coverage,
    };
  }

  /**
   * 区间多维度组合（跨月）。
   *
   * 与单期版本的区别：`from`/`to` 是闭区间月份，用于"某项目全年投入"这类问题。
   */
  async multiDimensionRange(params: {
    from: string;
    to: string;
    dimensionCodes: string[];
    taxEntityId?: string;
    accountCode?: string;
  }): Promise<AuxMultiDimensionBalance> {
    const from = this.assertPeriod(params.from, 'from');
    const to = this.assertPeriod(params.to, 'to');
    if (from > to) {
      throw new BadRequestException(`起始期间 ${from} 不能晚于结束期间 ${to}`);
    }
    const requested = (params.dimensionCodes ?? []).filter(Boolean);
    const available = await this.dimensions();
    const errors = validateCombinationRequest(requested, available);
    if (errors.length > 0) throw new BadRequestException(errors.join('；'));

    const codes = [...new Set(requested)];
    const lines = await this.loadLines({
      from,
      to,
      dimensionCodes: codes,
      taxEntityId: params.taxEntityId,
      accountCode: params.accountCode,
    });
    const combination = buildCombinations(lines, codes);
    return {
      period: `${from}~${to}`,
      dimensionCodes: codes,
      dimensionNames: codes.map(
        (code) => available.find((d) => d.code === code)?.name ?? code
      ),
      cells: combination.cells.map((cell) => ({
        key: cell.key,
        values: cell.values.map((value) => ({
          dimensionCode: value.dimensionCode,
          dimensionId: value.dimensionId,
          dimensionValue: value.dimensionValue,
        })),
        debit: cell.debit,
        credit: cell.credit,
        balance: cell.balance,
        lineCount: cell.lineCount,
      })),
      covered: combination.covered,
      uncovered: combination.uncovered,
      total: combination.total,
      coverage: assessCombinationCoverage(combination),
    };
  }

  /**
   * 跨维度结构对比：把多个维度各自的余额并列，配结构占比。
   *
   * 用途：回答"研发部的成本里人力占多少、外协占多少"这类结构问题。
   */
  async crossDimension(params: {
    period: string;
    dimensionCodes: string[];
    taxEntityId?: string;
    accountCode?: string;
  }): Promise<AuxCrossDimensionResult> {
    const period = this.assertPeriod(params.period);
    const requested = (params.dimensionCodes ?? []).filter(Boolean);
    const available = await this.dimensions();
    if (requested.length === 0) {
      throw new BadRequestException('至少选择 1 个辅助核算维度');
    }
    const errors = validateCombinationRequest(
      requested.slice(0, 1).concat(requested.slice(1)),
      available
    );
    // 结构对比允许超过组合上限（它不产生笛卡尔积），但仍要求维度存在且启用
    const existenceErrors = errors.filter((e) => !e.includes('最多同时分析'));
    if (existenceErrors.length > 0) {
      throw new BadRequestException(existenceErrors.join('；'));
    }

    const codes = [...new Set(requested)];
    const rows: Array<{
      dimensionCode: string;
      dimensionValue: string;
      balance: number;
    }> = [];
    for (const code of codes) {
      const lines = await this.loadLines({
        from: period,
        to: period,
        dimensionCodes: [code],
        taxEntityId: params.taxEntityId,
        accountCode: params.accountCode,
      });
      const grouped = new Map<string, number>();
      for (const line of lines) {
        const dimension = line.dimensions.find((d) => d.dimensionCode === code);
        if (!dimension) continue;
        const label =
          dimension.dimensionValue ?? dimension.dimensionId ?? '（未指定）';
        grouped.set(
          label,
          round2((grouped.get(label) ?? 0) + toNumber(line.debit) - toNumber(line.credit))
        );
      }
      for (const [dimensionValue, balance] of grouped) {
        rows.push({ dimensionCode: code, dimensionValue, balance });
      }
    }

    const built = buildCrossDimensionRows(rows);
    return {
      period,
      rows: built.rows,
      totalsByDimension: built.totalsByDimension.map((total) => ({
        ...total,
        dimensionName:
          available.find((d) => d.code === total.dimensionCode)?.name ??
          total.dimensionCode,
      })),
    };
  }

  /**
   * 维度取值范围（含本期余额），供前端下拉。
   *
   * 返回本期余额是为了让使用者**选之前就知道金额**，避免选到空组合再回来改。
   */
  async dimensionValues(params: {
    period: string;
    dimensionCode: string;
  }): Promise<AuxPeriodValue[]> {
    const period = this.assertPeriod(params.period);
    const rows = unwrapRows<{
      dimension_id: string | null;
      dimension_value: string | null;
      debit: string | null;
      credit: string | null;
    }>(
      await this.db.execute(sql`
        SELECT a.dimension_id, a.dimension_value,
               coalesce(sum(l.debit), 0) AS debit,
               coalesce(sum(l.credit), 0) AS credit
        FROM fin_voucher_line_aux a
        JOIN fin_voucher_line l ON l.id = a.line_id
        JOIN fin_voucher v ON v.id = l.voucher_id
        WHERE a.dimension_code = ${params.dimensionCode}
          AND v.status <> 'voided'
          AND v.period = ${period}
        GROUP BY a.dimension_id, a.dimension_value
        ORDER BY a.dimension_value
      `)
    );
    return rows.map((row) => ({
      dimensionId: row.dimension_id,
      dimensionValue: row.dimension_value ?? '（未指定）',
      debit: round2(toNumber(row.debit)),
      credit: round2(toNumber(row.credit)),
      balance: round2(toNumber(row.debit) - toNumber(row.credit)),
    }));
  }

  /**
   * 成本分摊试算。**只算不落库** —— 分摊结果入账属于业务动作，
   * 应由费用/成本模块在确认后调用，本接口只回答"按这些权重该分多少"。
   *
   * 金额分摊用最大余数法保证 `sum(shares) === amount`；
   * 若 `taxRate` 提供，还会给出不含税净额（与全仓价税分离口径一致）。
   */
  async previewAllocation(dto: {
    amount: number;
    weights: number[];
    targets?: string[];
    taxRate?: number;
    fallback?: 'equal' | 'reject';
  }): Promise<AuxAllocationPreview> {
    if (!(dto.weights ?? []).length) {
      throw new BadRequestException('weights 必填且至少一项');
    }
    if (dto.targets && dto.targets.length !== dto.weights.length) {
      throw new BadRequestException(
        `targets 数量（${dto.targets.length}）必须与 weights 数量（${dto.weights.length}）一致`
      );
    }
    let result;
    try {
      result = allocateAmount({
        amount: dto.amount,
        weights: dto.weights,
        fallback: dto.fallback ?? 'equal',
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error)
      );
    }
    const sharesSum = round2(
      result.shares.reduce((sum, value) => sum + value, 0)
    );
    if (sharesSum !== result.amount) {
      // 自检：分摊算法保证了这一点，若违反说明有回归，必须让调用方知道
      this.logger.error(
        `分摊自检失败：shares 合计 ${sharesSum} ≠ amount ${result.amount}（weights=${dto.weights.join(',')}）`
      );
      throw new BadRequestException(
        `分摊结果自检失败（合计 ${sharesSum} ≠ 总额 ${result.amount}），请联系管理员`
      );
    }
    const taxRate = dto.taxRate;
    return {
      amount: result.amount,
      totalWeight: result.totalWeight,
      equalFallback: result.equalFallback,
      adjustedCount: result.adjustedCount,
      sharesSum,
      lines: result.shares.map((share, index) => ({
        target: dto.targets?.[index] ?? `#${index + 1}`,
        weight: toNumber(dto.weights[index]),
        share,
        netShare:
          taxRate === undefined || taxRate === null
            ? null
            : /* 价税分离统一走权威口径（netOfTax → shared/tax 的 splitTax） */
              netOfTax(share, taxRate),
      })),
    };
  }
}
