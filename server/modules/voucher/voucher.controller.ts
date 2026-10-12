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
import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { VoucherService } from './voucher.service';
import type {
  AccountItem,
  CreateAccountDto as ICreateAccountDto,
  CreateVoucherDto as ICreateVoucherDto,
  CreateVoucherLineDto as ICreateVoucherLineDto,
  PagedResult,
  PeriodStatus,
  VoucherItem,
} from '@shared/api.interface';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export class CreateAccountDto implements ICreateAccountDto {
  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsIn(['asset', 'liability', 'equity', 'revenue', 'expense'])
  accountType!: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

  @IsOptional()
  @IsString()
  remark?: string;
}

export class CreateVoucherLineDto implements ICreateVoucherLineDto {
  @IsUUID()
  accountId!: string;

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  debit?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  credit?: number;
}

export class CreateVoucherDto implements ICreateVoucherDto {
  @IsDateString()
  voucherDate!: string;

  @IsString()
  @Matches(PERIOD_PATTERN, { message: '期间格式必须为 YYYY-MM' })
  period!: string;

  @IsString()
  @IsNotEmpty()
  summary!: string;

  @IsOptional()
  @IsString()
  @IsIn([
    'receipt',
    'payment',
    'expense',
    'payroll',
    'depreciation',
    'invoice',
    'manual',
  ])
  sourceType?:
    | 'receipt'
    | 'payment'
    | 'expense'
    | 'payroll'
    | 'depreciation'
    | 'invoice'
    | 'manual';

  @IsOptional()
  @IsString()
  sourceRef?: string;

  @ValidateNested({ each: true })
  @Type(() => CreateVoucherLineDto)
  lines!: CreateVoucherLineDto[];

  @IsOptional()
  @IsString()
  remark?: string;
}

@NeedLogin()
@Controller('api/voucher')
export class VoucherController {
  constructor(private readonly voucherService: VoucherService) {}

  @Get('accounts')
  async listAccounts(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string
  ): Promise<PagedResult<AccountItem>> {
    return this.voucherService.listAccounts(
      Math.max(1, parseInt(page ?? '1', 10) || 1),
      Math.min(50, Math.max(1, parseInt(pageSize ?? '20', 10) || 20)),
      keyword
    );
  }

  @CanRole(['admin'])
  @Post('accounts')
  async createAccount(@Body() dto: CreateAccountDto): Promise<AccountItem> {
    return this.voucherService.createAccount(dto);
  }

  @Get('vouchers')
  async listVouchers(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('period') period?: string,
    @Query('sourceType') sourceType?: string
  ): Promise<PagedResult<VoucherItem>> {
    return this.voucherService.listVouchers(
      Math.max(1, parseInt(page ?? '1', 10) || 1),
      Math.min(50, Math.max(1, parseInt(pageSize ?? '20', 10) || 20)),
      status,
      period,
      sourceType
    );
  }

  @CanRole(['admin'])
  @Post('vouchers')
  async createVoucher(@Body() dto: CreateVoucherDto): Promise<VoucherItem> {
    return this.voucherService.createVoucher(dto);
  }

  @CanRole(['admin'])
  @Post('vouchers/:id/actions/:action')
  async voucherAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('action') action: string
  ): Promise<VoucherItem> {
    return this.voucherService.voucherAction(
      id,
      action as 'post' | 'void'
    );
  }

  @Get('periods')
  async listPeriods(): Promise<PeriodStatus[]> {
    return this.voucherService.listPeriods();
  }

  @CanRole(['admin'])
  @Post('periods/:period/close')
  async closePeriod(
    @Param('period') period: string,
    @Req() req: Request
  ): Promise<PeriodStatus> {
    const userId: string =
      (req.userContext as { userId?: string } | undefined)?.userId ??
      'anonymous';
    return this.voucherService.closePeriod(period, userId);
  }
}
