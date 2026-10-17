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
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
} from 'class-validator';
import { ArService } from './ar.service';
import { ApService } from './ap.service';
import { CashFlowService } from './cash-flow.service';
import { InvoiceService } from './invoice.service';
import { InvoiceVerifyService } from './invoice-verify.service';
import { FinanceService } from './finance.service';
import { VendorSettlementService } from './vendor-settlement.service';
import { ReconciliationService } from './reconciliation.service';
import { StatementService } from './statement.service';
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
  StatementCounterpartyOption,
  StatementDirection,
  StatementQueryDto as IStatementQueryDto,
  StatementResult,
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
  CertifyInvoiceDto,
  BatchInvoiceVerifyDto,
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

/**
 * B1 / P0-C：作废原因。
 *
 * 作废是**不可逆**动作（单据退出资金/申报口径），必须留下"为什么"。
 * 允许为空（兼容既有前端调用），但服务端会把空值落为「未填写作废原因」
 * 而不是 NULL —— 事后看到 NULL 无法区分"没填"和"没走这条路径"。
 */
export class VoidReasonDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * P0-C / P0-D：红字发票登记（销售退货 / 收入冲回 / 采购退货）。
 *
 * 金额一律传**正数**，服务端按负数落账 —— 让调用方不必记住符号约定，
 * 也避免"传了负数又被取绝对值"这类双向歧义。
 */
export class CreateRedLetterInvoiceDto {
  @IsIn(['sales', 'purchase'], { message: 'direction 仅支持 sales / purchase' })
  direction!: 'sales' | 'purchase';

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  taxRate!: number;

  @IsString()
  @Length(1, 100)
  sourceRef!: string;

  @IsOptional()
  @IsDateString()
  invoiceDate?: string;

  @IsOptional()
  @IsUUID()
  contractId?: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsUUID()
  taxEntityId?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

/**
 * C-11 对账单查询参数。
 *
 * 虽然没有 `@Body()`，仍按 API-1 用 class DTO 承载 `@Query()`，
 * 这样校验规则与契约同源（禁止内联对象类型 / interface）。
 * 期间用 `@Matches` 保证 `YYYY-MM`（与 `statement.logic.ts` 的正则一致）。
 */
export class StatementQueryDto implements IStatementQueryDto {
  @IsUUID()
  counterpartyId!: string;

  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period 必须为 YYYY-MM' })
  period!: string;

