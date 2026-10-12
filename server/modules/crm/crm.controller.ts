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

  @CanRole(['admin'])
  @Post('leads')
  async createLead(@Body() dto: CreateLeadDto): Promise<Lead> {
    return this.crmService.createLead(dto);
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

  @CanRole(['admin'])
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
