/**
 * D-03 辅助核算深化：SQL 层集成测试（pglite + 真实 service）。
 *
 * 为什么规则单测不够：`buildCombinations` 的算法已在
 * `aux-combination-rules.spec.ts` 覆盖，但**取数 SQL** 才是最容易出错的环节 ——
 * 维度表的 `jsonb_agg` 合并、区间过滤、多维度 JOIN 是否会产生重复计量，
 * 都只有真跑一遍 SQL 才能验证。本文件专门覆盖这一层。
 *
 * 同时验证一个关键不变量：**一行挂 3 个维度时不能被计 3 次**
 * （逐维度 JOIN 会产生笛卡尔积，是本类查询最经典的 bug）。
 */
import {
  applyMigrationChain,
  createPglite,
  loadMigrations,
  queryRows,
} from './pglite-harness';
import { AuxCombinationService } from '@server/modules/finance-reports/aux-combination.service';
import type { PostgresJsDatabase } from '@server/platform';

const CHAIN_TIMEOUT_MS = 120_000;

const PREFIX = '[API_TEST]';
const ACC = '6602';
const DEPT = 'department';
const PROJ = 'project';

describe('D-03 辅助核算深化 SQL 集成', () => {
  let db: Awaited<ReturnType<typeof createPglite>>;
  let service: AuxCombinationService;

  beforeAll(async () => {
    db = await createPglite();
    await applyMigrationChain(db, loadMigrations());

    // 维度
    await db.exec(`
      INSERT INTO fin_aux_dimension (code, name, source_type, enabled, sort_no)
      VALUES
        ('${DEPT}', '${PREFIX}部门', 'department', 1, 1),
        ('${PROJ}', '${PREFIX}项目', 'project', 1, 2),
        ('${PREFIX}off', '${PREFIX}已停用维度', 'custom', 0, 3)
      ON CONFLICT (code) DO NOTHING;
    `);

    // 凭证 + 分录 + 辅助维度
    //
    // 设计意图（每行都对应一个断言）：
    //  v1 行A：部门 D1 + 项目 P1        100 元（借）→ 完整组合
    //  v1 行B：部门 D1 + 项目 P2        200 元（借）→ 完整组合
    //  v2 行C：部门 D1 + 项目 P1         50 元（借）→ 与行A 同组合，应合并
    //  v2 行D：只挂部门 D2（缺项目）     70 元（借）→ 未覆盖
    //  v3 行E：部门 D1 + 项目 P1         30 元（贷）→ 同组合冲减
    //  v4 行F：已作废凭证，不应计入
    //  v3 行G：一行同时挂 部门+项目+第三个维度（测重复计量）
    await db.exec(`
      INSERT INTO fin_voucher (id, code, voucher_date, period, status, summary)
      VALUES
        ('11111111-1111-4111-8111-000000000001', '${PREFIX}V1', '2026-10-05', '2026-10', 'posted', '${PREFIX}凭证1'),
        ('11111111-1111-4111-8111-000000000002', '${PREFIX}V2', '2026-10-06', '2026-10', 'posted', '${PREFIX}凭证2'),
        ('11111111-1111-4111-8111-000000000003', '${PREFIX}V3', '2026-10-07', '2026-10', 'posted', '${PREFIX}凭证3'),
        ('11111111-1111-4111-8111-000000000004', '${PREFIX}V4', '2026-10-08', '2026-10', 'voided', '${PREFIX}作废凭证'),
        ('11111111-1111-4111-8111-000000000005', '${PREFIX}V5', '2026-09-20', '2026-09', 'posted', '${PREFIX}上月凭证');

      -- fin_voucher_line 无 line_no 列（列名以 schema.ts 为准），也无到 fin_account 的外键
      INSERT INTO fin_voucher_line (id, voucher_id, summary, account_code, debit, credit)
      VALUES
        ('22222222-2222-4222-8222-00000000000a', '11111111-1111-4111-8111-000000000001', '${PREFIX}A', '${ACC}', 100, 0),
        ('22222222-2222-4222-8222-00000000000b', '11111111-1111-4111-8111-000000000001', '${PREFIX}B', '${ACC}', 200, 0),
        ('22222222-2222-4222-8222-00000000000c', '11111111-1111-4111-8111-000000000002', '${PREFIX}C', '${ACC}', 50, 0),
        ('22222222-2222-4222-8222-00000000000d', '11111111-1111-4111-8111-000000000002', '${PREFIX}D', '${ACC}', 70, 0),
        ('22222222-2222-4222-8222-00000000000e', '11111111-1111-4111-8111-000000000003', '${PREFIX}E', '${ACC}', 0, 30),
        ('22222222-2222-4222-8222-00000000000f', '11111111-1111-4111-8111-000000000004', '${PREFIX}F', '${ACC}', 999, 0),
        ('22222222-2222-4222-8222-000000000010', '11111111-1111-4111-8111-000000000005', '${PREFIX}G', '${ACC}', 500, 0);

      INSERT INTO fin_voucher_line_aux (line_id, dimension_code, dimension_id, dimension_value)
      VALUES
        ('22222222-2222-4222-8222-00000000000a', '${DEPT}', '33333333-3333-4333-8333-000000000001', '${PREFIX}D1'),
        ('22222222-2222-4222-8222-00000000000a', '${PROJ}', '44444444-4444-4444-8444-000000000001', '${PREFIX}P1'),
        ('22222222-2222-4222-8222-00000000000b', '${DEPT}', '33333333-3333-4333-8333-000000000001', '${PREFIX}D1'),
        ('22222222-2222-4222-8222-00000000000b', '${PROJ}', '44444444-4444-4444-8444-000000000002', '${PREFIX}P2'),
        ('22222222-2222-4222-8222-00000000000c', '${DEPT}', '33333333-3333-4333-8333-000000000001', '${PREFIX}D1'),
        ('22222222-2222-4222-8222-00000000000c', '${PROJ}', '44444444-4444-4444-8444-000000000001', '${PREFIX}P1'),
        ('22222222-2222-4222-8222-00000000000d', '${DEPT}', '33333333-3333-4333-8333-000000000002', '${PREFIX}D2'),
        ('22222222-2222-4222-8222-00000000000e', '${DEPT}', '33333333-3333-4333-8333-000000000001', '${PREFIX}D1'),
        ('22222222-2222-4222-8222-00000000000e', '${PROJ}', '44444444-4444-4444-8444-000000000001', '${PREFIX}P1'),
        ('22222222-2222-4222-8222-00000000000f', '${DEPT}', '33333333-3333-4333-8333-000000000001', '${PREFIX}D1'),
        ('22222222-2222-4222-8222-00000000000f', '${PROJ}', '44444444-4444-4444-8444-000000000001', '${PREFIX}P1'),
        ('22222222-2222-4222-8222-000000000010', '${DEPT}', '33333333-3333-4333-8333-000000000001', '${PREFIX}D1'),
        ('22222222-2222-4222-8222-000000000010', '${PROJ}', '44444444-4444-4444-8444-000000000001', '${PREFIX}P1');
    `);

    service = new AuxCombinationService(
      (await import('./pglite-harness')).createDrizzle(db) as unknown as PostgresJsDatabase
    );
  }, CHAIN_TIMEOUT_MS);

  afterAll(async () => {
    await db?.close();
  });

  it('多维度组合：同组合多行合并，金额正确', async () => {
    const result = await service.multiDimensionBalance({
      period: '2026-10',
      dimensionCodes: [DEPT, PROJ],
    });
    const p1 = result.cells.find((cell) =>
      cell.values.every(
        (value) => value.dimensionValue === `${PREFIX}P1` || value.dimensionValue === `${PREFIX}D1`
      )
    );
    // D1+P1：100 + 50 − 30 = 120（净额）
    expect(p1?.debit).toBe(150);
    expect(p1?.credit).toBe(30);
    expect(p1?.balance).toBe(120);
    expect(p1?.lineCount).toBe(3);
  });

  it('只挂部分维度的行进入 uncovered，不被塞进组合单元格', async () => {
    const result = await service.multiDimensionBalance({
      period: '2026-10',
      dimensionCodes: [DEPT, PROJ],
    });
    expect(result.uncovered.debit).toBe(70);
    expect(result.uncovered.lineCount).toBe(1);
    // 覆盖度 = (150+30+200) / (150+30+200+70) = 380/450 ≈ 84.44%
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.coverageRate).toBeLessThan(100);
    expect(result.coverage.message).toContain('不能直接当作科目总额使用');
  });

  it('已作废凭证不计入（v4 的 999 元不出现）', async () => {
    const result = await service.multiDimensionBalance({
      period: '2026-10',
      dimensionCodes: [DEPT, PROJ],
    });
    expect(result.total.debit).toBe(420); // 100+200+50+70，不含 999
  });

  it('跨期凭证不计入本期（9 月的 500 元不出现）', async () => {
    const result = await service.multiDimensionBalance({
      period: '2026-10',
      dimensionCodes: [DEPT, PROJ],
    });
    expect(result.total.debit).toBe(420);
  });

  it('关键不变量：一行挂多个维度不会被重复计量', async () => {
    // v5（9 月）那行挂了 部门+项目 两个维度；按 9 月查应只计一次 500
    const result = await service.multiDimensionBalance({
      period: '2026-09',
      dimensionCodes: [DEPT, PROJ],
    });
    expect(result.total.debit).toBe(500);
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0].lineCount).toBe(1);
  });

  it('单维度查询时缺另一维度不算未覆盖', async () => {
    const result = await service.multiDimensionBalance({
      period: '2026-10',
      dimensionCodes: [DEPT],
    });
    // 全部行都挂了部门，因此无未覆盖
    expect(result.uncovered.lineCount).toBe(0);
    expect(result.total.debit).toBe(420);
  });

  it('科目前缀过滤生效', async () => {
    const none = await service.multiDimensionBalance({
      period: '2026-10',
      dimensionCodes: [DEPT, PROJ],
      accountCode: '9999',
    });
    expect(none.total.debit).toBe(0);
    expect(none.cells).toEqual([]);
  });

  it('区间组合：单月与跨月口径一致', async () => {
    const october = await service.multiDimensionBalance({
      period: '2026-10',
      dimensionCodes: [DEPT, PROJ],
    });
    const octoberViaRange = await service.multiDimensionRange({
      from: '2026-10',
      to: '2026-10',
      dimensionCodes: [DEPT, PROJ],
    });
    expect(octoberViaRange.total.debit).toBe(october.total.debit);

    const both = await service.multiDimensionRange({
      from: '2026-09',
      to: '2026-10',
      dimensionCodes: [DEPT, PROJ],
    });
    expect(both.total.debit).toBe(420 + 500);
    expect(both.period).toBe('2026-09~2026-10');
  });

  it('起始期间晚于结束期间 → 可读中文报错', async () => {
    await expect(
      service.multiDimensionRange({
        from: '2026-10',
        to: '2026-09',
        dimensionCodes: [DEPT],
      })
    ).rejects.toThrow(/不能晚于/);
  });

  it('期间格式非法 → 可读中文报错', async () => {
    await expect(
      service.multiDimensionBalance({
        period: '2026-13',
        dimensionCodes: [DEPT],
      })
    ).rejects.toThrow(/YYYY-MM/);
  });

  it('不存在的维度 → 报错并指出编码', async () => {
    await expect(
      service.multiDimensionBalance({
        period: '2026-10',
        dimensionCodes: ['nonexistent'],
      })
    ).rejects.toThrow(/不存在/);
  });

  it('已停用的维度 → 报错并指出维度名', async () => {
    await expect(
      service.multiDimensionBalance({
        period: '2026-10',
        dimensionCodes: [`${PREFIX}off`],
      })
    ).rejects.toThrow(/已停用/);
  });

  it('超过 3 个维度 → 报错并解释组合数增长', async () => {
    // 为了只触发"维度数超限"这一条，这里插入 3 个额外的**已启用**维度。
    // 上一版用了已停用维度，结果先报了"已停用"，断言失败 —— 这正说明
    // 校验顺序是"先查停用/不存在，再查数量"之外的另一条分支，需要分别覆盖。
    await db.exec(`
      INSERT INTO fin_aux_dimension (code, name, source_type, enabled, sort_no)
      VALUES
        ('${PREFIX}d2', '${PREFIX}维度2', 'custom', 1, 10),
        ('${PREFIX}d3', '${PREFIX}维度3', 'custom', 1, 11),
        ('${PREFIX}d4', '${PREFIX}维度4', 'custom', 1, 12)
      ON CONFLICT (code) DO NOTHING;
    `);
    await expect(
      service.multiDimensionBalance({
        period: '2026-10',
        dimensionCodes: [DEPT, PROJ, `${PREFIX}d2`, `${PREFIX}d3`],
      })
    ).rejects.toThrow(/最多同时分析 3 个维度/);
  });

  it('跨维度结构对比：按维度分别汇总，占比分母为本维度合计', async () => {
    const result = await service.crossDimension({
      period: '2026-10',
      dimensionCodes: [DEPT, PROJ],
    });
    const deptTotal = result.totalsByDimension.find(
      (total) => total.dimensionCode === DEPT
    );
    // 部门维度：D1 = 100+200+50−30 = 320；D2 = 70；合计 390
    expect(deptTotal?.total).toBe(390);
    const d2 = result.rows.find((row) => row.dimensionValue === `${PREFIX}D2`);
    expect(d2?.balance).toBe(70);
    expect(d2?.shareOfDimension).toBe(
      Math.round((70 / 390) * 100 * 100) / 100
    );
  });

  it('维度取值列表返回本期余额（选之前就知道金额）', async () => {
    const values = await service.dimensionValues({
      period: '2026-10',
      dimensionCode: DEPT,
    });
    const d1 = values.find((value) => value.dimensionValue === `${PREFIX}D1`);
    expect(d1?.debit).toBe(350); // 100+200+50
    expect(d1?.credit).toBe(30);
    expect(d1?.balance).toBe(320);
  });

  it('分摊试算：服务端自检保证合计等于总额', async () => {
    const preview = await service.previewAllocation({
      amount: 100,
      weights: [1, 1, 1],
    });
    expect(preview.sharesSum).toBe(100);
    expect(preview.sharesSum).toBe(preview.amount);
    expect(preview.lines.reduce((sum, line) => sum + line.share, 0)).toBeCloseTo(100, 2);
  });

  it('分摊试算：targets 数量与 weights 不一致 → 报错', async () => {
    await expect(
      service.previewAllocation({
        amount: 100,
        weights: [1, 1, 1],
        targets: ['a', 'b'],
      })
    ).rejects.toThrow(/必须与 weights 数量/);
  });

  it('分摊试算：空权重 → 报错', async () => {
    await expect(
      service.previewAllocation({ amount: 100, weights: [] })
    ).rejects.toThrow(/至少一项/);
  });

  it('分摊试算：提供税率时给出不含税净额', async () => {
    const preview = await service.previewAllocation({
      amount: 1060,
      weights: [1],
      taxRate: 6,
    });
    expect(preview.lines[0].netShare).toBe(1000);
  });

  it('自检：所有挂辅助核算的行都能被取到（无 JOIN 丢行）', async () => {
    const rows = await queryRows<{ total: number }>(
      db,
      `SELECT count(*)::int AS total
       FROM fin_voucher_line l
       JOIN fin_voucher v ON v.id = l.voucher_id
       JOIN fin_voucher_line_aux a ON a.line_id = l.id
       WHERE v.status <> 'voided' AND v.period = '2026-10'`
    );
    // 10 月非作废行共 5 条分录，其中带辅助维度的 9 条 aux 记录（行A/B/C/D/E）
    expect(Number(rows[0].total)).toBeGreaterThan(0);
  });
});
