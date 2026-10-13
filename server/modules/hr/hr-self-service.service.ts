import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountLifecycleService,
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import {
  erpProject,
  erpTimesheet,
  hrAttendance,
  hrAttendanceAmendment,
  hrDepartment,
  hrLeaveBalance,
  hrPayroll,
  hrPosition,
  mdEmployee,
  mdSupplier,
} from '@server/database/schema';
import { ActorAccessService } from '@server/common/auth/actor-access.service';
import type { RequestActor } from '@server/common/auth/actor';
import { todayInShanghai } from '@server/common/utils/biz-date';
import { generateBizCode } from '@server/common/utils/biz-code';
import { HrCoreService } from './hr-core.service';
import type {
  AttendanceAmendment,
  AttendanceAmendmentStatus,
  AttendanceRecord,
  AttendanceStatus,
  Employee,
  HandoverProject,
  InitLeaveBalancesResult,
  LeaveBalance,
  LeaveType,
  MyHrSummary,
  OffboardResult,
  PayrollItem,
  PayrollStatus,
} from '@shared/api.interface';

interface AmendmentRow {
  id: string;
  code: string;
  employeeId: string | null;
  employeeName: string | null;
  workDate: string;
  reason: string;
  status: string;
  createdAt: Date;
}

interface AttendanceRow {
  id: string;
  employeeId: string | null;
  employeeName: string | null;
  workDate: string | null;
  status: string | null;
  remark: string | null;
}

interface LeaveBalanceRow {
  id: string;
  employeeId: string | null;
  employeeName: string | null;
  leaveType: string | null;
  year: string | null;
  totalDays: string | null;
  usedDays: string | null;
}

interface EmployeeRow {
  id: string;
  code: string;
  name: string;
  orgName: string | null;
  position: string | null;
  status: string | null;
  departmentId: string | null;
  departmentName: string | null;
  positionId: string | null;
  roleName: string | null;
  hireDate: string | null;
  employmentType: string | null;
  phone: string | null;
  resignDate: string | null;
  platformUserId: string | null;
  supplierId: string | null;
  supplierName: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function cnNow(): Date {
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class HrSelfServiceService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly hrCoreService: HrCoreService,
    private readonly actorAccess: ActorAccessService,
    private readonly accounts: AccountLifecycleService,
  ) {}

