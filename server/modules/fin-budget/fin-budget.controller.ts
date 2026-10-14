import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CanCapability, CanCapabilityRead, NeedLogin } from '@server/platform';
import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  MinLength,
} from 'class-validator';
import { FinBudgetService } from './fin-budget.service';
import { BudgetCommitmentService } from './budget-commitment.service';
import { BudgetForecastService } from './budget-forecast.service';
import { BUDGET_TYPES, type BudgetType } from './budget-forecast-rules';
import type {
  BudgetCommitmentSummary,
  BudgetForecastResult,
  BudgetExecution,
  BudgetItem,
  CommitmentGapRow,
  FullBudgetOverview,
  CreateBudgetDto as ICreateBudgetDto,
  PagedResult,
  UpdateBudgetDto as IUpdateBudgetDto,
} from '@shared/api.interface';

export class CreateBudgetDto implements ICreateBudgetDto {
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsString()
  @MinLength(1)
  expenseCategory!: string;

  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  period!: string;

  @IsNumber()
  @Min(0)
  budgetAmount!: number;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class UpdateBudgetDto implements IUpdateBudgetDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  budgetAmount?: number;

  @IsOptional()
  @IsString()
  remark?: string;
}

@NeedLogin()
@Controller('api/fin-budget')
export class FinBudgetController {
  constructor(
    private readonly finBudgetService: FinBudgetService,
    private readonly budgetCommitmentService: BudgetCommitmentService,
    private readonly budgetForecastService: BudgetForecastService
  ) {}

  @Get('budgets')
  async listBudgets(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('period') period?: string,
    @Query('projectId') projectId?: string,
    @Query('departmentId') departmentId?: string
  ): Promise<PagedResult<BudgetItem>> {
    return this.finBudgetService.listBudgets(
      page ? Math.max(1, parseInt(page, 10) || 1) : 1,
      pageSize
        ? Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20))
        : 20,
      period || undefined,
      projectId || undefined,
      departmentId || undefined
    );
  }

  @CanCapability('finance_write')
  @Post('budgets')
  async createBudget(@Body() dto: CreateBudgetDto): Promise<BudgetItem> {
    return this.finBudgetService.createBudget(dto);
  }

  @CanCapability('finance_write')
  @Patch('budgets/:id')
  async updateBudget(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBudgetDto
  ): Promise<BudgetItem> {
    return this.finBudgetService.updateBudget(id, dto);
  }

  @Get('executions')
  async listExecutions(): Promise<BudgetExecution[]> {
    return this.finBudgetService.listExecutions();
  }

  /* ========== C-09 预算承诺与三算对比 ========== */

  /**
   * 三算对比：预算 − 承诺 − 实际。
   *
   * 承诺 = 已批准采购订单 + 已生效合同净额 + 待批费用申请；
   * 实际 = 已批准报销 + 已批准费用申请。
   * `overCommitted` 标记"钱还没付但已超预算"的行，是这份报表的核心价值。
   */
  @Get('commitments')
  async commitments(
    @Query('period') period?: string
  ): Promise<BudgetCommitmentSummary> {
    if (period && !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      throw new BadRequestException('period 必须为 YYYY-MM');
    }
    return this.budgetCommitmentService.summary(
      period ? { period } : undefined
    );
  }

  /** 孤儿承诺：没有任何预算覆盖的承诺（三算表里看不到，风险最高） */
  @Get('commitment-gaps')
  async commitmentGaps(
    @Query('period') period?: string
  ): Promise<CommitmentGapRow[]> {
    return this.budgetCommitmentService.gaps(
      period ? { period } : undefined
    );
  }

  /* ========== D-05 全面预算：滚动预测与差异分析 ========== */

  /**
   * 全面预算总览：费用/收入/资本三类预算的滚动预测 + 费用率联动 + 差异 + CAPEX 分析。
   *
   * 一次返回三类的原因：**费用率必须同时看收入与费用**，分两次请求会因
   * 期间/过滤条件不一致而算错费用率。
   */
  @CanCapabilityRead('finance')
  @Get('full-overview')
  async fullOverview(
    @Query('year') year?: string,
    @Query('asOf') asOf?: string,
    @Query('projectId') projectId?: string,
    @Query('departmentId') departmentId?: string
  ): Promise<FullBudgetOverview> {
    return this.budgetForecastService.overview({
      year: this.assertBudgetYear(year),
      asOf: asOf || undefined,
      projectId: projectId || undefined,
      departmentId: departmentId || undefined,
    });
  }

  /** 单类型滚动预测（费用/收入/资本） */
  @CanCapabilityRead('finance')
  @Get('forecast')
  async forecast(
    @Query('year') year?: string,
    @Query('budgetType') budgetType?: string,
    @Query('asOf') asOf?: string,
    @Query('projectId') projectId?: string,
    @Query('departmentId') departmentId?: string
  ): Promise<BudgetForecastResult> {
    if (!BUDGET_TYPES.includes(budgetType as BudgetType)) {
      throw new BadRequestException(
        `budgetType 仅支持 ${BUDGET_TYPES.join(' / ')}`
      );
    }
    return this.budgetForecastService.forecast({
      year: this.assertBudgetYear(year),
      budgetType: budgetType as BudgetType,
      asOf: asOf || undefined,
      projectId: projectId || undefined,
      departmentId: departmentId || undefined,
    });
  }

  /** 会计年度校验：只接受 YYYY，缺省用当前业务年度 */
  private assertBudgetYear(year?: string): string {
    if (!year) {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
      }).format(new Date());
    }
    if (!/^\d{4}$/.test(year)) {
      throw new BadRequestException('year 必须为 YYYY');
    }
    return year;
  }
}
