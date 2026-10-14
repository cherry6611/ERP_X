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
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { ReturnService } from './return.service';
import type {
  CreatePurchaseReturnDto as ICreatePurchaseReturnDto,
  CreateSalesReturnDto as ICreateSalesReturnDto,
  PagedResult,
  PurchaseReturnItem,
  ReturnAction,
  ReturnActionDto as IReturnActionDto,
  ReturnRegisterResult,
  ReturnableQuantityResult,
  SalesReturnItem,
} from '@shared/api.interface';

/**
 * C-05：退货请求体 DTO。
 *
 * ⚠️ 这些 class **必须定义在 controller 之前**：
 * `@Body()` 会把 DTO 构造器作为设计期元数据写到 controller 的装饰器上，
 * 而编译到 CJS 后类声明仍是 `let/const`（TDZ）。定义在 controller 之后会导致
 * 生产构建启动时 `Cannot access 'X' before initialization`，
 * 而 `tsc --noEmit` 与 jest 都不会发现。
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class CreatePurchaseReturnDto implements ICreatePurchaseReturnDto {
  @IsUUID()
  orderId!: string;

  @Matches(DATE_ONLY, { message: '退货日期必须为 YYYY-MM-DD' })
  returnDate!: string;

  @IsInt({ message: '退货数量必须为整数' })
  @Min(1)
  returnQuantity!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  unitPrice?: number;

  @IsOptional()
  @IsUUID()
  apBillId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;
}

export class CreateSalesReturnDto implements ICreateSalesReturnDto {
  @IsUUID()
  revenueId!: string;

  @Matches(DATE_ONLY, { message: '退货日期必须为 YYYY-MM-DD' })
  returnDate!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  taxRate?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;
}

export class ReturnActionDto implements IReturnActionDto {
  @IsIn(['submit', 'approve', 'reject', 'complete', 'void'], {
    message: '动作仅支持 submit / approve / reject / complete / void',
  })
  action!: ReturnAction;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;
}

@NeedLogin()
@Controller('api/returns')
export class ReturnController {
  constructor(private readonly returnService: ReturnService) {}

  /** 状态与动作字典（前端不硬编码状态机） */
  @Get('dictionaries')
  dictionaries() {
    return this.returnService.dictionaries();
  }

  /** 退货台账（采购与销售按状态汇总） */
  @CanCapabilityRead('finance')
  @Get('register')
  async register(): Promise<ReturnRegisterResult> {
    return this.returnService.register();
  }

  /* ========== 采购退货 ========== */

  /**
   * 可退数量查询。下单前必须先查这个，否则会超退
   * （已验收 − 已退，未验收的货不可退）。
   */
  @CanCapabilityRead('pur_asset')
  @Get('purchase-returnable/:orderId')
  async returnable(
    @Param('orderId', ParseUUIDPipe) orderId: string
  ): Promise<ReturnableQuantityResult> {
    return this.returnService.returnable(orderId);
  }

  @CanCapabilityRead('pur_asset')
  @Get('purchase')
  async listPurchase(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('orderId') orderId?: string,
    @Query('supplierId') supplierId?: string,
    @Query('projectId') projectId?: string
  ): Promise<PagedResult<PurchaseReturnItem>> {
    return this.returnService.listPurchaseReturns({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      status,
      orderId,
      supplierId,
      projectId,
    });
  }

  @CanCapabilityRead('pur_asset')
  @Get('purchase/:id')
  async detailPurchase(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<PurchaseReturnItem> {
    return this.returnService.getPurchaseReturn(id);
  }

  @CanCapability('pur_asset')
  @Post('purchase')
  async createPurchase(
    @Req() req: Request,
    @Body() dto: CreatePurchaseReturnDto
  ): Promise<PurchaseReturnItem> {
    return this.returnService.createPurchaseReturn(
      dto,
      actorFromRequest(req).userId
    );
  }

  @CanCapability('pur_asset')
  @Post('purchase/:id/actions')
  async purchaseAction(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReturnActionDto
  ): Promise<PurchaseReturnItem> {
    return this.returnService.purchaseReturnAction(
      id,
      dto,
      actorFromRequest(req).userId
    );
  }

  /* ========== 销售退货 ========== */

  @CanCapabilityRead('finance')
  @Get('sales')
  async listSales(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('revenueId') revenueId?: string,
    @Query('customerId') customerId?: string
  ): Promise<PagedResult<SalesReturnItem>> {
    return this.returnService.listSalesReturns({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      status,
      revenueId,
      customerId,
    });
  }

  @CanCapabilityRead('finance')
  @Get('sales/:id')
  async detailSales(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<SalesReturnItem> {
    return this.returnService.getSalesReturn(id);
  }

  @CanCapability('finance_write')
  @Post('sales')
  async createSales(
    @Req() req: Request,
    @Body() dto: CreateSalesReturnDto
  ): Promise<SalesReturnItem> {
    return this.returnService.createSalesReturn(dto, actorFromRequest(req).userId);
  }

  @CanCapability('finance_write')
  @Post('sales/:id/actions')
  async salesAction(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReturnActionDto
  ): Promise<SalesReturnItem> {
    return this.returnService.salesReturnAction(
      id,
      dto,
      actorFromRequest(req).userId
    );
  }

  /* ========== 项目影响 ========== */

  @CanCapabilityRead('finance')
  @Get('project-impact/:projectId')
  async projectImpact(@Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.returnService.projectImpact(projectId);
  }
}
