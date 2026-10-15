import type { InvoiceVerifyOutcome } from '@shared/api.interface';

/**
 * C-01 发票查验 Provider 抽象。
 *
 * 设计原则（与需求书 §3.1 C-01「查验适配层 InvoiceVerifyProvider（可插拔）」一致）：
 *   - 服务层只依赖此接口，不关心底层是税局直连、第三方服务商还是离线占位；
 *   - Provider 内部**不得抛未捕获异常**：任何网络/解析失败都应归一为
 *     `verified:false` 的结构化结论，由服务层落为 `failed`，保证「失败不阻断录入」；
 *   - 传给 Provider 的仅为最小发票要素，避免在外部实现里泄露整张发票实体。
 */
export interface InvoiceVerifyRequest {
  id: string;
  code: string;
  invoiceNo: string | null;
  invoiceType: string;
  direction: 'sales' | 'purchase';
  amount: number;
  taxAmount: number;
  taxRate: number;
  invoiceDate: string | null;
  buyerName: string | null;
  buyerUscc: string | null;
  sellerName: string | null;
  sellerUscc: string | null;
}

export interface InvoiceVerifyProvider {
  /** 实现编码：none / http-vendor / mock（测试专用，不出现在生产工厂） */
  readonly code: string;
  /** 查验一张发票，返回结构化结论（见上方「不得抛异常」约束） */
  verify(req: InvoiceVerifyRequest): Promise<InvoiceVerifyOutcome>;
}
