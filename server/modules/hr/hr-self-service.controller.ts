import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CanRole, NeedLogin } from '@server/platform';
import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { HrSelfServiceService } from './hr-self-service.service';
import { actorFromRequest } from '@server/common/auth/actor';
import { consumeRate } from '@server/common/security/rate-limit';
import type {
  AttendanceAmendment,
  CreateAttendanceAmendmentDto as ICreateAttendanceAmendmentDto,
  InitLeaveBalancesDto as IInitLeaveBalancesDto,
  InitLeaveBalancesResult,
  MyHrSummary,
  OffboardEmployeeDto as IOffboardEmployeeDto,
  OffboardResult,
} from '@shared/api.interface';

export class CreateAttendanceAmendmentDto
  implements ICreateAttendanceAmendmentDto
{
  @IsDateString()
  workDate!: string;

  @IsString()
  @IsNotEmpty()
  reason!: string;
}

export class AttendanceAmendmentActionDto {
  @IsString()
  @IsIn(['approve', 'reject'])
  action!: 'approve' | 'reject';
}

export class InitLeaveBalancesDto implements IInitLeaveBalancesDto {
  @IsString()
  @Matches(/^\d{4}$/, { message: 'year 必须为 4 位年份数字' })
  year!: string;
}

export class OffboardEmployeeDto implements IOffboardEmployeeDto {
  @IsDateString()
  resignDate!: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

@NeedLogin()
@Controller('api/hr')
export class HrSelfServiceController {
  constructor(private readonly hrSelfService: HrSelfServiceService) {}

  @Get('my/summary')
  async getMySummary(@Req() req: Request): Promise<MyHrSummary> {
    const userId: string | undefined = req.userContext?.userId;
    return this.hrSelfService.getMySummary(userId);
  }

  @Get('attendance-amendments')
  async listAmendments(
    @Req() req: Request,
    @Query('status') status?: string
  ): Promise<AttendanceAmendment[]> {
    return this.hrSelfService.listAmendments(status, actorFromRequest(req));
  }

  @Post('attendance-amendments')
  async createAmendment(
    @Req() req: Request,
    @Body() dto: CreateAttendanceAmendmentDto
  ): Promise<AttendanceAmendment> {
    const actor = actorFromRequest(req);
    consumeRate(`amendment:${actor.userId}`, 30, 24 * 60 * 60 * 1000);
    return this.hrSelfService.createAmendment(dto, actor.userId);
  }

  @CanRole(['admin'])
  @Post('attendance-amendments/:id/actions')
  async amendmentAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AttendanceAmendmentActionDto
  ): Promise<AttendanceAmendment> {
    return this.hrSelfService.amendmentAction(id, body.action);
  }

  @CanRole(['admin'])
  @Post('leave-balances/init')
  async initLeaveBalances(
    @Body() dto: InitLeaveBalancesDto
  ): Promise<InitLeaveBalancesResult> {
    return this.hrSelfService.initLeaveBalances(dto.year);
  }

  @CanRole(['admin'])
  @Post('employees/:id/offboard')
  async offboard(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OffboardEmployeeDto
  ): Promise<OffboardResult> {
    return this.hrSelfService.offboard(id, dto);
  }
}
