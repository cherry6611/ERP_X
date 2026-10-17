/**
 * N-3 / B-4 集成测试：收入 → 应收 → 凭证 的**事务边界**与**三方对账自检**。
 *
 * 覆盖两个此前没有测试钉住的真实缺陷：
 *   ① 收入确认先落收入、再补应收（`createAr` 被 try/catch 吞掉），失败时留下
 *      「有收入无应收」且无台账的静默缺口 → 现在两者同一事务，任一步失败整体回滚；
 *   ② 缺口在业务列表里**完全看不出来** → 新增 `reconcileRevenueChain` 显式枚举
 *      missing_ar / ar_amount_mismatch / missing_voucher / voucher_pending 四类缺口。
 *
 * 边界（诚实声明）：
 *   - 数据库用 pglite（WASM PostgreSQL）内存库，先跑完整迁移链建表，不连开发库；
 *   - 使用**真实 service 实例**（RevenuesService / ArService / VoucherHookService /
 *     AccountResolverService / TaxResolverService），只把注入的 db 换成 pglite 驱动；
 *   - 不覆盖 Nest HTTP 层（DTO 管道 / @NeedLogin / @CanCapability）；
 *   - 科目表（1122 / 6001 / 222101）由迁移链的科目表种子提供，测试不自行建科目。
 */
import { AccountResolverService } from '@server/modules/voucher/account-resolver.service';
import { ArService } from '@server/modules/finance/ar.service';
import { InvoiceService } from '@server/modules/finance/invoice.service';
import { DataScopeService } from '@server/common/auth/data-scope.service';
import { ProjectAclService } from '@server/modules/projects/project-acl.service';
import { RevenuesService } from '@server/modules/revenues/revenues.service';
import { TaxEntityService } from '@server/modules/tax/tax-entity.service';
import { TaxResolverService } from '@server/modules/tax/tax-resolver.service';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import type { PostgresJsDatabase } from '@server/platform';
import { createHarness, queryRows, type Harness } from './pglite-harness';

/** pglite 首次启动（WASM）+ 全量迁移链，给足余量 */
const FLOW_TIMEOUT_MS = 180_000;

const PREFIX = '[API_TEST]';

const UUID = {
  taxEntity: 'a1111111-1111-4111-8111-111111111111',
  customer: 'b2222222-2222-4222-8222-111111111111',
  contract: 'c3333333-3333-4333-8333-111111111111',
  project: 'd4444444-4444-4444-8444-111111111111',
  projectNoContract: 'd4444444-4444-4444-8444-222222222222',
  /** 客户档案缺失的合同：用于验证「应收登记失败 → 收入一并回滚」 */
  orphanContract: 'c3333333-3333-4333-8333-222222222222',
  projectOrphan: 'd4444444-4444-4444-8444-333333333333',
  missingCustomer: 'b2222222-2222-4222-8222-999999999999',
} as const;

async function seed(harness: Harness): Promise<void> {
  const db = harness.db;
  await db.exec(`
    INSERT INTO md_tax_entity (id, code, name, taxpayer_type, default_output_rate, default_input_rate)
    VALUES ('${UUID.taxEntity}', '${PREFIX}-TE', '${PREFIX} 测试主体', 'general', 6, 6);

    INSERT INTO md_customer (id, code, name, terms_days)
    VALUES ('${UUID.customer}', '${PREFIX}-C1', '${PREFIX} 测试客户', 30);

    INSERT INTO erp_contract (id, code, name, customer_id, amount, tax_rate, tax_entity_id, status)
    VALUES ('${UUID.contract}', '${PREFIX}-CT1', '${PREFIX} 测试合同', '${UUID.customer}', 100000, 6, '${UUID.taxEntity}', 'active');

    -- 客户档案指向不存在的客户：应收登记必然 NotFound
    INSERT INTO erp_contract (id, code, name, customer_id, amount, tax_rate, tax_entity_id, status)
    VALUES ('${UUID.orphanContract}', '${PREFIX}-CT2', '${PREFIX} 缺客户合同', '${UUID.missingCustomer}', 10000, 6, '${UUID.taxEntity}', 'active');

    INSERT INTO erp_project (id, code, name, contract_id, status)
    VALUES
      ('${UUID.project}', '${PREFIX}-P1', '${PREFIX} 有合同项目', '${UUID.contract}', 'executing'),
      ('${UUID.projectNoContract}', '${PREFIX}-P2', '${PREFIX} 无合同项目', NULL, 'executing'),
      ('${UUID.projectOrphan}', '${PREFIX}-P3', '${PREFIX} 缺客户项目', '${UUID.orphanContract}', 'executing');
  `);
}

