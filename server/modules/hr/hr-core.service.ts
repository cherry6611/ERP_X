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
import { and, asc, desc, eq, gte, ilike, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  hrAttendance,
  hrDepartment,
  hrLeaveBalance,
  hrLeaveRequest,
  hrPosition,
  mdEmployee,
  mdSupplier,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import type {
  AttendanceRecord,
  CreateDepartmentDto,
  CreateEmployeeDto,
  CreateLeaveRequestDto,
  CreatePositionDto,
  Department,
  Employee,
  LeaveBalance,
  LeaveRequest,
  Position,
  SetLeaveBalanceDto,
  UpdateDepartmentDto,
  UpdateEmployeeDto,
  UpdatePositionDto,
  UpsertAttendanceDto,
} from '@shared/api.interface';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 员工状态机：probation → active → resigned 单向流转 */
const EMPLOYEE_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  probation: ['active', 'resigned'],
  active: ['resigned'],
  resigned: [],
};

interface DepartmentRow {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  parentName: string | null;
  status: string | null;
  remark: string | null;
  createdAt: Date;
}

interface PositionRow {
  id: string;
  code: string;
  name: string;
  roleName: string | null;
  status: string | null;
  remark: string | null;
  createdAt: Date;
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

interface LeaveRequestRow {
  id: string;
  code: string;
  employeeId: string | null;
  employeeName: string | null;
  leaveType: string | null;
  startDate: string | null;
  endDate: string | null;
  days: string | null;
  reason: string | null;
  status: string | null;
  createdAt: Date;
}

@Injectable()
export class HrCoreService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  private toDepartment(row: DepartmentRow): Department {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      parentId: row.parentId,
      parentName: row.parentName,
      status: row.status ?? 'active',
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toPosition(row: PositionRow): Position {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      roleName: row.roleName,
      status: row.status ?? 'active',
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

  private toAttendanceRecord(row: AttendanceRow): AttendanceRecord {
    return {
      id: row.id,
      employeeId: row.employeeId ?? '',
      employeeName: row.employeeName ?? '',
      workDate: row.workDate ?? '',
      status: (row.status ?? 'present') as AttendanceRecord['status'],
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
      leaveType: (row.leaveType ?? 'annual') as LeaveBalance['leaveType'],
      year: row.year ?? '',
      totalDays,
      usedDays,
      remainingDays: totalDays - usedDays,
    };
  }

  private toLeaveRequest(row: LeaveRequestRow): LeaveRequest {
    return {
      id: row.id,
      code: row.code,
      employeeId: row.employeeId ?? '',
      employeeName: row.employeeName ?? '',
      leaveType: (row.leaveType ?? 'annual') as LeaveRequest['leaveType'],
      startDate: row.startDate ?? '',
      endDate: row.endDate ?? '',
      days: Number(row.days ?? 0),
      reason: row.reason,
      status: (row.status ?? 'pending') as LeaveRequest['status'],
      createdAt: row.createdAt.toISOString(),
    };
  }

  /* ========== 部门 ========== */

  async listDepartments(): Promise<Department[]> {
    const parentDept = alias(hrDepartment, 'parent_dept');
    const rows: DepartmentRow[] = await this.db
      .select({
        id: hrDepartment.id,
        code: hrDepartment.code,
        name: hrDepartment.name,
        parentId: hrDepartment.parentId,
        parentName: parentDept.name,
        status: hrDepartment.status,
        remark: hrDepartment.remark,
        createdAt: hrDepartment.createdAt,
      })
      .from(hrDepartment)
      .leftJoin(parentDept, eq(hrDepartment.parentId, parentDept.id))
      .orderBy(asc(hrDepartment.code));
    return rows.map((row: DepartmentRow) => this.toDepartment(row));
  }

  async createDepartment(dto: CreateDepartmentDto): Promise<Department> {
    const code = await generateBizCode(
      this.db,
      hrDepartment,
      hrDepartment.code,
      'DPT'
    );
    const inserted = await this.db
      .insert(hrDepartment)
      .values({
        code,
        name: dto.name,
        parentId: dto.parentId,
        status: 'active',
        remark: dto.remark,
      })
      .returning({ id: hrDepartment.id });
    return this.getDepartmentById(inserted[0].id);
  }

  async updateDepartment(
    id: string,
    dto: UpdateDepartmentDto
  ): Promise<Department> {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.parentId !== undefined) patch.parentId = dto.parentId;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.remark !== undefined) patch.remark = dto.remark;
    const rows = await this.db
      .update(hrDepartment)
      .set(patch)
      .where(eq(hrDepartment.id, id))
      .returning({ id: hrDepartment.id });
    if (rows.length === 0) throw new NotFoundException('部门不存在');
    return this.getDepartmentById(id);
  }

