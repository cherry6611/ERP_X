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
import { CanRole, NeedLogin } from '@server/platform';
import type { Request } from 'express';
import { HrRead } from '@server/common/auth/read-roles';
import { actorFromRequest } from '@server/common/auth/actor';
import {
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { HrPayService } from './hr-pay.service';
import type {
  AddTrainingAttendeesDto as IAddTrainingAttendeesDto,
  AppraisalItem,
  Candidate,
  CreateAppraisalDto as ICreateAppraisalDto,
  CreateCandidateDto as ICreateCandidateDto,
  CreatePayrollDto as ICreatePayrollDto,
  CreateRecruitReqDto as ICreateRecruitReqDto,
  CreateTrainingDto as ICreateTrainingDto,
  PayrollItem,
  RecruitReq,
  Training,
} from '@shared/api.interface';

class CreatePayrollDto implements ICreatePayrollDto {
  @IsString()
  employeeId!: string;
  @IsString()
  period!: string;
  @IsNumber()
  baseSalary!: number;
  @IsOptional()
  @IsNumber()
  perfSalary?: number;
  @IsOptional()
  @IsNumber()
  allowance?: number;
  @IsOptional()
  @IsNumber()
  socialInsurance?: number;
  @IsOptional()
  @IsNumber()
  housingFund?: number;
  @IsOptional()
  @IsNumber()
  tax?: number;
  @IsOptional()
  @IsString()
  remark?: string;
}

class PayrollActionBody {
  @IsString()
  @IsIn(['submit', 'approve', 'reject'])
  action!: 'submit' | 'approve' | 'reject';
}

class CreateRecruitReqDto implements ICreateRecruitReqDto {
  @IsString()
  title!: string;
  @IsOptional()
  @IsString()
  departmentId?: string;
  @IsOptional()
  @IsNumber()
  headcount?: number;
  @IsOptional()
  @IsString()
  remark?: string;
}

class CreateCandidateDto implements ICreateCandidateDto {
  @IsString()
  recruitReqId!: string;
  @IsString()
  name!: string;
  @IsOptional()
  @IsString()
  phone?: string;
  @IsOptional()
  @IsString()
  remark?: string;
}

class CandidateActionBody {
  @IsString()
  @IsIn(['interview', 'offer', 'hired', 'rejected'])
  action!: 'interview' | 'offer' | 'hired' | 'rejected';
}

class CreateAppraisalDto implements ICreateAppraisalDto {
  @IsString()
  employeeId!: string;
  @IsString()
  period!: string;
  @IsNumber()
  score!: number;
  @IsOptional()
  @IsString()
  grade?: string;
  @IsOptional()
  @IsString()
  remark?: string;
}

class AppraisalActionBody {
  @IsString()
  @IsIn(['confirm'])
  action!: 'confirm';
}

class CreateTrainingDto implements ICreateTrainingDto {
  @IsString()
  name!: string;
  @IsOptional()
  @IsString()
  trainer?: string;
  @IsOptional()
  @IsNumber()
  hours?: number;
  @IsOptional()
  @IsString()
  startDate?: string;
  @IsOptional()
  @IsString()
  endDate?: string;
  @IsOptional()
  @IsString()
  remark?: string;
}

class AddTrainingAttendeesDto implements IAddTrainingAttendeesDto {
  @IsString()
  trainingId!: string;
  @IsArray()
  @IsString({ each: true })
  employeeIds!: string[];
}

class TrainingActionBody {
  @IsString()
  @IsIn(['finish'])
  action!: 'finish';
}

@NeedLogin()
@Controller('api/hr')
export class HrPayController {
  constructor(private readonly hrPayService: HrPayService) {}

  @HrRead()
  @Get('payrolls')
  async listPayrolls(
    @Query('period') period?: string,
    @Query('status') status?: string
  ): Promise<PayrollItem[]> {
    return this.hrPayService.listPayrolls(period, status);
  }

  @Get('my/payrolls')
  async listMyPayrolls(
    @Req() req: Request,
    @Query('period') period?: string,
    @Query('status') status?: string
  ): Promise<PayrollItem[]> {
    const actor = actorFromRequest(req);
    return this.hrPayService.listMyPayrolls(actor.userId, period, status);
  }

  @CanRole(['admin'])
  @Post('payrolls')
  async createPayroll(@Body() dto: CreatePayrollDto): Promise<PayrollItem> {
    return this.hrPayService.createPayroll(dto);
  }

  @CanRole(['admin'])
  @Post('payrolls/:id/actions')
  async payrollAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PayrollActionBody
  ): Promise<PayrollItem> {
    return this.hrPayService.payrollAction(id, body.action);
  }

  @Get('recruit-reqs')
  async listRecruitReqs(): Promise<RecruitReq[]> {
    return this.hrPayService.listRecruitReqs();
  }

  @CanRole(['admin'])
  @Post('recruit-reqs')
  async createRecruitReq(
    @Body() dto: CreateRecruitReqDto
  ): Promise<RecruitReq> {
    return this.hrPayService.createRecruitReq(dto);
  }

  @HrRead()
  @Get('candidates')
  async listCandidates(
    @Query('reqId') reqId?: string
  ): Promise<Candidate[]> {
    return this.hrPayService.listCandidates(reqId);
  }

  @CanRole(['admin'])
  @Post('candidates')
  async createCandidate(
    @Body() dto: CreateCandidateDto
  ): Promise<Candidate> {
    return this.hrPayService.createCandidate(dto);
  }

  @CanRole(['admin'])
  @Post('candidates/:id/actions')
  async candidateAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CandidateActionBody
  ): Promise<Candidate> {
    return this.hrPayService.candidateAction(id, body.action);
  }

  @HrRead()
  @Get('appraisals')
  async listAppraisals(
    @Query('period') period?: string
  ): Promise<AppraisalItem[]> {
    return this.hrPayService.listAppraisals(period);
  }

  @CanRole(['admin'])
  @Post('appraisals')
  async createAppraisal(
    @Body() dto: CreateAppraisalDto
  ): Promise<AppraisalItem> {
    return this.hrPayService.createAppraisal(dto);
  }

  @CanRole(['admin'])
  @Post('appraisals/:id/actions')
  async appraisalAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AppraisalActionBody
  ): Promise<AppraisalItem> {
    return this.hrPayService.appraisalAction(id, body.action);
  }

  @Get('trainings')
  async listTrainings(): Promise<Training[]> {
    return this.hrPayService.listTrainings();
  }

  @CanRole(['admin'])
  @Post('trainings')
  async createTraining(
    @Body() dto: CreateTrainingDto
  ): Promise<Training> {
    return this.hrPayService.createTraining(dto);
  }

  @CanRole(['admin'])
  @Post('trainings/:id/attendees')
  async addTrainingAttendees(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddTrainingAttendeesDto
  ): Promise<Training> {
    return this.hrPayService.addTrainingAttendees(id, dto);
  }

  @CanRole(['admin'])
  @Post('trainings/:id/actions')
  async trainingAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TrainingActionBody
  ): Promise<Training> {
    return this.hrPayService.trainingAction(id, body.action);
  }
}
