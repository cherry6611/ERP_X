import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CanRole, NeedLogin } from '@server/platform';
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
import type {
  BudgetExecution,
  BudgetItem,
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
  constructor(private readonly finBudgetService: FinBudgetService) {}

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

  @CanRole(['admin'])
  @Post('budgets')
  async createBudget(@Body() dto: CreateBudgetDto): Promise<BudgetItem> {
    return this.finBudgetService.createBudget(dto);
  }

  @CanRole(['admin'])
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
}
