import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { eq, inArray, sql } from 'drizzle-orm';
import { finAccount, finPeriodClose, finVoucher, finVoucherLine } from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';

export interface VoucherHookLine {
  accountCode: string;
  debit?: number;
  credit?: number;
  summary?: string;
}

export interface VoucherDraftParams {
  sourceType:
    | 'receipt'
    | 'payment'
    | 'expense'
    | 'payroll'
    | 'depreciation'
    | 'invoice'
    | 'manual';
  sourceRef: string;
  voucherDate: string;
  summary: string;
  lines: VoucherHookLine[];
}

export type VoucherDraftResult = 'created' | 'failed';

/**
 * 事件驱动生成凭证草稿。
 * 失败写入 comp_voucher_job（voucherStatus=failed）供重试，不阻断主业务。
 */
@Injectable()
export class VoucherHookService {
  private readonly logger = new Logger(VoucherHookService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  async generateVoucherDraft(
    params: VoucherDraftParams
  ): Promise<VoucherDraftResult> {
    try {
      const voucherDate = params.voucherDate.slice(0, 10);
      const period = voucherDate.slice(0, 7);
      if (params.lines.length === 0) {
        await this.markFailed(params, '分录为空');
        return 'failed';
      }

      const codes: string[] = Array.from(
        new Set(params.lines.map((line: VoucherHookLine) => line.accountCode))
      );
      const accountRows = await this.db
        .select({
          id: finAccount.id,
          code: finAccount.code,
          name: finAccount.name,
          status: finAccount.status,
        })
        .from(finAccount)
        .where(inArray(finAccount.code, codes));
      const accountByCode = new Map<string, { id: string; name: string }>();
      for (const row of accountRows) {
        if ((row.status ?? 'active') !== 'active') continue;
        accountByCode.set(row.code, { id: row.id, name: row.name });
      }
      for (const code of codes) {
        if (!accountByCode.has(code)) {
          await this.markFailed(params, `科目 ${code} 不存在或非 active`);
          return 'failed';
        }
      }

      const closedRows = await this.db
        .select({ period: finPeriodClose.period })
        .from(finPeriodClose)
        .where(eq(finPeriodClose.period, period))
        .limit(1);
      if (closedRows.length > 0) {
        await this.markFailed(params, `期间 ${period} 已结账`);
        return 'failed';
      }

      let totalDebit = 0;
      let totalCredit = 0;
      for (const line of params.lines) {
        totalDebit += Number(line.debit ?? 0);
        totalCredit += Number(line.credit ?? 0);
      }
      if (Math.round(totalDebit * 100) !== Math.round(totalCredit * 100)) {
        await this.markFailed(
          params,
          `借贷不平衡（借 ${totalDebit} / 贷 ${totalCredit}）`
        );
        return 'failed';
      }

      const code = await generateBizCode(
        this.db,
        finVoucher,
        finVoucher.code,
        'VCH'
      );
      await this.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(finVoucher)
          .values({
            code,
            voucherDate,
            period,
            summary: params.summary,
            sourceType: params.sourceType,
            sourceRef: params.sourceRef,
            status: 'draft',
          })
          .returning({ id: finVoucher.id });
        await tx.insert(finVoucherLine).values(
          params.lines.map((line: VoucherHookLine) => ({
            voucherId: inserted[0].id,
            accountId: accountByCode.get(line.accountCode)?.id ?? null,
            summary: line.summary ?? params.summary,
            debit: String(Number(line.debit ?? 0)),
            credit: String(Number(line.credit ?? 0)),
          }))
        );
      });
      await this.clearFailure(params);
      return 'created';
    } catch (error) {
      const message: string =
        error instanceof Error ? error.message : String(error);
      await this.markFailed(params, message);
      return 'failed';
    }
  }

  /** 将失败记入重试队列。表不存在时只打日志。 */
  private async markFailed(
    params: VoucherDraftParams,
    reason: string
  ): Promise<void> {
    this.logger.error(
      `凭证状态 voucherStatus=failed sourceRef=${params.sourceRef} ${reason}`
    );
    try {
      await this.db.execute(sql`
        INSERT INTO comp_voucher_job (
          source_type, source_ref, status, last_error, payload, attempts, next_retry_at, updated_at
        ) VALUES (
          ${params.sourceType},
          ${params.sourceRef},
          'failed',
          ${reason},
          ${JSON.stringify(params)},
          1,
          CURRENT_TIMESTAMP + interval '15 minutes',
          CURRENT_TIMESTAMP
        )
        ON CONFLICT (source_type, source_ref) DO UPDATE
        SET status = 'failed',
            last_error = EXCLUDED.last_error,
            payload = EXCLUDED.payload,
            attempts = comp_voucher_job.attempts + 1,
            next_retry_at = CURRENT_TIMESTAMP + interval '15 minutes',
            updated_at = CURRENT_TIMESTAMP
      `);
    } catch (error: unknown) {
      const message: string =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `凭证失败队列写入失败 sourceRef=${params.sourceRef} ${message}`
      );
    }
  }

  private async clearFailure(params: VoucherDraftParams): Promise<void> {
    try {
      await this.db.execute(sql`
        UPDATE comp_voucher_job
        SET status = 'done', updated_at = CURRENT_TIMESTAMP
        WHERE source_type = ${params.sourceType}
          AND source_ref = ${params.sourceRef}
      `);
    } catch (error: unknown) {
      const message: string =
        error instanceof Error ? error.message : String(error);
      if (!message.includes('42P01') && !message.includes('comp_voucher_job')) {
        this.logger.warn(`清理凭证失败队列异常 ${message}`);
      }
    }
  }
}
