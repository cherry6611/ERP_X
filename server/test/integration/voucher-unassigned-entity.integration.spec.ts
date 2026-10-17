/**
 * B-1 / REQ-BE-01 集成测试：凭证主体归属自检（`GET /api/voucher/unassigned-entity`）。
 *
 * 钉住的真实缺陷：`v_fin_voucher_unassigned_entity` 视图早已建好，但**只有集成测试
 * 引用过它**，没有任何 API 或界面入口 —— 运维/财务无法发现"本月有 N 张凭证没进任何
 * 主体报表"，对使用者而言等价于「凭证静默消失」。本用例锁定服务层口径（期间/来源类型
 * 聚合 + 逐张下钻明细），接口层由 `@NeedLogin()` + 类级守卫覆盖。
 *
 * 边界（诚实声明）：
 *   - pglite 内存库 + 全量迁移链，不连开发库；
 *   - 只覆盖 `VoucherService.checkUnassignedEntity`（不走 HTTP，不覆盖前端 banner）；
 *   - 凭证数据用原始 SQL 插入：本用例验证的是**自检口径**，不是凭证创建流程。
 */
import { VoucherService } from '@server/modules/voucher/voucher.service';
import type { PostgresJsDatabase } from '@server/platform';
import { createHarness, queryRows, type Harness } from './pglite-harness';

/** pglite 首次启动（WASM）+ 全量迁移链 */
const FLOW_TIMEOUT_MS = 180_000;

const PREFIX = '[API_TEST]';
const ENTITY_ID = 'e5555555-5555-4555-8555-111111111111';

interface VoucherSeed {
  id: string;
  code: string;
  period: string;
  sourceType: string | null;
  status: string;
  /** 借方金额；贷方取同额以保证分录平衡 */
  debit: number;
  /** null = 未归属主体 */
  taxEntityId: string | null;
}

const SEEDS: VoucherSeed[] = [
  {
    id: 'f1000000-0000-4000-8000-000000000001',
    code: `${PREFIX}-V1`,
    period: '2026-05',
    sourceType: 'payroll',
    status: 'posted',
    debit: 100,
    taxEntityId: null,
  },
  {
    id: 'f1000000-0000-4000-8000-000000000002',
    code: `${PREFIX}-V2`,
    period: '2026-05',
    sourceType: null,
    status: 'draft',
    debit: 200,
    taxEntityId: null,
  },
  {
    id: 'f1000000-0000-4000-8000-000000000003',
    code: `${PREFIX}-V3`,
    period: '2026-06',
    sourceType: 'payroll',
    status: 'posted',
    debit: 300,
    taxEntityId: null,
  },
  // 已归属主体：不算缺口
  {
    id: 'f1000000-0000-4000-8000-000000000004',
    code: `${PREFIX}-V4`,
    period: '2026-05',
    sourceType: 'payroll',
    status: 'posted',
    debit: 1000,
    taxEntityId: ENTITY_ID,
  },
  // 作废且未归属：作废凭证本就不进报表，不算缺口
  {
    id: 'f1000000-0000-4000-8000-000000000005',
    code: `${PREFIX}-V5`,
    period: '2026-05',
    sourceType: 'manual',
    status: 'voided',
    debit: 5000,
    taxEntityId: null,
  },
];

