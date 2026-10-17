import {
  applyMigrationChain,
  createDrizzle,
  createPglite,
  loadMigrations,
  queryRows,
} from '@server/test/integration/pglite-harness';
import { VoucherService } from '@server/modules/voucher/voucher.service';
import type { PostgresJsDatabase } from '@server/platform';

const CHAIN_TIMEOUT_MS = 120_000;

/**
 * A-09：科目启用/停用。
 *
 * ## 为什么这组测试重要
 *
 * `setAccountStatus` 的两道门槛（有下级科目不可停用、有凭证发生额不可停用）
 * 是**报表可信度的保护**，而不是体验优化：
 * 停用一个有余额的科目，会让它的历史余额继续出现在资产负债表上，
 * 但做账时被拒绝 —— 形成"看得到、动不了"的状态，比不停更糟。
 * 这类缺陷不会报错，只会在期末对账时变成一个没人解释得清的数字。
 */
describe('A-09 科目启用/停用', () => {
  let db: Awaited<ReturnType<typeof createPglite>>;
  let service: VoucherService;

  beforeAll(async () => {
    db = await createPglite();
    await applyMigrationChain(db, loadMigrations());
    service = new VoucherService(
      createDrizzle(db) as unknown as PostgresJsDatabase
    );
  }, CHAIN_TIMEOUT_MS);

  afterAll(async () => {
    await db?.close();
  });

  const uniqueCode = (suffix: string) => `9${suffix}`.padEnd(4, '0').slice(0, 4);

  it('停用无发生额的末级科目成功，且再次查询状态为 inactive', async () => {
    const code = uniqueCode('901');
    await service.createAccount({
      code,
      name: '[API_TEST]待停用科目',
      accountType: 'expense',
    });
    const updated = await service.setAccountStatus(code, 'inactive');
    expect(updated.code).toBe(code);
    expect(updated.status).toBe('inactive');

    // 落库确认（不能只信任返回值）
    const rows = await queryRows<{ status: string }>(
      db,
      `SELECT status FROM fin_account WHERE code = '${code}'`
    );
    expect(rows[0].status).toBe('inactive');
  });

  it('停用是可逆的：可以重新启用', async () => {
    const code = uniqueCode('902');
    await service.createAccount({
      code,
      name: '[API_TEST]可逆科目',
      accountType: 'expense',
    });
    await service.setAccountStatus(code, 'inactive');
    const back = await service.setAccountStatus(code, 'active');
    expect(back.status).toBe('active');
  });

  it('存在下级科目的父科目不可停用（否则整棵树语义含混）', async () => {
    const parent = uniqueCode('910');
    const child = uniqueCode('911');
    await service.createAccount({
      code: parent,
      name: '[API_TEST]父科目',
      accountType: 'expense',
    });
    await service.createAccount({
      code: child,
      name: '[API_TEST]子科目',
      accountType: 'expense',
      parentCode: parent,
    });
    await expect(service.setAccountStatus(parent, 'inactive')).rejects.toThrow(
      /存在下级科目/
    );
    // 子科目本身可以停用（它没有下级）
    const childUpdated = await service.setAccountStatus(child, 'inactive');
    expect(childUpdated.status).toBe('inactive');
  });

  it('已有凭证发生额的科目不可停用（避免"看得到、动不了"）', async () => {
    const code = uniqueCode('920');
    const account = await service.createAccount({
      code,
      name: '[API_TEST]已发生额科目',
      accountType: 'expense',
    });
    /*
     * 直接写入一条分录：模拟该科目已被使用。
     *
     * ⚠️ 2026-10-17：**必须先建父凭证**。
     * `fin_voucher_line.voucher_id` 原先没有外键，所以本 spec 只用了个悬空 uuid
     * 也能插进去；迁移 `2026-10-17-fix12-voucher-line-fk.sql` 补上
     * `FOREIGN KEY … ON DELETE CASCADE` 之后，这个插入被正确拒绝
     * （`violates foreign key constraint "fk_fin_voucher_line_voucher"`）。
     *
     * 这说明**之前的写法在造非法数据**（分录没有父凭证），
     * 而"分录属于某张凭证"本来就是业务事实 —— 补父凭证后 spec 更贴近真实，
     * 也正是那道外键想保证的。
     */
    await db.exec(`
      INSERT INTO fin_voucher (id, code, period, summary, status)
      VALUES ('eeeeeeee-0000-4000-8000-000000000001',
              'VCH-API-TEST-920', '2026-10', '[API_TEST]科目停用测试凭证', 'draft')
      ON CONFLICT (id) DO NOTHING;
    `);
    await db.exec(`
      INSERT INTO fin_voucher_line (id, voucher_id, summary, account_code, debit, credit)
      VALUES ('dddddddd-0000-4000-8000-000000000001',
              'eeeeeeee-0000-4000-8000-000000000001',
              '[API_TEST]已用科目分录', '${code}', 100, 0)
      ON CONFLICT (id) DO NOTHING;
    `);
    void account;

    await expect(service.setAccountStatus(code, 'inactive')).rejects.toThrow(
      /已有凭证发生额/
    );
    // 错误信息必须解释清楚后果，而不只是说"不允许"
    await expect(service.setAccountStatus(code, 'inactive')).rejects.toThrow(
      /历史余额仍会出现在报表中/
    );
  });

  it('不存在的科目 → 可读中文报错', async () => {
    await expect(
      service.setAccountStatus('99999999', 'inactive')
    ).rejects.toThrow(/不存在/);
  });

  it('停用后该科目不可做账（与 createVoucher 的状态校验一致）', async () => {
    const code = uniqueCode('930');
    const account = await service.createAccount({
      code,
      name: '[API_TEST]停用后不可做账',
      accountType: 'expense',
    });
    await service.setAccountStatus(code, 'inactive');

    // 构造一张借贷平衡的凭证，其中一行用被停用的科目
    const cash = await service.createAccount({
      code: uniqueCode('931'),
      name: '[API_TEST]对方科目',
      accountType: 'asset',
    });
    await expect(
      service.createVoucher({
        voucherDate: '2026-10-15',
        period: '2026-10',
        summary: '[API_TEST]停用科目做账',
        lines: [
          { accountId: account.id, debit: 100, credit: 0 },
          { accountId: cash.id, debit: 0, credit: 100 },
        ],
      })
    ).rejects.toThrow(/已停用/);
  });
});
