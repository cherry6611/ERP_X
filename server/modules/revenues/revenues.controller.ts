import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CanRole, NeedLogin } from '@server/platform';
import { RevenuesService } from './revenues.service';
import type {
  CreateRevenueAdjustDto,
  ReverseRevenueDto,
  RevenueAdjust,
  RevenueItem,
  UnbilledItem,
} from '@shared/api.interface';
import { CreateRevenueDto } from './revenues.dto';

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

  @CanRole(['admin'])
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

  @CanRole(['admin'])
  @Post('adjusts')
  async createAdjust(
    @Body() dto: CreateRevenueAdjustDto
  ): Promise<RevenueAdjust> {
    return this.revenuesService.createAdjust(dto);
  }

  @CanRole(['admin', 'finance_viewer'])
  @Post(':id/reverse')
  async reverseRevenue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReverseRevenueDto
  ): Promise<RevenueItem> {
    return this.revenuesService.reverseRevenue(id, dto?.reason);
  }
}
