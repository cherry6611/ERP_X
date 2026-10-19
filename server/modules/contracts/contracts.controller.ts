import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { actorFromRequest } from '@server/common/auth/actor';
import { CanCapability, NeedLogin } from '@server/platform';
import { IsIn, IsString } from 'class-validator';
import { ContractsService } from './contracts.service';
import {
  ContractItemsService,
  type ContractItemInput,
  type ContractItemView,
  type ContractItemWriteResult,
} from './contract-items.service';
import type {
  BillableSummary,
  Calloff,
  Contract,
  ContractDetail,
  ContractMilestone,
  ContractVersion,
  PagedResult,
} from '@shared/api.interface';
import {
  ContractItemBodyDto,
  CreateCalloffDto,
  CreateContractDto,
  CreateContractVersionDto,
  CreateMilestoneDto,
  ImportQuotationItemsDto,
  UpdateContractDto,
  UpdateMilestoneDto,
} from './contracts.dto';

export class ContractStatusActionDto {
  @IsString()
  @IsIn(['submit', 'approve', 'reject', 'start', 'complete', 'close', 'terminate'])
  action!: 'submit' | 'approve' | 'reject' | 'start' | 'complete' | 'close' | 'terminate';
}

@NeedLogin()
@Controller('api/contracts')
export class ContractsController {
  constructor(
    private readonly contractsService: ContractsService,
    private readonly contractItems: ContractItemsService
  ) {}

  @Get()
  async listContracts(
    @Req() req: Request,
    @Query('status') status?: string,
    @Query('keyword') keyword?: string,
    @Query('customerId') customerId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string
  ): Promise<PagedResult<Contract>> {
    const pageParam: number = Number(page);
    const pageNumber: number =
      Number.isFinite(pageParam) && pageParam >= 1 ? Math.floor(pageParam) : 1;
    const sizeParam: number = Number(pageSize);
    const rawPageSize: number =
      Number.isFinite(sizeParam) && sizeParam >= 1 ? Math.floor(sizeParam) : 20;
    const pageSizeNumber: number = Math.min(rawPageSize, 500);
    return this.contractsService.listContracts(
      status,
      keyword,
      customerId,
      pageNumber,
      pageSizeNumber,
      actorFromRequest(req),
    );
  }

  @CanCapability('crm_write')
  @Post()
  async createContract(@Body() dto: CreateContractDto): Promise<ContractDetail> {
    return this.contractsService.createContract(dto);
  }

  @Get('billable/:id')
  async getBillable(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<BillableSummary> {
    return this.contractsService.getBillable(id, actorFromRequest(req));
  }

  @Get(':id')
  async getContract(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<ContractDetail> {
    return this.contractsService.getContract(id, actorFromRequest(req));
  }

  @CanCapability('crm_write')
  @Patch(':id')
  async updateContract(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateContractDto
  ): Promise<Contract> {
    return this.contractsService.updateContract(id, dto);
  }

  @CanCapability('crm_write')
  @Post(':id/status')
  async changeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ContractStatusActionDto
  ): Promise<Contract> {
    return this.contractsService.changeStatus(id, dto.action);
  }

  @CanCapability('crm_write')
  @Post(':id/milestones')
  async addMilestone(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMilestoneDto
  ): Promise<ContractMilestone> {
    return this.contractsService.addMilestone(id, dto);
  }

  @CanCapability('crm_write')
  @Patch('milestones/:id')
  async updateMilestone(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMilestoneDto
  ): Promise<ContractMilestone> {
    return this.contractsService.updateMilestone(id, dto);
  }

  @CanCapability('crm_write')
  @Post(':id/changes')
  async createChange(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateContractVersionDto
  ): Promise<ContractVersion> {
    return this.contractsService.createChange(id, dto);
  }

  @Get(':id/items')
  async listItems(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<ContractItemView[]> {
    return this.contractItems.list(id);
  }

  @CanCapability('crm_write')
  @Post(':id/items')
  async createItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ContractItemBodyDto
  ): Promise<ContractItemWriteResult> {
    return this.contractItems.create(id, dto);
  }

  @CanCapability('crm_write')
  @Patch(':id/items/:itemId')
  async updateItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: ContractItemBodyDto
  ): Promise<ContractItemWriteResult> {
    return this.contractItems.update(id, itemId, dto);
  }

  @CanCapability('crm_write')
  @Post(':id/items/:itemId/delete')
  async deleteItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string
  ): Promise<ContractItemWriteResult> {
    return this.contractItems.remove(id, itemId);
  }

  @CanCapability('crm_write')
  @Post(':id/items/import-quotation')
  async importQuotation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ImportQuotationItemsDto
  ): Promise<ContractItemView[]> {
    return this.contractItems.importQuotation(id, dto.quotationId);
  }

  @CanCapability('crm_write')
  @Post(':id/calloffs')
  async createCalloff(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCalloffDto
  ): Promise<Calloff> {
    return this.contractsService.createCalloff(id, dto);
  }
}
