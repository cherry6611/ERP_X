/**
 * 核心账务链路集成测试（需求书 B-10，P0）
 *
 * 覆盖：建科目 → 建凭证 → 过账 → 试算平衡 → 期间结账 → 科目余额表恒等式 → 作废后余额回退，
 * 以及"故意破坏借贷平衡时凭证创建必须被拒"等真实错误信息断言。
 *
 * 实现边界（诚实声明）：
 *   - 数据库用 pglite（WASM PostgreSQL）内存库，先跑完整迁移链建表，**不连接本地开发库**
 *     （CI 没有该库，且迁移器会写库）。pglite 与真实 PostgreSQL 的差异见 pglite-harness.ts 文件头。
 *   - 账务逻辑用**真实 VoucherService 实例**：db 由 drizzle-orm/pglite 驱动构造后注入
 *     （VoucherService 只依赖 DRIZZLE_DATABASE 一个注入点，故只需一次显式类型转换），
 *     因此验证的是 service 的校验顺序、状态机与 SQL 取数，而不是复刻一份 SQL 断言。
 *   - 未覆盖：Nest HTTP 层（DTO 管道 / @NeedLogin / @CanRole）不在此测试内。
 *   - 测试数据按 AGENTS.md 约定以 `[API_TEST]` 前缀命名；科目编码统一用 9xxx 段，
 *     避开迁移预置的 1001~6801 科目表。
 *   - 各用例自带独立的期间的科目编码，不依赖用例执行顺序。
 */
import { PGlite } from '@electric-sql/pglite';
import { VoucherService } from '@server/modules/voucher/voucher.service';
import type { PostgresJsDatabase } from '@server/platform';
import type { AccountItem, AccountType } from '@shared/api.interface';
import {
  type Harness,
  accountMovement,
  createHarness,
  ledgerIdentity,
  queryRows,
  trialBalance,
} from './pglite-harness';

/** pglite 首次启动（WASM 初始化）+ 21 条迁移约 2 秒，给足余量 */
const FLOW_TIMEOUT_MS = 120_000;

const TEST_PREFIX = '[API_TEST]';
/** 模拟操作人（真实环境来自登录态；pglite 无会话变量，这里只用于审计列断言） */
const TEST_USER_ID = 'api-test-user-b10';

