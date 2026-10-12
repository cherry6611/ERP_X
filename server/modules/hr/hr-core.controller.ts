import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CanRole, NeedLogin } from '@server/platform';
import { IsDateString, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Min, MinLength } from 'class-validator';
import { HrCoreService } from './hr-core.service';
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

@NeedLogin()
@Controller('api/hr')
export class HrCoreController {
  constructor(private readonly hrCoreService: HrCoreService) {}

  @Get('departments')
  async listDepartments(): Promise<Department[]> {
    return this.hrCoreService.listDepartments();
  }

  @CanRole(['admin'])
  @Post('departments')
  async createDepartment(
    @Body() dto: CreateDepartmentDto
  ): Promise<Department> {
    return this.hrCoreService.createDepartment(dto);
  }

  @CanRole(['admin'])
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

  @CanRole(['admin'])
  @Post('positions')
  async createPosition(
    @Body() dto: CreatePositionDto
  ): Promise<Position> {
    return this.hrCoreService.createPosition(dto);
  }

  @CanRole(['admin'])
  @Patch('positions/:id')
  async updatePosition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePositionDto
  ): Promise<Position> {
    return this.hrCoreService.updatePosition(id, dto);
  }

  @Get('employees')
  async listEmployees(@Query('keyword') keyword?: string): Promise<Employee[]> {
    return this.hrCoreService.listEmployees(keyword);
  }

  @Get('employees/me')
  async getMyEmployee(@Req() req: Request): Promise<Employee | null> {
    const userId: string | undefined = req.userContext?.userId;
    if (!userId) return null;
    return this.hrCoreService.findEmployeeByPlatformUser(userId);
  }

  @CanRole(['admin'])
  @Post('employees')
  async createEmployee(@Body() dto: CreateEmployeeDto): Promise<Employee> {
    return this.hrCoreService.createEmployee(dto);
  }

  @CanRole(['admin'])
  @Patch('employees/:id')
  async updateEmployee(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmployeeDto
  ): Promise<Employee> {
    return this.hrCoreService.updateEmployee(id, dto);
  }

  @Get('attendance')
  async listAttendance(
    @Query('month') month: string,
    @Query('employeeId') employeeId?: string
  ): Promise<AttendanceRecord[]> {
    return this.hrCoreService.listAttendance(month, employeeId);
  }

  @CanRole(['admin'])
  @Post('attendance')
  async upsertAttendance(
    @Body() dto: UpsertAttendanceDto
  ): Promise<AttendanceRecord> {
    return this.hrCoreService.upsertAttendance(dto);
  }

  @Get('leave-balances')
  async listLeaveBalances(
    @Query('year') year?: string
  ): Promise<LeaveBalance[]> {
    return this.hrCoreService.listLeaveBalances(year);
  }

  @CanRole(['admin'])
  @Post('leave-balances')
  async setLeaveBalance(
    @Body() dto: SetLeaveBalanceDto
  ): Promise<LeaveBalance> {
    return this.hrCoreService.setLeaveBalance(dto);
  }

  @Get('leave-requests')
  async listLeaveRequests(
    @Query('status') status?: string,
    @Query('employeeId') employeeId?: string
  ): Promise<LeaveRequest[]> {
    return this.hrCoreService.listLeaveRequests(status, employeeId);
  }

  @Post('leave-requests')
  async createLeaveRequest(
    @Body() dto: CreateLeaveRequestDto
  ): Promise<LeaveRequest> {
    return this.hrCoreService.createLeaveRequest(dto);
  }

  @CanRole(['admin'])
  @Post('leave-requests/:id/actions')
  async handleLeaveRequestAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LeaveRequestActionDto
  ): Promise<LeaveRequest> {
    return this.hrCoreService.handleLeaveRequestAction(id, dto.action);
  }
}
