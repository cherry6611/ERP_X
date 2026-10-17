import {
  applyMigrationChain,
  createDrizzle,
  createPglite,
  loadMigrations,
  queryRows,
} from '@server/test/integration/pglite-harness';
import { CostsService } from '@server/modules/costs/costs.service';
import { ActorAccessService } from '@server/common/auth/actor-access.service';
import { DataScopeService } from '@server/common/auth/data-scope.service';
import { ProjectAclService } from '@server/modules/projects/project-acl.service';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import { AccountResolverService } from '@server/modules/voucher/account-resolver.service';
import type { PostgresJsDatabase } from '@server/platform';

const CHAIN_TIMEOUT_MS = 120_000;
const PREFIX = '[API_TEST]';

/**
 * `AuthorizationSDK` 的最小替身。
 *
 * 本文件测的是**分摊金额与落库原子性**，`ActorAccessService` 只在
 * 「谁能看别人的工时/成本」这类鉴权路径上被用到，与本测试无关。
 * 但它无法用 `null` 绕过（构造器要求该依赖），因此提供一个
 * 返回空成员列表的替身 —— 它让 `hasAnyRole` 稳定返回 false，
 * 语义上等价于"非管理员"，不会掩盖任何真实行为。
 */
const stubAuthzSdk = {
  members: {
    list: async () => ({ members: { userList: [] } }),
  },
} as unknown as ConstructorParameters<typeof ActorAccessService>[0];

/**
 * D-07 批量加权分摊（作业成本法 ABC 的核心动作）。
 *
 * ## 为什么关键断言是"合计必须严格等于被分摊总额"
 *
 * 把一笔公共成本拆到多个项目，分摊额之和必须**严格等于**被分摊总额。
 * 简单 `round2(amount × w / Σw)` 会在三项均分 100 元时得 33.33×3 = 99.99，
 * **差的 1 分在凭证上就是借贷不平**，总账与明细账永远对不上。
 *
 * 而这个问题**手工分摊同样会遇到** —— 原先一次只能传一个项目 + 一个金额，
 * 拆 N 笔全靠人手算，正是最容易出错的地方。所以这里的断言是
 * `Σ 落库金额 === 请求金额`，而不是"接口返回成功"。
 */
