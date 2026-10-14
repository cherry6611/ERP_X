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
import { CanCapability, NeedLogin } from '@server/platform';
import { FinanceRead } from '@server/common/auth/read-roles';
import { actorFromRequest } from '@server/common/auth/actor';
import type { Request } from 'express';
import { IsIn, IsString } from 'class-validator';
import { ArService } from './ar.service';
import { ApService } from './ap.service';
import { CashFlowService } from './cash-flow.service';
import { InvoiceService } from './invoice.service';
import { FinanceService } from './finance.service';
import { VendorSettlementService } from './vendor-settlement.service';
import { ReconciliationService } from './reconciliation.service';
import { IsOptional, IsUUID } from 'class-validator';
import type {
  AgingBucket,
  ApItem,
  ArItem,
  CashFlowForecast,
  FinanceSummary,
  GenerateVendorSettlementResult,
  InvoiceItem,
  PaymentItem,
  ReceiptItem,
  VendorSettlementPreview,
} from '@shared/api.interface';
import {
  ApWriteoffDto,
  ArWriteoffDto,
  CreateApDto,
  CreateArDto,
  CreateInvoiceDto,
  CreatePaymentDto,
  CreateReceiptDto,
  GenerateVendorSettlementDto,
  UpdateInvoiceDto,
} from './finance.dto';

export class ApprovePaymentDto {
  @IsString()
  @IsIn(['approve', 'reject'])
  action!: 'approve' | 'reject';
}

export class ReverseWriteoffDto {
  @IsOptional()
  @IsString()
  remark?: string;
}

export class BindApDto {
  @IsUUID()
  apId!: string;
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
    private readonly vendorSettlementService: VendorSettlementService,
    private readonly reconciliationService: ReconciliationService,
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
    @Req() req: Request,
    @Query('customerId') customerId?: string,
    @Query('status') status?: string
  ): Promise<ArItem[]> {
    // B-02：财务台账行级可见范围（纳税主体 / 部门），SQL 层过滤
    return this.arService.listArs(customerId, status, actorFromRequest(req));
  }

  @CanCapability('finance_write')
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

  @CanCapability('finance_write')
  @Post('receipts')
  async createReceipt(@Body() dto: CreateReceiptDto): Promise<ReceiptItem> {
    return this.arService.createReceipt(dto);
  }

  @CanCapability('finance_write')
  @Post('receipts/:id/void')
  async voidReceipt(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<ReceiptItem> {
    return this.arService.voidReceipt(id);
  }

  @CanCapability('finance_write')
  @Post('ar-writeoffs')
  async arWriteoff(@Body() dto: ArWriteoffDto): Promise<ArItem> {
    return this.arService.writeoff(dto);
  }

  @FinanceRead()
  @Get('ar-writeoffs')
  async listArWriteoffs(@Query('arId') arId?: string) {
    return this.arService.listWriteoffs(arId);
  }

  @CanCapability('finance_write')
  @Post('ar-writeoffs/:id/reverse')
  async reverseArWriteoff(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReverseWriteoffDto,
  ): Promise<ArItem> {
    return this.arService.reverseWriteoff(id, dto.remark);
  }

  @FinanceRead()
  @Get('aging')
  async listAging(): Promise<AgingBucket[]> {
    return this.arService.listAging();
  }

  @FinanceRead()
  @Get('aps')
  async listAps(
    @Req() req: Request,
    @Query('supplierId') supplierId?: string,
    @Query('status') status?: string
  ): Promise<ApItem[]> {
    // B-02：财务台账行级可见范围（纳税主体 / 部门）
    return this.apService.listAps(supplierId, status, actorFromRequest(req));
  }

  @CanCapability('finance_write')
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

  @CanCapability('finance_write')
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

  @CanCapability('finance_write')
  @Post('payments')
  async createPayment(@Body() dto: CreatePaymentDto): Promise<PaymentItem> {
    return this.apService.createPayment(dto);
  }

  @CanCapability('finance_write')
  @Post('payments/:id/void')
  async voidPayment(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<PaymentItem> {
    return this.apService.voidPayment(id);
  }

  @CanCapability('finance_write')
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

  @CanCapability('finance_write')
  @Post('ap-writeoffs')
  async apWriteoff(@Body() dto: ApWriteoffDto): Promise<ApItem> {
    return this.apService.apWriteoff(dto);
  }

  @CanCapability('finance_write')
  @Post('ap-writeoffs/:id/reverse')
  async reverseApWriteoff(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReverseWriteoffDto,
  ): Promise<ApItem> {
    return this.apService.reverseWriteoff(id, dto.remark);
  }

  @FinanceRead()
  @Get('reconciliation/summary')
  reconSummary() {
    return this.reconciliationService.summary();
  }

  @FinanceRead()
  @Get('reconciliation/purchase-ap')
  reconPurchaseAp() {
    return this.reconciliationService.listPurchaseAp();
  }

  @FinanceRead()
  @Get('reconciliation/sales-ar')
  reconSalesAr() {
    return this.reconciliationService.listSalesAr();
  }

  @FinanceRead()
  @Get('reconciliation/receipt-writeoff')
  reconReceipt() {
    return this.reconciliationService.listReceiptWriteoff();
  }

  @CanCapability('finance_write')
  @Post('reconciliation/purchase-ap/:invoiceId/bind')
  async bindPurchaseAp(
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Body() dto: BindApDto,
  ) {
    await this.reconciliationService.bindPurchaseAp(invoiceId, dto.apId);
    return { ok: true };
  }

  @CanCapability('finance_write')
  @Post('reconciliation/purchase-ap/:invoiceId/unbind')
  async unbindPurchaseAp(
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
  ) {
    await this.reconciliationService.unbindPurchaseAp(invoiceId);
    return { ok: true };
  }

  @FinanceRead()
  @Get('invoices')
  async listInvoices(
    @Req() req: Request,
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
    // B-02：发票台账按纳税主体 / 部门行级过滤
    return this.invoiceService.listInvoices(
      contractId,
      direction,
      actorFromRequest(req)
    );
  }

  @CanCapability('finance_write')
  @Post('invoices')
  async createInvoice(@Body() dto: CreateInvoiceDto): Promise<InvoiceItem> {
    return this.invoiceService.createInvoice(dto);
  }

  @CanCapability('finance_write')
  @Post('invoices/:id/void')
  async voidInvoice(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request
  ): Promise<InvoiceItem> {
    const userId: string = req.userContext?.userId ?? 'anonymous';
    return this.invoiceService.voidInvoice(id, userId);
  }

  @CanCapability('finance_write')
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
