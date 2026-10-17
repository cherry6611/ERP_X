/**
 * M3：凭证生成核心路径集成测试（pglite + 真实 VoucherHookService）
 *
 * 背景：`VoucherHookService.generateVoucherDraft` 是约 17 个业务模块共用的自动凭证入口，
 * 此前无任何自动化断言（见检查报告 M3「核心编排 service 大面积 0% 覆盖」）。
 *
 * 覆盖：
 *   ① 幂等：同 sourceType + sourceRef 重复触发不重复建凭证；
 *   ② 借贷平衡：不平衡分录被拒，且不落凭证，失败写入 comp_voucher_job 补偿队列；
 *   ③ 月结闸门：期间已结账时拒绝生成凭证；
 *   ④ 补偿重试：失败入队 → 补全前置数据 → retryPendingJobs 重放成功，队列收敛为 done。
 *
 * 边界（诚实声明）：
 *   - pglite 内存库 + 全量迁移链，不连开发库；
 *   - 走 service 层，不覆盖 Nest HTTP/DTO 管道；
 *   - 数据以 [API_TEST] 前缀命名，科目用 9xxx 段（避开迁移预置科目）；
 *   - pglite 无会话变量上下文，`_created_by` 审计列为 NULL，不影响账务数值断言。
 */
import { AccountResolverService } from '@server/modules/voucher/account-resolver.service';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import { VoucherService } from '@server/modules/voucher/voucher.service';
import type { PostgresJsDatabase } from '@server/platform';
import { createHarness, queryRows, type Harness } from './pglite-harness';

/** pglite 首次启动（WASM）+ 全量迁移链 */
const FLOW_TIMEOUT_MS = 180_000;
const PREFIX = '[API_TEST]';
const ENTITY_ID = 'e9999999-9999-4999-8999-000000000001';

/** 借贷等额分录（默认借 9001 / 贷 9002） */
function balancedLines(
  amount: number,
  debitCode = '9001',
  creditCode = '9002',
) {
  return [
    { accountCode: debitCode, debit: amount, credit: 0 },
    { accountCode: creditCode, debit: 0, credit: amount },
  ];
}

