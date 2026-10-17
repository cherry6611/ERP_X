import { axiosForBackend } from '@client/src/platform/request';
import type {
  AgingBucket,
  ApItem,
  ApWriteoffDto,
  ArItem,
  ArWriteoffDto,
  BatchInvoiceVerifyDto,
  BatchInvoiceVerifyResult,
  CertifyInvoiceDto,
  CashFlowForecast,
  CreateApDto,
  CreateArDto,
  CreateInvoiceDto,
  CreatePaymentDto,
  CreateReceiptDto,
  FinanceSummary,
  GenerateVendorSettlementDto,
  GenerateVendorSettlementResult,
  InvoiceDirection,
  InvoiceItem,
  InvoiceVerifyResult,
  InvoiceVerifyStatusView,
  PaymentAction,
  PaymentItem,
  ReceiptItem,
  ReconRowItem,
  ReconSummary,
  RevenueVariance,
  StatementCounterpartyOption,
  StatementDirection,
  StatementResult,
  UpdateInvoiceDto,
  VendorSettlementPreview,
} from '@shared/api.interface';

export async function listArs(customerId?: string, status?: string): Promise<ArItem[]> {
  const resp = await axiosForBackend.get<ArItem[]>('/api/finance/ars', {
    params: { customerId, status },
  });
  return resp.data;
}

export async function createAr(dto: CreateArDto): Promise<ArItem> {
  const resp = await axiosForBackend.post<ArItem>('/api/finance/ars', dto);
  return resp.data;
}

export async function listReceipts(customerId?: string): Promise<ReceiptItem[]> {
  const resp = await axiosForBackend.get<ReceiptItem[]>('/api/finance/receipts', {
    params: customerId ? { customerId } : undefined,
  });
  return resp.data;
}

export async function createReceipt(dto: CreateReceiptDto): Promise<ReceiptItem> {
  const resp = await axiosForBackend.post<ReceiptItem>('/api/finance/receipts', dto);
  return resp.data;
}

export async function voidReceipt(id: string): Promise<ReceiptItem> {
  const resp = await axiosForBackend.post<ReceiptItem>(
    `/api/finance/receipts/${id}/void`
  );
  return resp.data;
}

export async function arWriteoff(dto: ArWriteoffDto): Promise<ArItem> {
  const resp = await axiosForBackend.post<ArItem>('/api/finance/ar-writeoffs', dto);
  return resp.data;
}

export async function getAging(): Promise<AgingBucket[]> {
  const resp = await axiosForBackend.get<AgingBucket[]>('/api/finance/aging');
  return resp.data;
}

export async function listAps(supplierId?: string, status?: string): Promise<ApItem[]> {
  const resp = await axiosForBackend.get<ApItem[]>('/api/finance/aps', {
    params: { supplierId, status },
  });
  return resp.data;
}

export async function createAp(dto: CreateApDto): Promise<ApItem> {
  const resp = await axiosForBackend.post<ApItem>('/api/finance/aps', dto);
  return resp.data;
}

export async function listPayments(apId?: string): Promise<PaymentItem[]> {
  const resp = await axiosForBackend.get<PaymentItem[]>('/api/finance/payments', {
    params: apId ? { apId } : undefined,
  });
  return resp.data;
}

export async function createPayment(dto: CreatePaymentDto): Promise<PaymentItem> {
  const resp = await axiosForBackend.post<PaymentItem>('/api/finance/payments', dto);
  return resp.data;
}

export async function approvePayment(id: string, action: PaymentAction): Promise<PaymentItem> {
  const resp = await axiosForBackend.post<PaymentItem>(`/api/finance/payments/${id}/approve`, {
    action,
  });
  return resp.data;
}

export async function voidPayment(id: string): Promise<PaymentItem> {
  const resp = await axiosForBackend.post<PaymentItem>(
    `/api/finance/payments/${id}/void`
  );
  return resp.data;
}

