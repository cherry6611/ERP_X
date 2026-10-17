import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { CanCapability, NeedLogin } from '@server/platform';
import type { Request } from 'express';
import { HrRead } from '@server/common/auth/read-roles';
import { actorFromRequest } from '@server/common/auth/actor';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { HrPayService } from './hr-pay.service';
import { PayrollTaxService } from './payroll-tax.service';
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

/** D-15：社保城市规则必须经 ValidationPipe 校验，禁止负费率/期间倒挂 */
class UpsertCityRuleDto {
  @IsString()
  @MinLength(1)
  cityCode!: string;

  @IsString()
  @MinLength(1)
  cityName!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}$/)
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}$/)
  effectiveTo?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  pensionEmp?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  pensionCo?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  medicalEmp?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  medicalCo?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  unemploymentEmp?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  unemploymentCo?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  housingEmp?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  housingCo?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  baseMin?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  baseMax?: number;
}

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
  @IsBoolean()
  useEngine?: boolean;
  @IsOptional()
  @IsString()
  remark?: string;
}

class PayrollActionBody {
  @IsString()
  /*
   * B12（§7.2）：白名单必须与 `PayrollAction` 联合类型**同步**。
   *
   * 这个 `@IsIn` 是一道真实闸门：只加类型、漏了这里，
   * 前端点「标记发放」会得到 400「action must be one of ...」——
   * 而后端 service 里明明写好了处理分支（甚至已通过 tsc）。
   * 这类"类型对、白名单没跟上"是新增枚举值最常见的漏点，
   * 因此这里显式注释两者必须一起改。
   */
  @IsIn(['submit', 'approve', 'reject', 'pay', 'void'])
  action!: 'submit' | 'approve' | 'reject' | 'pay' | 'void';
}

/** A-07：工资试算入参（class DTO，避免 ValidationPipe 失效） */
class PreviewPayrollDto {
  @IsString()
  @MinLength(1)
  employeeId!: string;

  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period 必须为 YYYY-MM' })
  period!: string;

  @IsNumber()
  @Min(0)
  baseSalary!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  perfSalary?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  allowance?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  taxFreeIncome?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  otherDeduction?: number;
}

/** A-07：专项附加扣除登记入参 */
class UpsertTaxDeductionDto {
  @IsString()
  @MinLength(1)
  employeeId!: string;

  @IsNumber()
  @Min(2000)
  @Max(2100)
  taxYear!: number;

  @IsString()
  @IsIn([
    'child_education',
    'continuing_education',
    'medical',
    'housing_loan',
    'housing_rent',
    'elderly_support',
    'infant_care',
  ])
  deductionType!:
    | 'child_education'
    | 'continuing_education'
    | 'medical'
    | 'housing_loan'
    | 'housing_rent'
    | 'elderly_support'
    | 'infant_care';

  @IsNumber()
  @Min(0.01)
  monthlyAmount!: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(12)
  startMonth?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(12)
  endMonth?: number;

  @IsOptional()
  @IsString()
  remark?: string;
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
  constructor(
    private readonly hrPayService: HrPayService,
    private readonly payrollTaxService: PayrollTaxService,
  ) {}

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

  @CanCapability('hr_write')
  @Post('payrolls')
  async createPayroll(@Body() dto: CreatePayrollDto): Promise<PayrollItem> {
    return this.hrPayService.createPayroll(dto);
  }

  @CanCapability('hr_write')
  @Post('payrolls/preview')
  async previewPayroll(@Body() body: PreviewPayrollDto) {
    return this.hrPayService.previewPayrollEngine(body);
  }

  /* ========== A-07：专项附加扣除登记与年度汇算辅助 ========== */

  @HrRead()
  @Get('tax-deductions')
  listTaxDeductions(
    @Query('employeeId') employeeId?: string,
    @Query('taxYear') taxYear?: string,
    @Query('deductionType') deductionType?: string
  ) {
    return this.payrollTaxService.list({
      employeeId,
      taxYear: taxYear ? Number(taxYear) : undefined,
      deductionType,
    });
  }

  @HrRead()
  @Get('tax-deductions/types')
  listTaxDeductionTypes() {
    return this.payrollTaxService.listTypes();
  }

  @CanCapability('hr_write')
  @Post('tax-deductions')
  upsertTaxDeduction(@Body() body: UpsertTaxDeductionDto) {
    return this.payrollTaxService.upsert(body);
  }

  @CanCapability('hr_write')
  @Post('tax-deductions/:id/delete')
  removeTaxDeduction(@Param('id', ParseUUIDPipe) id: string) {
    return this.payrollTaxService.remove(id);
  }

  /** 年度汇算辅助：导出员工全年累计收入/扣除/已预扣税额 */
  @HrRead()
  @Get('tax-deductions/annual-summary')
  annualTaxSummary(@Query('taxYear') taxYear?: string) {
    const year = taxYear ? Number(taxYear) : new Date().getFullYear();
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('taxYear 必须为 2000~2100 之间的整数');
    }
    return this.payrollTaxService.annualSummary(year);
  }

  @HrRead()
  @Get('ss-city-rules')
  listCityRules() {
    return this.hrPayService.listCityRules();
  }

  @CanCapability('hr_write')
  @Post('ss-city-rules')
  upsertCityRule(@Body() body: UpsertCityRuleDto) {
    if (
      body.effectiveTo &&
      body.effectiveTo < body.effectiveFrom
    ) {
      throw new BadRequestException('生效结束不得早于生效开始');
    }
    if (
      body.baseMin != null &&
      body.baseMax != null &&
      body.baseMin > body.baseMax
    ) {
      throw new BadRequestException('缴费基数下限不得高于上限');
    }
    return this.hrPayService.upsertCityRule(body);
  }

  @CanCapability('hr_write')
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

  @CanCapability('hr_write')
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

  @CanCapability('hr_write')
  @Post('candidates')
  async createCandidate(
    @Body() dto: CreateCandidateDto
  ): Promise<Candidate> {
    return this.hrPayService.createCandidate(dto);
  }

  @CanCapability('hr_write')
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

  @CanCapability('hr_write')
  @Post('appraisals')
  async createAppraisal(
    @Body() dto: CreateAppraisalDto
  ): Promise<AppraisalItem> {
    return this.hrPayService.createAppraisal(dto);
  }

  @CanCapability('hr_write')
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

  @CanCapability('hr_write')
  @Post('trainings')
  async createTraining(
    @Body() dto: CreateTrainingDto
  ): Promise<Training> {
    return this.hrPayService.createTraining(dto);
  }

  @CanCapability('hr_write')
  @Post('trainings/:id/attendees')
  async addTrainingAttendees(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddTrainingAttendeesDto
  ): Promise<Training> {
    return this.hrPayService.addTrainingAttendees(id, dto);
  }

  @CanCapability('hr_write')
  @Post('trainings/:id/actions')
  async trainingAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TrainingActionBody
  ): Promise<Training> {
    return this.hrPayService.trainingAction(id, body.action);
  }
}
