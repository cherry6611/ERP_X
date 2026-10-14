import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CanCapability, NeedLogin } from '@server/platform';
import { HrRead } from '@server/common/auth/read-roles';
import { actorFromRequest } from '@server/common/auth/actor';
import { IsDateString, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Min, MinLength } from 'class-validator';
import { HrCoreService } from './hr-core.service';
import type { SetEntityStatusDto as ISetEntityStatusDto } from '@shared/api.interface';
import type {
  AttendanceRecord,
  CreateDepartmentDto as ICreateDepartmentDto,
  CreateEmployeeDto as ICreateEmployeeDto,
  CreateLeaveRequestDto as ICreateLeaveRequestDto,
  CreatePositionDto as ICreatePositionDto,
  Department,
  Employee,
  LeaveBalance,
  LeaveRequest,
  Position,
  SetLeaveBalanceDto as ISetLeaveBalanceDto,
  UpdateDepartmentDto as IUpdateDepartmentDto,
  UpdateEmployeeDto as IUpdateEmployeeDto,
  UpdatePositionDto as IUpdatePositionDto,
  UpsertAttendanceDto as IUpsertAttendanceDto,
} from '@shared/api.interface';

export class CreateDepartmentDto implements ICreateDepartmentDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class UpdateDepartmentDto implements IUpdateDepartmentDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class CreatePositionDto implements ICreatePositionDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  roleName?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class UpdatePositionDto implements IUpdatePositionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  roleName?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class CreateEmployeeDto implements ICreateEmployeeDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsUUID()
  positionId?: string;

  @IsOptional()
  @IsDateString()
  hireDate?: string;

  @IsOptional()
  @IsString()
  employmentType?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  remark?: string;

  @IsOptional()
  @IsString()
  platformUserId?: string;

  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @IsString()
  ssCityCode?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  ssBase?: number;
}

export class UpdateEmployeeDto implements IUpdateEmployeeDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsUUID()
  positionId?: string;

  @IsOptional()
  @IsDateString()
  hireDate?: string;

  @IsOptional()
  @IsString()
  employmentType?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsDateString()
  resignDate?: string;

  /** 飞书账号绑定（miaoda user_id）；传空字符串表示清空绑定 */
  @IsOptional()
  @IsString()
  platformUserId?: string | null;

  @IsOptional()
  @IsUUID()
  supplierId?: string | null;

  @IsOptional()
  @IsString()
  ssCityCode?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  ssBase?: number | null;
}

export class UpsertAttendanceDto implements IUpsertAttendanceDto {
  @IsUUID()
  employeeId!: string;

  @IsDateString()
  workDate!: string;

  @IsString()
  @IsIn(['present', 'absent', 'late', 'leave'])
  status!: 'present' | 'absent' | 'late' | 'leave';

  @IsOptional()
  @IsString()
  remark?: string;
}

export class SetLeaveBalanceDto implements ISetLeaveBalanceDto {
  @IsUUID()
  employeeId!: string;

  @IsString()
  @IsIn(['annual', 'sick', 'personal'])
  leaveType!: 'annual' | 'sick' | 'personal';

  @IsString()
  @MinLength(4)
  year!: string;

  @IsNumber()
  @Min(0)
  totalDays!: number;
}

export class CreateLeaveRequestDto implements ICreateLeaveRequestDto {
  @IsUUID()
  employeeId!: string;

  @IsString()
  @IsIn(['annual', 'sick', 'personal'])
  leaveType!: 'annual' | 'sick' | 'personal';

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsNumber()
  days!: number;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class LeaveRequestActionDto {
  @IsString()
  @IsIn(['approve', 'reject'])
  action!: 'approve' | 'reject';
}

export class SetEntityStatusBodyDto implements ISetEntityStatusDto {
  @IsIn(['active', 'inactive'], { message: '状态仅支持 active / inactive' })
  status!: 'active' | 'inactive';
}

@NeedLogin()
@Controller('api/hr')
export class HrCoreController {
  constructor(private readonly hrCoreService: HrCoreService) {}

  @Get('departments')
  async listDepartments(): Promise<Department[]> {
    return this.hrCoreService.listDepartments();
  }

  @CanCapability('hr_write')
  @Post('departments')
  async createDepartment(
    @Body() dto: CreateDepartmentDto
  ): Promise<Department> {
    return this.hrCoreService.createDepartment(dto);
  }

  @CanCapability('hr_write')
  @Patch('departments/:id')
  async updateDepartment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDepartmentDto
  ): Promise<Department> {
    return this.hrCoreService.updateDepartment(id, dto);
  }

  @Get('positions')
  async listPositions(): Promise<Position[]> {
    return this.hrCoreService.listPositions();
  }

  @CanCapability('hr_write')
  @Post('positions')
  async createPosition(
    @Body() dto: CreatePositionDto
  ): Promise<Position> {
    return this.hrCoreService.createPosition(dto);
  }