describe('M3 凭证生成核心路径（VoucherHookService）', () => {
  let harness: Harness;
  let voucherService: VoucherService;
  let accountResolver: AccountResolverService;
  let hook: VoucherHookService;
  let db: Harness['db'];

  beforeAll(async () => {
    harness = await createHarness();
    db = harness.db;
    const orm = harness.orm as unknown as PostgresJsDatabase;

    voucherService = new VoucherService(orm);
    accountResolver = new AccountResolverService(orm);
    hook = new VoucherHookService(orm, accountResolver);

    // 纳税主体（凭证 tax_entity_id 外键来源）
    await db.query(
      `INSERT INTO md_tax_entity (id, code, name, taxpayer_type, default_output_rate, default_input_rate)
       VALUES ($1, $2, $3, 'general', 6, 6) ON CONFLICT (id) DO NOTHING`,
      [ENTITY_ID, `${PREFIX}-TE`, `${PREFIX} 测试纳税主体`],
    );

    // 两个末级科目：资产（借）/ 收入（贷）
    await voucherService.createAccount({
      code: '9001',
      name: `${PREFIX} 测试科目-借`,
      accountType: 'asset',
    });
    await voucherService.createAccount({
      code: '9002',
      name: `${PREFIX} 测试科目-贷`,
      accountType: 'revenue',
    });
  }, FLOW_TIMEOUT_MS);

  afterAll(async () => {
    await harness?.close();
  });

  /** 统计某 sourceRef 下未被作废的凭证数（幂等/拒绝断言用） */
  async function countVouchers(sourceRef: string): Promise<number> {
    const rows = await queryRows<{ cnt: string }>(
      db,
      `SELECT COUNT(*) AS cnt FROM fin_voucher WHERE source_ref = $1 AND status <> 'voided'`,
      [sourceRef],
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  /** 读取补偿队列状态 */
  async function jobStatus(sourceRef: string): Promise<string | null> {
    const rows = await queryRows<{ status: string }>(
      db,
      `SELECT status FROM comp_voucher_job WHERE source_ref = $1`,
      [sourceRef],
    );
    return rows[0]?.status ?? null;
  }

  it('① 幂等：同 sourceType+sourceRef 重复触发只生成一张凭证', async () => {
    const params = {
      sourceType: 'revenue',
      sourceRef: `${PREFIX}-vgen-001`,
      voucherDate: '2026-06-08',
      summary: `${PREFIX} 收入确认`,
      lines: balancedLines(1000),
      taxEntityId: ENTITY_ID,
    };

    expect(await hook.generateVoucherDraft(params)).toBe('created');
    // 第二次：命中幂等（已有同 source 且未作废的凭证），仍返回 created 但不再插入
    expect(await hook.generateVoucherDraft(params)).toBe('created');

    expect(await countVouchers(params.sourceRef)).toBe(1);
  });

  it('② 借贷平衡：不平衡分录被拒且不落凭证，失败写入补偿队列', async () => {
    const params = {
      sourceType: 'revenue',
      sourceRef: `${PREFIX}-vgen-bad-balance`,
      voucherDate: '2026-06-09',
      summary: `${PREFIX} 不平衡分录`,
      lines: [
        { accountCode: '9001', debit: 100, credit: 0 },
        { accountCode: '9002', debit: 0, credit: 50 },
      ],
      taxEntityId: ENTITY_ID,
    };

    expect(await hook.generateVoucherDraft(params)).toBe('failed');
    expect(await countVouchers(params.sourceRef)).toBe(0);
    // 失败必须入队，否则无人重试 →「有应收无凭证」
    expect(await jobStatus(params.sourceRef)).toBe('failed');
  });

  it('③ 月结闸门：期间已结账时拒绝生成凭证', async () => {
    await db.query(
      `INSERT INTO fin_period_close (period) VALUES ($1) ON CONFLICT DO NOTHING`,
      ['2026-05'],
    );

    const params = {
      sourceType: 'revenue',
      sourceRef: `${PREFIX}-vgen-closed-period`,
      voucherDate: '2026-05-10',
      summary: `${PREFIX} 已结账期间`,
      lines: balancedLines(500),
      taxEntityId: ENTITY_ID,
    };

    expect(await hook.generateVoucherDraft(params)).toBe('failed');
    expect(await countVouchers(params.sourceRef)).toBe(0);
  });

  it('④ 补偿重试：前置数据缺失导致失败入队 → 补全后重放成功、队列收敛为 done', async () => {
    const params = {
      sourceType: 'revenue',
      sourceRef: `${PREFIX}-vgen-retry`,
      voucherDate: '2026-06-10',
      summary: `${PREFIX} 补偿重试`,
      // 科目 9999 此刻尚不存在 → 应失败入队
      lines: balancedLines(800, '9999', '9002'),
      taxEntityId: ENTITY_ID,
    };

    expect(await hook.generateVoucherDraft(params)).toBe('failed');
    expect(await jobStatus(params.sourceRef)).toBe('failed');

    // 补全前置数据：建末级科目 9999，并清科目解析缓存（科目表变更后必须失效）
    await voucherService.createAccount({
      code: '9999',
      name: `${PREFIX} 补建科目`,
      accountType: 'asset',
    });
    accountResolver.invalidate();
    // 补偿队列默认 15 分钟退避，这里把重试时间拨到过去以立即触发
    await db.query(
      `UPDATE comp_voucher_job SET next_retry_at = CURRENT_TIMESTAMP - interval '1 minute' WHERE source_ref = $1`,
      [params.sourceRef],
    );

    const result = await hook.retryPendingJobs(20);
    expect(result.retried).toBeGreaterThanOrEqual(1);

    // 凭证已生成，且补偿队列状态收敛为 done
    expect(await countVouchers(params.sourceRef)).toBe(1);
    expect(await jobStatus(params.sourceRef)).toBe('done');
  });
});
