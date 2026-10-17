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
import {
  DataScopeService,
  type TaxEntityFilter,
} from '@server/common/auth/data-scope.service';
import { actorFromRequest } from '@server/common/auth/actor';
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
  SetAccountStatusDto as ISetAccountStatusDto,
  CreateVoucherDto as ICreateVoucherDto,
  CreateVoucherLineDto as ICreateVoucherLineDto,
  PagedResult,
  PeriodStatus,
  UnassignedEntityCheckResult,
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

/**
 * A-09：科目启用/停放入参。
 *
 * 用 `@IsIn` 而不是 `@IsBoolean`：状态是**两个具名取值**（active/inactive）
 * 而非布尔量 —— 布尔会在契约里丢掉"这是状态机的一个取值"这层含义，
 * 且今后若增加第三种状态（如 `archived`）就必须改契约。
 */
export class SetAccountStatusDto implements ISetAccountStatusDto {
  @IsIn(['active', 'inactive'], {
    message: 'status 仅支持 active（启用）/ inactive（停用）',
  })
  status!: 'active' | 'inactive';
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
  constructor(
    private readonly voucherService: VoucherService,
    private readonly dataScope: DataScopeService,
  ) {}

  /**
   * B-2：凭证的纳税主体可见范围。
   *
   * 放在 HTTP 边界而不是 service：service 方法拿不到 actor；
   * 而 service 收到 filter 后会把过滤条条件真正拼进 SQL（在 SQL 层过滤，不是 UI 隐藏）。
   */
  private async voucherScope(req: Request): Promise<TaxEntityFilter> {
    return this.dataScope.taxEntityScopeFor('voucher', actorFromRequest(req));
  }

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

  /**
   * A-09：科目启用/停用。
   *
   * 此前只能建科目、不能停用 —— 建账模板带入的多余科目（实测 `1403 原材料`
   * 全库 0 次使用）无法清理，而 `createVoucher` 又会在科目非 active 时拒绝做账，
   * 形成一个"没有入口进入的状态"。
   */
  @CanCapability('finance_write')
  @Post('accounts/:code/status')
  async setAccountStatus(
    @Param('code') code: string,
    @Body() dto: SetAccountStatusDto
  ): Promise<AccountItem> {
    return this.voucherService.setAccountStatus(code, dto.status);
  }

  @Get('vouchers')
  async listVouchers(
    @Req() req: Request,
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
      sourceType,
      await this.voucherScope(req)
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
    @Param('action') action: string,
    @Req() req: Request
  ): Promise<VoucherItem> {
    return this.voucherService.voucherAction(
      id,
      action as 'post' | 'void',
      await this.voucherScope(req)
    );
  }

  /**
   * B-1 / REQ-BE-01：凭证主体归属自检。
   * 返回未归属纳税主体的凭证（按期间/来源类型聚合 + 逐张明细供下钻）。
   */
  @Get('unassigned-entity')
  async checkUnassignedEntity(
    @Query('period') period?: string,
    @Query('sourceType') sourceType?: string
  ): Promise<UnassignedEntityCheckResult> {
    return this.voucherService.checkUnassignedEntity(period, sourceType);
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
