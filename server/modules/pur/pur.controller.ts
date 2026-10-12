import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CanRole, NeedLogin } from '@server/platform';
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
} from '@shared/api.interface';

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
  @IsDateString()
  orderDate?: string;

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

  @CanRole(['admin'])
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

  @CanRole(['admin'])
  @Post('orders')
  async createOrder(@Body() dto: CreatePurOrderDto): Promise<PurOrderItem> {
    return this.purService.createOrder(dto);
  }

  @CanRole(['admin'])
  @Post('orders/:id/accept')
  async acceptOrder(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptPurOrderDto
  ): Promise<PurOrderItem> {
    return this.purService.acceptOrder(id, dto);
  }

  @CanRole(['admin'])
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
