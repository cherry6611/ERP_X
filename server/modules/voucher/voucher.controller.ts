import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
  Matches,
  MaxLength,
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
  VoucherSourceRef,
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

export class CreateVoucherDto implements ICreateVoucherDto {  @IsDateString()
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

  /**
   * A-01/A-06：凭证归属的纳税主体。
   * 不传时后端按「来源合同 → 系统唯一默认主体」推导；推导不出则留空。
   */
  @IsOptional()
  @IsUUID()
  taxEntityId?: string;
}

/** 反结账入参（A-04/B-01：必须有 class DTO，否则 ValidationPipe 静默失效） */
export class UnclosePeriodDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

/** A-11：凭证行备注编辑入参 */
export class UpdateVoucherLineDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  summary?: string;
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

  @CanCapability('finance_write')
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

  @CanCapability('finance_write')
  @Post('vouchers')
  async createVoucher(@Body() dto: CreateVoucherDto): Promise<VoucherItem> {
    return this.voucherService.createVoucher(dto);
  }

  @CanCapability('finance_write')
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

  @CanCapability('finance_write')
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

  @CanCapability('finance_write')
  @Post('periods/:period/unclose')
  async unclosePeriod(
    @Param('period') period: string,
    @Req() req: Request,
    @Body() body: UnclosePeriodDto,
  ): Promise<PeriodStatus> {
    const userId: string =
      (req.userContext as { userId?: string } | undefined)?.userId ??
      'anonymous';
    return this.voucherService.unclosePeriod(period, userId, body.remark);
  }

  /**
   * A-11：凭证来源单据关联。
   *
   * 审计要求"凭证可追溯到原始单据"，此接口把 `source_type` + `source_ref`
   * 解析为可跳转的单据引用，供 `VoucherDetailPage` 的「来源单据」区块使用。
   */
  @Get('vouchers/:id/source')
  async getVoucherSource(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VoucherSourceRef | null> {
    return this.voucherService.resolveSourceRef(id);
  }

  /**
   * A-11：凭证行备注编辑。
   * 仅草稿凭证可改（已过账凭证的分录摘要属于已入账信息，改动需走红冲）。
   */
  @CanCapability('finance_write')
  @Patch('vouchers/:voucherId/lines/:lineId')
  async updateVoucherLine(
    @Param('voucherId', ParseUUIDPipe) voucherId: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() dto: UpdateVoucherLineDto,
  ): Promise<VoucherItem> {
    return this.voucherService.updateVoucherLine(voucherId, lineId, dto);
  }
}
