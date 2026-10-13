import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CanRole, NeedLogin } from '@server/platform';
import { CrmService } from './crm.service';
import type {
  Contract,
  CreateLeadDto,
  CreateOpportunityDto,
  Lead,
  Opportunity,
  UpdateLeadDto,
  UpdateOpportunityDto,
} from '@shared/api.interface';

@NeedLogin()
@Controller('api/crm')
export class CrmController {
  constructor(private readonly crmService: CrmService) {}

  @Get('leads')
  async listLeads(@Query('status') status?: string): Promise<Lead[]> {
    return this.crmService.listLeads(status);
  }

  // 线索/商机登记属销售日常工作，所有登录用户均可创建；
  // 修改与赢单转合同涉及他人数据与合同生成，仍限管理员。
  @Post('leads')
  async createLead(@Body() dto: CreateLeadDto): Promise<Lead> {
    return this.crmService.createLead(dto);
  }

  @CanRole(['admin'])
  @Post('leads/:id/convert')
  async convertLead(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<Opportunity> {
    return this.crmService.convertLead(id);
  }

  @CanRole(['admin'])
  @Patch('leads/:id')
  async updateLead(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLeadDto
  ): Promise<Lead> {
    return this.crmService.updateLead(id, dto);
  }

  @Get('opportunities')
  async listOpportunities(
    @Query('stage') stage?: string
  ): Promise<Opportunity[]> {
    return this.crmService.listOpportunities(stage);
  }

  @Post('opportunities')
  async createOpportunity(
    @Body() dto: CreateOpportunityDto
  ): Promise<Opportunity> {
    return this.crmService.createOpportunity(dto);
  }

  @CanRole(['admin'])
  @Patch('opportunities/:id')
  async updateOpportunity(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOpportunityDto
  ): Promise<Opportunity> {
    return this.crmService.updateOpportunity(id, dto);
  }

  @CanRole(['admin'])
  @Post('opportunities/:id/convert')
  async convertToContract(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<Contract> {
    return this.crmService.convertToContract(id);
  }
}
