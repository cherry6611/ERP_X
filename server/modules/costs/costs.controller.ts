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
import { CanCapability, CanCapabilityRead, NeedLogin } from '@server/platform';
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
import {
  CreateAllocationDto,
  CreateCostAllocationBatchDto,
  CreateLaborRateDto,
} from './costs.dto';
import type {
  CostAllocation,
  CostAllocationBatchResult,
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
  @IsUUID()
  taxEntityId?: string;

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
    @Req() req: Request,
    @Query('projectId') projectId?: string,
    @Query('costType') costType?: string
  ): Promise<CostItem[]> {
    return this.costsService.listCosts(
      projectId,
      costType,
      actorFromRequest(req)
    );
  }

  /**
   * B10（§6.5.2）：**三个聚合接口此前漏传 actor**。
   *
   * `listCosts` 早已正确注入行级过滤，而这三个方法的签名里根本没有 actor 参数 ——
   * 于是当 `sys_data_scope` 为 `cost` 资源配置了收窄时，**明细被过滤、汇总仍全量**：
   * 既可越权读取，又直接暴露了被隐藏明细的金额（正是 `AGENTS.md:47` 禁止的
   * "只在 UI 隐藏"）。此处补齐 actor，与 `listCosts` 同口径。
   */
  @Get('summary')
  async costSummary(
    @Req() req: Request,
    @Query('projectId') projectId?: string
  ): Promise<CostTypeSummary[]> {
    return this.costsService.costSummary(projectId, actorFromRequest(req));
  }

  @Get('dimension-summary')
  async dimensionSummary(
    @Req() req: Request,
    @Query('dimension') dimension?: string,
    @Query('projectId') projectId?: string
  ): Promise<CostDimensionSummary[]> {
    const dim: CostDimension = COST_DIMENSIONS.includes(
      (dimension ?? 'costType') as CostDimension
    )
      ? ((dimension ?? 'costType') as CostDimension)
      : 'costType';
    return this.costsService.dimensionSummary(
      dim,
      projectId,
      actorFromRequest(req)
    );
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
    @Req() req: Request,
    @Query('projectId') projectId?: string
  ): Promise<Timesheet[]> {
    return this.costsService.listTimesheets(projectId, actorFromRequest(req));
  }

  @CanCapability('self_service')
  @Post('timesheets')
  async createTimesheet(
    @Req() req: Request,
    @Body() dto: CreateTimesheetRequestDto
  ): Promise<Timesheet> {
    return this.costsService.createTimesheet(dto, actorFromRequest(req).userId);
  }

  @CanCapability('self_service')
  @Post('timesheets/:id/action')
  async timesheetAction(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TimesheetActionDto
  ): Promise<Timesheet> {
    return this.costsService.timesheetAction(id, dto.action, actorFromRequest(req));
  }

  @CanCapabilityRead('finance')
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

  /**
   * D-07：一笔公共成本按**权重**分摊到多个项目（作业成本法 ABC 的核心动作）。
   *
   * 金额由服务端用最大余数法计算，保证 Σ amount === 请求的 amount（到分）——
   * 手工拆 N 笔极易出现合计差 1 分，而分摊合计与被分摊总额不等会让凭证不平。
   */
  @CanCapability('projects_write')
  @Post('allocations/batch')
  async createAllocationBatch(
    @Body() dto: CreateCostAllocationBatchDto
  ): Promise<CostAllocationBatchResult> {
    return this.costsService.createAllocationBatch(dto);
  }
}
