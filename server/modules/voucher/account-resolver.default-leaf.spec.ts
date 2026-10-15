import {
  applyMigrationChain,
  createDrizzle,
  createPglite,
  loadMigrations,
  queryRows,
} from '@server/test/integration/pglite-harness';
import { AccountResolverService } from '@server/modules/voucher/account-resolver.service';
import type { PostgresJsDatabase } from '@server/platform';

const CHAIN_TIMEOUT_MS = 120_000;

/**
 * P2-6：汇总科目的下钻目标可配置。
 *
 * ## 为什么这件事必须被测试锁住
 *
 * 下钻结果决定了**钱记到哪个科目**。原先它由"编码字典序第一个启用末级后代"决定，
 * 于是科目表里新增一个编码更小的子科目，入账口径就会**静默漂移**，
 * 而凭证明细上看不出"换过科目"。这类缺陷不报错、不平账，只会让费用慢慢
 * 归集到错的明细里 —— 事后对账才发现，且已经跨了几个会计期间。
 *
 * 因此断言两件事：**配置能决定科目**；**配置写错时回落到原行为而不是抛错**
 * （做账不能因一条配错的映射中断，但配错必须留痕，不能静默取到别的科目）。
 *
 * 期望值全部从种子科目表现取，不写死编码 —— 否则科目表一调整测试就假红。
 */