async function seed(harness: Harness): Promise<void> {
  const db = harness.db;
  await db.exec(`
    INSERT INTO md_tax_entity (id, code, name, taxpayer_type, default_output_rate, default_input_rate)
    VALUES ('${ENTITY_ID}', '${PREFIX}-TE', '${PREFIX} 测试主体', 'general', 6, 6);
  `);
  for (const seed of SEEDS) {
    await db.query(
      `INSERT INTO fin_voucher (id, code, voucher_date, period, summary, source_type, status, tax_entity_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        seed.id,
        seed.code,
        `${seed.period}-08`,
        seed.period,
        `${PREFIX} ${seed.code}`,
        seed.sourceType,
        seed.status,
        seed.taxEntityId,
      ]
    );
    await db.query(
      `INSERT INTO fin_voucher_line (voucher_id, account_code, summary, debit, credit)
       VALUES ($1, '1001', $2, $3, 0), ($1, '6001', $2, 0, $3)`,
      [seed.id, `${PREFIX} 分录`, String(seed.debit)]
    );
  }
}

describe('B-1 凭证主体归属自检', () => {
  let harness: Harness;
  let service: VoucherService;
  let db: Harness['db'];

  beforeAll(async () => {
    harness = await createHarness();
    db = harness.db;
    await seed(harness);
    service = new VoucherService(harness.orm as unknown as PostgresJsDatabase);
  }, FLOW_TIMEOUT_MS);

  afterAll(async () => {
    await harness?.close();
  });

  it('全量自检：只统计「未归属且非作废」的凭证，金额与张数可对账', async () => {
    const result = await service.checkUnassignedEntity();

    expect(result.period).toBeNull();
    expect(result.sourceType).toBeNull();
    // V1 + V2 + V3 = 3 张；已归属的 V4 与作废的 V5 都不计
    expect(result.voucherCount).toBe(3);
    expect(result.totalDebit).toBe(600);
    expect(result.consistent).toBe(false);
    expect(result.groups).toEqual([
      { period: '2026-05', sourceType: '(manual)', voucherCount: 1, totalDebit: 200 },
      { period: '2026-05', sourceType: 'payroll', voucherCount: 1, totalDebit: 100 },
      { period: '2026-06', sourceType: 'payroll', voucherCount: 1, totalDebit: 300 },
    ]);
    expect(result.vouchers.map((item) => item.code)).toEqual([
      `${PREFIX}-V1`,
      `${PREFIX}-V2`,
      `${PREFIX}-V3`,
    ]);
  });

  it('逐张明细可下钻：带凭证 id / 期间 / 来源 / 摘要 / 借方合计', async () => {
    const result = await service.checkUnassignedEntity('2026-05', 'payroll');
    expect(result.groups).toEqual([
      { period: '2026-05', sourceType: 'payroll', voucherCount: 1, totalDebit: 100 },
    ]);
    const [voucher] = result.vouchers;
    expect(voucher).toEqual({
      id: 'f1000000-0000-4000-8000-000000000001',
      code: `${PREFIX}-V1`,
      period: '2026-05',
      voucherDate: '2026-05-08',
      sourceType: 'payroll',
      sourceRef: null,
      summary: `${PREFIX} ${PREFIX}-V1`,
      totalDebit: 100,
    });
  });

  it('按期间过滤：只返回该期间的缺口', async () => {
    const result = await service.checkUnassignedEntity('2026-06');
    expect(result.period).toBe('2026-06');
    expect(result.voucherCount).toBe(1);
    expect(result.totalDebit).toBe(300);
    expect(result.vouchers.every((item) => item.period === '2026-06')).toBe(true);
  });

  it('按来源类型过滤：source_type 为 NULL 时归一为 (manual)，不会漏掉手工凭证', async () => {
    const result = await service.checkUnassignedEntity(undefined, '(manual)');
    expect(result.sourceType).toBe('(manual)');
    expect(result.voucherCount).toBe(1);
    expect(result.vouchers[0].code).toBe(`${PREFIX}-V2`);
  });

  it('过滤后无缺口时 consistent = true（前端据此不渲染提示条）', async () => {
    const result = await service.checkUnassignedEntity('2026-12');
    expect(result).toMatchObject({
      period: '2026-12',
      voucherCount: 0,
      totalDebit: 0,
      consistent: true,
      groups: [],
      vouchers: [],
    });
  });

  it('拒绝非法期间格式，避免静默全量扫描被当成"该期间无缺口"', async () => {
    await expect(service.checkUnassignedEntity('2026/05')).rejects.toThrow(
      '期间格式必须为 YYYY-MM'
    );
  });

  it('自检口径与视图一致：聚合结果等于直接查视图', async () => {
    const viewRows = await queryRows<{
      period: string;
      source_type: string;
      voucher_count: number;
      total_debit: string;
    }>(
      db,
      `SELECT period, source_type, voucher_count, total_debit
         FROM v_fin_voucher_unassigned_entity
        ORDER BY period, source_type`
    );
    const result = await service.checkUnassignedEntity();
    expect(
      viewRows.map((row) => ({
        period: row.period,
        sourceType: row.source_type,
        voucherCount: Number(row.voucher_count),
        totalDebit: Number(row.total_debit),
      }))
    ).toEqual(result.groups);
  });
});
