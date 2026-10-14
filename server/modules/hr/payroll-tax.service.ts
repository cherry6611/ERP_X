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
             coalesce(max(CASE WHEN p.period = ${`${taxYear}-12`} THEN p.ytd_income END), 0) AS dec_income,
             coalesce(max(CASE WHEN p.period = ${`${taxYear}-12`} THEN p.ytd_deduction END), 0) AS dec_deduction,
             coalesce(max(CASE WHEN p.period = ${`${taxYear}-12`} THEN p.ytd_additional_deduction END), 0) AS dec_additional,
             coalesce(max(CASE WHEN p.period = ${`${taxYear}-12`} THEN p.ytd_taxable_income END), 0) AS dec_taxable,
             coalesce(max(CASE WHEN p.period = ${`${taxYear}-12`} THEN p.ytd_tax_withheld END), 0) AS dec_tax,
             coalesce(sum(p.base_salary + p.perf_salary + p.allowance), 0) AS sum_gross,
             coalesce(sum(p.social_insurance + p.housing_fund), 0) AS sum_deduction,
             coalesce(sum(p.tax), 0) AS sum_tax
      FROM hr_payroll p
      LEFT JOIN md_employee e ON e.id = p.employee_id
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
      const decIncome = Number(row.dec_income ?? 0);
      const decDeduction = Number(row.dec_deduction ?? 0);
      const decTaxable = Number(row.dec_taxable ?? 0);
      const decTax = Number(row.dec_tax ?? 0);
      // 12 月工资单缺失时用年度汇总兜底（附加扣除按登记逐月重算）
      const ytdAdditional =
        Number(row.dec_additional ?? 0) || cumulativeAdditionalDeduction(entries, 12);
      return {
        employeeId,
        employeeName: String(row.employee_name ?? ''),
        ytdIncome: decIncome || Number(row.sum_gross ?? 0),
        ytdDeduction: decDeduction || Number(row.sum_deduction ?? 0),
        ytdAdditionalDeduction: ytdAdditional,
        ytdTaxableIncome: decTaxable,
        ytdTaxWithheld: decTax || Number(row.sum_tax ?? 0),
      };
    });
  }
}
