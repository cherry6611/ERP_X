import { Controller, Get, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '@server/platform';
import { FinanceRead, HrRead } from '@server/common/auth/read-roles';
import { actorFromRequest } from '@server/common/auth/actor';
import { ProjectAclService } from '@server/modules/projects/project-acl.service';
import { BiService } from './bi.service';
import type {
  AlertsResult,
  BiOverview,
  BiProjectCostBreakdownItem,
  CustomerContribution,
  HrOverview,
  MonthlyTrend,
  ProjectFinancialHealthSummary,
  ProjectMargin,
} from '@shared/api.interface';

@NeedLogin()
@Controller('api/bi')
export class BiController {
  constructor(
    private readonly biService: BiService,
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
}