export async function apWriteoff(dto: ApWriteoffDto): Promise<ApItem> {
  const resp = await axiosForBackend.post<ApItem>('/api/finance/ap-writeoffs', dto);
  return resp.data;
}

export async function listInvoices(
  contractId?: string,
  direction?: InvoiceDirection,
): Promise<InvoiceItem[]> {
  const resp = await axiosForBackend.get<InvoiceItem[]>('/api/finance/invoices', {
    params: contractId || direction ? { contractId, direction } : undefined,
  });
  return resp.data;
}

export async function createInvoice(dto: CreateInvoiceDto): Promise<InvoiceItem> {
  const resp = await axiosForBackend.post<InvoiceItem>('/api/finance/invoices', dto);
  return resp.data;
}

export async function getFinanceSummary(): Promise<FinanceSummary> {
  const resp = await axiosForBackend.get<FinanceSummary>('/api/finance/summary');
  return resp.data;
}

export async function cashFlowForecast(weeks = 13): Promise<CashFlowForecast> {
  const resp = await axiosForBackend.get<CashFlowForecast>(
    '/api/finance/cash-flow/forecast',
    { params: { weeks } },
  );
  return resp.data;
}

export async function updateInvoice(id: string, dto: UpdateInvoiceDto): Promise<InvoiceItem> {
  const resp = await axiosForBackend.patch<InvoiceItem>(
    `/api/finance/invoices/${id}`,
    dto,
  );
  return resp.data;
}

export async function voidInvoice(id: string): Promise<InvoiceItem> {
  const resp = await axiosForBackend.post<InvoiceItem>(
    `/api/finance/invoices/${id}/void`,
  );
  return resp.data;
}

/* ===================== C-01 发票查验与勾选认证 ===================== */

/** 单张发票查验 */
export async function verifyInvoice(id: string): Promise<InvoiceVerifyResult> {
  const resp = await axiosForBackend.post<InvoiceVerifyResult>(
    `/api/finance/invoices/${id}/verify`,
  );
  return resp.data;
}

/** 批量查验（逐张隔离，单张失败不影响其余） */
export async function batchVerifyInvoice(
  ids: string[],
): Promise<BatchInvoiceVerifyResult> {
  const dto: BatchInvoiceVerifyDto = { ids };
  const resp = await axiosForBackend.post<BatchInvoiceVerifyResult>(
    '/api/finance/invoices/batch-verify',
    dto,
  );
  return resp.data;
}

/** 勾选认证 / 标记已抵扣 */
export async function certifyInvoice(
  id: string,
  certificationPeriod: string,
  action?: 'certify' | 'deduct',
): Promise<InvoiceVerifyStatusView> {
  const dto: CertifyInvoiceDto = { certificationPeriod, action };
  const resp = await axiosForBackend.post<InvoiceVerifyStatusView>(
    `/api/finance/invoices/${id}/certify`,
    dto,
  );
  return resp.data;
}

/** 查询单张发票查验/认证状态 */
export async function getInvoiceVerifyStatus(
  id: string,
): Promise<InvoiceVerifyStatusView> {
  const resp = await axiosForBackend.get<InvoiceVerifyStatusView>(
    `/api/finance/invoices/${id}/verify-status`,
  );
  return resp.data;
}

export async function vendorSettlementPreview(
  supplierId: string,
  period: string,
  projectId?: string,
): Promise<VendorSettlementPreview> {
  const resp = await axiosForBackend.get<VendorSettlementPreview>(
    '/api/finance/vendor-settlement/preview',
    { params: { supplierId, period, projectId } },
  );
  return resp.data;
}

export async function generateVendorSettlement(
  dto: GenerateVendorSettlementDto,
): Promise<GenerateVendorSettlementResult> {
  const resp = await axiosForBackend.post<GenerateVendorSettlementResult>(
    '/api/finance/vendor-settlement/generate',
    dto,
  );
  return resp.data;
}

