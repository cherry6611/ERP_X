import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CanCapability, NeedLogin } from '@server/platform';
import { IsIn } from 'class-validator';
import { MasterDataService } from './master-data.service';
import {
  CreateContactDto,
  CreateCustomerDto,
  CreateSupplierDto,
  UpdateCustomerDto,
  UpdateSupplierDto,
} from './master-data.dto';
import type { SetEntityStatusDto as ISetEntityStatusDto } from '@shared/api.interface';
import type {
  Customer,
  CustomerContact,
  CreditSummary,
  Employee,
  PagedResult,
  Supplier,
} from '@shared/api.interface';

export class SetEntityStatusBodyDto implements ISetEntityStatusDto {
  @IsIn(['active', 'inactive'], { message: '状态仅支持 active / inactive' })
  status!: 'active' | 'inactive';
}

@NeedLogin()
@Controller('api/master-data')
export class MasterDataController {
  constructor(private readonly masterDataService: MasterDataService) {}

  @Get('customers')
  async listCustomers(
    @Query('keyword') keyword?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string
  ): Promise<PagedResult<Customer>> {
    const pageRaw: number = Number(page);
    const pageSizeRaw: number = Number(pageSize);
    const safePage: number =
      Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
    const safePageSize: number =
      Number.isFinite(pageSizeRaw) && pageSizeRaw >= 1
        ? Math.min(Math.floor(pageSizeRaw), 500)
        : 20;
    return this.masterDataService.listCustomers(keyword, safePage, safePageSize);
  }

  @CanCapability('crm_write')
  @Post('customers')
  async createCustomer(@Body() dto: CreateCustomerDto): Promise<Customer> {
    return this.masterDataService.createCustomer(dto);
  }

  @CanCapability('crm_write')
  @Patch('customers/:id')
  async updateCustomer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto
  ): Promise<Customer> {
    return this.masterDataService.updateCustomer(id, dto);
  }

  @CanCapability('crm_write')
  @Patch('customers/:id/status')
  async setCustomerStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SetEntityStatusBodyDto
  ): Promise<Customer> {
    return this.masterDataService.setCustomerStatus(id, body.status);
  }

  @Get('customers/:id/contacts')
  async listContacts(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<CustomerContact[]> {
    return this.masterDataService.listContacts(id);
  }

  @CanCapability('crm_write')
  @Post('customers/:id/contacts')
  async createContact(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateContactDto
  ): Promise<CustomerContact> {
    return this.masterDataService.createContact(id, dto);
  }

  @Get('customers/:id/credit')
  async getCredit(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<CreditSummary> {
    return this.masterDataService.getCredit(id);
  }

  @CanCapability('crm_write')
  @Patch('contacts/:id')
  async updateContact(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateContactDto
  ): Promise<CustomerContact> {
    return this.masterDataService.updateContact(id, dto);
  }

  @CanCapability('crm_write')
  @Delete('contacts/:id')
  async deleteContact(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.masterDataService.deleteContact(id);
  }

  @Get('suppliers')
  async listSuppliers(@Query('keyword') keyword?: string): Promise<Supplier[]> {
    return this.masterDataService.listSuppliers(keyword);
  }

  @CanCapability('crm_write')
  @Post('suppliers')
  async createSupplier(@Body() dto: CreateSupplierDto): Promise<Supplier> {
    return this.masterDataService.createSupplier(dto);
  }

  @CanCapability('crm_write')
  @Patch('suppliers/:id')
  async updateSupplier(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierDto
  ): Promise<Supplier> {
    return this.masterDataService.updateSupplier(id, dto);
  }

  @CanCapability('crm_write')
  @Patch('suppliers/:id/status')
  async setSupplierStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SetEntityStatusBodyDto
  ): Promise<Supplier> {
    return this.masterDataService.setSupplierStatus(id, body.status);
  }

  @Get('employees')
  async listEmployees(): Promise<Employee[]> {
    return this.masterDataService.listEmployees();
  }
}

/** 客户/供应商启停入参（class DTO：状态值白名单，避免任意字符串落库） */