  @CanCapability('hr_write')
  @Patch('positions/:id')
  async updatePosition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePositionDto
  ): Promise<Position> {
    return this.hrCoreService.updatePosition(id, dto);
  }

  @HrRead()
  @Get('employees')
  async listEmployees(
    @Req() req: Request,
    @Query('keyword') keyword?: string,
  ): Promise<Employee[]> {
    const roles = req.userContext?.roles ?? [];
    const canSeePhone = roles.some((r) => r === 'admin' || r === 'hr_manager');
    // B-02：数据级权限按登录用户解析（部门经理仅本部门及下级）
    return this.hrCoreService.listEmployees(keyword, {
      maskPhone: !canSeePhone,
      actor: actorFromRequest(req),
    });
  }

  @Get('employees/me')
  async getMyEmployee(@Req() req: Request): Promise<Employee | null> {
    const userId: string | undefined = req.userContext?.userId;
    if (!userId) return null;
    return this.hrCoreService.findEmployeeByPlatformUser(userId);
  }

  @CanCapability('hr_write')
  @Post('employees')
  async createEmployee(@Body() dto: CreateEmployeeDto): Promise<Employee> {
    return this.hrCoreService.createEmployee(dto);
  }

  @CanCapability('hr_write')
  @Patch('employees/:id')
  async updateEmployee(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmployeeDto
  ): Promise<Employee> {
    return this.hrCoreService.updateEmployee(id, dto);
  }

  @CanCapability('hr_write')
  @Patch('employees/:id/status')
  async setEmployeeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SetEntityStatusBodyDto
  ): Promise<Employee> {
    return this.hrCoreService.setEmployeeStatus(id, body.status);
  }

  @HrRead()
  @Get('attendance')
  async listAttendance(
    @Req() req: Request,
    @Query('month') month: string,
    @Query('employeeId') employeeId?: string
  ): Promise<AttendanceRecord[]> {
    // B-02：考勤的行级可见范围（SQL 层）
    return this.hrCoreService.listAttendance(
      month,
      employeeId,
      actorFromRequest(req)
    );
  }

  /** F4X-2：员工自助 — 仅本人考勤 */
  @Get('my/attendance')
  async listMyAttendance(
    @Req() req: Request,
    @Query('month') month: string,
  ): Promise<AttendanceRecord[]> {
    const userId = req.userContext?.userId;
    if (!userId) throw new BadRequestException('未登录');
    const me = await this.hrCoreService.findEmployeeByPlatformUser(userId);
    if (!me) return [];
    return this.hrCoreService.listAttendance(month, me.id);
  }

  @CanCapability('hr_write')
  @Post('attendance')
  async upsertAttendance(
    @Body() dto: UpsertAttendanceDto
  ): Promise<AttendanceRecord> {
    return this.hrCoreService.upsertAttendance(dto);
  }

  @HrRead()
  @Get('leave-balances')
  async listLeaveBalances(
    @Query('year') year?: string
  ): Promise<LeaveBalance[]> {
    return this.hrCoreService.listLeaveBalances(year);
  }

  /** F4X-2：员工自助 — 仅本人假期余额 */
  @Get('my/leave-balances')
  async listMyLeaveBalances(
    @Req() req: Request,
    @Query('year') year?: string,
  ): Promise<LeaveBalance[]> {
    const userId = req.userContext?.userId;
    if (!userId) throw new BadRequestException('未登录');
    const me = await this.hrCoreService.findEmployeeByPlatformUser(userId);
    if (!me) return [];
    const all = await this.hrCoreService.listLeaveBalances(year);
    return all.filter((b) => b.employeeId === me.id);
  }

  @CanCapability('hr_write')
  @Post('leave-balances')
  async setLeaveBalance(
    @Body() dto: SetLeaveBalanceDto
  ): Promise<LeaveBalance> {
    return this.hrCoreService.setLeaveBalance(dto);
  }

  @HrRead()
  @Get('leave-requests')
  async listLeaveRequests(
    @Query('status') status?: string,
    @Query('employeeId') employeeId?: string
  ): Promise<LeaveRequest[]> {
    return this.hrCoreService.listLeaveRequests(status, employeeId);
  }

  /** F4X-2：员工自助 — 仅本人请假单 */
  @Get('my/leave-requests')
  async listMyLeaveRequests(
    @Req() req: Request,
    @Query('status') status?: string,
  ): Promise<LeaveRequest[]> {
    const userId = req.userContext?.userId;
    if (!userId) throw new BadRequestException('未登录');
    const me = await this.hrCoreService.findEmployeeByPlatformUser(userId);
    if (!me) return [];
    return this.hrCoreService.listLeaveRequests(status, me.id);
  }

  @Post('leave-requests')
  async createLeaveRequest(
    @Req() req: Request,
    @Body() dto: CreateLeaveRequestDto
  ): Promise<LeaveRequest> {
    // D-23：非 HR/admin 只能为自己请假
    const roles = req.userContext?.roles ?? [];
    const isHr =
      roles.includes('admin') || roles.includes('hr_manager');
    if (!isHr) {
      const userId = req.userContext?.userId;
      if (!userId) throw new BadRequestException('未登录');
      const me = await this.hrCoreService.findEmployeeByPlatformUser(userId);
      if (!me) {
        throw new BadRequestException('当前账号未绑定员工档案，无法请假');
      }
      dto.employeeId = me.id;
    }
    return this.hrCoreService.createLeaveRequest(dto);
  }

  @CanCapability('hr_write')
  @Post('leave-requests/:id/actions')
  async handleLeaveRequestAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LeaveRequestActionDto
  ): Promise<LeaveRequest> {
    return this.hrCoreService.handleLeaveRequestAction(id, dto.action);
  }
}

/** 员工/客户/供应商启停入参（class DTO：状态值白名单，避免任意字符串落库） */
