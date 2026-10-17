/**
 * B-2 / REQ-BE-02 集成测试：会计资料（凭证/账簿/报表）的纳税主体行级权限。
 *
 * 钉住的三件事：
 *   ① 未配置 → 不收紧（升级不改变既有行为），配置后 → SQL 层真的过滤；
 *   ② `self` / `dept` 这类对会计资料没有业务含义的范围 → fail-closed，
 *      而不是"回落到某个列上过滤"（那种过滤器看起来生效、实际不过滤）；
 *   ③ **绕过自检**：同一批数据换入口读取必须得到一致结果 ——
 *      凭证列表（drizzle query builder）与账簿取数（手写 SQL）是两条独立代码路径，
 *      历史上"两边口径不一致"就是从这里漏出去的。
 *
 * 边界（诚实声明）：
 *   - 走 service 而不是 HTTP：actor 由 `RequestActor` 手工构造，
 *     controller 的 `@Req()` + `@CanCapability('finance')` 由 RBAC 检查脚本覆盖；
 *   - 报表（`ReportsService`）未在本文件覆盖：它的取数最终落到
 *     `LedgersService.rawBalances`（同一函数已被本文件断言），但打印包/模板渲染未覆盖。
 */
import { ForbiddenException } from '@nestjs/common';
import { DataScopeService } from '@server/common/auth/data-scope.service';
import { VoucherService } from '@server/modules/voucher/voucher.service';
import { LedgersService } from '@server/modules/finance-reports/ledgers.service';
import type { PostgresJsDatabase } from '@server/platform';
import type { RequestActor } from '@server/common/auth/actor';
import { createHarness, type Harness } from './pglite-harness';

const FLOW_TIMEOUT_MS = 180_000;

const PREFIX = '[API_TEST]';
const ENTITY_A = 'a1111111-1111-4111-8111-111111111111';
const ENTITY_B = 'b2222222-2222-4222-8222-222222222222';
const PERIOD = '2026-05';

/** 被隔离的角色：自身没有权限，权限全部来自 sys_data_scope 配置 */
const SCOPED_ROLE = `${PREFIX}scoped`;

const ACTOR: RequestActor = {
  userId: `${PREFIX}user-1`,
  userName: '数据权限测试用户',
  roles: [SCOPED_ROLE],
};

interface SeedVoucher {
  id: string;
  code: string;
  taxEntityId: string | null;
  debit: number;
}

const VOUCHERS: SeedVoucher[] = [
  {
    id: 'a1000000-0000-4000-8000-000000000001',
    code: `${PREFIX}-A1`,
    taxEntityId: ENTITY_A,
    debit: 100,
  },
  {
    id: 'b1000000-0000-4000-8000-000000000001',
    code: `${PREFIX}-B1`,
    taxEntityId: ENTITY_B,
    debit: 300,
  },
  // 未归属主体：任何主体范围下都不该看见（它不在任何主体报表里）
  {
    id: 'c1000000-0000-4000-8000-000000000001',
    code: `${PREFIX}-NOENTITY`,
    taxEntityId: null,
    debit: 50,
  },
];

async function seed(harness: Harness): Promise<void> {
  const db = harness.db;
  await db.exec(`
    INSERT INTO md_tax_entity (id, code, name, taxpayer_type, default_output_rate, default_input_rate)
    VALUES ('${ENTITY_A}', '${PREFIX}-TA', '${PREFIX} 主体A', 'general', 6, 6),
           ('${ENTITY_B}', '${PREFIX}-TB', '${PREFIX} 主体B', 'general', 6, 6)
    ON CONFLICT (id) DO NOTHING;
  `);
  for (const voucher of VOUCHERS) {
    await db.query(
      `INSERT INTO fin_voucher (id, code, voucher_date, period, summary, source_type, status, tax_entity_id)
       VALUES ($1, $2, $3, $4, $5, 'manual', 'posted', $6)`,
      [
        voucher.id,
        voucher.code,
        `${PERIOD}-10`,
        PERIOD,
        `${PREFIX} ${voucher.code}`,
        voucher.taxEntityId,
      ]
    );
    await db.query(
      `INSERT INTO fin_voucher_line (voucher_id, account_code, summary, debit, credit)
       VALUES ($1, '1001', $2, $3, 0), ($1, '6001', $2, 0, $3)`,
      [voucher.id, `${PREFIX} 分录`, String(voucher.debit)]
    );
  }
}

/** 只改这三类会计资料的范围配置；其它资源类型保持未配置 */
async function setScope(
  harness: Harness,
  resourceType: string,
  scope: string,
  customIds: string[]
): Promise<void> {
  await harness.db.query(
    `INSERT INTO sys_data_scope (role_code, resource_type, scope, custom_ids, enabled, remark)
     VALUES ($1, $2, $3, $4, 1, $5)
     ON CONFLICT (role_code, resource_type)
     DO UPDATE SET scope = excluded.scope, custom_ids = excluded.custom_ids, enabled = 1`,
    [
      SCOPED_ROLE,
      resourceType,
      scope,
      JSON.stringify(customIds),
      `${PREFIX} 集成测试`,
    ]
  );
}