  private async getDepartmentById(idOrCode: string): Promise<Department> {
    const parentDept = alias(hrDepartment, 'parent_dept');
    const rows: DepartmentRow[] = await this.db
      .select({
        id: hrDepartment.id,
        code: hrDepartment.code,
        name: hrDepartment.name,
        parentId: hrDepartment.parentId,
        parentName: parentDept.name,
        status: hrDepartment.status,
        remark: hrDepartment.remark,
        createdAt: hrDepartment.createdAt,
      })
      .from(hrDepartment)
      .leftJoin(parentDept, eq(hrDepartment.parentId, parentDept.id))
      .where(eq(hrDepartment.id, idOrCode))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('部门不存在');
    return this.toDepartment(rows[0]);
  }

  /* ========== 岗位 ========== */

  async listPositions(): Promise<Position[]> {
    const rows: PositionRow[] = await this.db
      .select({
        id: hrPosition.id,
        code: hrPosition.code,
        name: hrPosition.name,
        roleName: hrPosition.roleName,
        status: hrPosition.status,
        remark: hrPosition.remark,
        createdAt: hrPosition.createdAt,
      })
      .from(hrPosition)
      .orderBy(asc(hrPosition.code));
    return rows.map((row: PositionRow) => this.toPosition(row));
  }

  async createPosition(dto: CreatePositionDto): Promise<Position> {
    const code = await generateBizCode(
      this.db,
      hrPosition,
      hrPosition.code,
      'POS'
    );
    const inserted = await this.db
      .insert(hrPosition)
      .values({
        code,
        name: dto.name,
        roleName: dto.roleName,
        status: 'active',
        remark: dto.remark,
      })
      .returning({ id: hrPosition.id });
    return this.getPositionById(inserted[0].id);
  }

