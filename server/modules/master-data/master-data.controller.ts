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
import { CanRole, NeedLogin } from '@server/platform';
import { MasterDataService } from './master-data.service';
import type {
  CreateContactDto,
  CreateSupplierDto,
  Customer,
  CustomerContact,
  CreditSummary,
  Employee,
  PagedResult,
  Supplier,
  UpdateCustomerDto,
  UpdateSupplierDto,
} from '@shared/api.interface';
import { CreateCustomerDto } from './master-data.dto';

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

  @CanRole(['admin'])
  @Post('customers')
  async createCustomer(@Body() dto: CreateCustomerDto): Promise<Customer> {
    return this.masterDataService.createCustomer(dto);
  }

  @CanRole(['admin'])
  @Patch('customers/:id')
  async updateCustomer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto
  ): Promise<Customer> {
    return this.masterDataService.updateCustomer(id, dto);
  }

  @CanRole(['admin'])
  @Patch('customers/:id/status')
  async setCustomerStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { status: 'active' | 'inactive' }
  ): Promise<Customer> {
    return this.masterDataService.setCustomerStatus(id, body.status);
  }

  @Get('customers/:id/contacts')
  async listContacts(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<CustomerContact[]> {
    return this.masterDataService.listContacts(id);
  }

  @CanRole(['admin'])
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

  @CanRole(['admin'])
  @Patch('contacts/:id')
  async updateContact(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateContactDto
  ): Promise<CustomerContact> {
    return this.masterDataService.updateContact(id, dto);
  }

  @CanRole(['admin'])
  @Delete('contacts/:id')
  async deleteContact(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.masterDataService.deleteContact(id);
  }

  @Get('suppliers')
  async listSuppliers(@Query('keyword') keyword?: string): Promise<Supplier[]> {
    return this.masterDataService.listSuppliers(keyword);
  }

  @CanRole(['admin'])
  @Post('suppliers')
  async createSupplier(@Body() dto: CreateSupplierDto): Promise<Supplier> {
    return this.masterDataService.createSupplier(dto);
  }

  @CanRole(['admin'])
  @Patch('suppliers/:id')
  async updateSupplier(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierDto
  ): Promise<Supplier> {
    return this.masterDataService.updateSupplier(id, dto);
  }

  @CanRole(['admin'])
  @Patch('suppliers/:id/status')
  async setSupplierStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { status: 'active' | 'inactive' }
  ): Promise<Supplier> {
    return this.masterDataService.setSupplierStatus(id, body.status);
  }

  @Get('employees')
  async listEmployees(): Promise<Employee[]> {
    return this.masterDataService.listEmployees();
  }
}