  @IsIn(['customer', 'supplier'], { message: 'direction 仅支持 customer / supplier' })
  direction!: StatementDirection;
}

/**
 * P0-4 / P1-1：勾稽中心期间查询参数。
 * 按 API-1 用 class DTO 承载 `@Query()`，校验规则与契约同源。
 */
export class ReconPeriodQueryDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period 必须为 YYYY-MM' })
  period!: string;
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
    private readonly statementService: StatementService,
    private readonly invoiceVerifyService: InvoiceVerifyService,
  ) {}

  /* ==================== C-11 客户/供应商对账单 ====================
   *
   * 路径刻意用 `statement-*` 前缀，**不占用** `reconciliation/*`：
   * 后者是内部三方勾稽，本组接口是给对手方确认的对账单，语义不同不可混用。
   */

  @FinanceRead()
  @Get('statement-customers')
  async listStatementCustomers(): Promise<StatementCounterpartyOption[]> {
    return this.statementService.listCounterparties('customer');
  }

  @FinanceRead()
  @Get('statement-suppliers')
  async listStatementSuppliers(): Promise<StatementCounterpartyOption[]> {
    return this.statementService.listCounterparties('supplier');
  }

  @FinanceRead()
  @Get('statement/customer')
  async getCustomerStatement(
    @Req() req: Request,
    @Query() query: StatementQueryDto
  ): Promise<StatementResult> {
    // B-02：对账单按对手方暴露全部发生额，必须在 service 内做行级校验（越权 403）
    return this.statementService.getCustomerStatement(
      query.counterpartyId,
      query.period,
      actorFromRequest(req)
    );
  }

  @FinanceRead()
  @Get('statement/supplier')
  async getSupplierStatement(
    @Req() req: Request,
    @Query() query: StatementQueryDto
  ): Promise<StatementResult> {
    return this.statementService.getSupplierStatement(
      query.counterpartyId,
      query.period,
      actorFromRequest(req)
    );
  }

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

  /**
   * B1：作废应收（终态，不可逆）。
   *
   * 前置条件：`settledAmount = 0`、无有效发票引用；作废与红字凭证同事务。
   * 这是本报告列为最高优先级业务风险的那一项 —— 在此之前，误录的应收
   * **没有任何退出路径**，唯一"解法"是伪造一笔回款核销（把录入错误升级为
   * 人为掩盖）。前端在 `status='voided'` 或无权限时隐藏/禁用该按钮。
   */
  @CanCapability('finance_write')
  @Post('ars/:id/void')
  async voidAr(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Body() dto: VoidReasonDto
  ): Promise<ArItem> {
    return this.arService.voidAr(
      id,
      req.userContext?.userId ?? 'anonymous',
      dto.reason
    );
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

  /**
   * B1：作废应付（终态，不可逆）。与 `ars/:id/void` 同源问题、同套修法。
   *
   * 前置条件：`paidAmount = 0`、无未作废付款单、无有效进项发票引用。
   */
  @CanCapability('finance_write')
  @Post('aps/:id/void')
  async voidAp(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Body() dto: VoidReasonDto
  ): Promise<ApItem> {
    return this.apService.voidAp(
      id,
      req.userContext?.userId ?? 'anonymous',
      dto.reason
    );
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

  /** P1-1：应收已登记但一张发票也没开（反向缺口） */
  @FinanceRead()
  @Get('reconciliation/ar-without-invoice')
  reconArWithoutInvoice() {
    return this.reconciliationService.listArWithoutInvoice();
  }

  /** P0-4 / P1-1：总账收入 vs 收入台账 差异检测 */
  @FinanceRead()
  @Get('reconciliation/revenue-variance')
  reconRevenueVariance(@Query() query: ReconPeriodQueryDto) {
    return this.reconciliationService.revenueVariance(query.period);
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
    @Req() req: Request,
    @Body() dto: VoidReasonDto
  ): Promise<InvoiceItem> {
    const userId: string = req.userContext?.userId ?? 'anonymous';
    return this.invoiceService.voidInvoice(id, userId, dto.reason);
  }

  /**
   * P0-C / P0-D：登记红字发票（负数发票）。
   *
   * 退货与收入冲回原先只出红字凭证、不出红字发票，导致底稿销项不冲减
   * （多缴）且每月必报 `output_mismatch`（告警疲劳）。本接口让票与账重新对齐。
   * 幂等键为 `sourceRef`（同一来源单据重复调用返回既有红字发票）。
   */
  @CanCapability('finance_write')
  @Post('invoices/red-letter')
  async createRedLetterInvoice(
    @Body() dto: CreateRedLetterInvoiceDto,
    @Req() req: Request
  ): Promise<InvoiceItem> {
    return this.invoiceService.createRedLetterInvoice(
      {
        direction: dto.direction,
        amount: dto.amount,
        taxRate: dto.taxRate,
        sourceRef: dto.sourceRef,
        invoiceDate: dto.invoiceDate,
        contractId: dto.contractId ?? null,
        customerId: dto.customerId ?? null,
        supplierId: dto.supplierId ?? null,
        projectId: dto.projectId ?? null,
        taxEntityId: dto.taxEntityId ?? null,
        remark: dto.remark,
      },
      req.userContext?.userId ?? 'anonymous'
    );
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

  /* ==================== C-01 发票查验与勾选认证 ==================== */

  /** 单张发票查验：调用可插拔 Provider，落查验状态（失败只标记不阻断） */
  @CanCapability('finance_write')
  @Post('invoices/:id/verify')
  async verifyInvoice(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request
  ) {
    return this.invoiceVerifyService.verifyInvoice(id, actorFromRequest(req));
  }

  /** 批量查验：逐张隔离，单张失败不影响其余 */
  @CanCapability('finance_write')
  @Post('invoices/batch-verify')
  async batchVerifyInvoice(
    @Body() dto: BatchInvoiceVerifyDto,
    @Req() req: Request
  ) {
    return this.invoiceVerifyService.batchVerify(dto, actorFromRequest(req));
  }

  /** 勾选认证 / 标记已抵扣：独立于查验，仅校验期间格式 */
  @CanCapability('finance_write')
  @Post('invoices/:id/certify')
  async certifyInvoice(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CertifyInvoiceDto,
    @Req() req: Request
  ) {
    return this.invoiceVerifyService.certifyInvoice(id, dto, actorFromRequest(req));
  }

  /** 查询单张发票查验/认证状态 */
  @FinanceRead()
  @Get('invoices/:id/verify-status')
  async getInvoiceVerifyStatus(
    @Param('id', ParseUUIDPipe) id: string
  ) {
    return this.invoiceVerifyService.getVerifyStatus(id);
  }

  @FinanceRead()
  @Get('summary')
  async getSummary(): Promise<FinanceSummary> {
    return this.financeService.getSummary();
  }
}
