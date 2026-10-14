import { axiosForBackend } from '@client/src/platform/request';
import { ensureNotForbidden } from '@client/src/utils/api-error';
import type {
  AgingBucket,
  ApItem,
  ApWriteoffDto,
  ArItem,
  ArWriteoffDto,
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
  PaymentAction,
  PaymentItem,
  ReceiptItem,
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
  ensureNotForbidden(resp);
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
  ensureNotForbidden(resp);
  return resp.data;
}

export async function voidReceipt(id: string): Promise<ReceiptItem> {
  const resp = await axiosForBackend.post<ReceiptItem>(
    `/api/finance/receipts/${id}/void`
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function arWriteoff(dto: ArWriteoffDto): Promise<ArItem> {
  const resp = await axiosForBackend.post<ArItem>('/api/finance/ar-writeoffs', dto);
  ensureNotForbidden(resp);
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
  ensureNotForbidden(resp);
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
  ensureNotForbidden(resp);
  return resp.data;
}

export async function approvePayment(id: string, action: PaymentAction): Promise<PaymentItem> {
  const resp = await axiosForBackend.post<PaymentItem>(`/api/finance/payments/${id}/approve`, {
    action,
  });
  ensureNotForbidden(resp);
  return resp.data;
}

export async function voidPayment(id: string): Promise<PaymentItem> {
  const resp = await axiosForBackend.post<PaymentItem>(
    `/api/finance/payments/${id}/void`
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function apWriteoff(dto: ApWriteoffDto): Promise<ApItem> {
  const resp = await axiosForBackend.post<ApItem>('/api/finance/ap-writeoffs', dto);
  ensureNotForbidden(resp);
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
  ensureNotForbidden(resp);
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
  ensureNotForbidden(resp);
  return resp.data;
}

export async function voidInvoice(id: string): Promise<InvoiceItem> {
  const resp = await axiosForBackend.post<InvoiceItem>(
    `/api/finance/invoices/${id}/void`,
  );
  ensureNotForbidden(resp);
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
  ensureNotForbidden(resp);
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
  ensureNotForbidden(resp);
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
  ensureNotForbidden(resp);
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
  const resp = await axiosForBackend.get('/api/finance/reconciliation/summary');
  return resp.data as {
    purchaseUnlinked: number;
    salesUnlinked: number;
    receiptUnlinked: number;
    voidedRisk: number;
  };
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

export async function unbindPurchaseAp(invoiceId: string) {
  const resp = await axiosForBackend.post(
    `/api/finance/reconciliation/purchase-ap/${invoiceId}/unbind`,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function bindPurchaseAp(invoiceId: string, apId: string) {
  const resp = await axiosForBackend.post(
    `/api/finance/reconciliation/purchase-ap/${invoiceId}/bind`,
    { apId },
  );
  ensureNotForbidden(resp);
  return resp.data;
}