describe('核心账务链路集成（pglite + 真实 VoucherService）', () => {
  let harness: Harness;
  let service: VoucherService;
  let db: PGlite;

  beforeAll(async () => {
    harness = await createHarness();
    db = harness.db;
    // VoucherService 只注入 DRIZZLE_DATABASE；pglite 驱动与 postgres-js 驱动在该层同构
    service = new VoucherService(harness.orm as unknown as PostgresJsDatabase);
  }, FLOW_TIMEOUT_MS);

  afterAll(async () => {
    await harness?.close();
  });

  /** 幂等准备 [API_TEST] 科目：同一 harness 内多用例共享科目编码时避免重复建科目 */
  async function ensureAccount(
    code: string,
    name: string,
    accountType: AccountType,
    parentCode?: string
  ): Promise<AccountItem> {
    const page = await service.listAccounts(1, 50, code);
    const hit = page.items.find((item) => item.code === code);
    if (hit) return hit;
    return service.createAccount({ code, name, accountType, parentCode });
  }

  it('主链路：建科目 → 建凭证 → 过账 → 试算平衡 → 期间结账，余额表两端恒等', async () => {
    /* ---------- ① 建科目 ---------- */
    const cash = await service.createAccount({
      code: '9001',
      name: `${TEST_PREFIX} 测试现金`,
      accountType: 'asset',
    });
    const revenue = await service.createAccount({
      code: '9002',
      name: `${TEST_PREFIX} 测试服务收入`,
      accountType: 'revenue',
    });

    expect(cash).toMatchObject({
      code: '9001',
      accountType: 'asset',
      status: 'active',
      parentCode: null,
      level: 1,
      isLeaf: true,
      direction: 'debit',
      auxRequired: [],
    });
    // 收入类科目默认贷方
    expect(revenue).toMatchObject({ direction: 'credit', level: 1, isLeaf: true });

    // 科目真实落库
    const accountRows = await queryRows<{
      code: string;
      is_leaf: number;
      direction: string;
    }>(
      db,
      `SELECT code, is_leaf, direction FROM fin_account WHERE code IN ('9001','9002') ORDER BY code`
    );
    expect(accountRows).toEqual([
      { code: '9001', is_leaf: 1, direction: 'debit' },
      { code: '9002', is_leaf: 1, direction: 'credit' },
    ]);

    /* ---------- ② 建凭证 ---------- */
    const voucher = await service.createVoucher({
      voucherDate: '2026-05-18',
      period: '2026-05',
      summary: `${TEST_PREFIX} 提供数据服务确认收入`,
      lines: [
        { accountId: cash.id, debit: 12000, credit: 0, summary: '收到服务款' },
        { accountId: revenue.id, debit: 0, credit: 12000, summary: '确认收入' },
      ],
    });

    expect(voucher.status).toBe('draft');
    expect(voucher.period).toBe('2026-05');
    expect(voucher.sourceType).toBe('manual');
    expect(voucher.sourceRef).toBeNull();
    expect(voucher.totalDebit).toBe(12000);
    expect(voucher.totalCredit).toBe(12000);
    expect(voucher.code).toMatch(/^VCH\d{10}$/);
    // 分录 account_code 由迁移里的 plpgsql 触发器回填
    // 注意：service 的分录排序是 (created_at, id)，同一事务写入的多行 created_at 相同、
    // id 为随机 uuid，因此行序不稳定 → 断言按内容排序比较，不绑定展示顺序。
    expect(
      voucher.lines.map((line) => [line.accountCode, line.accountName]).sort()
    ).toEqual([
      ['9001', `${TEST_PREFIX} 测试现金`],
      ['9002', `${TEST_PREFIX} 测试服务收入`],
    ]);

    /* ---------- ③ 过账 ---------- */
    const posted = await service.voucherAction(voucher.id, 'post');
    expect(posted.status).toBe('posted');

    const voucherRows = await queryRows<{ status: string; period: string }>(
      db,
      'SELECT status, period FROM fin_voucher WHERE id = $1',
      [voucher.id]
    );
    expect(voucherRows).toEqual([{ status: 'posted', period: '2026-05' }]);

    const lineRows = await queryRows<{
      total_debit: string;
      total_credit: string;
      lines: string;
    }>(
      db,
      `SELECT COALESCE(SUM(debit), 0) AS total_debit,
              COALESCE(SUM(credit), 0) AS total_credit,
              COUNT(*) AS lines
         FROM fin_voucher_line WHERE voucher_id = $1`,
      [voucher.id]
    );
    expect(Number(lineRows[0].total_debit)).toBe(12000);
    expect(Number(lineRows[0].total_credit)).toBe(12000);
    expect(Number(lineRows[0].lines)).toBe(2);

    /* ---------- ④ 科目余额表恒等式 ---------- */
    const balance = await trialBalance(db, '2026-05');
    expect(balance.rows).toEqual([
      {
        accountCode: '9001',
        accountName: `${TEST_PREFIX} 测试现金`,
        debit: 12000,
        credit: 0,
        netDebit: 12000,
      },
      {
        accountCode: '9002',
        accountName: `${TEST_PREFIX} 测试服务收入`,
        debit: 0,
        credit: 12000,
        netDebit: -12000,
      },
    ]);
    expect(balance.totalDebit).toBe(12000);
    expect(balance.totalCredit).toBe(12000);
    expect(balance.balanced).toBe(true);
    expect(await accountMovement(db, '9001', '2026-05')).toEqual({
      debit: 12000,
      credit: 0,
      netDebit: 12000,
    });
    expect(await accountMovement(db, '9002', '2026-05')).toEqual({
      debit: 0,
      credit: 12000,
      netDebit: -12000,
    });

    /* ---------- ⑤ 期间结账 ---------- */
    const closed = await service.closePeriod('2026-05', TEST_USER_ID);
    expect(closed).toEqual({
      period: '2026-05',
      voucherCount: 1,
      draftCount: 0,
      totalDebit: 12000,
      totalCredit: 12000,
      balanced: true,
      closed: true,
    });

    const closeRows = await queryRows<{ period: string; closed_by: string | null }>(
      db,
      'SELECT period, closed_by FROM fin_period_close WHERE period = $1',
      ['2026-05']
    );
    expect(closeRows).toHaveLength(1);
    expect(closeRows[0].period).toBe('2026-05');
    expect(String(closeRows[0].closed_by)).toContain(TEST_USER_ID);

    // 期间汇总（listPeriods 真实数值）
    const may = (await service.listPeriods()).find((item) => item.period === '2026-05');
    expect(may).toEqual({
      period: '2026-05',
      voucherCount: 1,
      draftCount: 0,
      totalDebit: 12000,
      totalCredit: 12000,
      balanced: true,
      closed: true,
    });

    // 重复结账被拒
    await expect(service.closePeriod('2026-05', TEST_USER_ID)).rejects.toThrow(
      '期间 2026-05 已结账，不可重复结账'
    );
  });

  it('建科目：重复编码与上级科目不存在必须被拒（真实错误信息）', async () => {
    await ensureAccount('9001', `${TEST_PREFIX} 测试现金`, 'asset');

    await expect(
      service.createAccount({
        code: '9001',
        name: `${TEST_PREFIX} 重复科目`,
        accountType: 'asset',
      })
    ).rejects.toThrow('科目编码 9001 已存在');

    await expect(
      service.createAccount({
        code: '900199',
        name: `${TEST_PREFIX} 孤儿科目`,
        accountType: 'asset',
        parentCode: '9999',
      })
    ).rejects.toThrow('上级科目 9999 不存在');

    // 被拒科目不得落库
    const rows = await queryRows<{ total: string }>(
      db,
      `SELECT COUNT(*) AS total FROM fin_account WHERE code IN ('900199')`
    );
    expect(Number(rows[0].total)).toBe(0);
  });

  it('已结账期间：禁止新增凭证、禁止过账、禁止作废', async () => {
    const cash = await ensureAccount('9201', `${TEST_PREFIX} 测试现金E`, 'asset');
    const revenue = await ensureAccount('9202', `${TEST_PREFIX} 测试收入E`, 'revenue');

    const voucher = await service.createVoucher({
      voucherDate: '2026-06-10',
      period: '2026-06',
      summary: `${TEST_PREFIX} 结账期间凭证`,
      lines: [
        { accountId: cash.id, debit: 6000, credit: 0 },
        { accountId: revenue.id, debit: 0, credit: 6000 },
      ],
    });
    await service.voucherAction(voucher.id, 'post');
    expect((await service.closePeriod('2026-06', TEST_USER_ID)).closed).toBe(true);

    await expect(
      service.createVoucher({
        voucherDate: '2026-06-20',
        period: '2026-06',
        summary: `${TEST_PREFIX} 结账后补录`,
        lines: [
          { accountId: cash.id, debit: 1, credit: 0 },
          { accountId: revenue.id, debit: 0, credit: 1 },
        ],
      })
    ).rejects.toThrow('期间 2026-06 已结账，禁止新增凭证');

    await expect(service.voucherAction(voucher.id, 'post')).rejects.toThrow(
      '期间 2026-06 已结账，禁止过账'
    );
    await expect(service.voucherAction(voucher.id, 'void')).rejects.toThrow(
      '期间 2026-06 已结账，禁止作废凭证'
    );

    // 被拒操作未改动任何数据
    const rows = await queryRows<{ status: string }>(
      db,
      'SELECT status FROM fin_voucher WHERE id = $1',
      [voucher.id]
    );
    expect(rows[0].status).toBe('posted');
  });

  it('故意破坏借贷平衡：建凭证必须被拒，错误信息给出双方合计', async () => {
    const cash = await ensureAccount('9001', `${TEST_PREFIX} 测试现金`, 'asset');
    const revenue = await ensureAccount('9002', `${TEST_PREFIX} 测试服务收入`, 'revenue');

    // 借方 12000 / 贷方 11000
    await expect(
      service.createVoucher({
        voucherDate: '2026-12-05',
        period: '2026-12',
        summary: `${TEST_PREFIX} 借贷不平`,
        lines: [
          { accountId: cash.id, debit: 12000, credit: 0 },
          { accountId: revenue.id, debit: 0, credit: 11000 },
        ],
      })
    ).rejects.toThrow('借贷不平衡：借方合计 12000，贷方合计 11000');

    // 单边分录（贷方为 0）
    await expect(
      service.createVoucher({
        voucherDate: '2026-12-05',
        period: '2026-12',
        summary: `${TEST_PREFIX} 单边分录`,
        lines: [
          { accountId: cash.id, debit: 100, credit: 0 },
          { accountId: revenue.id, debit: 0, credit: 0 },
        ],
      })
    ).rejects.toThrow('借贷不平衡：借方合计 100，贷方合计 0');

    // 被拒的凭证不得落库、且不占用期间
    const rows = await queryRows<{ total: string }>(
      db,
      `SELECT COUNT(*) AS total FROM fin_voucher WHERE period = '2026-12'`
    );
    expect(Number(rows[0].total)).toBe(0);
  });

  it('凭证入参校验：分录行数 / 期间格式 / 日期与期间一致性 / 无效科目', async () => {
    const cash = await ensureAccount('9001', `${TEST_PREFIX} 测试现金`, 'asset');
    const validLines = [
      { accountId: cash.id, debit: 10, credit: 0 },
      { accountId: cash.id, debit: 0, credit: 10 },
    ];

    await expect(
      service.createVoucher({
        voucherDate: '2026-04-05',
        period: '2026-04',
        summary: `${TEST_PREFIX} 单行分录`,
        lines: [{ accountId: cash.id, debit: 10, credit: 10 }],
      })
    ).rejects.toThrow('凭证分录至少 2 行');

    await expect(
      service.createVoucher({
        voucherDate: '2026-04-05',
        period: '2026/04',
        summary: `${TEST_PREFIX} 期间格式非法`,
        lines: validLines,
      })
    ).rejects.toThrow('期间格式必须为 YYYY-MM');

    await expect(
      service.createVoucher({
        voucherDate: '2026-04-05',
        period: '2026-03',
        summary: `${TEST_PREFIX} 日期与期间不一致`,
        lines: validLines,
      })
    ).rejects.toThrow('凭证日期 2026-04-05 与会计期间 2026-03 不一致');

    await expect(
      service.createVoucher({
        // P2-2 后这里不能再借用 2026-04：该期间早于已结账期间（2026-06），
        // 会先被「补记守卫」拦下。改用晚于最新已结账期间的 2026-09，
        // 让本用例继续验证它真正想覆盖的「无效科目」分支。
        voucherDate: '2026-09-05',
        period: '2026-09',
        summary: `${TEST_PREFIX} 无效科目`,
        lines: [
          { accountId: '00000000-0000-0000-0000-000000000000', debit: 10, credit: 0 },
          { accountId: cash.id, debit: 0, credit: 10 },
        ],
      })
    ).rejects.toThrow('分录存在无效科目');
  });

  it('非末级（汇总）科目不可做账，末级子科目可做账', async () => {
    const parent = await ensureAccount('9300', `${TEST_PREFIX} 测试往来`, 'asset');
    const child = await ensureAccount(
      '930001',
      `${TEST_PREFIX} 测试往来-明细`,
      'asset',
      '9300'
    );
    const revenue = await ensureAccount('930002', `${TEST_PREFIX} 测试收入F`, 'revenue');

    expect(child).toMatchObject({ level: 2, isLeaf: true, parentCode: '9300' });
    // 建了子科目后，父科目自动降级为非末级
    const listed = await service.listAccounts(1, 50, '9300');
    expect(listed.items.map((item) => [item.code, item.isLeaf])).toEqual([
      ['9300', false],
      ['930001', true],
      ['930002', true],
    ]);

    await expect(
      service.createVoucher({
        voucherDate: '2026-07-08',
        period: '2026-07',
        summary: `${TEST_PREFIX} 非末级科目做账`,
        lines: [
          { accountId: parent.id, debit: 100, credit: 0 },
          { accountId: revenue.id, debit: 0, credit: 100 },
        ],
      })
    ).rejects.toThrow(
      `科目 9300 ${TEST_PREFIX} 测试往来 为非末级（汇总）科目，不可直接做账；请选择其明细科目`
    );

    const voucher = await service.createVoucher({
      voucherDate: '2026-07-08',
      period: '2026-07',
      summary: `${TEST_PREFIX} 末级科目做账`,
      lines: [
        { accountId: child.id, debit: 100, credit: 0 },
        { accountId: revenue.id, debit: 0, credit: 100 },
      ],
    });
    expect(voucher.lines.map((line) => line.accountCode).sort()).toEqual([
      '930001',
      '930002',
    ]);
    // 非末级科目在余额表里不出现（只有末级分录参与汇总）
    const balance = await trialBalance(db, '2026-07');
    expect(balance.rows.map((row) => row.accountCode)).toEqual(['930001', '930002']);
    expect(balance.balanced).toBe(true);
  });

  it('存在草稿凭证的期间不可结账', async () => {
    const cash = await ensureAccount('9401', `${TEST_PREFIX} 测试现金G`, 'asset');
    const revenue = await ensureAccount('9402', `${TEST_PREFIX} 测试收入G`, 'revenue');

    const draft = await service.createVoucher({
      voucherDate: '2026-08-06',
      period: '2026-08',
      summary: `${TEST_PREFIX} 草稿凭证`,
      lines: [
        { accountId: cash.id, debit: 3000, credit: 0 },
        { accountId: revenue.id, debit: 0, credit: 3000 },
      ],
    });
    expect(draft.status).toBe('draft');

    await expect(service.closePeriod('2026-08', TEST_USER_ID)).rejects.toThrow(
      '期间 2026-08 存在草稿凭证，不可结账'
    );

    const rows = await queryRows<{ total: string }>(
      db,
      `SELECT COUNT(*) AS total FROM fin_period_close WHERE period = '2026-08'`
    );
    expect(Number(rows[0].total)).toBe(0);

    // 过账后即可结账（同一用例内闭环验证）
    expect((await service.voucherAction(draft.id, 'post')).status).toBe('posted');
    const closed = await service.closePeriod('2026-08', TEST_USER_ID);
    expect(closed).toEqual({
      period: '2026-08',
      voucherCount: 1,
      draftCount: 0,
      totalDebit: 3000,
      totalCredit: 3000,
      balanced: true,
      closed: true,
    });
  });

  /**
   * P2-2：跳期结账本身允许，但**不允许把凭证补记到已结账期间之前**。
   * 上一条用例已把 2026-08 结账，此处 2026-07 仍未结账 —— 若允许写入，
   * 08 月已出具的报表期初数会与 07 月期末数永久矛盾。
   */
  it('补记守卫：已结账期间之前的未结账期间禁止新增/过账凭证', async () => {
    const cash = await ensureAccount('9405', `${TEST_PREFIX} 测试现金I`, 'asset');
    const revenue = await ensureAccount('9406', `${TEST_PREFIX} 测试收入I`, 'revenue');

    await expect(
      service.createVoucher({
        voucherDate: '2026-07-15',
        period: '2026-07',
        summary: `${TEST_PREFIX} 补记到 08 月之前`,
        lines: [
          { accountId: cash.id, debit: 100, credit: 0 },
          { accountId: revenue.id, debit: 0, credit: 100 },
        ],
      })
    ).rejects.toThrow('早于已结账期间 2026-08');
  });

  it('反结账：清空结账标记并写审计留痕，未结账期间反结账被拒', async () => {
    const cash = await ensureAccount('9403', `${TEST_PREFIX} 测试现金H`, 'asset');
    const revenue = await ensureAccount('9404', `${TEST_PREFIX} 测试收入H`, 'revenue');

    const voucher = await service.createVoucher({
      voucherDate: '2026-11-11',
      period: '2026-11',
      summary: `${TEST_PREFIX} 反结账用例`,
      lines: [
        { accountId: cash.id, debit: 8000, credit: 0 },
        { accountId: revenue.id, debit: 0, credit: 8000 },
      ],
    });
    await service.voucherAction(voucher.id, 'post');
    expect((await service.closePeriod('2026-11', TEST_USER_ID)).closed).toBe(true);

    const reopened = await service.unclosePeriod(
      '2026-11',
      TEST_USER_ID,
      `${TEST_PREFIX} 反结账复核`
    );
    expect(reopened.closed).toBe(false);
    expect(reopened.balanced).toBe(true);
    expect(reopened.totalDebit).toBe(8000);
    expect(reopened.totalCredit).toBe(8000);

    const audits = await queryRows<{
      period: string;
      action: string;
      actor_user_id: string;
      remark: string;
    }>(
      db,
      `SELECT period, action, actor_user_id, remark FROM fin_period_close_audit
        WHERE period = '2026-11' ORDER BY created_at`
    );
    expect(audits).toEqual([
      {
        period: '2026-11',
        action: 'unclose',
        actor_user_id: TEST_USER_ID,
        remark: `${TEST_PREFIX} 反结账复核`,
      },
    ]);

    await expect(service.unclosePeriod('2026-11', TEST_USER_ID)).rejects.toThrow(
      '期间 2026-11 未结账，无需反结账'
    );
  });

  it('凭证校验补充：停用科目 / 必填辅助核算 / 辅助核算写入 / 非法维度配置', async () => {
    const cash = await ensureAccount('9001', `${TEST_PREFIX} 测试现金`, 'asset');
    const revenue = await ensureAccount('9002', `${TEST_PREFIX} 测试服务收入`, 'revenue');

    /* 停用科目不可做账（status 只能由运维改，故用 SQL 直改） */
    const disabled = await ensureAccount('9501', `${TEST_PREFIX} 停用科目`, 'asset');
    await db.exec(`UPDATE fin_account SET status = 'inactive' WHERE code = '9501'`);
    await expect(
      service.createVoucher({
        voucherDate: '2026-09-03',
        period: '2026-09',
        summary: `${TEST_PREFIX} 停用科目做账`,
        lines: [
          { accountId: disabled.id, debit: 10, credit: 0 },
          { accountId: revenue.id, debit: 0, credit: 10 },
        ],
      })
    ).rejects.toThrow('科目 9501 已停用，不可做账');
    await db.exec(`UPDATE fin_account SET status = 'active' WHERE code = '9501'`);

    /* 科目要求辅助核算维度时必须填写 */
    const auxAccount = await service.createAccount({
      code: '9502',
      name: `${TEST_PREFIX} 需挂项目维度`,
      accountType: 'expense',
      auxRequired: ['project'],
    });
    expect(auxAccount.auxRequired).toEqual(['project']);
    await expect(
      service.createVoucher({
        voucherDate: '2026-09-04',
        period: '2026-09',
        summary: `${TEST_PREFIX} 缺辅助核算`,
        lines: [
          { accountId: auxAccount.id, debit: 20, credit: 0 },
          { accountId: cash.id, debit: 0, credit: 20 },
        ],
      })
    ).rejects.toThrow('科目 9502 要求填写辅助核算维度：project');

    /* 填写维度后成功，且维度值真实落库 */
    const auxVoucher = await service.createVoucher({
      voucherDate: '2026-09-04',
      period: '2026-09',
      summary: `${TEST_PREFIX} 带辅助核算`,
      lines: [
        {
          accountId: auxAccount.id,
          debit: 20,
          credit: 0,
          auxDimensions: [{ dimensionCode: 'project', dimensionValue: 'PRJ-API-TEST' }],
        },
        { accountId: cash.id, debit: 0, credit: 20 },
      ],
    });
    const auxLine = auxVoucher.lines.find((line) => line.accountCode === '9502');
    // 维度名称来自迁移种子 fin_aux_dimension（project → 项目）
    const dimension = await queryRows<{ name: string }>(
      db,
      `SELECT name FROM fin_aux_dimension WHERE code = 'project'`
    );
    expect(dimension).toEqual([{ name: '项目' }]);
    expect(auxLine?.aux).toEqual([
      {
        dimensionCode: 'project',
        dimensionName: '项目',
        dimensionId: null,
        dimensionValue: 'PRJ-API-TEST',
      },
    ]);
    const auxRows = await queryRows<{ dimension_value: string }>(
      db,
      `SELECT dimension_value FROM fin_voucher_line_aux WHERE voucher_id = $1`,
      [auxVoucher.id]
    );
    expect(auxRows).toEqual([{ dimension_value: 'PRJ-API-TEST' }]);

    /* fin_account.aux_required 非法 JSON 时按"无要求"处理（防御分支） */
    await db.exec(
      `UPDATE fin_account SET aux_required = 'not-json' WHERE code = '9501'`
    );
    const listed = await service.listAccounts(1, 50, '9501');
    expect(listed.items[0].auxRequired).toEqual([]);

    /* listVouchers 过滤与分页（按状态 / 期间 / 来源） */
    const byStatus = await service.listVouchers(1, 20, 'draft', '2026-09', 'manual');
    expect(byStatus.items.map((item) => item.code)).toContain(auxVoucher.code);
    expect(byStatus.items.every((item) => item.status === 'draft')).toBe(true);
    expect(byStatus.items.every((item) => item.period === '2026-09')).toBe(true);
    expect(byStatus.items.every((item) => item.sourceType === 'manual')).toBe(true);
    // 过滤结果里不含其它期间的凭证明细（如 2026-11 的用例凭证）
    const all = await service.listVouchers(1, 20);
    expect(all.total).toBeGreaterThanOrEqual(byStatus.total);
    expect(
      all.items.some((item) => item.period !== '2026-09')
    ).toBe(true);
  });

  it('期间操作补充：格式校验 / 作废凭证不可再作废或过账', async () => {
    await expect(service.closePeriod('2026/01', TEST_USER_ID)).rejects.toThrow(
      '期间格式必须为 YYYY-MM'
    );
    await expect(
      service.unclosePeriod('2026/01', TEST_USER_ID)
    ).rejects.toThrow('期间格式必须为 YYYY-MM');

    /* 作废后的凭证不可再作废，作废凭证也不可过账 */
    const cash = await ensureAccount('9001', `${TEST_PREFIX} 测试现金`, 'asset');
    const revenue = await ensureAccount('9002', `${TEST_PREFIX} 测试服务收入`, 'revenue');
    const voucher = await service.createVoucher({
      voucherDate: '2026-09-10',
      period: '2026-09',
      summary: `${TEST_PREFIX} 状态机边界`,
      lines: [
        { accountId: cash.id, debit: 30, credit: 0 },
        { accountId: revenue.id, debit: 0, credit: 30 },
      ],
    });
    await service.voucherAction(voucher.id, 'post');
    expect((await service.voucherAction(voucher.id, 'void')).status).toBe('voided');
    await expect(service.voucherAction(voucher.id, 'void')).rejects.toThrow(
      '非法的状态流转：voided 状态不允许作废'
    );
    await expect(service.voucherAction(voucher.id, 'post')).rejects.toThrow(
      '非法的状态流转：voided 状态不允许过账（仅草稿可过账）'
    );
  });

  it('作废凭证后余额回退：科目发生额归零，借贷恒等式仍成立', async () => {
    const cash = await ensureAccount('9405', `${TEST_PREFIX} 测试现金I`, 'asset');
    const revenue = await ensureAccount('9406', `${TEST_PREFIX} 测试收入I`, 'revenue');

    const voucher = await service.createVoucher({
      voucherDate: '2026-10-09',
      period: '2026-10',
      summary: `${TEST_PREFIX} 作废回退用例`,
      lines: [
        { accountId: cash.id, debit: 5000, credit: 0 },
        { accountId: revenue.id, debit: 0, credit: 5000 },
      ],
    });
    await service.voucherAction(voucher.id, 'post');

    // 过账后余额 5000，试算平衡
    expect(await accountMovement(db, '9405', '2026-10')).toEqual({
      debit: 5000,
      credit: 0,
      netDebit: 5000,
    });
    const before = await trialBalance(db, '2026-10');
    expect(before.rows.map((row) => row.accountCode)).toEqual(['9405', '9406']);
    expect(before.totalDebit).toBe(5000);
    expect(before.totalCredit).toBe(5000);
    expect(before.balanced).toBe(true);

    // 已结账期间禁止作废
    expect((await service.closePeriod('2026-10', TEST_USER_ID)).closed).toBe(true);
    await expect(service.voucherAction(voucher.id, 'void')).rejects.toThrow(
      '期间 2026-10 已结账，禁止作废凭证'
    );

    // 反结账后作废 → 余额回退到 0
    await service.unclosePeriod('2026-10', TEST_USER_ID, `${TEST_PREFIX} 作废前反结账`);
    expect((await service.voucherAction(voucher.id, 'void')).status).toBe('voided');

    expect(await accountMovement(db, '9405', '2026-10')).toEqual({
      debit: 0,
      credit: 0,
      netDebit: 0,
    });
    expect(await accountMovement(db, '9406', '2026-10')).toEqual({
      debit: 0,
      credit: 0,
      netDebit: 0,
    });
    const after = await trialBalance(db, '2026-10');
    expect(after.rows).toEqual([]);
    expect(after.totalDebit).toBe(0);
    expect(after.totalCredit).toBe(0);
    expect(after.balanced).toBe(true);

    // 作废只改状态、不删分录（审计可追溯）
    const rows = await queryRows<{ status: string; lines: string }>(
      db,
      `SELECT v.status,
              (SELECT COUNT(*) FROM fin_voucher_line l WHERE l.voucher_id = v.id) AS lines
         FROM fin_voucher v WHERE v.id = $1`,
      [voucher.id]
    );
    expect(rows[0].status).toBe('voided');
    expect(Number(rows[0].lines)).toBe(2);

    // 作废后该期间已无有效凭证，可再次结账且合计为 0
    expect(await service.closePeriod('2026-10', TEST_USER_ID)).toEqual({
      period: '2026-10',
      voucherCount: 0,
      draftCount: 0,
      totalDebit: 0,
      totalCredit: 0,
      balanced: true,
      closed: true,
    });

    // 全库借贷恒等式（所有非作废凭证行）
    const identity = await ledgerIdentity(db);
    expect(identity.balanced).toBe(true);
    expect(identity.totalDebit).toBe(identity.totalCredit);
    expect(identity.lineCount).toBeGreaterThan(0);
  });

  /**
   * 本用例刻意放在文件末尾：它会留下"最晚期间已结账"的状态，
   * 若排在前面会让其它用例的 unclosePeriod 被同一条守卫拦住（守卫只看更晚期间）。
   */
  it('期间守卫：存在更晚已结账期间时反结账被拒，最晚期间可正常反结账', async () => {
    // 2027-01 / 2027-02 无任何凭证（合计 0），用于构造"更晚期间已结账"
    expect((await service.closePeriod('2027-01', TEST_USER_ID)).closed).toBe(true);
    expect((await service.closePeriod('2027-02', TEST_USER_ID)).closed).toBe(true);

    await expect(service.unclosePeriod('2027-01', TEST_USER_ID)).rejects.toThrow(
      '存在更晚已结账期间 2027-02，请先反结账后续期间'
    );
    // 2027-02 是最晚已结账期间（其后无已结账期间），可正常反结账
    const reopened = await service.unclosePeriod('2027-02', TEST_USER_ID);
    expect(reopened).toMatchObject({
      period: '2027-02',
      closed: false,
      totalDebit: 0,
      totalCredit: 0,
    });
  });
});
