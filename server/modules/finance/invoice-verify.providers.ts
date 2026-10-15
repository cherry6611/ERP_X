import type { InvoiceVerifyOutcome } from '@shared/api.interface';
import type { InvoiceVerifyProvider, InvoiceVerifyRequest } from './invoice-verify.types';

/** 生产工厂注入令牌（Nest 自定义 Provider） */
export const INVOICE_VERIFY_PROVIDER = 'INVOICE_VERIFY_PROVIDER';

/**
 * 未接入查验服务（默认）。
 *
 * 行为：不向外部发起任何请求，如实返回「未配置查验」。
 * 服务层据此把发票落为 `unverified`（注意：不是 `failed`——`none` 表示「没有尝试查验」，
 * `failed` 表示「尝试了但税局/第三方判定不通过或异常」，二者语义不同，前端需区分展示）。
 */
export class NoneInvoiceVerifyProvider implements InvoiceVerifyProvider {
  readonly code = 'none';
  async verify(_req: InvoiceVerifyRequest): Promise<InvoiceVerifyOutcome> {
    return {
      verified: false,
      source: 'none',
      message:
        '未接入发票查验服务（INVOICE_VERIFY_PROVIDER=none）：发票按未查验状态保留，可在接入第三方服务商后重新查验',
    };
  }
}

interface HttpVendorConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * 第三方查验服务商适配（如航信/百望聚合查验接口）。
 *
 * 容错契约：任何网络超时、HTTP 非 2xx、JSON 解析失败都归一为 `verified:false` 并带回原因，
 * 由服务层落 `failed`，**绝不抛异常阻断调用方**（需求书 C-01「失败不阻断录入只标记」）。
 */
export class HttpVendorInvoiceVerifyProvider implements InvoiceVerifyProvider {
  readonly code = 'http-vendor';
  private readonly cfg: HttpVendorConfig;

  constructor(cfg: HttpVendorConfig) {
    this.cfg = cfg;
  }

  async verify(req: InvoiceVerifyRequest): Promise<InvoiceVerifyOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.cfg.timeoutMs ?? 8000,
    );
    try {
      const res = await fetch(
        `${this.cfg.baseUrl.replace(/\/$/, '')}/v1/invoices/verify`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.cfg.apiKey
              ? { authorization: `Bearer ${this.cfg.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            invoiceCode: req.code,
            invoiceNo: req.invoiceNo,
            amount: req.amount,
            taxAmount: req.taxAmount,
            invoiceDate: req.invoiceDate,
            sellerUscc: req.sellerUscc,
            buyerUscc: req.buyerUscc,
          }),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        return {
          verified: false,
          source: 'vendor',
          message: `查验服务返回 HTTP ${res.status}`,
        };
      }
      const data = (await res.json()) as {
        exists?: boolean;
        consistent?: boolean;
        message?: string;
        details?: Record<string, unknown>;
      };
      const consistent = data.exists === true && data.consistent !== false;
      return {
        verified: consistent,
        source: 'vendor',
        message: consistent
          ? data.message ?? '税局查验一致'
          : data.message ?? '税局查验不一致或发票不存在',
        details: data.details,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        verified: false,
        source: 'vendor',
        message: `查验调用异常：${msg}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 电子发票要素解析（PDF/OFD 提取文本 → 结构化字段）。
 *
 * 用途：上传电子发票后「自动填充 80% 要素」（需求书 C-01③）。纯函数、无副作用，便于单测。
 * 正则仅做宽松匹配，未识别字段返回 undefined，由人工在界面补录——绝不臆造金额等关键信息。
 */
export function parseInvoiceText(
  text: string,
): Partial<InvoiceVerifyRequest> & { rawTextLength: number } {
  const pick = (re: RegExp): string | undefined => {
    const m = text.match(re);
    return m?.[1]?.trim();
  };
  const toNum = (s?: string): number | undefined => {
    if (!s) return undefined;
    const n = Number(s.replace(/,/g, ''));
    return Number.isFinite(n) ? n : undefined;
  };
  const amount = pick(/价税合计[^\d]*([\d,]+\.?\d*)/) ?? pick(/金额[^\d]*([\d,]+\.?\d*)/);
  const taxAmount = pick(/税额[^\d]*([\d,]+\.?\d*)/);
  return {
    invoiceNo:
      pick(/发票号码[：:\s]*([A-Za-z0-9]+)/) ??
      pick(/No[.\s]*([A-Za-z0-9]+)/i),
    sellerName:
      pick(/销售方名称[：:\s]*([^\n]+)/) ?? pick(/销售方[：:\s]*([^\n]+)/),
    buyerName:
      pick(/购买方名称[：:\s]*([^\n]+)/) ?? pick(/购买方[：:\s]*([^\n]+)/),
    sellerUscc:
      pick(/销售方识别号[：:\s]*([A-Za-z0-9]+)/) ??
      pick(/纳税人识别号[：:\s]*([A-Za-z0-9]+)/),
    buyerUscc: pick(/购买方识别号[：:\s]*([A-Za-z0-9]+)/),
    amount: toNum(amount),
    taxAmount: toNum(taxAmount),
    rawTextLength: text.length,
  };
}

/**
 * 生产工厂：按环境变量选择 Provider。
 *   - INVOICE_VERIFY_PROVIDER=none（默认）：不发起外部请求；
 *   - INVOICE_VERIFY_PROVIDER=http-vendor：读 INVOICE_VERIFY_BASE_URL / INVOICE_VERIFY_API_KEY / INVOICE_VERIFY_TIMEOUT_MS。
 */
export function createInvoiceVerifyProvider(): InvoiceVerifyProvider {
  const code = (process.env.INVOICE_VERIFY_PROVIDER ?? 'none').toLowerCase();
  switch (code) {
    case 'http-vendor':
      return new HttpVendorInvoiceVerifyProvider({
        baseUrl: process.env.INVOICE_VERIFY_BASE_URL ?? '',
        apiKey: process.env.INVOICE_VERIFY_API_KEY,
        timeoutMs: Number(process.env.INVOICE_VERIFY_TIMEOUT_MS ?? 8000) || 8000,
      });
    case 'none':
    default:
      return new NoneInvoiceVerifyProvider();
  }
}
