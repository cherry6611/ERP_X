import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { eq } from 'drizzle-orm';
import { erpInvoice } from '@server/database/schema';
import { AuditService } from '@server/modules/audit/audit.service';
import type {
  BatchInvoiceVerifyDto,
  BatchInvoiceVerifyResult,
  CertifyInvoiceDto,
  InvoiceCertificationStatus,
  InvoiceVerifyOutcome,
  InvoiceVerifyResult,
  InvoiceVerifyStatus,
  InvoiceVerifyStatusView,
} from '@shared/api.interface';
import type { RequestActor } from '@server/common/auth/actor';
import {
  INVOICE_VERIFY_PROVIDER,
  createInvoiceVerifyProvider,
} from './invoice-verify.providers';
import type { InvoiceVerifyProvider, InvoiceVerifyRequest } from './invoice-verify.types';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

type InvoiceRow = typeof erpInvoice.$inferSelect;

/**
 * C-01：发票查验与勾选认证服务。
 *
 * 边界与异常（与需求书 §3.1 C-01 对齐）：
 *   - 作废发票（status='voided'）不可查验/认证，直接拒绝；
 *   - Provider 调用失败**不阻断**：归一为 `failed` 状态并记录原因，录入链路照常；
 *   - 单张发票查验失败/不存在，不影响批量中其余发票（逐张隔离 + 汇总）；
 *   - 勾选认证仅校验期间格式，认证状态独立于查验（未查验也可人工勾选）；
 *   - 所有写操作通过 AuditService 留痕（DoD #8）。
 */
@Injectable()
export class InvoiceVerifyService {
  private readonly logger = new Logger(InvoiceVerifyService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly audit: AuditService,
    @Inject(INVOICE_VERIFY_PROVIDER)
    private readonly provider: InvoiceVerifyProvider = createInvoiceVerifyProvider(),
  ) {}

  /** 纯函数：把 Provider 结论映射为发票查验字段。单独抽出便于单测，不触库、不依赖时钟注入 */
  static mapOutcomeToFields(
    outcome: InvoiceVerifyOutcome,
    now: Date,
  ): {
    verifyStatus: InvoiceVerifyStatus;
    verifyTime: Date | null;
    verifyError: string | null;
  } {
    if (outcome.source === 'none') {
      // 未接入查验：保持"未查验"，不制造虚假的失败
      return { verifyStatus: 'unverified', verifyTime: null, verifyError: null };
    }
    if (outcome.verified) {
      return {
        verifyStatus: 'verified',
        verifyTime: now,
        verifyError: null,
      };
    }
    return {
      verifyStatus: 'failed',
      verifyTime: now,
      verifyError: outcome.message,
    };
  }

  private toVerifyRequest(row: InvoiceRow): InvoiceVerifyRequest {
    return {
      id: row.id,
      code: row.code,
      invoiceNo: row.invoiceNo,
      invoiceType: row.invoiceType ?? 'vat_special',
      direction: (row.direction ?? 'sales') as 'sales' | 'purchase',
      amount: Number(row.amount ?? 0),
      taxAmount: Number(row.taxAmount ?? 0),
      taxRate: Number(row.taxRate ?? 0),
      invoiceDate: row.invoiceDate ?? null,
      buyerName: row.buyerName ?? null,
      buyerUscc: row.buyerUscc ?? null,
      sellerName: row.sellerName ?? null,
      sellerUscc: row.sellerUscc ?? null,
    };
  }

  private toStatusView(row: InvoiceRow): InvoiceVerifyStatusView {
    return {
      id: row.id,
      code: row.code,
      direction: (row.direction ?? 'sales') as 'sales' | 'purchase',
      status: (row.status ?? 'issued') as InvoiceVerifyStatusView['status'],
      verifyStatus: (row.verifyStatus ?? 'unverified') as InvoiceVerifyStatus,
      verifyTime: row.verifyTime ? new Date(row.verifyTime).toISOString() : null,
      verifyError: row.verifyError ?? null,
      certificationStatus: (row.certificationStatus ??
        'uncertified') as InvoiceCertificationStatus,
      certificationPeriod: row.certificationPeriod ?? null,
      certifiedAt: row.certifiedAt ? new Date(row.certifiedAt).toISOString() : null,
    };
  }

  private async loadInvoice(id: string): Promise<InvoiceRow | undefined> {
    const rows = await this.db
      .select()
      .from(erpInvoice)
      .where(eq(erpInvoice.id, id))
      .limit(1);
    return rows[0];
  }

