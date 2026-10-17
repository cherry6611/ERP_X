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
import { and, asc, desc, eq, gte, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import {
  ilikeEscaped,
  likeContains,
} from '@server/common/utils/sql-like';
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
import { round2 } from '@server/common/utils/number';
import { extractPostgresErrorCode } from '@server/common/utils/postgres-error';
import {
  DataScopeService,
  applyScope,
  type ResolvedScope,
} from '@server/common/auth/data-scope.service';
import type { RequestActor } from '@server/common/auth/actor';
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

/** 手机号脱敏：保留前 3 后 4 */
function maskPhoneNumber(phone: string): string {
  const digits = phone.replace(/\s+/g, '');
  if (digits.length < 7) return '****';
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

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
  ssCityCode: string | null;
  ssBase: string | null;
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
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly dataScope: DataScopeService
  ) {}

  /**
   * B-02：员工档案行级可见范围（SQL 层过滤）。
   *
   * `sys_data_scope` 里 `hr_manager × employee` 种为 `dept_and_child`，
   * 于是"部门经理只能看到本部门及下级部门的员工档案"（需求书验收标准①）
   * 由 `md_employee.department_id IN (...)` 在 SQL 里完成，而不是取全量后再筛。
   * 未配置该资源时：若 employee 资源**完全没用过行级权限**，返回 undefined
   * （保持既有"人事经理可读全量"的行为）；若已启用（`from === 'policy'`），
   * 则由 `conditionFor` 走 fail-closed，不给全量。
   */
  private async employeeScopeCondition(
    actor?: RequestActor
  ): Promise<SQL | undefined> {
    if (!actor) return undefined;
    const resolved: ResolvedScope = await this.dataScope.resolveScope(
      actor.roles ?? [],
      'employee'
    );
    if (resolved.from === 'default') return undefined;
    return this.dataScope.conditionFor(
      'employee',
      actor,
      {
        primary: mdEmployee.id,
        self: mdEmployee.platformUserId,
        dept: mdEmployee.departmentId,
      },
      { resolved }
    );
  }

  /**
   * B-02：考勤行级可见范围。
   *
   * `hr_attendance` 只有 `employee_id`，没有部门列与用户列：
   *   - `self`             → `employee_id = 当前登录人绑定的员工`
   *   - `dept/dept_and_child` → 先取"本部门及下级"的员工 id 集合，再 `employee_id IN (...)`
   *   - `custom`           → `employee_id IN custom_ids`
   * 部门集合为空时 fail-closed（返回空集并记 warn），不放行全量。
   */
  private async attendanceScopeCondition(
    actor?: RequestActor
  ): Promise<SQL | undefined> {
    if (!actor) return undefined;
    const resolved: ResolvedScope = await this.dataScope.resolveScope(
      actor.roles ?? [],
      'attendance'
    );
    if (resolved.from === 'default' || resolved.scope === 'all') return undefined;
    if (resolved.scope === 'none') {
      return this.dataScope.failClosed(
        'attendance',
        actor,
        resolved,
        '该资源已启用行级权限但本角色未配置'
      );
    }
    const ctx = await this.dataScope.resolveContext(actor, 'attendance');
    if (resolved.scope === 'self' || resolved.scope === 'custom') {
      return applyScope(hrAttendance.employeeId, resolved, ctx);
    }
    const employeeIds: string[] = await this.dataScope.employeeIdsInDepartments(
      ctx.departmentIds ?? []
    );
    if (employeeIds.length === 0) {
      return this.dataScope.failClosed(
        'attendance',
        actor,
        resolved,
        'actor 未绑定部门或部门下无员工'
      );
    }
    return inArray(hrAttendance.employeeId, employeeIds);
  }

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
      ssCityCode: row.ssCityCode ?? null,
      ssBase: row.ssBase != null ? Number(row.ssBase) : null,
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

  async listEmployees(
    keyword?: string,
    options?: { maskPhone?: boolean; actor?: RequestActor },
  ): Promise<Employee[]> {
    // S4：与主数据搜索同一修法 —— 转义 `%`/`_` 并显式 `ESCAPE`。
    // 原实现 `%${keyword}%` 让 `keyword=%` 匹配全表，绕过"搜索"语义枚举员工。
    const keywordPattern = likeContains(keyword);
    const keywordWhere: SQL | undefined = keywordPattern
      ? or(
          ilikeEscaped(mdEmployee.name, keywordPattern),
          ilikeEscaped(mdEmployee.code, keywordPattern)
        )
      : undefined;
    // B-02：行级可见范围在 SQL 层注入（部门经理仅本部门及下级）
    const scopeWhere: SQL | undefined = await this.employeeScopeCondition(
      options?.actor
    );
    const where: SQL | undefined =
      keywordWhere && scopeWhere
        ? and(keywordWhere, scopeWhere)
        : (keywordWhere ?? scopeWhere);
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
        ssCityCode: mdEmployee.ssCityCode,
        ssBase: mdEmployee.ssBase,
      })
      .from(mdEmployee)
      .leftJoin(hrDepartment, eq(mdEmployee.departmentId, hrDepartment.id))
      .leftJoin(hrPosition, eq(mdEmployee.positionId, hrPosition.id))
      .leftJoin(mdSupplier, eq(mdEmployee.supplierId, mdSupplier.id))
      .where(where)
      .orderBy(desc(mdEmployee.createdAt));
    return rows.map((row: EmployeeRow) => {
      const emp = this.toEmployee(row);
      if (options?.maskPhone && emp.phone) {
        emp.phone = maskPhoneNumber(emp.phone);
      }
      return emp;
    });
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
          ...(dto.ssCityCode ? { ssCityCode: dto.ssCityCode } : {}),
          ...(dto.ssBase != null ? { ssBase: String(dto.ssBase) } : {}),
        })
        .returning({ id: mdEmployee.id });
      return await this.getEmployeeById(inserted[0].id);
    } catch (error) {
      if (extractPostgresErrorCode(error) === '23505') {
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
    if (dto.ssCityCode !== undefined) {
      patch.ssCityCode = dto.ssCityCode === '' ? null : dto.ssCityCode;
    }
    if (dto.ssBase !== undefined) {
      patch.ssBase = dto.ssBase === null ? null : String(dto.ssBase);
    }
    try {
      const rows = await this.db
        .update(mdEmployee)
        .set(patch)
        .where(eq(mdEmployee.id, id))
        .returning({ id: mdEmployee.id });
      if (rows.length === 0) throw new NotFoundException('员工不存在');
    } catch (error) {
      if (extractPostgresErrorCode(error) === '23505') {
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
        ssCityCode: mdEmployee.ssCityCode,
        ssBase: mdEmployee.ssBase,
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

  /* ========== 考勤 ========== */

  async listAttendance(
    month: string,
    employeeId?: string,
    actor?: RequestActor
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
    // B-02：考勤的行级可见范围（SQL 层，非 UI 隐藏）
    const scopeWhere: SQL | undefined = await this.attendanceScopeCondition(actor);
    if (scopeWhere) conditions.push(scopeWhere);
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
    if (!dto.startDate || !dto.endDate) {
      throw new BadRequestException('请假起止日期必填');
    }
    if (dto.endDate < dto.startDate) {
      throw new BadRequestException('结束日期不得早于开始日期');
    }
    // D-23：天数由服务端按自然日重算，忽略客户端自报
    const startMs = Date.parse(`${dto.startDate}T00:00:00Z`);
    const endMs = Date.parse(`${dto.endDate}T00:00:00Z`);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new BadRequestException('请假日期格式无效');
    }
    const days = Math.floor((endMs - startMs) / 86_400_000) + 1;
    if (!(days > 0)) {
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
    /*
     * B11（§7.2）：**区间重叠校验**。
     *
     * 原实现允许对**同一天**提交多张请假单（比如 6/1–6/3 与 6/2–6/4），
     * 两张都会被批准、`usedDays` 各加一次 —— 但员工实际只休了 4 天，
     * 系统里记了 6 天。这既多扣员工额度（员工会来吵），
     * 又让考勤与请假记录对不上（考勤只认"当天有没有请假"这个事实）。
     *
     * 只与**未驳回**（`pending` / `approved`）的请假单比对：
     * 被驳回/撤销的单不占用日期，否则员工被驳回一次就再也报不了那几天。
     *
     * 有意**只拦同类型**：事假与年假同一天并存是常见且合理的
     * （上午事假、下午年假），跨类型重叠不是错误。
     */
    const overlapping = await this.db
      .select({
        code: hrLeaveRequest.code,
        startDate: hrLeaveRequest.startDate,
        endDate: hrLeaveRequest.endDate,
        status: hrLeaveRequest.status,
      })
      .from(hrLeaveRequest)
      .where(
        and(
          eq(hrLeaveRequest.employeeId, dto.employeeId),
          eq(hrLeaveRequest.leaveType, dto.leaveType),
          inArray(hrLeaveRequest.status, ['pending', 'approved']),
          // 区间相交：已有.start <= 新.end 且 已有.end >= 新.start
          lte(hrLeaveRequest.startDate, dto.endDate),
          gte(hrLeaveRequest.endDate, dto.startDate),
        ),
      )
      .limit(1);
    if (overlapping.length > 0) {
      throw new ConflictException(
        `该员工在 ${dto.startDate} ~ ${dto.endDate} 已存在同类请假单` +
          `（${overlapping[0].code}，${overlapping[0].startDate} ~ ${overlapping[0].endDate}，` +
          `状态 ${overlapping[0].status ?? 'pending'}）；` +
          `请先撤销该单，或调整本次请假的起止日期`
      );
    }
    if (remaining < days) {
      throw new BadRequestException(
        `请假余额不足：剩余 ${remaining} 天，申请 ${days} 天`
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
        days: String(days),
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
        .where(
          and(
            eq(hrLeaveRequest.id, id),
            eq(hrLeaveRequest.status, 'pending'),
          ),
        )
        .returning({ id: hrLeaveRequest.id });
      if (updated.length === 0) {
        throw new ConflictException('该请假单已被处理，请刷新后重试');
      }
      return this.getLeaveRequestById(id);
    }
    const year: string = String(request.startDate ?? '').slice(0, 4);
    const daysNum = Number(request.days ?? 0);
    if (!(daysNum > 0)) {
      throw new BadRequestException('请假天数无效，无法审批');
    }
    const days: string = String(daysNum);
    await this.db.transaction(async (tx) => {
      // F4X-21：先锁余额行，校验剩余天数，再 CAS 更新请假单与 usedDays
      const balanceRows = await tx
        .select({
          id: hrLeaveBalance.id,
          totalDays: hrLeaveBalance.totalDays,
          usedDays: hrLeaveBalance.usedDays,
        })
        .from(hrLeaveBalance)
        .where(
          and(
            eq(hrLeaveBalance.employeeId, request.employeeId ?? ''),
            eq(hrLeaveBalance.leaveType, request.leaveType ?? ''),
            eq(hrLeaveBalance.year, year),
          ),
        )
        .for('update');
      if (balanceRows.length === 0) {
        throw new BadRequestException('请假余额记录不存在，审批失败');
      }
      const total = Number(balanceRows[0].totalDays ?? 0);
      const used = Number(balanceRows[0].usedDays ?? 0);
      /*
       * B11（§7.2）：**待审批的请假必须一并占用额度**。
       *
       * 原实现只用 `usedDays`（已批准天数）算剩余。于是：
       *   · 员工剩余 5 天，先后提交 3 天 + 3 天两笔请假（都还是 pending）；
       *   · 第一笔审批通过 → used = 3，剩余 2；
       *   · 第二笔审批 → 3 > 2 → **被拒**。
       * 从员工视角这是"我明明按剩余额度提交的，为什么第二笔不批" ——
       * 而根因是第一笔提交时**没有占用额度**。
       *
       * 因此把同员工 + 同类型 + 同年度、状态为 `pending` 的**其他**请假单
       * 天数也扣掉。注意排除本次这一单（它自己即将变成 approved，
       * 不排除就会把它扣两次）。
       *
       * 并发：余额行已被 `FOR UPDATE` 锁定，因此这里的 pending 查询
       * 在同一余额行上是串行的 —— 两个并发审批不会各自看到"对方未占用"。
       */
      const pendingRows = await tx
        .select({
          days: hrLeaveRequest.days,
          id: hrLeaveRequest.id,
          startDate: hrLeaveRequest.startDate,
        })
        .from(hrLeaveRequest)
        .where(
          and(
            eq(hrLeaveRequest.employeeId, request.employeeId ?? ''),
            eq(hrLeaveRequest.leaveType, request.leaveType ?? ''),
            eq(hrLeaveRequest.status, 'pending'),
          ),
        );
      let pendingDays = 0;
      for (const row of pendingRows) {
        if (row.id === id) continue;
        // 只算同一年的（余额是按年分档的，跨年的 pending 不该占今年的额度）
        if (String(row.startDate ?? '').slice(0, 4) !== year) continue;
        pendingDays += Number(row.days ?? 0);
      }
      const remaining = total - used - pendingDays;
      if (daysNum > remaining + 1e-9) {
        throw new BadRequestException(
          `请假余额不足：总额度 ${total} 天，已批准 ${used} 天，` +
            `待审批占用 ${pendingDays} 天，可批 ${round2(remaining)} 天，本次申请 ${daysNum} 天。` +
            `请先处理其他待审批的请假单，或调整本次天数`
        );
      }
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
        throw new ConflictException('该请假单已被处理，请刷新后重试');
      }
      const balances = await tx
        .update(hrLeaveBalance)
        .set({
          usedDays: sql`${hrLeaveBalance.usedDays} + ${days}::numeric`,
          updatedAt: new Date(),
        })
        .where(eq(hrLeaveBalance.id, balanceRows[0].id))
        .returning({ id: hrLeaveBalance.id });
      if (balances.length === 0) {
        throw new BadRequestException('请假余额更新失败');
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
