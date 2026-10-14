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
import { CanCapability, NeedLogin } from '@server/platform';
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
import type {
  BudgetCommitmentSummary,
  BudgetExecution,
  BudgetItem,
  CommitmentGapRow,
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
    private readonly budgetCommitmentService: BudgetCommitmentService
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
}
