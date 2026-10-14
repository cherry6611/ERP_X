import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CanCapability, NeedLogin } from '@server/platform';
import { RevenuesService } from './revenues.service';
import type {
  RevenueAdjust,
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
    @Query('projectId') projectId?: string,
    @Query('period') period?: string
  ): Promise<RevenueItem[]> {
    return this.revenuesService.listRevenues(projectId, period);
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
