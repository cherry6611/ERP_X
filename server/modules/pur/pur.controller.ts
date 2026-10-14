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
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateIf,
} from 'class-validator';
import { PurService } from './pur.service';
import type {
  AcceptPurOrderDto as IAcceptPurOrderDto,
  CreatePurOrderDto as ICreatePurOrderDto,
  CreatePurRequestDto as ICreatePurRequestDto,
  PagedResult,
  PurChainSummary,
  PurOrderItem,
  PurRequestItem,
  UpdatePurOrderDto as IUpdatePurOrderDto,
} from '@shared/api.interface';

const VAT_RATE_VALUES = [0, 1, 3, 6, 9, 13] as const;

export class CreatePurRequestDto implements ICreatePurRequestDto {
  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsString()
  @IsIn(['service', 'equipment'])
  requestType!: 'service' | 'equipment';

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsUUID()
  supplierId?: string;

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

export class CreatePurOrderDto implements ICreatePurOrderDto {
  @IsOptional()
  @IsUUID()
  requestId?: string;

  @IsOptional()
  @IsUUID()
  contractId?: string;

  @IsUUID()
  supplierId!: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsString()
  @IsNotEmpty()
  itemName!: string;

  @IsString()
  @IsIn(['service', 'equipment'])
  category!: 'service' | 'equipment';

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsNumber()
  @Min(0)
  unitPrice!: number;

  @IsOptional()
  @IsNumber()
  @IsIn([...VAT_RATE_VALUES])
  taxRate?: number;

  @IsOptional()
  @IsDateString()
  orderDate?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class UpdatePurOrderDto implements IUpdatePurOrderDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @IsIn([...VAT_RATE_VALUES])
  taxRate?: number | null;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class AcceptPurOrderDto implements IAcceptPurOrderDto {
  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsDateString()
  acceptDate?: string;
}

@NeedLogin()
@Controller('api/pur')
export class PurController {
  constructor(private readonly purService: PurService) {}

  @Get('requests')
  async listRequests(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('projectId') projectId?: string
  ): Promise<PagedResult<PurRequestItem>> {
    return this.purService.listRequests({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      status,
      projectId,
    });
  }

  @Post('requests')
  async createRequest(
    @Body() dto: CreatePurRequestDto
  ): Promise<PurRequestItem> {
    return this.purService.createRequest(dto);
  }

  @CanCapability('pur_asset')
  @Post('requests/:id/actions/:action')
  async requestAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('action') action: string
  ): Promise<PurRequestItem> {
    if (action !== 'approve' && action !== 'reject') {
      throw new BadRequestException('不支持的操作，仅允许 approve / reject');
    }
    return this.purService.requestAction(id, action);
  }

  @Get('orders')
  async listOrders(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('supplierId') supplierId?: string
  ): Promise<PagedResult<PurOrderItem>> {
    return this.purService.listOrders({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      status,
      supplierId,
    });
  }

  @CanCapability('pur_asset')
  @Post('orders')
  async createOrder(@Body() dto: CreatePurOrderDto): Promise<PurOrderItem> {
    return this.purService.createOrder(dto);
  }

  @CanCapability('pur_asset')
  @Patch('orders/:id')
  async updateOrder(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePurOrderDto
  ): Promise<PurOrderItem> {
    return this.purService.updateOrder(id, dto);
  }

  @CanCapability('pur_asset')
  @Post('orders/:id/accept')
  async acceptOrder(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptPurOrderDto
  ): Promise<PurOrderItem> {
    return this.purService.acceptOrder(id, dto);
  }

  @CanCapability('pur_asset')
  @Post('orders/:id/actions/cancel')
  async cancelOrder(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<PurOrderItem> {
    return this.purService.cancelOrder(id);
  }

  @Get('chain-summary')
  async getChainSummary(): Promise<PurChainSummary> {
    return this.purService.getChainSummary();
  }
}
