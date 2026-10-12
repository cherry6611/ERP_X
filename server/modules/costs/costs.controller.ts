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
import { actorFromRequest } from '@server/common/auth/actor';
import { IsIn, IsNumber, IsOptional, IsString } from 'class-validator';
import { CostsService } from './costs.service';
import type {
  CostAllocation,
  CostDimension,
  CostDimensionSummary,
  CostItem,
  CostTypeSummary,
  CreateAllocationDto,
  CreateCostDto,
  CreateLaborRateDto,
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

export class TimesheetActionDto {
  @IsString()
  @IsIn(['submit', 'confirm', 'reject'])
  action!: 'submit' | 'confirm' | 'reject';
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

  @CanRole(['admin'])
  @Post()
  async createCost(@Body() dto: CreateCostDto): Promise<CostItem> {
    return this.costsService.createCost(dto);
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

  @CanRole(['admin'])
  @Post('labor-rates')
  async createLaborRate(
    @Body() dto: CreateLaborRateDto
  ): Promise<LaborRate> {
    return this.costsService.createLaborRate(dto);
  }

  @CanRole(['admin'])
  @Post('allocations')
  async createAllocation(
    @Body() dto: CreateAllocationDto
  ): Promise<CostAllocation> {
    return this.costsService.createAllocation(dto);
  }
}
