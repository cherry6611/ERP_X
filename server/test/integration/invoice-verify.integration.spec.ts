/**
 * C-01 发票查验与勾选认证 · 集成测试（需求书 C-01，pglite + 真实 InvoiceVerifyService）
 *
 * 覆盖：查验落库（verified/failed/unverified 三态）、勾选认证（certified/deducted + 期间校验）、
 * 作废发票拒绝查验/认证、批量查验逐张隔离、审计留痕。
 *
 * 与 accounting-chain.spec 同一套 pglite harness；不连接本地开发库。
 */
import { BadRequestException } from '@nestjs/common';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from '@server/platform';
import { InvoiceVerifyService } from '@server/modules/finance/invoice-verify.service';
import { AuditService } from '@server/modules/audit/audit.service';
import { erpInvoice } from '@server/database/schema';
import type {
  InvoiceVerifyProvider,
} from '@server/modules/finance/invoice-verify.types';
import type {
  BatchInvoiceVerifyDto,
  CertifyInvoiceDto,
  InvoiceVerifyOutcome,
} from '@shared/api.interface';
import { createHarness, type Harness } from './pglite-harness';

const FLOW_TIMEOUT_MS = 120_000;
const TEST_USER = 'c01-integration';

describe('C-01 发票查验与勾选认证（pglite 集成）', () => {
  let harness: Harness;
  let db: PGlite;
  let audit: AuditService;

  const providerFor = (outcome: InvoiceVerifyOutcome): InvoiceVerifyProvider => ({
    code: 'mock',
    verify: async () => outcome,
  });

  async function seedInvoice(
    code: string,
    opts: { direction?: 'sales' | 'purchase'; status?: string } = {},
  ): Promise<string> {
    const rows = await harness.orm
      .insert(erpInvoice)
      .values({
        code,
        direction: opts.direction ?? 'purchase',
        status: opts.status ?? 'issued',
        amount: '100',
        taxRate: '6',
        taxAmount: '6',
      })
      .returning({ id: erpInvoice.id });
    return rows[0].id;
  }

  async function getRow(id: string) {
    const rows = await harness.orm
      .select()
      .from(erpInvoice)
      .where(eq(erpInvoice.id, id))
      .limit(1);
    return rows[0];
  }

  function makeService(outcome: InvoiceVerifyOutcome): InvoiceVerifyService {
    return new InvoiceVerifyService(
      harness.orm as unknown as PostgresJsDatabase,
      audit,
      providerFor(outcome),
    );
  }

  beforeAll(async () => {
    harness = await createHarness();
    db = harness.db;
    audit = new AuditService(harness.orm as unknown as PostgresJsDatabase);
  }, FLOW_TIMEOUT_MS);

  afterAll(async () => {
    await harness?.close();
  });

  it('查验通过：verifyStatus=verified 且 verify_error 为空', async () => {
    const id = await seedInvoice('INV-C01-VERIFIED');
    const svc = makeService({
      verified: true,
      source: 'vendor',
      message: '税局查验一致',
    });
    const res = await svc.verifyInvoice(id, {
      userId: TEST_USER,
      userName: TEST_USER,
      roles: ['finance'],
    });
    expect(res.verifyStatus).toBe('verified');

    const row = await getRow(id);
    expect(row.verifyStatus).toBe('verified');
    expect(row.verifyError).toBeNull();
    expect(row.verifyTime).not.toBeNull();
  });

  it('查验失败：verifyStatus=failed 且 verify_error 带回原因（失败不阻断）', async () => {
    const id = await seedInvoice('INV-C01-FAILED');
    const svc = makeService({
      verified: false,
      source: 'vendor',
      message: '税局无此发票记录',
    });
    const res = await svc.verifyInvoice(id, {
      userId: TEST_USER,
      userName: TEST_USER,
      roles: ['finance'],
    });
    expect(res.verifyStatus).toBe('failed');

    const row = await getRow(id);
    expect(row.verifyStatus).toBe('failed');
    expect(row.verifyError).toBe('税局无此发票记录');
  });

  it('未接入查验（none）：verifyStatus=unverified，不制造虚假失败', async () => {
    const id = await seedInvoice('INV-C01-NONE');
    const svc = makeService({
      verified: false,
      source: 'none',
      message: '未接入查验服务',
    });
    const res = await svc.verifyInvoice(id, {
      userId: TEST_USER,
      userName: TEST_USER,
      roles: ['finance'],
    });
    expect(res.verifyStatus).toBe('unverified');

    const row = await getRow(id);
    expect(row.verifyStatus).toBe('unverified');
    expect(row.verifyError).toBeNull();
  });

  it('作废发票不可查验（直接拒绝，不依赖 Provider）', async () => {
    const id = await seedInvoice('INV-C01-VOID', { status: 'voided' });
    const svc = makeService({
      verified: true,
      source: 'vendor',
      message: 'x',
    });
    await expect(
      svc.verifyInvoice(id, {
        userId: TEST_USER,
        userName: TEST_USER,
        roles: ['finance'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('勾选认证：certified + 期间落库；无效期间被拒', async () => {
    const id = await seedInvoice('INV-C01-CERT');
    const svc = makeService({
      verified: true,
      source: 'vendor',
      message: 'x',
    });
    const dto: CertifyInvoiceDto = {
      certificationPeriod: '2026-03',
      action: 'certify',
    };
    const view = await svc.certifyInvoice(id, dto, {
      userId: TEST_USER,
      userName: TEST_USER,
      roles: ['finance'],
    });
    expect(view.certificationStatus).toBe('certified');
    expect(view.certificationPeriod).toBe('2026-03');

    const bad: CertifyInvoiceDto = { certificationPeriod: '2026-13' };
    await expect(
      svc.certifyInvoice(id, bad, {
        userId: TEST_USER,
        userName: TEST_USER,
        roles: ['finance'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('勾选认证可标记已抵扣（action=deduct）', async () => {
    const id = await seedInvoice('INV-C01-DEDUCT');
    const svc = makeService({
      verified: true,
      source: 'vendor',
      message: 'x',
    });
    const view = await svc.certifyInvoice(
      id,
      { certificationPeriod: '2026-04', action: 'deduct' },
      { userId: TEST_USER, userName: TEST_USER, roles: ['finance'] },
    );
    expect(view.certificationStatus).toBe('deducted');
  });

  it('批量查验：逐张隔离，单张作废/不存在不影响其余', async () => {
    const okId = await seedInvoice('INV-C01-B1');
    const voidId = await seedInvoice('INV-C01-B2', { status: 'voided' });
    const svc = makeService({
      verified: true,
      source: 'vendor',
      message: '税局查验一致',
    });
    const dto: BatchInvoiceVerifyDto = {
      ids: [okId, voidId, '00000000-0000-0000-0000-000000000000'],
    };
    const res = await svc.batchVerify(dto, {
      userId: TEST_USER,
      userName: TEST_USER,
      roles: ['finance'],
    });
    expect(res.total).toBe(3);
    expect(res.success).toBe(1);
    expect(res.skipped).toBe(2);
    expect((await getRow(okId)).verifyStatus).toBe('verified');
  });

  it('审计留痕：查验动作写入 comp_audit_log', async () => {
    const id = await seedInvoice('INV-C01-AUDIT');
    const svc = makeService({
      verified: true,
      source: 'vendor',
      message: '税局查验一致',
    });
    await svc.verifyInvoice(id, {
      userId: TEST_USER,
      userName: TEST_USER,
      roles: ['finance'],
    });
    const auditRows = await db.query(
      'SELECT action, object_code FROM comp_audit_log WHERE object_code = $1 ORDER BY _created_at DESC LIMIT 1',
      ['INV-C01-AUDIT'],
    );
    const auditRow = auditRows.rows[0] as { action: string; object_code: string };
    expect(auditRows.rows.length).toBeGreaterThan(0);
    expect(auditRow.action).toBe('invoice_verify');
    expect(auditRow.object_code).toBe('INV-C01-AUDIT');
  });
});