  /** 单张发票查验 */
  async verifyInvoice(
    id: string,
    actor?: RequestActor,
  ): Promise<InvoiceVerifyResult> {
    const row = await this.loadInvoice(id);
    if (!row) throw new NotFoundException('发票记录不存在');
    if (row.status === 'voided') {
      throw new BadRequestException('作废发票不可查验');
    }

    const req = this.toVerifyRequest(row);
    // Provider 内部已保证不抛异常；此处再包一层以防万一（绝不阻断）
    let outcome: InvoiceVerifyOutcome;
    try {
      outcome = await this.provider.verify(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outcome = { verified: false, source: 'none', message: `查验异常：${msg}` };
      this.logger.warn(`发票 ${row.code} 查验 Provider 异常：${msg}`);
    }

    const now = new Date();
    const fields = InvoiceVerifyService.mapOutcomeToFields(outcome, now);
    await this.db
      .update(erpInvoice)
      .set({
        verifyStatus: fields.verifyStatus,
        verifyTime: fields.verifyTime,
        verifyError: fields.verifyError,
      })
      .where(eq(erpInvoice.id, id));

    const actorName = actor?.userName ?? actor?.userId ?? 'system';
    await this.audit.record({
      actor: actorName,
      action: 'invoice_verify',
      objectType: 'erp_invoice',
      objectId: row.id,
      objectCode: row.code,
      detail: JSON.stringify({
        provider: this.provider.code,
        source: outcome.source,
        verifyStatus: fields.verifyStatus,
        message: outcome.message,
      }),
    });

    return {
      id: row.id,
      code: row.code,
      verifyStatus: fields.verifyStatus,
      verifyTime: fields.verifyTime ? fields.verifyTime.toISOString() : null,
      verifyError: fields.verifyError,
      source: outcome.source,
      message: outcome.message,
    };
  }

  /** 批量查验：逐张隔离，单张失败/不存在不影响其余 */
  async batchVerify(
    dto: BatchInvoiceVerifyDto,
    actor?: RequestActor,
  ): Promise<BatchInvoiceVerifyResult> {
    const ids = Array.from(new Set(dto.ids)).slice(0, 200);
    const result: BatchInvoiceVerifyResult = {
      total: ids.length,
      success: 0,
      failed: 0,
      skipped: 0,
      items: [],
    };

    for (const id of ids) {
      try {
        const row = await this.loadInvoice(id);
        if (!row) {
          result.skipped += 1;
          result.items.push({
            id,
            code: id,
            verifyStatus: 'unverified',
            message: '发票不存在',
          });
          continue;
        }
        if (row.status === 'voided') {
          result.skipped += 1;
          result.items.push({
            id: row.id,
            code: row.code,
            verifyStatus: 'unverified',
            message: '作废发票不参与查验',
          });
          continue;
        }
        const res = await this.verifyInvoice(id, actor);
        if (res.verifyStatus === 'failed') result.failed += 1;
        else result.success += 1;
        result.items.push({
          id: res.id,
          code: res.code,
          verifyStatus: res.verifyStatus,
          message: res.message,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.failed += 1;
        result.items.push({
          id,
          code: id,
          verifyStatus: 'failed',
          message: msg,
        });
      }
    }
    return result;
  }

  /**
   * 勾选认证（或标记已抵扣）。独立于查验，仅校验期间格式。
   *
   * P0-A 附带缺陷修正：**只有进项（`direction='purchase'`）发票才可以被勾选认证**。
   * 原实现只校验了状态与期间格式，于是销项发票也能被标记成 `certified` / `deducted`
   * —— 一旦底稿按"认证状态即抵扣权"接线（本次 P0-A 的修法），
   * 一张销项票被误勾选就会凭空产生一笔可抵扣进项 = **直接少缴增值税**。
   * 因此这条校验不是形式检查，而是 P0-A 修复的必要配套。
   */
  async certifyInvoice(
    id: string,
    dto: CertifyInvoiceDto,
    actor?: RequestActor,
  ): Promise<InvoiceVerifyStatusView> {
    if (!PERIOD_PATTERN.test(dto.certificationPeriod)) {
      throw new BadRequestException('certificationPeriod 必须为 YYYY-MM');
    }
    const row = await this.loadInvoice(id);
    if (!row) throw new NotFoundException('发票记录不存在');
    if (row.status === 'voided') {
      throw new BadRequestException('作废发票不可勾选认证');
    }
    // P0-A：销项发票不存在"勾选认证/抵扣"这个概念，必须拒绝
    if ((row.direction ?? 'sales') !== 'purchase') {
      throw new BadRequestException(
        '仅进项发票（direction=purchase）可勾选认证；销项发票的抵扣凭证是购买方取得后自行勾选'
      );
    }
    // 红字进项发票（负数）不参与勾选认证：它是对已认证进项的冲减，
    // 在申报表上走"进项税额转出"，而不是再认证一笔负数进项。
    if (Number(row.amount ?? 0) < 0 || row.sourceRef?.startsWith('red-letter:')) {
      throw new BadRequestException(
        '红字进项发票不可勾选认证：请在申报表按「进项税额转出」处理'
      );
    }

    const nextStatus: InvoiceCertificationStatus =
      dto.action === 'deduct' ? 'deducted' : 'certified';
    const now = new Date();
    await this.db
      .update(erpInvoice)
      .set({
        certificationStatus: nextStatus,
        certificationPeriod: dto.certificationPeriod,
        certifiedAt: now,
      })
      .where(eq(erpInvoice.id, id));

    const actorName = actor?.userName ?? actor?.userId ?? 'system';
    await this.audit.record({
      actor: actorName,
      action: 'invoice_certify',
      objectType: 'erp_invoice',
      objectId: row.id,
      objectCode: row.code,
      detail: JSON.stringify({
        certificationStatus: nextStatus,
        certificationPeriod: dto.certificationPeriod,
      }),
    });

    const updated = await this.loadInvoice(id);
    return this.toStatusView(updated!);
  }

  /** 查询单张发票的查验/认证状态 */
  async getVerifyStatus(id: string): Promise<InvoiceVerifyStatusView> {
    const row = await this.loadInvoice(id);
    if (!row) throw new NotFoundException('发票记录不存在');
    return this.toStatusView(row);
  }
}
