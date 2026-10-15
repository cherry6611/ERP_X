import {
  HttpVendorInvoiceVerifyProvider,
  NoneInvoiceVerifyProvider,
  createInvoiceVerifyProvider,
  parseInvoiceText,
} from './invoice-verify.providers';
import { InvoiceVerifyService } from './invoice-verify.service';
import type {
  InvoiceVerifyOutcome,
  InvoiceVerifyStatus,
} from '@shared/api.interface';

describe('C-01 发票查验 · 纯逻辑单测', () => {
  describe('parseInvoiceText（电子发票要素提取）', () => {
    it('能从典型发票文本中解析出发票号码/金额/税额/销售方', () => {
      const text = [
        '增值税电子专用发票',
        '发票号码：24417000000123456789',
        '销售方名称：晟笙（重庆）科技有限公司',
        '销售方识别号：91500000MA5XXXXXXX',
        '价税合计：11300.00',
        '税额：1300.00',
      ].join('\n');

      const r = parseInvoiceText(text);
      expect(r.invoiceNo).toBe('24417000000123456789');
      expect(r.sellerName).toContain('晟笙');
      expect(r.sellerUscc).toBe('91500000MA5XXXXXXX');
      expect(r.amount).toBe(11300);
      expect(r.taxAmount).toBe(1300);
      expect(r.rawTextLength).toBeGreaterThan(0);
    });

    it('未识别字段返回 undefined 而非臆造（避免金额污染）', () => {
      const r = parseInvoiceText('无关文本 没有任何发票要素');
      expect(r.invoiceNo).toBeUndefined();
      expect(r.amount).toBeUndefined();
      expect(r.taxAmount).toBeUndefined();
    });
  });

  describe('mapOutcomeToFields（结论→状态映射，纯函数）', () => {
    const now = new Date('2026-03-15T10:00:00.000Z');

    it('source=none：无论 verified 与否都落 unverified，不制造虚假失败', () => {
      const f = InvoiceVerifyService.mapOutcomeToFields(
        { verified: false, source: 'none', message: '未接入查验' },
        now,
      );
      expect(f.verifyStatus).toBe<InvoiceVerifyStatus>('unverified');
      expect(f.verifyTime).toBeNull();
      expect(f.verifyError).toBeNull();
    });

    it('source=vendor 且 verified=true：verified，时间有值、错误为空', () => {
      const f = InvoiceVerifyService.mapOutcomeToFields(
        { verified: true, source: 'vendor', message: '税局查验一致' },
        now,
      );
      expect(f.verifyStatus).toBe('verified');
      expect(f.verifyTime).toBe(now);
      expect(f.verifyError).toBeNull();
    });

    it('source=vendor 且 verified=false：failed，时间有值、错误带原因', () => {
      const f = InvoiceVerifyService.mapOutcomeToFields(
        { verified: false, source: 'vendor', message: '税局无此发票记录' },
        now,
      );
      expect(f.verifyStatus).toBe('failed');
      expect(f.verifyTime).toBe(now);
      expect(f.verifyError).toBe('税局无此发票记录');
    });
  });

  describe('Provider 工厂与实现', () => {
    const prev = process.env.INVOICE_VERIFY_PROVIDER;
    afterEach(() => {
      if (prev === undefined) delete process.env.INVOICE_VERIFY_PROVIDER;
      else process.env.INVOICE_VERIFY_PROVIDER = prev;
    });

    it('默认（none）：不发起外部请求，如实返回未接入', async () => {
      delete process.env.INVOICE_VERIFY_PROVIDER;
      const p = createInvoiceVerifyProvider();
      expect(p).toBeInstanceOf(NoneInvoiceVerifyProvider);
      const out = await p.verify({ id: 'x', code: 'INV', invoiceNo: null, direction: 'purchase', invoiceType: 'vat_special', amount: 1, taxAmount: 0.06, taxRate: 6, invoiceDate: null, buyerName: null, buyerUscc: null, sellerName: null, sellerUscc: null });
      expect(out.verified).toBe(false);
      expect(out.source).toBe('none');
    });

    it('http-vendor：按环境变量构造，调用外部接口', async () => {
      process.env.INVOICE_VERIFY_PROVIDER = 'http-vendor';
      process.env.INVOICE_VERIFY_BASE_URL = 'https://verify.example.com';
      const p = createInvoiceVerifyProvider();
      expect(p).toBeInstanceOf(HttpVendorInvoiceVerifyProvider);
    });

    it('HttpVendorProvider：税局返回一致 → verified=true', async () => {
      const okJson = async () => ({
        ok: true,
        json: async () => ({ exists: true, consistent: true, message: '一致' }),
      } as unknown as Response);
      const spy = jest.spyOn(global, 'fetch').mockImplementation(okJson as never);
      const p = new HttpVendorInvoiceVerifyProvider({ baseUrl: 'https://v' });
      const out: InvoiceVerifyOutcome = await p.verify({ id: 'x', code: 'INV', invoiceNo: null, direction: 'purchase', invoiceType: 'vat_special', amount: 1, taxAmount: 0.06, taxRate: 6, invoiceDate: null, buyerName: null, buyerUscc: null, sellerName: null, sellerUscc: null });
      expect(out.verified).toBe(true);
      spy.mockRestore();
    });

    it('HttpVendorProvider：HTTP 非 2xx 或异常 → verified=false（失败不阻断）', async () => {
      const bad = async () => ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
      const spy = jest.spyOn(global, 'fetch').mockImplementation(bad as never);
      const p = new HttpVendorInvoiceVerifyProvider({ baseUrl: 'https://v' });
      const out = await p.verify({ id: 'x', code: 'INV', invoiceNo: null, direction: 'purchase', invoiceType: 'vat_special', amount: 1, taxAmount: 0.06, taxRate: 6, invoiceDate: null, buyerName: null, buyerUscc: null, sellerName: null, sellerUscc: null });
      expect(out.verified).toBe(false);
      expect(out.source).toBe('vendor');
      spy.mockRestore();
    });
  });
});
