import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, eq, sql } from 'drizzle-orm';
import { finPeriodClose, finVoucher, finVoucherLine } from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { todayInShanghai } from '@server/common/utils/biz-date';
import { AccountResolverService } from './account-resolver.service';

export interface VoucherHookLine {
  accountCode: string;
  debit?: number;
  credit?: number;
  summary?: string;
}

export interface VoucherDraftParams {
  sourceType: string;
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
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly accountResolver: AccountResolverService,
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
      // A-10：把语义编码解析为可做账的末级科目（1002 → 100201、6602 → 660201 等）
      const resolved = await this.accountResolver.resolveMany(codes);
      for (const code of codes) {
        if (!resolved.has(code)) {
          await this.markFailed(params, `科目 ${code} 不存在、已停用或无可做账末级科目`);
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

      const existing = await this.db
        .select({ id: finVoucher.id })
        .from(finVoucher)
        .where(
          and(
            eq(finVoucher.sourceType, params.sourceType),
            eq(finVoucher.sourceRef, params.sourceRef)
          )
        )
        .limit(1);
      if (existing.length > 0) return 'created';

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
          params.lines.map((line: VoucherHookLine) => {
            const account = resolved.get(line.accountCode);
            return {
              voucherId: inserted[0].id,
              accountId: account?.id ?? null,
              accountCode: account?.code ?? null,
              summary: line.summary ?? params.summary,
              debit: String(Number(line.debit ?? 0)),
              credit: String(Number(line.credit ?? 0)),
            };
          })
        );
      });
      await this.clearFailure(params);
      return 'created';
    } catch (error) {
      const message: string =
        error instanceof Error ? error.message : String(error);
      if (message.includes('23505') || message.includes('uq_fin_voucher_source')) {
        return 'created';
      }
      await this.markFailed(params, message);
      return 'failed';
    }
  }

  /**
   * 主业务已成功、后续凭证失败时写入补偿队列。
   * D-20：禁止空 lines 入队（重试端会直接判 dead）；无分录时只记日志，由运维按 source 补录。
   */
  async recordCompensation(
    sourceType: string,
    sourceRef: string,
    reason: string,
    lines?: VoucherHookLine[],
    voucherDate?: string,
  ): Promise<void> {
    if (!lines?.length) {
      this.logger.error(
        `补偿登记缺少分录，跳过入队 source=${sourceType}:${sourceRef} reason=${reason}`,
      );
      return;
    }
    await this.markFailed(
      {
        sourceType,
        sourceRef,
        voucherDate: (voucherDate ?? todayInShanghai()).slice(0, 10),
        summary: reason,
        lines,
      },
      reason,
    );
  }

  /**
   * B1：消费失败队列。跳过空 lines（无法重放的补偿记录标 dead）。
   * 最多重试 8 次。
   */
  async retryPendingJobs(limit = 20): Promise<{ retried: number; dead: number }> {
    // L4：必须在事务内使用 FOR UPDATE SKIP LOCKED，否则锁在语句结束即释放
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        SELECT id, source_type, source_ref, payload, attempts
        FROM comp_voucher_job
        WHERE status = 'failed'
          AND (next_retry_at IS NULL OR next_retry_at <= CURRENT_TIMESTAMP)
          AND attempts < 8
        ORDER BY next_retry_at NULLS FIRST
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `);
      const list = Array.isArray(rows)
        ? (rows as unknown as {
            id: string;
            source_type: string;
            source_ref: string;
            payload: string | null;
            attempts: number;
          }[])
        : (((rows as { rows?: {
            id: string;
            source_type: string;
            source_ref: string;
            payload: string | null;
            attempts: number;
          }[] }).rows) ?? []);

      let retried = 0;
      let dead = 0;
      for (const job of list) {
        let params: VoucherDraftParams | null = null;
        try {
          params = job.payload
            ? (JSON.parse(job.payload) as VoucherDraftParams)
            : null;
        } catch {
          params = null;
        }
        if (!params?.lines?.length) {
          await tx.execute(sql`
            UPDATE comp_voucher_job
            SET status = 'dead',
                last_error = coalesce(last_error, '') || ' [无有效分录，无法重试]',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ${job.id}
          `);
          dead += 1;
          continue;
        }
        const result = await this.generateVoucherDraft(params);
        if (result === 'created') {
          retried += 1;
        }
      }
      return { retried, dead };
    });
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