/** 清空配置，回到"未配置"状态（逐用例隔离） */
async function clearScope(harness: Harness): Promise<void> {
  await harness.db.query(`DELETE FROM sys_data_scope WHERE role_code = $1`, [
    SCOPED_ROLE,
  ]);
}

describe('B-2 会计资料行级数据权限', () => {
  let harness: Harness;
  let dataScope: DataScopeService;
  let vouchers: VoucherService;
  let ledgers: LedgersService;
  let orm: PostgresJsDatabase;

  beforeAll(async () => {
    harness = await createHarness();
    orm = harness.orm as unknown as PostgresJsDatabase;
    await seed(harness);
    dataScope = new DataScopeService(orm);
    vouchers = new VoucherService(orm);
    ledgers = new LedgersService(orm);
  }, FLOW_TIMEOUT_MS);

  afterAll(async () => {
    await harness?.close();
  });

  afterEach(async () => {
    await clearScope(harness);
  });

  /** 凭证列表看到的借方合计（与账簿取数是两条独立代码路径） */
  async function voucherListDebit(): Promise<number> {
    const filter = await dataScope.taxEntityScopeFor('voucher', ACTOR);
    const page = await vouchers.listVouchers(1, 50, undefined, PERIOD, undefined, filter);
    return page.items.reduce((sum, item) => sum + item.totalDebit, 0);
  }

  /** 账簿「本期发生额」借方合计（控制器等价路径：先收敛主体，再让 service 过滤） */
  async function ledgerDebit(): Promise<number> {
    const taxEntityId = await dataScope.narrowTaxEntityIdFor('ledger', ACTOR);
    const balances = await ledgers.rawBalances(PERIOD, { taxEntityId });
    let total = 0;
    for (const row of balances.values()) total += Number(row.debit_occur ?? 0);
    return total;
  }

  it('S2 收口：会计资料未登记配置行时默认 fail-closed，列表返回空集', async () => {
    // 未配置 = 拒绝（而不是原实现的"未配置 = 全量可见"）。
    // 这是本次安全收口的核心断言：把 fail-open 改成 fail-closed。
    await expect(dataScope.taxEntityScopeFor('voucher', ACTOR)).resolves.toEqual({
      kind: 'denied',
    });
    // 反例锁定：若退回 fail-open，这里会变成 450（全部主体 + 未归属主体的借方合计）
    expect(await voucherListDebit()).toBe(0);
    // 账簿同理：narrowTaxEntityIdFor 在 denied 下必须抛 403，而不是返回 undefined（= 不过滤）
    await expect(
      dataScope.narrowTaxEntityIdFor('ledger', ACTOR)
    ).rejects.toThrow(ForbiddenException);
  });

  it('③ 绕过自检：同一批数据换入口读取，两个入口口径一致（均被拒绝）', async () => {
    // 两个入口都必须拒绝；不允许"一个入口拦住、另一个入口漏放"
    const fromList = await voucherListDebit();
    await expect(
      dataScope.narrowTaxEntityIdFor('ledger', ACTOR)
    ).rejects.toThrow(ForbiddenException);
    expect(fromList).toBe(0);
  });

  it('配置 custom=[主体A] 后：凭证列表与账簿同时只剩主体A，且两条路径一致', async () => {
    await setScope(harness, 'voucher', 'custom', [ENTITY_A]);
    await setScope(harness, 'ledger', 'custom', [ENTITY_A]);

    const filter = await dataScope.taxEntityScopeFor('voucher', ACTOR);
    expect(filter).toEqual({ kind: 'entities', taxEntityIds: [ENTITY_A] });

    const page = await vouchers.listVouchers(1, 50, undefined, PERIOD, undefined, filter);
    expect(page.items.map((item) => item.code)).toEqual([`${PREFIX}-A1`]);

    const fromList = await voucherListDebit();
    const fromLedger = await ledgerDebit();
    // ③ 换入口一致：100 == 100（主体 B 的 300 与未归属的 50 两条路径都必须排除）
    expect(fromList).toBe(100);
    expect(fromLedger).toBe(100);
  });

  it('③ 绕过自检：注销该角色的配置后两个入口一起收紧，不存在"只放宽了一个入口"', async () => {
    await setScope(harness, 'voucher', 'custom', [ENTITY_A]);
    await setScope(harness, 'ledger', 'custom', [ENTITY_A]);
    expect(await voucherListDebit()).toBe(100);

    // 注销配置 → 回到"该角色未配置"状态。会计资料默认 fail-closed，
    // 因此两个入口都必须收紧到 0，而不是回到全量 450。
    await clearScope(harness);
    expect(await voucherListDebit()).toBe(0);
    await expect(
      dataScope.narrowTaxEntityIdFor('ledger', ACTOR)
    ).rejects.toThrow(ForbiddenException);
  });

  it('请求指定了范围外的主体 → 403（越权直连接口同样拦得住）', async () => {
    await setScope(harness, 'ledger', 'custom', [ENTITY_A]);
    await expect(
      dataScope.narrowTaxEntityIdFor('ledger', ACTOR, ENTITY_B)
    ).rejects.toThrow(ForbiddenException);
  });

  it('范围允许多个主体但请求未指定 → 403（不替调用方猜一个主体出报表）', async () => {
    await setScope(harness, 'ledger', 'custom', [ENTITY_A, ENTITY_B]);
    await expect(
      dataScope.narrowTaxEntityIdFor('ledger', ACTOR)
    ).rejects.toThrow(/显式指定/);
    // 显式指定后放行
    await expect(
      dataScope.narrowTaxEntityIdFor('ledger', ACTOR, ENTITY_B)
    ).resolves.toBe(ENTITY_B);
  });

  it('scope=self / dept 对会计资料无意义 → fail-closed，而不是回落到别的列', async () => {
    await setScope(harness, 'voucher', 'self', []);

    const filter = await dataScope.taxEntityScopeFor('voucher', ACTOR);
    expect(filter).toEqual({ kind: 'denied' });

    const page = await vouchers.listVouchers(1, 50, undefined, PERIOD, undefined, filter);
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);

    await setScope(harness, 'voucher', 'dept', []);
    const deptPage = await vouchers.listVouchers(
      1,
      50,
      undefined,
      PERIOD,
      undefined,
      await dataScope.taxEntityScopeFor('voucher', ACTOR)
    );
    expect(deptPage.items).toEqual([]);
  });

  it('custom 的空列表按"无可见主体"处理（fail-closed），不是"全部"', async () => {
    await setScope(harness, 'voucher', 'custom', []);
    expect(await dataScope.taxEntityScopeFor('voucher', ACTOR)).toEqual({
      kind: 'denied',
    });
    const page = await vouchers.listVouchers(
      1,
      50,
      undefined,
      PERIOD,
      undefined,
      await dataScope.taxEntityScopeFor('voucher', ACTOR)
    );
    expect(page.items).toEqual([]);
  });

  it('该资源已启用行级权限但本角色未配置 → fail-closed（P1-7 统一默认语义）', async () => {
    // 给**另一个**角色配置 voucher，使该资源类型进入"已启用"状态
    await harness.db.query(
      `INSERT INTO sys_data_scope (role_code, resource_type, scope, custom_ids, enabled, remark)
       VALUES ($1, 'voucher', 'all', '[]', 1, $2)
       ON CONFLICT (role_code, resource_type) DO NOTHING`,
      [`${PREFIX}other-role`, `${PREFIX} 集成测试`]
    );
    try {
      expect(await dataScope.taxEntityScopeFor('voucher', ACTOR)).toEqual({
        kind: 'denied',
      });
      const page = await vouchers.listVouchers(
        1,
        50,
        undefined,
        PERIOD,
        undefined,
        await dataScope.taxEntityScopeFor('voucher', ACTOR)
      );
      expect(page.items).toEqual([]);
    } finally {
      await harness.db.query(
        `DELETE FROM sys_data_scope WHERE role_code = $1`,
        [`${PREFIX}other-role`]
      );
    }
  });

  it('写入类操作同样拦截：跨主体的凭证过账被 403 拒绝', async () => {
    await setScope(harness, 'voucher', 'custom', [ENTITY_A]);
    const filter = await dataScope.taxEntityScopeFor('voucher', ACTOR);
    await expect(
      vouchers.voucherAction(
        'b1000000-0000-4000-8000-000000000001',
        'void',
        filter
      )
    ).rejects.toThrow(ForbiddenException);
    // 本主体的凭证正常放行（此处用 draft 校验前置条件会拦，故只断言不被数据权限拦）
    await expect(
      vouchers.voucherAction(
        'a1000000-0000-4000-8000-000000000001',
        'void',
        filter
      )
    ).resolves.toMatchObject({ code: `${PREFIX}-A1` });
  });

  it('admin 角色绕过（与既有 bypass 语义一致）', async () => {
    await setScope(harness, 'voucher', 'custom', [ENTITY_A]);
    const admin: RequestActor = { ...ACTOR, roles: ['admin'] };
    expect(await dataScope.taxEntityScopeFor('voucher', admin)).toEqual({
      kind: 'unrestricted',
    });
  });
});