describe('P2-6 科目下钻：配置优先、字典序兜底', () => {
  let db: Awaited<ReturnType<typeof createPglite>>;
  let resolver: AccountResolverService;
  /** 6602 下所有启用的末级后代，按编码升序 */
  let leaves: string[] = [];

  beforeAll(async () => {
    db = await createPglite();
    await applyMigrationChain(db, loadMigrations());
    resolver = new AccountResolverService(
      createDrizzle(db) as unknown as PostgresJsDatabase
    );
    const rows = await queryRows<{ code: string; is_leaf: number; status: string }>(
      db,
      `SELECT code, is_leaf, status FROM fin_account
        WHERE code LIKE '6602%' ORDER BY code`
    );
    leaves = rows
      .filter((r) => Number(r.is_leaf) === 1 && r.status === 'active')
      .map((r) => r.code);
  }, CHAIN_TIMEOUT_MS);

  /** 设置 6602 的下钻目标并失效解析缓存（结果有 60s 缓存，改配置后必须失效） */
  const setDefaultLeaf = async (code: string | null) => {
    await db.query(
      `UPDATE fin_account SET default_leaf_code = $1 WHERE code = '6602'`,
      [code]
    );
    resolver.invalidate();
  };

  it('前提：种子科目表里 6602 至少有 2 个启用末级后代（否则本文件断言无意义）', () => {
    expect(leaves.length).toBeGreaterThanOrEqual(2);
  });

  it('未配置时：回落编码字典序第一个启用末级后代（原行为不变）', async () => {
    await setDefaultLeaf(null);
    const account = await resolver.resolve('6602');
    expect(account?.code).toBe(leaves[0]);
    expect(account?.requestedCode).toBe('6602');
    expect(account?.drilledDown).toBe(true);
  }, CHAIN_TIMEOUT_MS);

  it('配置了 default_leaf_code 时：按配置下钻，压过字典序', async () => {
    const target = leaves[leaves.length - 1];
    await setDefaultLeaf(target);
    const account = await resolver.resolve('6602');
    expect(account?.code).toBe(target);
  }, CHAIN_TIMEOUT_MS);

  it('配置指向不存在的编码 → 回落字典序，不阻断做账', async () => {
    await setDefaultLeaf('999999');
    const account = await resolver.resolve('6602');
    expect(account?.code).toBe(leaves[0]);
  }, CHAIN_TIMEOUT_MS);

  it('配置指向非末级科目 → 回落字典序（避免再产生一层歧义）', async () => {
    await setDefaultLeaf('6602');
    const account = await resolver.resolve('6602');
    expect(account?.code).toBe(leaves[0]);
  }, CHAIN_TIMEOUT_MS);

  it('配置指向已停用的末级 → 回落字典序，不会把费用记到停用科目', async () => {
    const target = leaves[leaves.length - 1];
    try {
      await db.query(`UPDATE fin_account SET status = 'inactive' WHERE code = $1`, [
        target,
      ]);
      await setDefaultLeaf(target);
      const account = await resolver.resolve('6602');
      expect(account?.code).toBe(leaves[0]);
    } finally {
      await db.query(`UPDATE fin_account SET status = 'active' WHERE code = $1`, [
        target,
      ]);
    }
  }, CHAIN_TIMEOUT_MS);

  it('请求末级科目本身：原样返回、不下钻，也不受配置影响', async () => {
    await setDefaultLeaf(leaves[leaves.length - 1]);
    const account = await resolver.resolve(leaves[0]);
    expect(account?.code).toBe(leaves[0]);
    expect(account?.drilledDown).toBe(false);
  }, CHAIN_TIMEOUT_MS);

  /**
   * 回归锁：2221（应交税费）的下钻目标必须稳定为 222101。
   *
   * 为什么值得单独锁一条：凭证行写的是 222101/222102，而常量 `ACCOUNT_TAX_PAYABLE`
   * 指向的是**汇总科目** 2221。下钻规则是"编码字典序第一个启用末级后代"——
   * 也就是说，将来只要有人往 2221 下插入一个编码更小的子科目，或把 222101 停用，
   * 所有走 2221 的凭证就会**静默改记到别的科目**：不报错、不平账、事后才发现。
   *
   * 迁移 batch9 内置了同样的断言，但那只在迁移执行时校验一次；
   * 这条测试把约束固定成长期的，防止后续科目表调整再次动摇落账口径。
   */
  it('2221 应交税费：下钻目标锁死为 222101（防止科目表调整静默改变落账）', async () => {
    const account = await resolver.resolve('2221');
    expect(account?.code).toBe('222101');
    expect(account?.drilledDown).toBe(true);
  }, CHAIN_TIMEOUT_MS);

  /**
   * 附加税费的科目可用性（验证 batch8 / batch9 两个迁移的产物真能用于做账）。
   *
   * 为什么现在就验：附加税计提会写 `6403x`（借）与 `2221xx`（贷）。
   * 如果种子里这些科目漏设 `is_leaf = 1`、或 `status` 不是 active、
   * 或父子编码写错，**失败会推迟到第一次真正计提落账时才暴露**——
   * 而那一刻正是月末结账、最不该出问题的时候。
   * 现在验，成本是几行断言；那时验，成本是一张失败的凭证和一次排查。
   */
  it('6403 税金及附加：已拆为末级明细，下钻到 640301（城建税）', async () => {
    const account = await resolver.resolve('6403');
    expect(account?.code).toBe('640301');
    expect(account?.drilledDown).toBe(true);
  }, CHAIN_TIMEOUT_MS);

  it.each([
    ['640301', '税金及附加—城建税（借方）'],
    ['640302', '税金及附加—教育费附加（借方）'],
    ['640303', '税金及附加—地方教育附加（借方）'],
    ['222106', '应交税费-城建税（贷方）'],
    ['222110', '应交税费-教育费附加（贷方）'],
    ['222111', '应交税费-地方教育附加（贷方）'],
  ])('%s 是可做账的启用末级科目：%s', async (code) => {
    const account = await resolver.resolve(code);
    expect(account?.code).toBe(code);
    expect(account?.drilledDown).toBe(false);
  }, CHAIN_TIMEOUT_MS);

  /* ==================== P2-11：业务场景 → 科目 ==================== */

  /** 设置场景映射（null = 删除该场景配置）并失效缓存 */
  const setSceneMapping = async (scene: string, code: string | null) => {
    await db.query(`DELETE FROM fin_account_mapping WHERE scene = $1`, [scene]);
    if (code !== null) {
      await db.query(
        `INSERT INTO fin_account_mapping (scene, account_code) VALUES ($1, $2)`,
        [scene, code]
      );
    }
    resolver.invalidate();
  };

  it('P2-11 未配置场景：回落调用方给的默认科目', async () => {
    await setSceneMapping('payroll_accrual', null);
    const account = await resolver.resolveSceneAccount('payroll_accrual', leaves[0]);
    expect(account?.code).toBe(leaves[0]);
  }, CHAIN_TIMEOUT_MS);

  it('P2-11 配置了场景：用配置的科目，而不是默认科目', async () => {
    await setSceneMapping('payroll_accrual', leaves[leaves.length - 1]);
    const account = await resolver.resolveSceneAccount('payroll_accrual', leaves[0]);
    expect(account?.code).toBe(leaves[leaves.length - 1]);
  }, CHAIN_TIMEOUT_MS);

  it('P2-11 场景配了汇总科目：照常下钻到末级（允许业务按大类配置）', async () => {
    // 先清掉 6602 上的下钻配置，否则下钻结果会沿用上一个用例留下的 default_leaf_code
    await setDefaultLeaf(null);
    await setSceneMapping('payroll_accrual', '6602');
    const account = await resolver.resolveSceneAccount('payroll_accrual', '6401');
    expect(account?.code).toBe(leaves[0]);
  }, CHAIN_TIMEOUT_MS);

  it('P2-11 场景配了不存在的科目：回落默认科目，不阻断做账', async () => {
    await setSceneMapping('payroll_accrual', '999999');
    const account = await resolver.resolveSceneAccount('payroll_accrual', leaves[0]);
    expect(account?.code).toBe(leaves[0]);
  }, CHAIN_TIMEOUT_MS);
});
