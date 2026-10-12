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
import { IsIn, IsString } from 'class-validator';
import { ContractsService } from './contracts.service';
import type {
  BillableSummary,
  Calloff,
  Contract,
  ContractDetail,
  ContractMilestone,
  ContractVersion,
  CreateCalloffDto,
  CreateContractDto,
  CreateMilestoneDto,
  PagedResult,
  UpdateContractDto,
} from '@shared/api.interface';

export class ContractStatusActionDto {
  @IsString()
  @IsIn(['submit', 'approve', 'reject', 'start', 'complete', 'close'])
  action!: 'submit' | 'approve' | 'reject' | 'start' | 'complete' | 'close';
}

@NeedLogin()
@Controller('api/contracts')
export class ContractsController {
  constructor(private readonly contractsService: ContractsService) {}

  @Get()
  async listContracts(
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
      pageSizeNumber
    );
  }

  @CanRole(['admin'])
  @Post()
  async createContract(@Body() dto: CreateContractDto): Promise<ContractDetail> {
    return this.contractsService.createContract(dto);
  }

  @Get('billable/:id')
  async getBillable(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<BillableSummary> {
    return this.contractsService.getBillable(id);
  }

  @Get(':id')
  async getContract(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<ContractDetail> {
    return this.contractsService.getContract(id);
  }

  @CanRole(['admin'])
  @Patch(':id')
  async updateContract(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateContractDto
  ): Promise<Contract> {
    return this.contractsService.updateContract(id, dto);
  }

  @CanRole(['admin'])
  @Post(':id/status')
  async changeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ContractStatusActionDto
  ): Promise<Contract> {
    return this.contractsService.changeStatus(id, dto.action);
  }

  @CanRole(['admin'])
  @Post(':id/milestones')
  async addMilestone(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMilestoneDto
  ): Promise<ContractMilestone> {
    return this.contractsService.addMilestone(id, dto);
  }

  @CanRole(['admin'])
  @Patch('milestones/:id')
  async updateMilestone(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { status?: 'reached'; actualDate?: string; name?: string; amount?: number }
  ): Promise<ContractMilestone> {
    return this.contractsService.updateMilestone(id, dto);
  }

  @CanRole(['admin'])
  @Post(':id/changes')
  async createChange(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { changeLog: string; newAmount?: number }
  ): Promise<ContractVersion> {
    return this.contractsService.createChange(id, dto);
  }

  @CanRole(['admin'])
  @Post(':id/calloffs')
  async createCalloff(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCalloffDto
  ): Promise<Calloff> {
    return this.contractsService.createCalloff(id, dto);
  }
}