export async function reverseArWriteoff(
  id: string,
  remark?: string,
): Promise<ArItem> {
  const resp = await axiosForBackend.post<ArItem>(
    `/api/finance/ar-writeoffs/${id}/reverse`,
    { remark },
  );
  return resp.data;
}

export async function reverseApWriteoff(
  id: string,
  remark?: string,
): Promise<ApItem> {
  const resp = await axiosForBackend.post<ApItem>(
    `/api/finance/ap-writeoffs/${id}/reverse`,
    { remark },
  );
  return resp.data;
}

export async function listArWriteoffs(arId?: string) {
  const resp = await axiosForBackend.get('/api/finance/ar-writeoffs', {
    params: arId ? { arId } : undefined,
  });
  return resp.data as Array<{
    id: string;
    arId: string;
    receiptId: string;
    amount: number;
    writeoffDate: string | null;
    reversalOf: string | null;
    remark: string | null;
  }>;
}

export async function reconSummary() {
  const resp = await axiosForBackend.get<ReconSummary>(
    '/api/finance/reconciliation/summary',
  );
  return resp.data;
}

export async function reconPurchaseAp() {
  const resp = await axiosForBackend.get(
    '/api/finance/reconciliation/purchase-ap',
  );
  return resp.data;
}

export async function reconSalesAr() {
  const resp = await axiosForBackend.get('/api/finance/reconciliation/sales-ar');
  return resp.data;
}

export async function reconReceiptWriteoff() {
  const resp = await axiosForBackend.get(
    '/api/finance/reconciliation/receipt-writeoff',
  );
  return resp.data;
}

/** P1-1：应收已登记但未开票明细（反向缺口） */
export async function reconArWithoutInvoice() {
  const resp = await axiosForBackend.get<ReconRowItem[]>(
    '/api/finance/reconciliation/ar-without-invoice',
  );
  return resp.data;
}

/** P0-4 / P1-1：总账收入 vs 收入台账 差异检测 */
export async function reconRevenueVariance(period: string) {
  const resp = await axiosForBackend.get<RevenueVariance>(
    '/api/finance/reconciliation/revenue-variance',
    { params: { period } },
  );
  return resp.data;
}

export async function unbindPurchaseAp(invoiceId: string) {
  const resp = await axiosForBackend.post(
    `/api/finance/reconciliation/purchase-ap/${invoiceId}/unbind`,
  );
  return resp.data;
}

export async function bindPurchaseAp(invoiceId: string, apId: string) {
  const resp = await axiosForBackend.post(
    `/api/finance/reconciliation/purchase-ap/${invoiceId}/bind`,
    { apId },
  );
  return resp.data;
}

/* ==================== C-11 客户/供应商对账单 ====================
 *
 * 与 `recon*`（内部三方勾稽）区分：这里是给对手方确认的对账单。
 */

/** 可选对手方（只列有业务的），direction 决定查客户还是供应商 */
export async function listStatementCounterparties(
  direction: StatementDirection,
): Promise<StatementCounterpartyOption[]> {
  const path =
    direction === 'customer'
      ? '/api/finance/statement-customers'
      : '/api/finance/statement-suppliers';
  const resp = await axiosForBackend.get<StatementCounterpartyOption[]>(path);
  return resp.data;
}

/** 客户对账单（`erp_ar` + `erp_receipt` + 销项发票） */
export async function getCustomerStatement(
  counterpartyId: string,
  period: string,
): Promise<StatementResult> {
  const resp = await axiosForBackend.get<StatementResult>(
    '/api/finance/statement/customer',
    { params: { counterpartyId, period, direction: 'customer' } },
  );
  return resp.data;
}

/** 供应商对账单（`erp_ap_bill` + `erp_payment` + 进项发票） */
export async function getSupplierStatement(
  counterpartyId: string,
  period: string,
): Promise<StatementResult> {
  const resp = await axiosForBackend.get<StatementResult>(
    '/api/finance/statement/supplier',
    { params: { counterpartyId, period, direction: 'supplier' } },
  );
  return resp.data;
}
