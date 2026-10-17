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
import { CanCapability, NeedLogin } from '@server/platform';
import { actorFromRequest } from '@server/common/auth/actor';
import { RevenuesService } from './revenues.service';
import type {
  RevenueAdjust,
  RevenueChainReconcileResult,
  RevenueItem,
  UnbilledItem,
} from '@shared/api.interface';
import {
  CreateRevenueAdjustDto,
  CreateRevenueDto,
  ReverseRevenueDto,
} from './revenues.dto';

@NeedLogin()
@Controller('api/revenues')
export class RevenuesController {
  constructor(private readonly revenuesService: RevenuesService) {}

  @Get()
  async listRevenues(
    @Req() req: Request,
    @Query('projectId') projectId?: string,
    @Query('period') period?: string
  ): Promise<RevenueItem[]> {
    return this.revenuesService.listRevenues(
      projectId,
      period,
      actorFromRequest(req)
    );
  }

  @CanCapability('finance_write')
  @Post()
  async createRevenue(@Body() dto: CreateRevenueDto): Promise<RevenueItem> {
    return this.revenuesService.createRevenue(dto);
  }

  @Get('unbilled')
  async listUnbilled(): Promise<UnbilledItem[]> {
    return this.revenuesService.listUnbilled();
  }

  /** N-3/B-4：收入→应收→凭证 三方对账自检（只读） */
  @Get('reconcile')
  async reconcileRevenueChain(
    @Query('period') period?: string
  ): Promise<RevenueChainReconcileResult> {
    return this.revenuesService.reconcileRevenueChain(period);
  }

  @Get('adjusts')
  async listAdjusts(@Query('revenueId') revenueId?: string): Promise<RevenueAdjust[]> {
    return this.revenuesService.listAdjusts(revenueId);
  }

  @CanCapability('finance_write')
  @Post('adjusts')
  async createAdjust(
    @Body() dto: CreateRevenueAdjustDto
  ): Promise<RevenueAdjust> {
    return this.revenuesService.createAdjust(dto);
  }

  // D-21：冲回为写操作，禁止 finance_viewer
  @CanCapability('finance_write')
  @Post(':id/reverse')
  async reverseRevenue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReverseRevenueDto
  ): Promise<RevenueItem> {
    return this.revenuesService.reverseRevenue(id, dto?.reason);
  }
}