  async updatePosition(id: string, dto: UpdatePositionDto): Promise<Position> {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.roleName !== undefined) patch.roleName = dto.roleName;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.remark !== undefined) patch.remark = dto.remark;
    const rows = await this.db
      .update(hrPosition)
      .set(patch)
      .where(eq(hrPosition.id, id))
      .returning({ id: hrPosition.id });
    if (rows.length === 0) throw new NotFoundException('岗位不存在');
    return this.getPositionById(id);
  }

  private async getPositionById(idOrCode: string): Promise<Position> {
    const rows: PositionRow[] = await this.db
      .select({
        id: hrPosition.id,
        code: hrPosition.code,
        name: hrPosition.name,
        roleName: hrPosition.roleName,
        status: hrPosition.status,
        remark: hrPosition.remark,
        createdAt: hrPosition.createdAt,
      })
      .from(hrPosition)
      .where(eq(hrPosition.id, idOrCode))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('岗位不存在');
    return this.toPosition(rows[0]);
  }

  /* ========== 员工档案 ========== */

  async listEmployees(keyword?: string): Promise<Employee[]> {
    const where =
      keyword && keyword.trim() !== ''
        ? or(
            ilike(mdEmployee.name, `%${keyword}%`),
            ilike(mdEmployee.code, `%${keyword}%`)
          )
        : undefined;
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
      .where(where)
      .orderBy(desc(mdEmployee.createdAt));
    return rows.map((row: EmployeeRow) => this.toEmployee(row));
  }

  async createEmployee(dto: CreateEmployeeDto): Promise<Employee> {
    const code = await generateBizCode(
      this.db,
      mdEmployee,
      mdEmployee.code,
      'EMP'
    );
    try {
      const inserted = await this.db
        .insert(mdEmployee)
        .values({
          code,
          name: dto.name,
          departmentId: dto.departmentId,
          positionId: dto.positionId,
          hireDate: dto.hireDate,
          employmentType: dto.employmentType,
          phone: dto.phone,
          status: dto.status ?? 'probation',
          ...(dto.platformUserId ? { platformUserId: dto.platformUserId } : {}),
          ...(dto.supplierId ? { supplierId: dto.supplierId } : {}),
        })
        .returning({ id: mdEmployee.id });
      return await this.getEmployeeById(inserted[0].id);
    } catch (error) {
      if (this.extractPostgresErrorCode(error) === '23505') {
        throw new ConflictException('该飞书账号已绑定其他员工');
      }
      throw error;
    }
  }

  /**
   * 软停用/启用员工主数据（admin）。
   * inactive 为档案停用（区别于 resigned 离职流程）；active 可从 inactive 恢复。
   */
  async setEmployeeStatus(
    id: string,
    status: 'active' | 'inactive'
  ): Promise<Employee> {
    if (status !== 'active' && status !== 'inactive') {
      throw new BadRequestException('员工启停状态仅支持 active / inactive');
    }
    const existing = await this.db
      .select({ status: mdEmployee.status })
      .from(mdEmployee)
      .where(eq(mdEmployee.id, id));
    if (existing.length === 0) throw new NotFoundException('员工不存在');
    const current: string = existing[0].status ?? 'active';
    if (current === 'resigned') {
      throw new BadRequestException('已离职员工不能通过启停接口变更状态');
    }
    if (status === 'active' && current !== 'inactive' && current !== 'active') {
      throw new BadRequestException(
        `当前状态 ${current} 请使用转正/离职流程，不能直接设为 active`
      );
    }
    const rows = await this.db
      .update(mdEmployee)
      .set({ status, updatedAt: new Date() })
      .where(eq(mdEmployee.id, id))
      .returning({ id: mdEmployee.id });
    if (rows.length === 0) throw new NotFoundException('员工不存在');
    return this.getEmployeeById(id);
  }

  async updateEmployee(id: string, dto: UpdateEmployeeDto): Promise<Employee> {
    const existing = await this.db
      .select({ status: mdEmployee.status })
      .from(mdEmployee)
      .where(eq(mdEmployee.id, id));
    if (existing.length === 0) throw new NotFoundException('员工不存在');
    const currentStatus: string = existing[0].status ?? 'active';
    if (dto.status !== undefined && dto.status !== currentStatus) {
      // inactive ↔ active 走专用启停接口；此处仍允许从 inactive 恢复为 active
      if (currentStatus === 'inactive' && dto.status === 'active') {
        // ok
      } else {
        const allowed = EMPLOYEE_STATUS_TRANSITIONS[currentStatus] ?? [];
        if (!allowed.includes(dto.status)) {
          throw new BadRequestException(
            `非法的员工状态流转：${currentStatus} → ${dto.status}`
          );
        }
      }
      if (dto.status === 'resigned' && !dto.resignDate) {
        throw new BadRequestException('员工离职必须同时提供离职日期');
      }
    }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.departmentId !== undefined) patch.departmentId = dto.departmentId;
    if (dto.positionId !== undefined) patch.positionId = dto.positionId;
    if (dto.hireDate !== undefined) patch.hireDate = dto.hireDate;
    if (dto.employmentType !== undefined) {
      patch.employmentType = dto.employmentType;
    }
    if (dto.phone !== undefined) patch.phone = dto.phone;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.resignDate !== undefined) patch.resignDate = dto.resignDate;
    if (dto.platformUserId !== undefined) {
      patch.platformUserId =
        dto.platformUserId === '' ? null : dto.platformUserId;
    }
    if (dto.supplierId !== undefined) {
      patch.supplierId = dto.supplierId === '' ? null : dto.supplierId;
    }
    try {
      const rows = await this.db
        .update(mdEmployee)
        .set(patch)
        .where(eq(mdEmployee.id, id))
        .returning({ id: mdEmployee.id });
      if (rows.length === 0) throw new NotFoundException('员工不存在');
    } catch (error) {
      if (this.extractPostgresErrorCode(error) === '23505') {
        throw new ConflictException('该飞书账号已绑定其他员工');
      }
      throw error;
    }
    return this.getEmployeeById(id);
  }

  private async getEmployeeById(idOrCode: string): Promise<Employee> {
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
      .where(eq(mdEmployee.id, idOrCode))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('员工不存在');
    return this.toEmployee(rows[0]);
  }

  /** 按平台账号（miaoda user_id）查绑定的在职员工 */
  async findEmployeeByPlatformUser(userId: string): Promise<Employee | null> {
    const rows = await this.db
      .select({ id: mdEmployee.id })
      .from(mdEmployee)
      .where(
        and(
          or(eq(mdEmployee.feishuUnionId, userId), eq(mdEmployee.platformUserId, userId)),
          sql`${mdEmployee.status} is distinct from 'resigned'`
        )
      )
      .limit(1);
    if (rows.length === 0) return null;
    return this.getEmployeeById(rows[0].id);
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

  /* ========== 考勤 ========== */

  async listAttendance(
    month: string,
    employeeId?: string
  ): Promise<AttendanceRecord[]> {
    if (!MONTH_PATTERN.test(month)) {
      throw new BadRequestException('month 参数必须为 YYYY-MM 格式');
    }
    const year: number = Number(month.slice(0, 4));
    const monthNum: number = Number(month.slice(5, 7));
    const nextYear: number = monthNum === 12 ? year + 1 : year;
    const nextMonth: number = monthNum === 12 ? 1 : monthNum + 1;
    const rangeStart = `${month}-01`;
    const rangeEnd = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
    const conditions = [
      gte(hrAttendance.workDate, rangeStart),
      lt(hrAttendance.workDate, rangeEnd),
    ];
    if (employeeId) conditions.push(eq(hrAttendance.employeeId, employeeId));
    const rows: AttendanceRow[] = await this.db
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
      .where(and(...conditions))
      .orderBy(asc(hrAttendance.workDate));
    return rows.map((row: AttendanceRow) => this.toAttendanceRecord(row));
  }

  async upsertAttendance(dto: UpsertAttendanceDto): Promise<AttendanceRecord> {
    const employees = await this.db
      .select({ id: mdEmployee.id, name: mdEmployee.name, status: mdEmployee.status })
      .from(mdEmployee)
      .where(eq(mdEmployee.id, dto.employeeId));
    if (employees.length === 0) throw new NotFoundException('员工不存在');
    if (employees[0].status === 'resigned') {
      throw new BadRequestException('员工已离职，不能登记考勤');
    }
    const rows = await this.db
      .insert(hrAttendance)
      .values({
        employeeId: dto.employeeId,
        workDate: dto.workDate,
        status: dto.status,
        remark: dto.remark,
      })
      .onConflictDoUpdate({
        target: [hrAttendance.employeeId, hrAttendance.workDate],
        set: {
          status: dto.status,
          remark: dto.remark,
          updatedAt: new Date(),
        },
      })
      .returning({
        id: hrAttendance.id,
        employeeId: hrAttendance.employeeId,
        workDate: hrAttendance.workDate,
        status: hrAttendance.status,
        remark: hrAttendance.remark,
      });
    return this.toAttendanceRecord({
      ...rows[0],
      employeeName: employees[0].name,
    });
  }

  /* ========== 请假余额 ========== */

  async listLeaveBalances(year?: string): Promise<LeaveBalance[]> {
    const where = year ? eq(hrLeaveBalance.year, year) : undefined;
    const rows: LeaveBalanceRow[] = await this.db
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
      .where(where)
      .orderBy(asc(hrLeaveBalance.year), asc(hrLeaveBalance.employeeId));
    return rows.map((row: LeaveBalanceRow) => this.toLeaveBalance(row));
  }

  async setLeaveBalance(dto: SetLeaveBalanceDto): Promise<LeaveBalance> {
    const rows = await this.db
      .insert(hrLeaveBalance)
      .values({
        employeeId: dto.employeeId,
        leaveType: dto.leaveType,
        year: dto.year,
        totalDays: String(dto.totalDays),
        usedDays: '0',
      })
      .onConflictDoUpdate({
        target: [
          hrLeaveBalance.employeeId,
          hrLeaveBalance.leaveType,
          hrLeaveBalance.year,
        ],
        set: {
          totalDays: String(dto.totalDays),
          updatedAt: new Date(),
        },
      })
      .returning({ id: hrLeaveBalance.id });
    return this.getLeaveBalanceById(rows[0].id);
  }

  private async getLeaveBalanceById(id: string): Promise<LeaveBalance> {
    const rows: LeaveBalanceRow[] = await this.db
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
      .where(eq(hrLeaveBalance.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('请假余额记录不存在');
    return this.toLeaveBalance(rows[0]);
  }

  /* ========== 请假申请 ========== */

  async listLeaveRequests(
    status?: string,
    employeeId?: string
  ): Promise<LeaveRequest[]> {
    const conditions = [];
    if (status) conditions.push(eq(hrLeaveRequest.status, status));
    if (employeeId) conditions.push(eq(hrLeaveRequest.employeeId, employeeId));
    const rows: LeaveRequestRow[] = await this.db
      .select({
        id: hrLeaveRequest.id,
        code: hrLeaveRequest.code,
        employeeId: hrLeaveRequest.employeeId,
        employeeName: mdEmployee.name,
        leaveType: hrLeaveRequest.leaveType,
        startDate: hrLeaveRequest.startDate,
        endDate: hrLeaveRequest.endDate,
        days: hrLeaveRequest.days,
        reason: hrLeaveRequest.reason,
        status: hrLeaveRequest.status,
        createdAt: hrLeaveRequest.createdAt,
      })
      .from(hrLeaveRequest)
      .leftJoin(mdEmployee, eq(hrLeaveRequest.employeeId, mdEmployee.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(hrLeaveRequest.createdAt));
    return rows.map((row: LeaveRequestRow) => this.toLeaveRequest(row));
  }

  async createLeaveRequest(
    dto: CreateLeaveRequestDto
  ): Promise<LeaveRequest> {
    const employees = await this.db
      .select({ status: mdEmployee.status })
      .from(mdEmployee)
      .where(eq(mdEmployee.id, dto.employeeId));
    if (employees.length === 0) throw new NotFoundException('员工不存在');
    if (employees[0].status === 'resigned') {
      throw new BadRequestException('员工已离职，不能申请请假');
    }
    if (!(dto.days > 0)) {
      throw new BadRequestException('请假天数必须大于 0');
    }
    const year: string = dto.startDate.slice(0, 4);
    const balances = await this.db
      .select({
        totalDays: hrLeaveBalance.totalDays,
        usedDays: hrLeaveBalance.usedDays,
      })
      .from(hrLeaveBalance)
      .where(
        and(
          eq(hrLeaveBalance.employeeId, dto.employeeId),
          eq(hrLeaveBalance.leaveType, dto.leaveType),
          eq(hrLeaveBalance.year, year)
        )
      );
    let totalDays: number;
    let usedDays: number;
    if (balances.length === 0) {
      const defaultDays: Record<string, number> = {
        annual: 5,
        sick: 10,
        personal: 3,
      };
      totalDays = defaultDays[dto.leaveType] ?? 0;
      usedDays = 0;
      await this.db
        .insert(hrLeaveBalance)
        .values({
          employeeId: dto.employeeId,
          leaveType: dto.leaveType,
          year,
          totalDays: String(totalDays),
          usedDays: String(usedDays),
        })
        .onConflictDoNothing();
    } else {
      totalDays = Number(balances[0].totalDays ?? 0);
      usedDays = Number(balances[0].usedDays ?? 0);
    }
    const remaining = totalDays - usedDays;
    if (remaining < dto.days) {
      throw new BadRequestException(
        `请假余额不足：剩余 ${remaining} 天，申请 ${dto.days} 天`
      );
    }
    const code = await generateBizCode(
      this.db,
      hrLeaveRequest,
      hrLeaveRequest.code,
      'LRQ'
    );
    const inserted = await this.db
      .insert(hrLeaveRequest)
      .values({
        code,
        employeeId: dto.employeeId,
        leaveType: dto.leaveType,
        startDate: dto.startDate,
        endDate: dto.endDate,
        days: String(dto.days),
        reason: dto.reason,
        status: 'pending',
      })
      .returning({ id: hrLeaveRequest.id });
    return this.getLeaveRequestById(inserted[0].id);
  }

  async handleLeaveRequestAction(
    id: string,
    action: 'approve' | 'reject'
  ): Promise<LeaveRequest> {
    const requests = await this.db
      .select({
        employeeId: hrLeaveRequest.employeeId,
        leaveType: hrLeaveRequest.leaveType,
        startDate: hrLeaveRequest.startDate,
        days: hrLeaveRequest.days,
        status: hrLeaveRequest.status,
      })
      .from(hrLeaveRequest)
      .where(eq(hrLeaveRequest.id, id));
    if (requests.length === 0) throw new NotFoundException('请假单不存在');
    const request = requests[0];
    if (request.status !== 'pending') {
      throw new BadRequestException('仅待审批的请假单可以执行审批操作');
    }
    if (action === 'reject') {
      const updated = await this.db
        .update(hrLeaveRequest)
        .set({ status: 'rejected', updatedAt: new Date() })
        .where(eq(hrLeaveRequest.id, id))
        .returning({ id: hrLeaveRequest.id });
      if (updated.length === 0) throw new NotFoundException('请假单不存在');
      return this.getLeaveRequestById(id);
    }
    const year: string = String(request.startDate ?? '').slice(0, 4);
    const days: string = String(Number(request.days ?? 0));
    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(hrLeaveRequest)
        .set({ status: 'approved', updatedAt: new Date() })
        .where(
          and(
            eq(hrLeaveRequest.id, id),
            eq(hrLeaveRequest.status, 'pending')
          )
        )
        .returning({ id: hrLeaveRequest.id });
      if (updated.length === 0) {
        throw new BadRequestException('请假单状态已变更，审批失败');
      }
      const balances = await tx
        .update(hrLeaveBalance)
        .set({
          usedDays: sql`${hrLeaveBalance.usedDays} + ${days}::numeric`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(hrLeaveBalance.employeeId, request.employeeId ?? ''),
            eq(hrLeaveBalance.leaveType, request.leaveType ?? ''),
            eq(hrLeaveBalance.year, year)
          )
        )
        .returning({ id: hrLeaveBalance.id });
      if (balances.length === 0) {
        throw new BadRequestException('请假余额记录不存在，审批失败');
      }
    });
    return this.getLeaveRequestById(id);
  }

  private async getLeaveRequestById(id: string): Promise<LeaveRequest> {
    const rows: LeaveRequestRow[] = await this.db
      .select({
        id: hrLeaveRequest.id,
        code: hrLeaveRequest.code,
        employeeId: hrLeaveRequest.employeeId,
        employeeName: mdEmployee.name,
        leaveType: hrLeaveRequest.leaveType,
        startDate: hrLeaveRequest.startDate,
        endDate: hrLeaveRequest.endDate,
        days: hrLeaveRequest.days,
        reason: hrLeaveRequest.reason,
        status: hrLeaveRequest.status,
        createdAt: hrLeaveRequest.createdAt,
      })
      .from(hrLeaveRequest)
      .leftJoin(mdEmployee, eq(hrLeaveRequest.employeeId, mdEmployee.id))
      .where(eq(hrLeaveRequest.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('请假单不存在');
    return this.toLeaveRequest(rows[0]);
  }
}