describe('N-3/B-4 收入→应收→凭证 事务边界与三方对账自检', () => {
  let harness: Harness;
  let service: RevenuesService;
  let db: Harness['db'];

  const createRevenue = (
    projectId: string,
    period: string,
    amount: number,
    remark: string
  ) =>
    service.createRevenue({
      projectId,
      period,
      method: 'progress',
      amount,
      basis: `${PREFIX} 完工百分比`,
      remark,
    });

  beforeAll(async () => {
    harness = await createHarness();
    db = harness.db;
    await seed(harness);
    const orm = harness.orm as unknown as PostgresJsDatabase;
    const accountResolver = new AccountResolverService(orm);
    const voucherHook = new VoucherHookService(orm, accountResolver);
    const taxResolver = new TaxResolverService(orm);
    const dataScope = new DataScopeService(orm);
    const arService = new ArService(orm, voucherHook, taxResolver, dataScope);
    // P0-D：收入冲回/调整现在会同步登记红字发票，因此需要 InvoiceService。
    // 这里用真实实例而不是 mock —— 红字发票的幂等键与负数落账口径正是本测试
    // 要覆盖的行为（mock 掉就只剩"调用过"这一条断言，等于没测）。
    const taxEntities = new TaxEntityService(orm);
    const invoiceService = new InvoiceService(
      orm,
      voucherHook,
      taxEntities,
      taxResolver,
      dataScope
    );
    const projectAcl = {
      visibleProjectIds: async () => undefined,
    } as unknown as ProjectAclService;
    service = new RevenuesService(
      orm,
      arService,
      voucherHook,
      taxResolver,
      dataScope,
      projectAcl,
      invoiceService
    );

    // 前置断言：迁移链的科目表种子必须已提供收入凭证所需科目，否则后续用例会误判为业务缺陷
    const accounts = await queryRows<{ code: string; is_leaf: number | null }>(
      db,
      "SELECT code, is_leaf FROM fin_account WHERE code IN ('1122','6001','222101') "
        + 'ORDER BY code'
    );
    expect(accounts.map((row) => row.code)).toEqual([
      '1122',
      '222101',
      '6001',
    ]);
    expect(accounts.every((row) => Number(row.is_leaf ?? 1) === 1)).toBe(true);
  }, FLOW_TIMEOUT_MS);

  afterAll(async () => {
    await harness?.close();
  });

  it('收入确认：收入 / 应收 / 凭证 三方齐备且金额自洽', async () => {
    const revenue = await createRevenue(
      UUID.project,
      '2026-05',
      10600,
      '三方齐备'
    );
    expect(revenue.amount).toBe(10600);

    const ar = await queryRows<{ amount: string; source_ref: string | null }>(
      db,
      'SELECT amount, source_ref FROM erp_ar WHERE source_ref = $1',
      [`revenue:${revenue.code}`]
    );
    expect(ar).toHaveLength(1);
    expect(Number(ar[0].amount)).toBe(10600);

    const voucher = await queryRows<{ status: string }>(
      db,
      "SELECT status FROM fin_voucher WHERE source_type = 'revenue' AND source_ref = $1",
      [`revenue:${revenue.code}`]
    );
    expect(voucher).toHaveLength(1);
    expect(voucher[0].status).toBe('draft');

    const result = await service.reconcileRevenueChain('2026-05');
    expect(result).toMatchObject({
      period: '2026-05',
      checked: 1,
      gapCount: 0,
      consistent: true,
    });
    expect(result.gaps).toEqual([]);
  });

  it('无合同项目：不要求应收，也不报缺口', async () => {
    const revenue = await createRevenue(
      UUID.projectNoContract,
      '2026-05',
      500,
      '无合同'
    );
    expect(revenue.contractId).toBeNull();

    const ar = await queryRows<{ id: string }>(
      db,
      'SELECT id FROM erp_ar WHERE source_ref = $1',
      [`revenue:${revenue.code}`]
    );
    expect(ar).toHaveLength(0);

    const result = await service.reconcileRevenueChain('2026-05');
    expect(result.checked).toBe(2);
    expect(result.consistent).toBe(true);
  });

  it('应收登记失败（客户档案缺失）时收入一并回滚，不留静默缺口', async () => {
    const before = await queryRows<{ count: string }>(
      db,
      'SELECT count(*) AS count FROM erp_project_revenue'
    );
    await expect(
      createRevenue(UUID.projectOrphan, '2026-06', 1000, '应收失败的收入')
    ).rejects.toThrow('客户不存在');

    const after = await queryRows<{ count: string }>(
      db,
      'SELECT count(*) AS count FROM erp_project_revenue'
    );
    expect(after[0].count).toBe(before[0].count);

    const orphan = await queryRows<{ id: string }>(
      db,
      'SELECT id FROM erp_project_revenue WHERE project_id = $1',
      [UUID.projectOrphan]
    );
    expect(orphan).toHaveLength(0);

    const orphanAr = await queryRows<{ id: string }>(
      db,
      'SELECT id FROM erp_ar WHERE contract_id = $1',
      [UUID.orphanContract]
    );
    expect(orphanAr).toHaveLength(0);
  });

  it('自检能枚举四类缺口：missing_ar / ar_amount_mismatch / missing_voucher / voucher_pending', async () => {
    /*
     * T12：`erp_project_revenue` 现在有 `(project_id, period)` 唯一约束，
     * 因此四条用例**不能**再挤在同一个 (项目, 期间) 上。
     *
     * 这不是"为了过测试而改测试"：那条约束要挡的正是"同一项目同一期间
     * 重复确认收入"（会同时产生双份应收与双份凭证，而自检 `reconcileRevenueChain`
     * 查不出来）。原测试之所以能这么写，恰恰说明当时没有约束。
     *
     * 现在给每条用例分配**独立期间**（表里没有"任意插入"的后门，只能如实
     * 按业务语义分期间），既满足唯一约束，又保持"互不干扰"的原有意图。
     * 每个期间只放一条，因此 `reconcileRevenueChain(period)` 只需检查一条。
     */
    const a = await createRevenue(UUID.project, '2026-07', 600, '缺应收');
    const b = await createRevenue(UUID.project, '2026-09', 700, '金额不一致');
    const c = await createRevenue(UUID.project, '2026-10', 800, '缺凭证');
    const d = await createRevenue(UUID.project, '2026-11', 900, '凭证待重试');

    // ① 删除应收 → missing_ar
    await db.query('DELETE FROM erp_ar WHERE source_ref = $1', [
      `revenue:${a.code}`,
    ]);
    // ② 应收金额与收入不一致 → ar_amount_mismatch
    await db.query('UPDATE erp_ar SET amount = $1 WHERE source_ref = $2', [
      '1.00',
      `revenue:${b.code}`,
    ]);
    // ③ 删除凭证且不进补偿队列 → missing_voucher
    await db.query(
      "DELETE FROM fin_voucher WHERE source_type = 'revenue' AND source_ref = $1",
      [`revenue:${c.code}`]
    );
    // ④ 删除凭证但补偿队列中有一条 failed → voucher_pending
    await db.query(
      "DELETE FROM fin_voucher WHERE source_type = 'revenue' AND source_ref = $1",
      [`revenue:${d.code}`]
    );
    await db.query(
      `INSERT INTO comp_voucher_job (source_type, source_ref, status, last_error, payload, attempts)
       VALUES ('revenue', $1, 'failed', '${PREFIX} 模拟失败', '{}', 1)`,
      [`revenue:${d.code}`]
    );

    /*
     * T12 之后每条用例各自占一个期间，因此这里逐个期间断言。
     * 这样断言强度**更强**：原来"一次查 4 条"只能证明四类缺口能同时出现，
     * 现在能证明"每个期间各自的缺口判定互不污染"。
     */
    const gapsOf: Record<string, string[]> = {};
    let totalChecked = 0;
    for (const [period, expectedCode] of [
      ['2026-07', a.code],
      ['2026-09', b.code],
      ['2026-10', c.code],
      ['2026-11', d.code],
    ] as Array<[string, string]>) {
      const result = await service.reconcileRevenueChain(period);
      expect(result.period).toBe(period);
      expect(result.checked).toBe(1);
      expect(result.consistent).toBe(false);
      expect(result.gapCount).toBe(result.gaps.length);
      expect(result.gaps[0]?.code).toBe(expectedCode);
      gapsOf[period] = result.gaps.map((gap) => gap.gapKind);
      totalChecked += result.checked;
    }
    expect(totalChecked).toBe(4);

    // 四类缺口各命中一次，且类型正确
    expect(gapsOf['2026-07']).toEqual(['missing_ar']);
    expect(gapsOf['2026-09']).toEqual(['ar_amount_mismatch']);
    expect(gapsOf['2026-10']).toEqual(['missing_voucher']);
    expect(gapsOf['2026-11']).toEqual(['voucher_pending']);

    // 缺口行必须带可展示信息（编码 / 项目名 / 期间 / 金额 / 中文说明）
    const period7 = await service.reconcileRevenueChain('2026-07');
    const missingAr = period7.gaps[0];
    expect(missingAr).toMatchObject({
      projectId: UUID.project,
      projectName: `${PREFIX} 有合同项目`,
      period: '2026-07',
      amount: 600,
      contractId: UUID.contract,
    });
    expect(missingAr?.detail).toContain('应收');
    const period9 = await service.reconcileRevenueChain('2026-09');
    expect(period9.gaps[0]?.detail).toContain('不一致');
  });

  it('自检按期间过滤：无收入的期间返回 checked=0 且 consistent', async () => {
    const result = await service.reconcileRevenueChain('2026-12');
    expect(result).toMatchObject({
      period: '2026-12',
      checked: 0,
      gapCount: 0,
      consistent: true,
    });
    expect(result.gaps).toEqual([]);
  });

  it('自检拒绝非法期间格式（不允许静默全量扫描）', async () => {
    await expect(service.reconcileRevenueChain('2026/12')).rejects.toThrow(
      '期间格式须为 YYYY-MM'
    );
  });

  /**
   * P0-D（T4）回归锁：**收入冲回必须同时登记红字发票**。
   *
   * 原实现只出红字凭证（借 6001 / 借 222101 / 贷 1122），而增值税底稿的销项
   * **100% 来自 `erp_invoice` 台账**（只取 `direction='sales' AND status='issued'`）。
   * 后果双向且都是资金影响：
   *   · **申报口径不冲减 → 多缴增值税**；
   *   · **账表永久差异** → 底稿每月必然报 `output_mismatch`，长期噪声把真实异常淹没。
   *
   * 这里直接断言三件事（缺一不可）：
   *   ① 红字发票确实落库，且 `amount / tax_amount` 都是**负数**（底稿 `sum()` 天然冲减）；
   *   ② `direction='sales'` 且 `status='issued'` —— 否则底稿根本取不到它；
   *   ③ 幂等：`sourceRef` 是 `revenue-reverse:<收入单号>`，重复冲回不会重复冲减。
   */
  it('收入冲回：同步登记负数红字发票（账表口径对齐，且幂等）', async () => {
    const revenue = await createRevenue(
      UUID.project,
      '2026-08',
      11300,
      'P0-D 红字发票'
    );
    await service.reverseRevenue(revenue.id, `${PREFIX} 客户取消`);

    const rows = await queryRows<{
      amount: string;
      tax_amount: string;
      direction: string;
      status: string;
      source_ref: string | null;
    }>(
      db,
      `SELECT amount, tax_amount, direction, status, source_ref
       FROM erp_invoice WHERE source_ref = $1`,
      [`revenue-reverse:${revenue.code}`]
    );
    expect(rows).toHaveLength(1);
    // ① 负数：底稿的 sum() 直接把它算作冲减，不需要特例分支
    expect(Number(rows[0].amount)).toBeLessThan(0);
    expect(Number(rows[0].tax_amount)).toBeLessThan(0);
    // ② 方向与状态：底稿只取 sales + issued，写错任一项这张票就等于不存在
    expect(rows[0].direction).toBe('sales');
    expect(rows[0].status).toBe('issued');
    // 金额与收入一致（含税），税额 = 价税分离结果（6%）
    expect(Number(rows[0].amount)).toBe(-11300);
    expect(Number(rows[0].tax_amount)).toBe(-639.62);

    // ③ 幂等：再次登记同一 sourceRef 返回既有发票，不新增行
    await service['registerRevenueRedLetterInvoice']({
      sourceRef: `revenue-reverse:${revenue.code}`,
      amount: 11300,
      taxRate: 6,
      contractId: UUID.contract,
      projectId: UUID.project,
      remark: `${PREFIX} 幂等重放`,
      taxEntityId: UUID.taxEntity,
    });
    const after = await queryRows<{ id: string }>(
      db,
      'SELECT id FROM erp_invoice WHERE source_ref = $1',
      [`revenue-reverse:${revenue.code}`]
    );
    expect(after).toHaveLength(1);
  });
});
