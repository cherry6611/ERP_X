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
import { CanCapability, NeedLogin } from '@server/platform';
import type { Request } from 'express';
import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { FinExpenseService } from './fin-expense.service';
import { ActorAccessService } from '@server/common/auth/actor-access.service';
import { actorFromRequest } from '@server/common/auth/actor';
import type {
  CreateExpenseApplyDto as ICreateExpenseApplyDto,
  CreateExpenseClaimDto as ICreateExpenseClaimDto,
  ExpenseApplyAction,
  ExpenseApplyItem,
  ExpenseClaimAction,
  ExpenseClaimItem,
  PagedResult,
} from '@shared/api.interface';

export class CreateExpenseApplyDto implements ICreateExpenseApplyDto {
  @IsString()
  @IsIn(['travel', 'purchase'])
  applyType!: 'travel' | 'purchase';

  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsString()
  @IsNotEmpty()
  expenseCategory!: string;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsDateString()
  expectDate?: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class CreateExpenseClaimDto implements ICreateExpenseClaimDto {
  @IsOptional()
  @IsUUID()
  applyId?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsString()
  @IsNotEmpty()
  expenseCategory!: string;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsDateString()
  expenseDate?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

@NeedLogin()
@Controller('api/fin-expense')
export class FinExpenseController {
  constructor(
    private readonly finExpenseService: FinExpenseService,
    private readonly actorAccess: ActorAccessService
  ) {}

  @Get('applies')
  async listApplies(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('projectId') projectId?: string
  ): Promise<PagedResult<ExpenseApplyItem>> {
    const actor = actorFromRequest(req);
    const privileged: boolean = await this.actorAccess.hasAnyRole(actor.userId, [
      'admin',
      'finance_viewer',
    ]);
    return this.finExpenseService.listApplies(
      page ? Math.max(1, parseInt(page, 10) || 1) : 1,
      pageSize
        ? Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20))
        : 20,
      status || undefined,
      projectId || undefined,
      privileged ? undefined : actor.userId
    );
  }

  @Post('applies')
  async createApply(
    @Body() dto: CreateExpenseApplyDto
  ): Promise<ExpenseApplyItem> {
    return this.finExpenseService.createApply(dto);
  }

  @CanCapability('finance_write')
  @Post('applies/:id/actions/:action')
  async applyAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('action') action: ExpenseApplyAction
  ): Promise<ExpenseApplyItem> {
    return this.finExpenseService.applyAction(id, action);
  }

  @Get('claims')
  async listClaims(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('projectId') projectId?: string
  ): Promise<PagedResult<ExpenseClaimItem>> {
    const actor = actorFromRequest(req);
    const privileged: boolean = await this.actorAccess.hasAnyRole(actor.userId, [
      'admin',
      'finance_viewer',
    ]);
    return this.finExpenseService.listClaims(
      page ? Math.max(1, parseInt(page, 10) || 1) : 1,
      pageSize
        ? Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20))
        : 20,
      status || undefined,
      projectId || undefined,
      privileged ? undefined : actor
    );
  }

  @Post('claims')
  async createClaim(
    @Req() req: Request,
    @Body() dto: CreateExpenseClaimDto
  ): Promise<ExpenseClaimItem> {
    const applicant =
      req.userContext?.userName ?? req.userContext?.userId ?? 'system';
    return this.finExpenseService.createClaim(dto, applicant);
  }

  @CanCapability('finance_write')
  @Post('claims/:id/actions/:action')
  async claimAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('action') action: ExpenseClaimAction
  ): Promise<ExpenseClaimItem> {
    return this.finExpenseService.claimAction(id, action);
  }
}
