import {
  BadRequestException,
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
import { CanRole, NeedLogin } from '@server/platform';
import { FinanceRead } from '@server/common/auth/read-roles';
import type { Request } from 'express';
import { IsIn, IsString } from 'class-validator';
import { ArService } from './ar.service';
import { ApService } from './ap.service';
import { CashFlowService } from './cash-flow.service';
import { InvoiceService } from './invoice.service';
import { FinanceService } from './finance.service';
import { VendorSettlementService } from './vendor-settlement.service';
import type {
  AgingBucket,
  ApItem,
  ApWriteoffDto,
  ArItem,
  ArWriteoffDto,
  CreateInvoiceDto,
  CashFlowForecast,
  FinanceSummary,
  GenerateVendorSettlementDto,
  GenerateVendorSettlementResult,
  InvoiceItem,
  PaymentItem,
  ReceiptItem,
  UpdateInvoiceDto,
  VendorSettlementPreview,
} from '@shared/api.interface';
import {
  CreateApDto,
  CreateArDto,
  CreatePaymentDto,
  CreateReceiptDto,
} from './finance.dto';

export class ApprovePaymentDto {
  @IsString()
  @IsIn(['approve', 'reject'])
  action!: 'approve' | 'reject';
}

@NeedLogin()
@Controller('api/finance')
export class FinanceController {
  constructor(
    private readonly arService: ArService,
    private readonly apService: ApService,
    private readonly cashFlowService: CashFlowService,
    private readonly invoiceService: InvoiceService,
    private readonly financeService: FinanceService,
    private readonly vendorSettlementService: VendorSettlementService
  ) {}

  @FinanceRead()
  @Get('cash-flow/forecast')
  async getCashFlowForecast(
    @Query('weeks') weeks?: string
  ): Promise<CashFlowForecast> {
    let weekCount = 13;
    if (weeks !== undefined && weeks !== '') {
      const parsed: number = Number.parseInt(weeks, 10);
      if (Number.isNaN(parsed)) {
        throw new BadRequestException('weeks 必须为整数');
      }
      weekCount = Math.min(52, Math.max(1, parsed));
    }
    return this.cashFlowService.getForecast(weekCount);
  }

  @FinanceRead()
  @Get('ars')
  async listArs(
    @Query('customerId') customerId?: string,
    @Query('status') status?: string
  ): Promise<ArItem[]> {
    return this.arService.listArs(customerId, status);
  }

  @CanRole(['admin'])
  @Post('ars')
  async createAr(@Body() dto: CreateArDto): Promise<ArItem> {
    return this.arService.createAr(dto);
  }

  @FinanceRead()
  @Get('receipts')
  async listReceipts(
    @Query('customerId') customerId?: string
  ): Promise<ReceiptItem[]> {
    return this.arService.listReceipts(customerId);
  }

  @CanRole(['admin'])
  @Post('receipts')
  async createReceipt(@Body() dto: CreateReceiptDto): Promise<ReceiptItem> {
    return this.arService.createReceipt(dto);
  }

  @CanRole(['admin'])
  @Post('receipts/:id/void')
  async voidReceipt(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<ReceiptItem> {
    return this.arService.voidReceipt(id);
  }

  @CanRole(['admin'])
  @Post('ar-writeoffs')
  async arWriteoff(@Body() dto: ArWriteoffDto): Promise<ArItem> {
    return this.arService.writeoff(dto);
  }

  @FinanceRead()
  @Get('aging')
  async listAging(): Promise<AgingBucket[]> {
    return this.arService.listAging();
  }

  @FinanceRead()
  @Get('aps')
  async listAps(
    @Query('supplierId') supplierId?: string,
    @Query('status') status?: string
  ): Promise<ApItem[]> {
    return this.apService.listAps(supplierId, status);
  }

  @CanRole(['admin'])
  @Post('aps')
  async createAp(@Body() dto: CreateApDto): Promise<ApItem> {
    return this.apService.createAp(dto);
  }

  @FinanceRead()
  @Get('vendor-settlement/preview')
  async previewVendorSettlement(
    @Query('supplierId') supplierId?: string,
    @Query('period') period?: string,
    @Query('projectId') projectId?: string
  ): Promise<VendorSettlementPreview> {
    return this.vendorSettlementService.preview(
      supplierId,
      period,
      projectId
    );
  }

  @CanRole(['admin'])
  @Post('vendor-settlement/generate')
  async generateVendorSettlement(
    @Body() dto: GenerateVendorSettlementDto
  ): Promise<GenerateVendorSettlementResult> {
    return this.vendorSettlementService.generate(dto);
  }

  @FinanceRead()
  @Get('payments')
  async listPayments(@Query('apId') apId?: string): Promise<PaymentItem[]> {
    return this.apService.listPayments(apId);
  }

  @CanRole(['admin'])
  @Post('payments')
  async createPayment(@Body() dto: CreatePaymentDto): Promise<PaymentItem> {
    return this.apService.createPayment(dto);
  }

  @CanRole(['admin'])
  @Post('payments/:id/void')
  async voidPayment(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<PaymentItem> {
    return this.apService.voidPayment(id);
  }

  @CanRole(['admin'])
  @Post('payments/:id/approve')
  async approvePayment(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Body() dto: ApprovePaymentDto
  ): Promise<PaymentItem> {
    const approver =
      req.userContext?.userName ?? req.userContext?.userId ?? 'system';
    return this.apService.approvePayment(id, dto.action, approver);
  }

  @CanRole(['admin'])
  @Post('ap-writeoffs')
  async apWriteoff(@Body() dto: ApWriteoffDto): Promise<ApItem> {
    return this.apService.apWriteoff(dto);
  }

  @FinanceRead()
  @Get('invoices')
  async listInvoices(
    @Query('contractId') contractId?: string,
    @Query('direction') direction?: string
  ): Promise<InvoiceItem[]> {
    if (
      direction !== undefined &&
      direction !== 'sales' &&
      direction !== 'purchase'
    ) {
      throw new BadRequestException('direction 仅支持 sales / purchase');
    }
    return this.invoiceService.listInvoices(contractId, direction);
  }

  @CanRole(['admin'])
  @Post('invoices')
  async createInvoice(@Body() dto: CreateInvoiceDto): Promise<InvoiceItem> {
    return this.invoiceService.createInvoice(dto);
  }

  @CanRole(['admin'])
  @Post('invoices/:id/void')
  async voidInvoice(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request
  ): Promise<InvoiceItem> {
    const userId: string = req.userContext?.userId ?? 'anonymous';
    return this.invoiceService.voidInvoice(id, userId);
  }

  @CanRole(['admin'])
  @Patch('invoices/:id')
  async updateInvoice(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Body() dto: UpdateInvoiceDto
  ): Promise<InvoiceItem> {
    const userId: string = req.userContext?.userId ?? 'anonymous';
    return this.invoiceService.updateInvoice(id, dto, userId);
  }

  @FinanceRead()
  @Get('summary')
  async getSummary(): Promise<FinanceSummary> {
    return this.financeService.getSummary();
  }
}