describe('D-07 批量加权分摊', () => {
  let db: Awaited<ReturnType<typeof createPglite>>;
  let service: CostsService;
  const projectIds: string[] = [];

  const uid = (n: number) =>
    `d0700000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  beforeAll(async () => {
    db = await createPglite();
    await applyMigrationChain(db, loadMigrations());
    const orm = createDrizzle(db) as unknown as PostgresJsDatabase;
    const actorAccess = new ActorAccessService(stubAuthzSdk);
    const dataScope = new DataScopeService(orm);
    service = new CostsService(
      orm,
      actorAccess,
      new VoucherHookService(orm, new AccountResolverService(orm)),
      dataScope,
      new ProjectAclService(orm, actorAccess, dataScope),
    );

    for (let i = 1; i <= 4; i += 1) {
      const id = uid(i);
      projectIds.push(id);
      await db.query(
        `INSERT INTO erp_project (id, code, name, status)
         VALUES ($1,$2,$3,'executing') ON CONFLICT (id) DO NOTHING`,
        [id, `${PREFIX}P${i}`, `${PREFIX}项目${i}`]
      );
    }
  }, CHAIN_TIMEOUT_MS);

  afterAll(async () => {
    await db?.close();
  });

  /** 汇总某来源产生的分摊额与项目成本额 */
  const sumsOf = async (
    sourceRef: string
  ): Promise<{ alloc: number; cost: number; rows: number }> => {
    const a = await queryRows<{ total: string; n: number }>(
      db,
      `SELECT coalesce(sum(amount),0) AS total, count(*)::int AS n
       FROM erp_cost_allocation WHERE source_ref = '${sourceRef}'`
    );
    const c = await queryRows<{ total: string }>(
      db,
      `SELECT coalesce(sum(amount),0) AS total FROM erp_project_cost
       WHERE source_ref LIKE 'allocation:%' AND remark LIKE '%${sourceRef}%'`
    );
    return {
      alloc: Number(a[0].total),
      cost: Number(c[0].total),
      rows: Number(a[0].n),
    };
  };

  it('等权分摊 100 元到 3 个项目：合计严格等于 100（尾差被补齐）', async () => {
    const sourceRef = `${PREFIX}EQ3`;
    const result = await service.createAllocationBatch({
      sourceDesc: `${PREFIX}GPU 租金`,
      costType: 'compute',
      amount: 100,
      period: '2026-10',
      sourceRef,
      targets: [
        { projectId: projectIds[0], weight: 1 },
        { projectId: projectIds[1], weight: 1 },
        { projectId: projectIds[2], weight: 1 },
      ],
    });

    expect(result.allocations).toHaveLength(3);
    // 接口自报的合计
    expect(result.allocatedAmount).toBe(100);
    expect(result.totalAmount).toBe(100);
    // ✅ 真正重要的：落库金额合计也必须是 100
    const sums = await sumsOf(sourceRef);
    expect(sums.alloc).toBe(100);
    expect(sums.rows).toBe(3);
    // 逐项差额不超过 1 分（最大余数法的特征）
    const cents = result.allocations.map((a) => Math.round(a.amount * 100));
    expect(Math.max(...cents) - Math.min(...cents)).toBeLessThanOrEqual(1);
    // 明确记录了尾差去向
    expect(result.adjustedCount).toBe(1);
  });

  it('按权重 3:2:1 分摊 600 元 → 300 / 200 / 100', async () => {
    const sourceRef = `${PREFIX}W321`;
    const result = await service.createAllocationBatch({
      sourceDesc: `${PREFIX}按机时分摊`,
      costType: 'compute',
      amount: 600,
      period: '2026-10',
      sourceRef,
      targets: [
        { projectId: projectIds[0], weight: 3 },
        { projectId: projectIds[1], weight: 2 },
        { projectId: projectIds[2], weight: 1 },
      ],
    });
    expect(result.allocations.map((a) => a.amount)).toEqual([300, 200, 100]);
    expect((await sumsOf(sourceRef)).alloc).toBe(600);
  });

  it('回归：多组会产生尾差的金额，落库合计始终等于请求金额', async () => {
    const cases: Array<[number, number[]]> = [
      [100, [1, 1, 1]],
      [0.03, [1, 1, 1]],
      [999.99, [7, 11, 13]],
      [1234.56, [1, 1, 1, 1]],
      [0.01, [1, 1]],
    ];
    for (let i = 0; i < cases.length; i += 1) {
      const [amount, weights] = cases[i];
      const sourceRef = `${PREFIX}RG${i}`;
      const result = await service.createAllocationBatch({
        sourceDesc: `${PREFIX}回归${i}`,
        costType: 'compute',
        amount,
        period: '2026-10',
        sourceRef,
        targets: weights.map((weight, idx) => ({
          projectId: projectIds[idx],
          weight,
        })),
      });
      const sums = await sumsOf(sourceRef);
      expect(`${amount}:${sums.alloc}`).toBe(`${amount}:${amount}`);
      expect(result.allocatedAmount).toBe(amount);
    }
  });

  it('每个项目都生成对应的项目成本（金额与分摊额一致）', async () => {
    const sourceRef = `${PREFIX}COST`;
    const result = await service.createAllocationBatch({
      sourceDesc: `${PREFIX}成本归集检查`,
      costType: 'outsource',
      amount: 300,
      period: '2026-10',
      sourceRef,
      targets: [
        { projectId: projectIds[0], weight: 1 },
        { projectId: projectIds[1], weight: 2 },
      ],
    });
    const rows = await queryRows<{ project_id: string; amount: string }>(
      db,
      `SELECT project_id, amount FROM erp_project_cost
       WHERE source_ref IN (${result.allocations
         .map((a) => `'allocation:${a.code}'`)
         .join(',')})
       ORDER BY amount DESC`
    );
    expect(rows).toHaveLength(2);
    expect(Number(rows[0].amount)).toBe(200);
    expect(Number(rows[1].amount)).toBe(100);
    expect(rows[0].project_id).toBe(projectIds[1]);
  });

  it('重复项目 → 拒绝（避免同一项目出现两笔独立分摊）', async () => {
    await expect(
      service.createAllocationBatch({
        sourceDesc: `${PREFIX}重复`,
        costType: 'compute',
        amount: 100,
        period: '2026-10',
        sourceRef: `${PREFIX}DUP`,
        targets: [
          { projectId: projectIds[0], weight: 1 },
          { projectId: projectIds[0], weight: 1 },
        ],
      })
    ).rejects.toThrow(/重复项目/);
    // 拒绝后不得留下任何分摊记录（整批原子性）
    expect((await sumsOf(`${PREFIX}DUP`)).rows).toBe(0);
  });

  it('非正权重 → 拒绝', async () => {
    await expect(
      service.createAllocationBatch({
        sourceDesc: `${PREFIX}零权重`,
        costType: 'compute',
        amount: 100,
        period: '2026-10',
        sourceRef: `${PREFIX}W0`,
        targets: [
          { projectId: projectIds[0], weight: 0 },
          { projectId: projectIds[1], weight: 1 },
        ],
      })
    ).rejects.toThrow(/权重必须大于 0/);
  });

  it('目标项目不存在 → 整批拒绝且不落任何记录（原子性）', async () => {
    const sourceRef = `${PREFIX}MISS`;
    await expect(
      service.createAllocationBatch({
        sourceDesc: `${PREFIX}缺项目`,
        costType: 'compute',
        amount: 100,
        period: '2026-10',
        sourceRef,
        targets: [
          { projectId: projectIds[0], weight: 1 },
          { projectId: uid(99), weight: 1 },
        ],
      })
    ).rejects.toThrow(/目标项目不存在/);
    // 关键：不能出现"部分成功"——否则被分摊总额与已分摊合计永久对不上
    expect((await sumsOf(sourceRef)).rows).toBe(0);
  });

  it('空目标列表 → 拒绝', async () => {
    await expect(
      service.createAllocationBatch({
        sourceDesc: `${PREFIX}空`,
        costType: 'compute',
        amount: 100,
        period: '2026-10',
        sourceRef: `${PREFIX}EMPTY`,
        targets: [],
      })
    ).rejects.toThrow(/至少 1 项/);
  });

  it('金额非正 → 拒绝', async () => {
    await expect(
      service.createAllocationBatch({
        sourceDesc: `${PREFIX}零额`,
        costType: 'compute',
        amount: 0,
        period: '2026-10',
        sourceRef: `${PREFIX}ZERO`,
        targets: [{ projectId: projectIds[0], weight: 1 }],
      })
    ).rejects.toThrow(/分摊金额必须大于 0/);
  });
});
