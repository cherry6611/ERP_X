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
import { CanCapability, NeedLogin } from '@server/platform';
import { actorFromRequest } from '@server/common/auth/actor';
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { CostsService } from './costs.service';
import { CreateAllocationDto, CreateLaborRateDto } from './costs.dto';
import type {
  CostAllocation,
  CostDimension,
  CostDimensionSummary,
  CostItem,
  CostTypeSummary,
  CreateCostDto,
  CreateTimesheetDto,
  LaborRate,
  Timesheet,
} from '@shared/api.interface';

const COST_DIMENSIONS: CostDimension[] = [
  'costType',
  'department',
  'contract',
  'period',
];

const COST_TYPES = [
  'labor',
  'outsource',
  'compute',
  'storage',
  'tool',
  'travel',
  'flex_labor',
] as const;

export class TimesheetActionDto {
  @IsString()
  @IsIn(['submit', 'confirm', 'reject'])
  action!: 'submit' | 'confirm' | 'reject';
}

export class CreateCostBodyDto implements CreateCostDto {
  @IsUUID()
  projectId!: string;

  @IsString()
  @IsIn([...COST_TYPES])
  costType!: CreateCostDto['costType'];

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsDateString()
  occurredDate?: string;

  @IsString()
  sourceRef!: string;

  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

class CreateTimesheetRequestDto implements CreateTimesheetDto {
  @IsString()
  projectId!: string;

  @IsOptional()
  @IsString()
  employeeId?: string;

  @IsOptional()
  @IsString()
  employeeName?: string;

  @IsOptional()
  @IsString()
  roleName?: string;

  @IsString()
  workDate!: string;

  @IsNumber()
  hours!: number;

  @IsOptional()
  @IsString()
  remark?: string;
}

@NeedLogin()
@Controller('api/costs')
export class CostsController {
  constructor(private readonly costsService: CostsService) {}

  @Get()
  async listCosts(
    @Query('projectId') projectId?: string,
    @Query('costType') costType?: string
  ): Promise<CostItem[]> {
    return this.costsService.listCosts(projectId, costType);
  }

  @Get('summary')
  async costSummary(
    @Query('projectId') projectId?: string
  ): Promise<CostTypeSummary[]> {
    return this.costsService.costSummary(projectId);
  }

  @Get('dimension-summary')
  async dimensionSummary(
    @Query('dimension') dimension?: string,
    @Query('projectId') projectId?: string
  ): Promise<CostDimensionSummary[]> {
    const dim: CostDimension = COST_DIMENSIONS.includes(
      (dimension ?? 'costType') as CostDimension
    )
      ? ((dimension ?? 'costType') as CostDimension)
      : 'costType';
    return this.costsService.dimensionSummary(dim, projectId);
  }

  @CanCapability('projects_write')
  @Post()
  async createCost(@Body() dto: CreateCostBodyDto): Promise<CostItem> {
    return this.costsService.createCost(dto);
  }

  @CanCapability('projects_write')
  @Post(':id/red-flush')
  async redFlush(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<CostItem> {
    return this.costsService.redFlush(id);
  }

  @Get('timesheets')
  async listTimesheets(
    @Query('projectId') projectId?: string
  ): Promise<Timesheet[]> {
    return this.costsService.listTimesheets(projectId);
  }

  @Post('timesheets')
  async createTimesheet(
    @Req() req: Request,
    @Body() dto: CreateTimesheetRequestDto
  ): Promise<Timesheet> {
    return this.costsService.createTimesheet(dto, actorFromRequest(req).userId);
  }

  @Post('timesheets/:id/action')
  async timesheetAction(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TimesheetActionDto
  ): Promise<Timesheet> {
    return this.costsService.timesheetAction(id, dto.action, actorFromRequest(req));
  }

  @Get('labor-rates')
  async listLaborRates(): Promise<LaborRate[]> {
    return this.costsService.listLaborRates();
  }

  @CanCapability('projects_write')
  @Post('labor-rates')
  async createLaborRate(
    @Body() dto: CreateLaborRateDto
  ): Promise<LaborRate> {
    return this.costsService.createLaborRate(dto);
  }

  @CanCapability('projects_write')
  @Post('allocations')
  async createAllocation(
    @Body() dto: CreateAllocationDto
  ): Promise<CostAllocation> {
    return this.costsService.createAllocation(dto);
  }
}
