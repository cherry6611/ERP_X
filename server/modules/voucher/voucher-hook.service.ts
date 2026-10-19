import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BindTrigger,
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, eq, ne, sql } from 'drizzle-orm';
import { finPeriodClose, finVoucher, finVoucherLine } from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { unwrapRows } from '@server/common/utils/rows';
import { todayInShanghai } from '@server/common/utils/biz-date';
import { assertFiscalYearOpen } from '@server/common/utils/period-guard';
import {
  listActiveTaxEntityIds,
  resolveVoucherTaxEntityId,
} from '@server/common/tax/tax-entity-resolver';
import { AccountResolverService, type ResolvedAccount } from './account-resolver.service';
import { centsToYuanText, yuanToCents } from '@shared/number';

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
  /**
   * P0-2：凭证归属的纳税主体。自动凭证调用点**应尽量显式传入**
   * （业务单据上的合同/主体）；缺省时由 `resolveVoucherTaxEntityId` 兜底
   * （sourceRef 命中合同 → 唯一默认主体 → null）。
   */
  taxEntityId?: string | null;
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

  /**
   * P2-11：按业务场景取做账科目（未配置时回落 `defaultCode`）。
   *
   * 透传自 `AccountResolverService`，让调用方不必为了一个科目查询多注入一个依赖
   * （本服务已经在各处被注入，是现成的通道）。
   */
  async resolveSceneAccount(
    scene: string,
    defaultCode: string
  ): Promise<ResolvedAccount | null> {
    return this.accountResolver.resolveSceneAccount(scene, defaultCode);
  }

  async generateVoucherDraft(
    params: VoucherDraftParams,
    outerDb?: PostgresJsDatabase,
  ): Promise<VoucherDraftResult> {
    const db = outerDb ?? this.db;
    /*
     * 校验失败的处理：
     *   · 独立调用：写 comp_voucher_job 失败记录并返回 failed（业务不阻断）；
     *   · 外层事务：直接抛错，让外层把业务与凭证一起回滚，避免“发票已改、凭证没有”。
     */
    const fail = async (reason: string): Promise<VoucherDraftResult> => {
      if (outerDb) throw new Error(reason);
      await this.markFailed(params, reason);
      return 'failed';
    };
    try {
      const voucherDate = params.voucherDate.slice(0, 10);
      const period = voucherDate.slice(0, 7);
      if (params.lines.length === 0) {
        return fail('分录为空');
      }

      const codes: string[] = Array.from(
        new Set(params.lines.map((line: VoucherHookLine) => line.accountCode))
      );
      // A-10：把语义编码解析为可做账的末级科目（1002 → 100201、6602 → 660201 等）
      const resolved = await this.accountResolver.resolveMany(codes);
      for (const code of codes) {
        if (!resolved.has(code)) {
          return fail(`科目 ${code} 不存在、已停用或无可做账末级科目`);
        }
      }

      const closedRows = await db
        .select({ period: finPeriodClose.period })
        .from(finPeriodClose)
        .where(eq(finPeriodClose.period, period))
        .limit(1);
      if (closedRows.length > 0) {
        return fail(`期间 ${period} 已结账`);
      }
      // P0-3：会计年度已年结则该年度期间只读（月结与年结是两套闸门，必须都接线）
      await assertFiscalYearOpen(db, period);

      let totalDebit = 0n;
      let totalCredit = 0n;
      for (const line of params.lines) {
        const debit = yuanToCents(line.debit ?? 0);
        const credit = yuanToCents(line.credit ?? 0);
        if (debit == null || credit == null) {
          return fail('分录金额无法换算到分');
        }
        totalDebit += debit;
        totalCredit += credit;
      }
      if (totalDebit !== totalCredit) {
        return fail(
          `借贷不平衡（借 ${centsToYuanText(totalDebit)} / 贷 ${centsToYuanText(totalCredit)}）`,
        );
      }

      const existing = await db
        .select({ id: finVoucher.id })
        .from(finVoucher)
        .where(
          and(
            eq(finVoucher.sourceType, params.sourceType),
            eq(finVoucher.sourceRef, params.sourceRef),
            // P2-7：幂等键需含状态。已作废（voided）的旧凭证不能代表「本业务已出凭证」，
            // 否则同一单据再次触发时会被误判为 created →「有业务无凭证」。
            ne(finVoucher.status, 'voided'),
          )
        )
        .limit(1);
      if (existing.length > 0) return 'created';

      // P0-2：解析纳税主体（读 erp_contract / md_tax_entity，必须在写事务外）
      const taxEntityId = await resolveVoucherTaxEntityId(db, {
        explicit: params.taxEntityId,
        sourceRef: params.sourceRef,
        sourceType: params.sourceType,
      });
      if (!taxEntityId) {
        const active = await listActiveTaxEntityIds(db);
        // 还没有任何启用主体时保持旧行为（凭证主体留空），避免空库无法记账。
        // 一旦存在启用主体，推不出归属就不再落默认主体，也不插入无主体凭证。
        if (active.length > 0) return fail('未归属纳税主体');
      }

      const code = await generateBizCode(db, finVoucher, finVoucher.code, 'VCH');
      const writeVoucher = async (target: PostgresJsDatabase) => {
        const inserted = await target
          .insert(finVoucher)
          .values({
            code,
            voucherDate,
            period,
            summary: params.summary,
            sourceType: params.sourceType,
            sourceRef: params.sourceRef,
            status: 'draft',
            // P0-2：落纳税主体，否则该凭证不计入任何主体的账簿/报表
            taxEntityId,
          })
          .returning({ id: finVoucher.id });
        await target.insert(finVoucherLine).values(
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
      };
      if (outerDb) {
        // 调用方已开启事务：直接在同一事务内写，失败由外层统一回滚。
        await writeVoucher(outerDb);
      } else {
        await this.db.transaction(async (tx) => {
          await writeVoucher(tx as unknown as PostgresJsDatabase);
        });
      }
      await this.clearFailure(params);
      return 'created';
    } catch (error) {
      const message: string =
        error instanceof Error ? error.message : String(error);
      if (message.includes('23505') || message.includes('uq_fin_voucher_source')) {
        return 'created';
      }
      if (outerDb) {
        // 外层事务由调用方负责回滚；不能在这里用另一条连接写失败记录。
        throw error;
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
   *
   * P0-4：**不能在持有行锁的事务里重放**。原实现在 `db.transaction` 内
   * `SELECT ... FOR UPDATE SKIP LOCKED` 后直接调用 `generateVoucherDraft`，
   * 而后者走的是另一条连接（`this.db`）去 UPDATE/INSERT 同一批行
   * （`clearFailure` / `markFailed`）→ 内层等外层释放行锁、外层 `await` 内层，
   * 真实 Postgres 下自死锁（`lock_timeout=0` 即永久等待）；pglite（单连接）下
   * 则表现为嵌套事务冲突。现在拆成两步：短事务内「认领」并立即提交，
   * 事务外再做重放。
   */
  async retryPendingJobs(
    limit = 20,
  ): Promise<{ retried: number; dead: number; deadSourceRefs: string[] }> {
    type JobRow = {
      id: string;
      source_type: string;
      source_ref: string;
      payload: string | null;
      attempts: number;
    };
    // 第一步：短事务认领。FOR UPDATE SKIP LOCKED 仍需在事务内才有意义；
    // 顺带把陈旧的 'processing'（上次进程异常退出遗留）重新纳入。
    const claimed = await this.db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        SELECT id, source_type, source_ref, payload, attempts
        FROM comp_voucher_job
        WHERE (
                (
                  status IN ('failed', 'pending')
                  AND (next_retry_at IS NULL OR next_retry_at <= CURRENT_TIMESTAMP)
                )
                OR (
                  status = 'processing'
                  AND updated_at < CURRENT_TIMESTAMP - interval '10 minutes'
                )
              )
              AND attempts < 8
        ORDER BY next_retry_at NULLS FIRST
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `);
      const list = unwrapRows<JobRow>(rows);
      if (list.length === 0) return list;
      for (const job of list) {
        await tx.execute(sql`
          UPDATE comp_voucher_job
          SET status = 'processing', updated_at = CURRENT_TIMESTAMP
          WHERE id = ${job.id}
        `);
      }
      return list;
    });

    let retried = 0;
    let dead = 0;
    const deadSourceRefs: string[] = [];
    for (const job of claimed) {
      let params: VoucherDraftParams | null = null;
      try {
        params = job.payload
          ? (JSON.parse(job.payload) as VoucherDraftParams)
          : null;
      } catch {
        params = null;
      }
      if (!params?.lines?.length) {
        await this.db.execute(sql`
          UPDATE comp_voucher_job
          SET status = 'dead',
              last_error = coalesce(last_error, '') || ' [无有效分录，无法重试]',
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ${job.id}
        `);
        dead += 1;
        deadSourceRefs.push(job.source_ref);
        continue;
      }
      const result = await this.generateVoucherDraft(params);
      if (result === 'created') {
        retried += 1;
      } else if (result === 'failed') {
        const attempts = Number(job.attempts ?? 0) + 1;
        if (attempts >= 8) {
          await this.db.execute(sql`
            UPDATE comp_voucher_job
            SET status = 'dead', updated_at = CURRENT_TIMESTAMP
            WHERE id = ${job.id} AND status <> 'done'
          `);
          dead += 1;
          deadSourceRefs.push(job.source_ref);
        }
      }
    }
    return { retried, dead, deadSourceRefs };
  }

  /**
   * S4：凭证补偿对账（定时任务 `reconcile_voucher_ar`）。
   *
   * 业务（如项目收入确认的 AR + 凭证）采用「最终一致 + 补偿队列」：AR 写成功后若凭证生成
   * 失败，会写入 `comp_voucher_job` 供重试。本任务周期性重放失败队列，缩小 AR 与凭证之间
   * 的不一致窗口。强一致（单一编排事务）属二期改造，见 docs/REMEDIATION_PLAN_SEVERE.md。
   */
  @BindTrigger('reconcile_voucher_ar')
  async reconcileVoucherCompensation(): Promise<{
    retried: number;
    dead: number;
  }> {
    const result = await this.retryPendingJobs(50);
    this.logger.log(
      `凭证补偿对账完成：重试 ${result.retried} 笔 / 标记 dead ${result.dead} 笔 / ${result.deadSourceRefs.join(',')}`,
    );
    return result;
  }

  /**
   * 业务事务内先占一条待生成记录。进程在凭证写出之前退出时，队列里已经有这张单，
   * 重试会在 next_retry_at 之后接手。成功写出后由 clearFailure 标成 done。
   */
  async reserveCompensation(
    db: PostgresJsDatabase,
    params: VoucherDraftParams,
    reason: string,
  ): Promise<void> {
    if (!params.lines?.length) {
      this.logger.error(
        `补偿预留缺少分录，跳过入队 source=${params.sourceType}:${params.sourceRef}`,
      );
      return;
    }
    await db.execute(sql`
      INSERT INTO comp_voucher_job (
        source_type, source_ref, status, last_error, payload, attempts, next_retry_at, updated_at
      ) VALUES (
        ${params.sourceType},
        ${params.sourceRef},
        'pending',
        ${reason},
        ${JSON.stringify({ ...params, voucherDate: params.voucherDate.slice(0, 10) })},
        0,
        CURRENT_TIMESTAMP + interval '2 minutes',
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (source_type, source_ref) DO UPDATE
      SET payload = EXCLUDED.payload,
          last_error = EXCLUDED.last_error,
          status = CASE
            WHEN comp_voucher_job.status = 'done' THEN 'done'
            ELSE 'pending'
          END,
          next_retry_at = CASE
            WHEN comp_voucher_job.status = 'done' THEN comp_voucher_job.next_retry_at
            ELSE CURRENT_TIMESTAMP + interval '2 minutes'
          END,
          updated_at = CURRENT_TIMESTAMP
    `);
  }

  async summarizeQueue(): Promise<{
    pending: number;
    processing: number;
    failed: number;
    dead: number;
    items: Array<{ sourceRef: string; sourceType: string; status: string; lastError: string | null }>;
  }> {
    const counts = unwrapRows<{ status: string; total: number }>(
      await this.db.execute(sql`
        SELECT status, count(*)::int AS total
        FROM comp_voucher_job
        GROUP BY status
      `),
    );
    const tally = { pending: 0, processing: 0, failed: 0, dead: 0 };
    for (const row of counts) {
      if (row.status === 'pending' || row.status === 'processing' || row.status === 'failed' || row.status === 'dead') {
        tally[row.status] = Number(row.total ?? 0);
      }
    }
    const items = unwrapRows<{
      source_ref: string;
      source_type: string;
      status: string;
      last_error: string | null;
    }>(
      await this.db.execute(sql`
        SELECT source_ref, source_type, status, last_error
        FROM comp_voucher_job
        WHERE status IN ('pending', 'processing', 'failed', 'dead')
        ORDER BY updated_at DESC
        LIMIT 50
      `),
    );
    return {
      ...tally,
      items: items.map((row) => ({
        sourceRef: row.source_ref,
        sourceType: row.source_type,
        status: row.status,
        lastError: row.last_error,
      })),
    };
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