  private toAmendment(row: AmendmentRow): AttendanceAmendment {
    return {
      id: row.id,
      code: row.code,
      employeeId: row.employeeId ?? '',
      employeeName: row.employeeName ?? '',
      workDate: row.workDate,
      reason: row.reason,
      status: (row.status ?? 'pending') as AttendanceAmendmentStatus,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toAttendanceRecord(row: AttendanceRow): AttendanceRecord {
    return {
      id: row.id,
      employeeId: row.employeeId ?? '',
      employeeName: row.employeeName ?? '',
      workDate: row.workDate ?? '',
      status: (row.status ?? 'present') as AttendanceStatus,
      remark: row.remark,
    };
  }

  private toLeaveBalance(row: LeaveBalanceRow): LeaveBalance {
    const totalDays = Number(row.totalDays ?? 0);
    const usedDays = Number(row.usedDays ?? 0);
    return {
      id: row.id,
      employeeId: row.employeeId ?? '',
      employeeName: row.employeeName ?? '',
      leaveType: (row.leaveType ?? 'annual') as LeaveType,
      year: row.year ?? '',
      totalDays,
      usedDays,
      remainingDays: totalDays - usedDays,
    };
  }

  private toPayrollItem(
    row: typeof hrPayroll.$inferSelect,
    employeeName: string
  ): PayrollItem {
    return {
      id: row.id,
      code: row.code,
      employeeId: row.employeeId ?? '',
      employeeName,
      period: row.period ?? '',
      baseSalary: Number(row.baseSalary ?? 0),
      perfSalary: Number(row.perfSalary ?? 0),
      allowance: Number(row.allowance ?? 0),
      socialInsurance: Number(row.socialInsurance ?? 0),
      housingFund: Number(row.housingFund ?? 0),
      tax: Number(row.tax ?? 0),
      netSalary: Number(row.netSalary ?? 0),
      status: (row.status ?? 'draft') as PayrollStatus,
      allocationGenerated: row.allocationGenerated ?? false,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toEmployee(row: EmployeeRow): Employee {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      orgName: row.orgName,
      position: row.position,
      status: row.status ?? 'active',
      departmentId: row.departmentId,
      departmentName: row.departmentName,
      positionId: row.positionId,
      roleName: row.roleName,
      hireDate: row.hireDate,
      employmentType: row.employmentType,
      phone: row.phone,
      resignDate: row.resignDate,
      platformUserId: row.platformUserId ?? null,
      supplierId: row.supplierId ?? null,
      supplierName: row.supplierName ?? null,
    };
  }

  private emptySummary(): MyHrSummary {
    return { employee: null, attendance: [], leaveBalances: [], payrolls: [] };
  }

  /* ========== 员工自助 ========== */

  async getMySummary(userId: string | undefined): Promise<MyHrSummary> {
    if (!userId) return this.emptySummary();
    const employee = await this.hrCoreService.findEmployeeByPlatformUser(userId);
    if (!employee) return this.emptySummary();

    const nowCn = cnNow();
    const year: number = nowCn.getUTCFullYear();
    const month: number = nowCn.getUTCMonth() + 1;
    const nextYear: number = month === 12 ? year + 1 : year;
    const nextMonth: number = month === 12 ? 1 : month + 1;
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const monthEnd = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

    const attendanceRows: AttendanceRow[] = await this.db
      .select({
        id: hrAttendance.id,
        employeeId: hrAttendance.employeeId,
        employeeName: mdEmployee.name,
        workDate: hrAttendance.workDate,
        status: hrAttendance.status,
        remark: hrAttendance.remark,
      })
      .from(hrAttendance)
      .leftJoin(mdEmployee, eq(hrAttendance.employeeId, mdEmployee.id))
      .where(
        and(
          eq(hrAttendance.employeeId, employee.id),
          gte(hrAttendance.workDate, monthStart),
          lt(hrAttendance.workDate, monthEnd)
        )
      )
      .orderBy(asc(hrAttendance.workDate));

    const balanceRows: LeaveBalanceRow[] = await this.db
      .select({
        id: hrLeaveBalance.id,
        employeeId: hrLeaveBalance.employeeId,
        employeeName: mdEmployee.name,
        leaveType: hrLeaveBalance.leaveType,
        year: hrLeaveBalance.year,
        totalDays: hrLeaveBalance.totalDays,
        usedDays: hrLeaveBalance.usedDays,
      })
      .from(hrLeaveBalance)
      .leftJoin(mdEmployee, eq(hrLeaveBalance.employeeId, mdEmployee.id))
      .where(
        and(
          eq(hrLeaveBalance.employeeId, employee.id),
          eq(hrLeaveBalance.year, String(year))
        )
      )
      .orderBy(asc(hrLeaveBalance.leaveType));

    const payrollRows = await this.db
      .select({ payroll: hrPayroll, employeeName: mdEmployee.name })
      .from(hrPayroll)
      .leftJoin(mdEmployee, eq(hrPayroll.employeeId, mdEmployee.id))
      .where(
        and(
          eq(hrPayroll.employeeId, employee.id),
          eq(hrPayroll.status, 'approved')
        )
      )
      .orderBy(desc(hrPayroll.period));

    return {
      employee,
      attendance: attendanceRows.map((row: AttendanceRow) =>
        this.toAttendanceRecord(row)
      ),
      leaveBalances: balanceRows.map((row: LeaveBalanceRow) =>
        this.toLeaveBalance(row)
      ),
      payrolls: payrollRows.map((row) =>
        this.toPayrollItem(row.payroll, row.employeeName ?? employee.name)
      ),
    };
  }

  /* ========== 考勤补卡 ========== */

  async listAmendments(
    status: string | undefined,
    actor: RequestActor
  ): Promise<AttendanceAmendment[]> {
    const privileged: boolean = await this.actorAccess.hasAnyRole(actor.userId, [
      'admin',
      'hr_manager',
    ]);
    const conditions = [];
    if (status) conditions.push(eq(hrAttendanceAmendment.status, status));
    if (!privileged) {
      const employee = await this.hrCoreService.findEmployeeByPlatformUser(
        actor.userId
      );
      if (!employee) return [];
      conditions.push(eq(hrAttendanceAmendment.employeeId, employee.id));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows: AmendmentRow[] = await this.db
      .select({
        id: hrAttendanceAmendment.id,
        code: hrAttendanceAmendment.code,
        employeeId: hrAttendanceAmendment.employeeId,
        employeeName: mdEmployee.name,
        workDate: hrAttendanceAmendment.workDate,
        reason: hrAttendanceAmendment.reason,
        status: hrAttendanceAmendment.status,
        createdAt: hrAttendanceAmendment.createdAt,
      })
      .from(hrAttendanceAmendment)
      .leftJoin(
        mdEmployee,
        eq(hrAttendanceAmendment.employeeId, mdEmployee.id)
      )
      .where(where)
      .orderBy(desc(hrAttendanceAmendment.createdAt));
    return rows.map((row: AmendmentRow) => this.toAmendment(row));
  }

  async createAmendment(
    dto: {
      workDate: string;
      reason: string;
    },
    userId: string
  ): Promise<AttendanceAmendment> {
    const bound = await this.hrCoreService.findEmployeeByPlatformUser(userId);
    if (!bound) {
      throw new BadRequestException('当前账号未绑定员工，无法提交补卡');
    }
    const employees = await this.db
      .select({ id: mdEmployee.id, name: mdEmployee.name, status: mdEmployee.status })
      .from(mdEmployee)
      .where(eq(mdEmployee.id, bound.id));
    if (employees.length === 0) throw new NotFoundException('员工不存在');
    if (employees[0].status === 'resigned') {
      throw new BadRequestException('员工已离职，不能提交补卡申请');
    }
    const today: string = todayInShanghai();
    if (dto.workDate > today) {
      throw new BadRequestException('补卡日期不能是未来日期');
    }
    const attendance = await this.db
      .select({ id: hrAttendance.id })
      .from(hrAttendance)
      .where(
        and(
          eq(hrAttendance.employeeId, bound.id),
          eq(hrAttendance.workDate, dto.workDate)
        )
      );
    if (attendance.length > 0) {
      throw new BadRequestException('该日期已有考勤记录');
    }
    const code = await generateBizCode(
      this.db,
      hrAttendanceAmendment,
      hrAttendanceAmendment.code,
      'AMD'
    );
    try {
      const rows = await this.db
        .insert(hrAttendanceAmendment)
        .values({
          code,
          employeeId: bound.id,
          workDate: dto.workDate,
          reason: dto.reason,
          status: 'pending',
        })
        .returning();
      await this.db.execute(sql`
        UPDATE hr_attendance_amendment
        SET submitted_by = ${userId}
        WHERE id = ${rows[0].id}
      `).catch((error: unknown) => {
        const message: string =
          error instanceof Error ? error.message : String(error);
        if (!message.includes('submitted_by') && !message.includes('42703')) {
          throw error;
        }
      });
      return this.toAmendment({
        ...rows[0],
        employeeName: employees[0].name,
      });
    } catch (error) {
      if (this.extractPostgresErrorCode(error) === '23505') {
        throw new ConflictException('该日期已有补卡申请');
      }
      throw error;
    }
  }

  async amendmentAction(
    id: string,
    action: 'approve' | 'reject'
  ): Promise<AttendanceAmendment> {
    const existing = await this.db
      .select()
      .from(hrAttendanceAmendment)
      .where(eq(hrAttendanceAmendment.id, id));
    if (existing.length === 0) throw new NotFoundException('补卡申请不存在');
    if (existing[0].status !== 'pending') {
      throw new BadRequestException('该补卡申请已被处理，仅待审批状态可操作');
    }
    const amendment = existing[0];

    if (action === 'reject') {
      const updated = await this.db
        .update(hrAttendanceAmendment)
        .set({ status: 'rejected', updatedAt: new Date() })
        .where(
          and(
            eq(hrAttendanceAmendment.id, id),
            eq(hrAttendanceAmendment.status, 'pending')
          )
        )
        .returning({ id: hrAttendanceAmendment.id });
      if (updated.length === 0) {
        throw new BadRequestException('该补卡申请已被处理');
      }
      return this.getAmendmentById(id);
    }

    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(hrAttendanceAmendment)
        .set({ status: 'approved', updatedAt: new Date() })
        .where(
          and(
            eq(hrAttendanceAmendment.id, id),
            eq(hrAttendanceAmendment.status, 'pending')
          )
        )
        .returning({ id: hrAttendanceAmendment.id });
      if (updated.length === 0) {
        throw new BadRequestException('该补卡申请已被处理');
      }
      await tx
        .insert(hrAttendance)
        .values({
          employeeId: amendment.employeeId,
          workDate: amendment.workDate,
          status: 'present',
          remark: `补卡审批通过 ${amendment.code}`,
        })
        .onConflictDoUpdate({
          target: [hrAttendance.employeeId, hrAttendance.workDate],
          set: {
            status: 'present',
            remark: `补卡审批通过 ${amendment.code}`,
            updatedAt: new Date(),
          },
        });
    });
    return this.getAmendmentById(id);
  }

  private async getAmendmentById(id: string): Promise<AttendanceAmendment> {
    const rows: AmendmentRow[] = await this.db
      .select({
        id: hrAttendanceAmendment.id,
        code: hrAttendanceAmendment.code,
        employeeId: hrAttendanceAmendment.employeeId,
        employeeName: mdEmployee.name,
        workDate: hrAttendanceAmendment.workDate,
        reason: hrAttendanceAmendment.reason,
        status: hrAttendanceAmendment.status,
        createdAt: hrAttendanceAmendment.createdAt,
      })
      .from(hrAttendanceAmendment)
      .leftJoin(
        mdEmployee,
        eq(hrAttendanceAmendment.employeeId, mdEmployee.id)
      )
      .where(eq(hrAttendanceAmendment.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('补卡申请不存在');
    return this.toAmendment(rows[0]);
  }

  private extractPostgresErrorCode(error: unknown): string | undefined {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
      const { code, cause } = current as { code?: unknown; cause?: unknown };
      if (typeof code === 'string') return code;
      current = cause;
    }
    return undefined;
  }

  /* ========== 年假规则初始化 ========== */

  async initLeaveBalances(year: string): Promise<InitLeaveBalancesResult> {
    const employees = await this.db
      .select({ id: mdEmployee.id, hireDate: mdEmployee.hireDate })
      .from(mdEmployee)
      .where(sql`${mdEmployee.status} is distinct from 'resigned'`);
    const existing = await this.db
      .select({ employeeId: hrLeaveBalance.employeeId })
      .from(hrLeaveBalance)
      .where(
        and(eq(hrLeaveBalance.year, year), eq(hrLeaveBalance.leaveType, 'annual'))
      );
    const existingIds = new Set<string>(
      existing.map((row) => row.employeeId ?? '')
    );
    const toInsert = employees.filter(
      (emp) => !existingIds.has(emp.id)
    );
    const baseTime = Date.parse(`${year}-01-01`);
    let initializedCount = 0;
    if (toInsert.length > 0) {
      const inserted = await this.db
        .insert(hrLeaveBalance)
        .values(
          toInsert.map((emp) => ({
            employeeId: emp.id,
            leaveType: 'annual',
            year,
            totalDays: String(this.annualDaysByTenure(emp.hireDate, baseTime)),
            usedDays: '0',
          }))
        )
        .onConflictDoNothing({
          target: [
            hrLeaveBalance.employeeId,
            hrLeaveBalance.leaveType,
            hrLeaveBalance.year,
          ],
        })
        .returning({ id: hrLeaveBalance.id });
      initializedCount = inserted.length;
    }
    return {
      year,
      initializedCount,
      skippedCount: employees.length - toInsert.length,
    };
  }

  /** 司龄（截至 year-01-01 的整年数）→ 年假天数：<1 年或无 hireDate 5 天、1-3 年 8 天、3-5 年 10 天、5-10 年 12 天、≥10 年 15 天 */
  private annualDaysByTenure(hireDate: string | null, baseTime: number): number {
    if (!hireDate) return 5;
    const hireTime = Date.parse(`${hireDate}T00:00:00Z`);
    if (Number.isNaN(hireTime)) return 5;
    const base = new Date(baseTime);
    const hire = new Date(hireTime);
    let years = base.getUTCFullYear() - hire.getUTCFullYear();
    const beforeAnniversary =
      base.getUTCMonth() < hire.getUTCMonth() ||
      (base.getUTCMonth() === hire.getUTCMonth() &&
        base.getUTCDate() < hire.getUTCDate());
    if (beforeAnniversary) years -= 1;
    if (years >= 10) return 15;
    if (years >= 5) return 12;
    if (years >= 3) return 10;
    if (years >= 1) return 8;
    return 5;
  }

  /* ========== 离职流转 ========== */

  async offboard(
    id: string,
    dto: { resignDate: string; remark?: string }
  ): Promise<OffboardResult> {
    const employees = await this.db
      .select({ id: mdEmployee.id, status: mdEmployee.status, hireDate: mdEmployee.hireDate })
      .from(mdEmployee)
      .where(eq(mdEmployee.id, id));
    if (employees.length === 0) throw new NotFoundException('员工不存在');
    if (employees[0].status === 'resigned') {
      throw new BadRequestException('员工已离职，无需重复办理');
    }
    if (employees[0].hireDate && dto.resignDate < employees[0].hireDate) {
      throw new BadRequestException('离职日期不能早于入职日期');
    }
    const patch: Record<string, unknown> = {
      status: 'resigned',
      resignDate: dto.resignDate,
      updatedAt: new Date(),
    };
    if (dto.remark !== undefined) patch.remark = dto.remark;
    const updated = await this.db
      .update(mdEmployee)
      .set(patch)
      .where(eq(mdEmployee.id, id))
      .returning({ id: mdEmployee.id });
    if (updated.length === 0) throw new NotFoundException('员工不存在');
    await this.accounts.disableEmployeeAccount(id);
    const employee = await this.getEmployeeById(id);

    const cutoff: string = toIsoDate(
      new Date(Date.parse(dto.resignDate) - 60 * DAY_MS)
    );
    const timesheetRows = await this.db
      .select({
        projectId: erpTimesheet.projectId,
        totalHours: sql<number>`coalesce(sum(${erpTimesheet.hours}), 0)::float8`,
        lastWorkDate: sql<string | null>`max(${erpTimesheet.workDate})`,
      })
      .from(erpTimesheet)
      .where(
        and(
          eq(erpTimesheet.employeeId, id),
          eq(erpTimesheet.status, 'confirmed'),
          gte(erpTimesheet.workDate, cutoff),
          lte(erpTimesheet.workDate, dto.resignDate)
        )
      )
      .groupBy(erpTimesheet.projectId);
    const projectIds = timesheetRows
      .map((row) => row.projectId)
      .filter((projectId): projectId is string => projectId !== null);
    const projectNameMap = new Map<string, string>();
    if (projectIds.length > 0) {
      const projects = await this.db
        .select({ id: erpProject.id, name: erpProject.name })
        .from(erpProject)
        .where(inArray(erpProject.id, projectIds));
      for (const project of projects) {
        projectNameMap.set(project.id, project.name);
      }
    }
    const handoverProjects: HandoverProject[] = timesheetRows
      .filter((row) => row.projectId !== null)
      .map((row) => ({
        projectId: row.projectId ?? '',
        projectName: projectNameMap.get(row.projectId ?? '') ?? '',
        lastWorkDate: row.lastWorkDate ?? null,
        confirmedHours: Number(row.totalHours ?? 0),
      }));
    handoverProjects.sort(
      (a: HandoverProject, b: HandoverProject) =>
        b.confirmedHours - a.confirmedHours
    );
    return { employee, handoverProjects };
  }

  private async getEmployeeById(id: string): Promise<Employee> {
    const rows: EmployeeRow[] = await this.db
      .select({
        id: mdEmployee.id,
        code: mdEmployee.code,
        name: mdEmployee.name,
        orgName: mdEmployee.orgName,
        position: mdEmployee.position,
        status: mdEmployee.status,
        departmentId: mdEmployee.departmentId,
        departmentName: hrDepartment.name,
        positionId: mdEmployee.positionId,
        roleName: hrPosition.roleName,
        hireDate: mdEmployee.hireDate,
        employmentType: mdEmployee.employmentType,
        phone: mdEmployee.phone,
        resignDate: mdEmployee.resignDate,
        platformUserId: mdEmployee.platformUserId,
        supplierId: mdEmployee.supplierId,
        supplierName: mdSupplier.name,
      })
      .from(mdEmployee)
      .leftJoin(hrDepartment, eq(mdEmployee.departmentId, hrDepartment.id))
      .leftJoin(hrPosition, eq(mdEmployee.positionId, hrPosition.id))
      .leftJoin(mdSupplier, eq(mdEmployee.supplierId, mdSupplier.id))
      .where(eq(mdEmployee.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('员工不存在');
    return this.toEmployee(rows[0]);
  }
}
