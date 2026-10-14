import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CanCapability, NeedLogin } from '@server/platform';
import { FinanceRead, HrRead } from '@server/common/auth/read-roles';
import { actorFromRequest } from '@server/common/auth/actor';
import { IsIn, IsNumber, IsOptional, IsString } from 'class-validator';
import { ProjectAclService } from '@server/modules/projects/project-acl.service';
import { BiService } from './bi.service';
import { BiMetricsService } from './bi-metrics.service';
import type {
  AlertsResult,
  BiAlertSubscriptionItem,
  BiMetricsResult,
  BiOverview,
  BiProjectCostBreakdownItem,
  CustomerContribution,
  HrOverview,
  MonthlyTrend,
  ProjectFinancialHealthSummary,
  ProjectMargin,
  UpsertBiAlertSubscriptionDto as IUpsertBiAlertSubscriptionDto,
} from '@shared/api.interface';

/** D-12：预警订阅入参（class 必须定义在 controller 之前） */
export class UpsertBiAlertSubscriptionDto
  implements IUpsertBiAlertSubscriptionDto
{
  @IsString()
  metricKey!: string;

  @IsOptional()
  @IsIn(['gt', 'lt'], { message: '阈值方向仅支持 gt / lt' })
  thresholdDirection?: 'gt' | 'lt';

  @IsNumber({ maxDecimalPlaces: 4 })
  threshold!: number;

  @IsOptional()
  @IsIn(['feishu', 'inbox'], { message: '通知渠道仅支持 feishu / inbox' })
  channel?: 'feishu' | 'inbox';

  @IsOptional()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  remark?: string;
}

@NeedLogin()
@Controller('api/bi')
export class BiController {
  constructor(
    private readonly biService: BiService,
    private readonly biMetrics: BiMetricsService,
    private readonly projectAcl: ProjectAclService
  ) {}

  @FinanceRead()
  @Get('overview')
  async getOverview(): Promise<BiOverview> {
    return this.biService.getOverview();
  }

  @FinanceRead()
  @Get('project-margins')
  async getProjectMargins(): Promise<ProjectMargin[]> {
    return this.biService.getProjectMargins();
  }

  @FinanceRead()
  @Get('project-financial-health')
  async getProjectFinancialHealth(): Promise<ProjectFinancialHealthSummary> {
    return this.biService.getProjectFinancialHealth();
  }

  @Get('projects/:id/cost-breakdown')
  async getProjectCostBreakdown(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<BiProjectCostBreakdownItem[]> {
    await this.projectAcl.assertVisible(id, actorFromRequest(req));
    return this.biService.getProjectCostBreakdown(id);
  }

  @FinanceRead()
  @Get('customer-contributions')
  async getCustomerContributions(): Promise<CustomerContribution[]> {
    return this.biService.getCustomerContributions();
  }

  @FinanceRead()
  @Get('tax-distribution')
  async getTaxDistribution(): Promise<
    { taxEntityId: string | null; taxEntityName: string; amount: number; taxAmount: number }[]
  > {
    return this.biService.getTaxDistribution();
  }

  @FinanceRead()
  @Get('monthly-trends')
  async getMonthlyTrends(): Promise<MonthlyTrend[]> {
    return this.biService.getMonthlyTrends();
  }

  @HrRead()
  @Get('hr-overview')
  async getHrOverview(): Promise<HrOverview> {
    return this.biService.getHrOverview();
  }

  @FinanceRead()
  @Get('alerts')
  async getAlerts(): Promise<AlertsResult> {
    return this.biService.getAlerts();
  }

  /* ========== D-12 指标中心与预警订阅 ========== */

  /** 指标中心：本期值 + 上期对比 + 可读口径 + 下钻路由 */
  @FinanceRead()
  @Get('metrics')
  async getMetrics(@Query('period') period?: string): Promise<BiMetricsResult> {
    return this.biMetrics.metrics(period ?? this.currentPeriod());
  }

  /** 指标字典（前端渲染订阅下拉用，避免前端硬编码） */
  @Get('metric-definitions')
  listMetricDefinitions() {
    return this.biMetrics.listMetricDefinitions();
  }

  @Get('alert-subscriptions')
  async listSubscriptions(
    @Req() req: Request
  ): Promise<BiAlertSubscriptionItem[]> {
    return this.biMetrics.listSubscriptions(actorFromRequest(req).userId);
  }

  @CanCapability('finance_write')
  @Post('alert-subscriptions')
  async upsertSubscription(
    @Req() req: Request,
    @Body() dto: UpsertBiAlertSubscriptionDto
  ): Promise<BiAlertSubscriptionItem> {
    return this.biMetrics.upsertSubscription(
      actorFromRequest(req).userId,
      dto
    );
  }

  @CanCapability('finance_write')
  @Post('alert-subscriptions/:id/delete')
  async removeSubscription(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<{ ok: true }> {
    return this.biMetrics.removeSubscription(actorFromRequest(req).userId, id);
  }

  /** 运维视图：全体订阅（admin 才能看他人订阅） */
  @FinanceRead()
  @Get('alert-subscriptions/all')
  async listAllSubscriptions(): Promise<BiAlertSubscriptionItem[]> {
    return this.biMetrics.listAllSubscriptions();
  }

  /** 当前业务时区月份（与 biz-date 口径一致，避免用 UTC 月份） */
  private currentPeriod(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
    })
      .format(new Date())
      .slice(0, 7);
  }
}
