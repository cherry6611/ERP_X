import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { hrEmployeeTaxDeduction, mdEmployee } from '@server/database/schema';
import {
  BASIC_DEDUCTION_PER_MONTH,
  cumulativeAdditionalDeduction,
  monthlyAdditionalDeduction,
  TAX_DEDUCTION_LABELS,
  TAX_DEDUCTION_TYPES,
  type TaxDeductionEntry,
  type TaxDeductionType,
} from './payroll-engine';
import type {
  EmployeeTaxDeductionItem,
  UpsertTaxDeductionDto,
} from '@shared/api.interface';

/**
 * A-07：个税专项附加扣除登记与累计口径查询。
 *
 * 登记方式（需财务确认，默认按"HR 代录"实现）：HR 在工资模块按员工 × 年度维护，
 * 员工自助入口可选（hr-self-service 已保留登录态，可后续开放）。
 */
@Injectable()
export class PayrollTaxService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  private assertType(type: string): TaxDeductionType {
    if (!TAX_DEDUCTION_TYPES.includes(type as TaxDeductionType)) {
      throw new BadRequestException(
        `不支持的专项附加扣除类型：${type}（可选 ${TAX_DEDUCTION_TYPES.join(' / ')}）`
      );
    }
    return type as TaxDeductionType;
  }

  /**
   * P1-8：各类型专项附加扣除的**月度法定标准上限**（个人所得税法 + 国发〔2018〕41 号，
   * 按 2023 年提标后口径）。系统按「员工 × 年度 × 类型」只允许一条登记，
   * 因此子女教育/婴幼儿照护等「按子女数累加」的项目这里取**单个子女**的标准
   * ——多子女家庭需拆到多条登记的能力见备注，超出上限一律拒绝并提供清晰提示。
   */
  private static readonly MONTHLY_CAP: Record<TaxDeductionType, number> = {
    child_education: 2000,
    continuing_education: 400,
    // 大病医疗按年度据实限额扣除（15000 起付 / 80000 上限），无月度定额，
    // 这里以年度上限的 1/12 作为月度登记上限，避免登记出荒诞值。
    medical: Math.floor(80000 / 12),
    housing_loan: 1000,
    // 住房租金按城市档 1500/1100/800，取最高档作为上限
    housing_rent: 1500,
    elderly_support: 3000,
    infant_care: 2000,
  };

  private assertMonthlyCap(type: TaxDeductionType, amount: number): void {
    const cap = PayrollTaxService.MONTHLY_CAP[type];
    if (amount > cap + 0.001) {
      throw new BadRequestException(
        `${TAX_DEDUCTION_LABELS[type]}月度扣除标准上限为 ${cap} 元，当前登记 ${amount} 元。` +
          `如为多子女/多项目合并扣除，请分别登记；住房租金请按所属城市档位（最高 1500 元/月）填写`
      );
    }
  }

  private toItem(row: {
    id: string;
    employeeId: string;
    employeeName?: string | null;
    taxYear: number;
    deductionType: string;
    monthlyAmount: string | number;
    startMonth: number;
    endMonth: number | null;
    remark: string | null;
  }): EmployeeTaxDeductionItem {
    return {
      id: row.id,
      employeeId: row.employeeId,
      employeeName: row.employeeName ?? null,
      taxYear: Number(row.taxYear),
      deductionType: this.assertType(row.deductionType),
      monthlyAmount: Number(row.monthlyAmount ?? 0),
      startMonth: Number(row.startMonth ?? 1),
      endMonth: row.endMonth == null ? null : Number(row.endMonth),
      remark: row.remark,
    };
  }

  async list(params: {
    employeeId?: string;
    taxYear?: number;
    deductionType?: string;
  }): Promise<EmployeeTaxDeductionItem[]> {
    const conditions = [];
    if (params.employeeId) {
      conditions.push(eq(hrEmployeeTaxDeduction.employeeId, params.employeeId));
    }
    if (params.taxYear) {
      conditions.push(eq(hrEmployeeTaxDeduction.taxYear, params.taxYear));
    }
    if (params.deductionType) {
      conditions.push(
        eq(hrEmployeeTaxDeduction.deductionType, this.assertType(params.deductionType))
      );
    }
    const rows = await this.db
      .select({
        id: hrEmployeeTaxDeduction.id,
        employeeId: hrEmployeeTaxDeduction.employeeId,
        employeeName: mdEmployee.name,
        taxYear: hrEmployeeTaxDeduction.taxYear,
        deductionType: hrEmployeeTaxDeduction.deductionType,
        monthlyAmount: hrEmployeeTaxDeduction.monthlyAmount,
        startMonth: hrEmployeeTaxDeduction.startMonth,
        endMonth: hrEmployeeTaxDeduction.endMonth,
        remark: hrEmployeeTaxDeduction.remark,
      })
      .from(hrEmployeeTaxDeduction)
      .leftJoin(mdEmployee, eq(hrEmployeeTaxDeduction.employeeId, mdEmployee.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(
        asc(hrEmployeeTaxDeduction.taxYear),
        asc(hrEmployeeTaxDeduction.employeeId),
        asc(hrEmployeeTaxDeduction.deductionType)
      );
    return rows.map((row) => this.toItem(row));
  }

  /** 员工 × 年度 → 扣除登记（供工资引擎计算月度/累计专项附加扣除） */
  async entriesFor(
    employeeId: string,
    taxYear: number
  ): Promise<TaxDeductionEntry[]> {
    const rows = await this.db
      .select({
        deductionType: hrEmployeeTaxDeduction.deductionType,
        monthlyAmount: hrEmployeeTaxDeduction.monthlyAmount,
        startMonth: hrEmployeeTaxDeduction.startMonth,
        endMonth: hrEmployeeTaxDeduction.endMonth,
      })
      .from(hrEmployeeTaxDeduction)
      .where(
        and(
          eq(hrEmployeeTaxDeduction.employeeId, employeeId),
          eq(hrEmployeeTaxDeduction.taxYear, taxYear)
        )
      );
    return rows.map((row) => ({
      deductionType: this.assertType(row.deductionType),
      monthlyAmount: Number(row.monthlyAmount ?? 0),
      startMonth: Number(row.startMonth ?? 1),
      endMonth: row.endMonth == null ? null : Number(row.endMonth),
    }));
  }

  /** 批量：多员工同年度扣除登记 */
  async entriesForMany(
    employeeIds: string[],
    taxYear: number
  ): Promise<Map<string, TaxDeductionEntry[]>> {
    const result = new Map<string, TaxDeductionEntry[]>();
    if (employeeIds.length === 0) return result;
    const rows = await this.db
      .select({
        employeeId: hrEmployeeTaxDeduction.employeeId,
        deductionType: hrEmployeeTaxDeduction.deductionType,
        monthlyAmount: hrEmployeeTaxDeduction.monthlyAmount,
        startMonth: hrEmployeeTaxDeduction.startMonth,
        endMonth: hrEmployeeTaxDeduction.endMonth,
      })
      .from(hrEmployeeTaxDeduction)
      .where(
        and(
          inArray(hrEmployeeTaxDeduction.employeeId, employeeIds),
          eq(hrEmployeeTaxDeduction.taxYear, taxYear)
        )
      );
    for (const row of rows) {
      const key = row.employeeId;
      result.set(key, [
        ...(result.get(key) ?? []),
        {
          deductionType: this.assertType(row.deductionType),
          monthlyAmount: Number(row.monthlyAmount ?? 0),
          startMonth: Number(row.startMonth ?? 1),
          endMonth: row.endMonth == null ? null : Number(row.endMonth),
        },
      ]);
    }
    return result;
  }

  /** 月度扣除额（某月） */
  async monthlyAmount(
    employeeId: string,
    taxYear: number,
    monthIndex: number
  ): Promise<number> {
    const entries = await this.entriesFor(employeeId, taxYear);
    return monthlyAdditionalDeduction(entries, monthIndex);
  }

  /** 累计扣除额（1 月至 monthIndex） */
  async cumulativeAmount(
    employeeId: string,
    taxYear: number,
    monthIndex: number
  ): Promise<number> {
    const entries = await this.entriesFor(employeeId, taxYear);
    return cumulativeAdditionalDeduction(entries, monthIndex);
  }

  /**
   * 新增/更新登记。同一员工 × 年度 × 类型唯一（upsert），
   * 避免重复登记导致重复扣除（审计风险）。
   */
  async upsert(dto: UpsertTaxDeductionDto): Promise<EmployeeTaxDeductionItem> {
    const type = this.assertType(dto.deductionType);
    if (!Number.isInteger(dto.taxYear) || dto.taxYear < 2000 || dto.taxYear > 2100) {
      throw new BadRequestException('taxYear 必须为 2000~2100 之间的整数');
    }
    if (!(dto.monthlyAmount > 0)) {
      throw new BadRequestException('monthlyAmount 必须大于 0');
    }
    // P1-8：专项附加扣除按月定额有法定上限，超额登记会直接少缴个税。
    // 原实现只校验「大于 0」，可登记 999999/月。
    this.assertMonthlyCap(type, Number(dto.monthlyAmount));
    const startMonth = dto.startMonth == null ? 1 : Number(dto.startMonth);
    if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
      throw new BadRequestException('startMonth 必须为 1~12');
    }
    const endMonth = dto.endMonth == null ? null : Number(dto.endMonth);
    if (endMonth != null && (!Number.isInteger(endMonth) || endMonth < startMonth || endMonth > 12)) {
      throw new BadRequestException('endMonth 必须为空或 ≥ startMonth 且 ≤ 12');
    }
    const employees = await this.db
      .select({ id: mdEmployee.id, name: mdEmployee.name })
      .from(mdEmployee)
      .where(eq(mdEmployee.id, dto.employeeId))
      .limit(1);
    if (employees.length === 0) throw new NotFoundException('员工不存在');

    const existing = await this.db
      .select({ id: hrEmployeeTaxDeduction.id })
      .from(hrEmployeeTaxDeduction)
      .where(
        and(
          eq(hrEmployeeTaxDeduction.employeeId, dto.employeeId),
          eq(hrEmployeeTaxDeduction.taxYear, dto.taxYear),
          eq(hrEmployeeTaxDeduction.deductionType, type)
        )
      )
      .limit(1);
    // P1-8：住房贷款利息 与 住房租金 是法定互斥项（同一纳税年度只能享受其中一项）。
    // 不拦的话员工可以同时登记 1000 + 1500，属可直接被稽查发现的多扣。
    const exclusive: Partial<Record<TaxDeductionType, TaxDeductionType>> = {
      housing_loan: 'housing_rent',
      housing_rent: 'housing_loan',
    };
    const conflictsWith = exclusive[type];
    if (conflictsWith) {
      const conflictRows = await this.db
        .select({ id: hrEmployeeTaxDeduction.id })
        .from(hrEmployeeTaxDeduction)
        .where(
          and(
            eq(hrEmployeeTaxDeduction.employeeId, dto.employeeId),
            eq(hrEmployeeTaxDeduction.taxYear, dto.taxYear),
            eq(hrEmployeeTaxDeduction.deductionType, conflictsWith)
          )
        )
        .limit(1);
      if (conflictRows.length > 0) {
        throw new BadRequestException(
          `${TAX_DEDUCTION_LABELS[type]}与${TAX_DEDUCTION_LABELS[conflictsWith]}在同一纳税年度互斥，` +
            `该员工${dto.taxYear}年度已登记${TAX_DEDUCTION_LABELS[conflictsWith]}；` +
            `如需改为${TAX_DEDUCTION_LABELS[type]}，请先删除原有登记`
        );
      }
    }
    const values = {
      employeeId: dto.employeeId,
      taxYear: dto.taxYear,
      deductionType: type,
      monthlyAmount: String(dto.monthlyAmount),
      startMonth,
      endMonth,
      remark: dto.remark ?? null,
      updatedAt: new Date(),
    };
    if (existing.length > 0) {
      await this.db
        .update(hrEmployeeTaxDeduction)
        .set(values)
        .where(eq(hrEmployeeTaxDeduction.id, existing[0].id));
      return this.toItem({
        id: existing[0].id,
        ...values,
        employeeName: employees[0].name,
      });
    }
    try {
      const inserted = await this.db
        .insert(hrEmployeeTaxDeduction)
        .values(values)
        .returning({ id: hrEmployeeTaxDeduction.id });
      return this.toItem({
        id: inserted[0].id,
        ...values,
        employeeName: employees[0].name,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('23505') || message.includes('uq_hr_emp_tax_deduction')) {
        throw new ConflictException(
          '该员工本年度此类型专项附加扣除已登记，请改为更新'
        );
      }
      throw error;
    }
  }

  async remove(id: string): Promise<{ ok: true }> {
    const removed = await this.db
      .delete(hrEmployeeTaxDeduction)
      .where(eq(hrEmployeeTaxDeduction.id, id))
      .returning({ id: hrEmployeeTaxDeduction.id });
    if (removed.length === 0) {
      throw new NotFoundException('专项附加扣除登记不存在');
    }
    return { ok: true };
  }

  /** 扣除类型字典（前端下拉） */
  listTypes(): Array<{ code: TaxDeductionType; label: string }> {
    return TAX_DEDUCTION_TYPES.map((code) => ({
      code,
      label: TAX_DEDUCTION_LABELS[code],
    }));
  }

  /**
   * 年度汇算辅助：导出员工全年累计数据（收入/扣除/已预扣税额）。
   * 供"个人所得税年度汇算"使用。
   */
  async annualSummary(taxYear: number, employeeIds?: string[]): Promise<
    Array<{
      employeeId: string;
      employeeName: string;
      ytdIncome: number;
      ytdDeduction: number;
      ytdAdditionalDeduction: number;
      ytdTaxableIncome: number;
      ytdTaxWithheld: number;
    }>
  > {
    const employeeFilter =
      employeeIds && employeeIds.length > 0
        ? sql`AND p.employee_id = ANY(${sql.raw(
            `ARRAY[${employeeIds
              .map((id) => `'${id.replace(/'/g, "''")}'`)
              .join(',')}]`
          )}::uuid[])`
        : sql``;
    const rows = await this.db.execute(sql`
      SELECT p.employee_id AS employee_id,
             coalesce(max(e.name), '') AS employee_name,
             coalesce(max(latest.ytd_income), 0) AS latest_income,
             coalesce(max(latest.ytd_tax_free_income), 0) AS latest_tax_free,
             coalesce(max(latest.ytd_basic_deduction), 0) AS latest_basic,
             coalesce(max(latest.ytd_deduction), 0) AS latest_deduction,
             coalesce(max(latest.ytd_additional_deduction), 0) AS latest_additional,
             coalesce(max(latest.ytd_taxable_income), 0) AS latest_taxable,
             coalesce(max(latest.ytd_tax_withheld), 0) AS latest_tax,
             coalesce(sum(p.base_salary + p.perf_salary + p.allowance), 0) AS sum_gross,
             coalesce(sum(p.social_insurance + p.housing_fund), 0) AS sum_deduction,
             coalesce(sum(p.tax), 0) AS sum_tax,
             count(DISTINCT p.period) AS months
      FROM hr_payroll p
      LEFT JOIN md_employee e ON e.id = p.employee_id
      -- P2-10：取该员工本年度**最后一张**工资单的累计口径行，作为五个字段的共同来源。
      -- 原实现只在 12 月工资单存在时取累计值，缺失时只有收入/专项扣除/已预扣税额
      -- 有"按月度汇总"兜底，应纳税所得额直接取 0 —— 同一函数里两套策略，导出的
      -- 汇算底稿会出现"有收入、有扣除、应纳税所得额为 0"的自相矛盾行。
      LEFT JOIN LATERAL (
        SELECT y.ytd_income,
               y.ytd_tax_free_income,
               y.ytd_basic_deduction,
               y.ytd_deduction,
               y.ytd_additional_deduction,
               y.ytd_taxable_income,
               y.ytd_tax_withheld
        FROM hr_payroll y
        WHERE y.employee_id = p.employee_id
          AND y.period LIKE ${`${taxYear}-%`}
          AND y.status IN ('approved', 'submitted', 'paid')
        ORDER BY y.period DESC
        LIMIT 1
      ) latest ON true
      WHERE p.period LIKE ${`${taxYear}-%`}
        AND p.status IN ('approved', 'submitted', 'paid')
        ${employeeFilter}
      GROUP BY p.employee_id
      ORDER BY p.employee_id
    `);
    const list = Array.isArray(rows)
      ? (rows as Array<Record<string, unknown>>)
      : ((rows as { rows?: Array<Record<string, unknown>> }).rows ?? []);
    const additionalByEmployee = await this.entriesForMany(
      list.map((row) => String(row.employee_id)),
      taxYear
    );
    return list.map((row) => {
      const employeeId = String(row.employee_id);
      const entries = additionalByEmployee.get(employeeId) ?? [];
      const months = Number(row.months ?? 0);
      const latestIncome = Number(row.latest_income ?? 0);
      const latestDeduction = Number(row.latest_deduction ?? 0);
      const latestTaxable = Number(row.latest_taxable ?? 0);
      const latestTax = Number(row.latest_tax ?? 0);
      const latestAdditional = Number(row.latest_additional ?? 0);
      // 五个字段统一口径：优先取最后一张工资单的累计值；仅当该年度完全没有引擎口径数据
      // （全部为手工录入工资单，累计列恒为 0）时，才整体退回"按月度金额汇总"的推导，
      // 且应纳税所得额按同一路径推导，不再出现部分字段兜底、部分字段取 0。
      const ytdIncome = latestIncome || Number(row.sum_gross ?? 0);
      const ytdDeduction = latestDeduction || Number(row.sum_deduction ?? 0);
      const ytdAdditionalDeduction =
        latestAdditional || cumulativeAdditionalDeduction(entries, 12);
      const ytdTaxWithheld = latestTax || Number(row.sum_tax ?? 0);
      const basicDeduction =
        Number(row.latest_basic ?? 0) || BASIC_DEDUCTION_PER_MONTH * months;
      const ytdTaxableIncome =
        latestTaxable ||
        Math.max(
          0,
          Math.round(
            (ytdIncome -
              Number(row.latest_tax_free ?? 0) -
              basicDeduction -
              ytdDeduction -
              ytdAdditionalDeduction) *
              100
          ) / 100
        );
      return {
        employeeId,
        employeeName: String(row.employee_name ?? ''),
        ytdIncome,
        ytdDeduction,
        ytdAdditionalDeduction,
        ytdTaxableIncome,
        ytdTaxWithheld,
      };
    });
  }
}
