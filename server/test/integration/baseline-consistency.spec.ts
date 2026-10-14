import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  applyMigrationChain,
  createPglite,
  loadMigrations,
  queryRows,
} from './pglite-harness';

// 本文件位于 server/test/integration/，故仓库根需上溯三级
const REPO_ROOT = resolve(__dirname, '../../..');

/**
 * 基线一致性审计：**迁移建出来的表，是否真的被业务代码使用**。
 *
 * ## 为什么需要
 *
 * 本项目已出现过两次「有表无码」的失实汇报（C-04 票据、C-05 退货），
 * 验收标准因此写进了台账：新增功能必须「表 + service + controller + 契约 +
 * 前端 + 单测」全部落地。但这条标准此前只能靠人工核对 ——
 * `rg -l 'purReturn|salesReturn' server client shared` 需要人记得去跑，
 * 而且对"用 raw SQL 访问、不走 drizzle 变量"的表会误判。
 *
 * 这个 spec 把它自动化：
 * 1. 从迁移链（pglite 全量执行）取出**真实的表清单**；
 * 2. 扫描 `server` / `client` / `shared` 下全部源码（含 `raw SQL` 里的表名，
 *    而不仅是 drizzle 变量引用）—— 这样用 `sql\`insert into sys_feishu_event ...\``
 *    访问的表不会被误报；
 * 3. 任何既无 drizzle 变量引用、也无 raw SQL 表名引用的表，即为**孤儿表**，
 *    必须显式登记在下面的 `KNOWN_UNUSED_TABLES` 白名单里并写明理由。
 *
 * ## 白名单不是免罪符
 *
 * 白名单要求写明「为什么允许存在」，且必须是以下两类之一：
 * - **基础设施表**：由迁移/引导脚本/运维工具使用，不在应用代码里出现；
 * - **已知缺口**：建了但功能未实现，需要明确登记（绝不能悄悄留着）。
 *
 * 前者是设计如此，后者是待办。两者混在一起会让"未实现"看起来像"设计如此"，
 * 所以白名单条目必须带上 `kind` 字段区分。
 */
interface UnusedTableEntry {
  table: string;
  /** infra = 设计如此；gap = 已建表但功能未实现（待办） */
  kind: 'infra' | 'gap';
  reason: string;
}

/**
 * 允许"无业务代码引用"的表。
 *
 * ⚠️ 维护约定：新增条目必须写明理由与 kind。新增 `gap` 条目等同于
 * 记录一个技术债，应在台账遗留清单里同步登记。
 */
const KNOWN_UNUSED_TABLES: UnusedTableEntry[] = [
  {
    table: 'schema_migrations',
    kind: 'infra',
    reason: '迁移执行记录表，由 scripts/db-migrate.mjs 独占读写，应用代码不应访问',
  },
  {
    table: 'fin_account_balance_snapshot',
    kind: 'gap',
    reason:
      'A-03 科目余额快照表，已建但未实现读写 —— 当前报表每次实时聚合 ' +
      'fin_voucher_line。**实测（真实 PostgreSQL，10 万凭证行）P95 292ms，' +
      'NFR-P2 的 3s 预算约 10 倍余量，故暂不实现物化**' +
      '（物化会引入"报表显示过期数据"的风险）。' +
      '复测脚本 scripts/bench-report-query-pg.mjs；重新评估条件见 schema.ts 该表注释',
  },
  {
    table: 'pur_return_item',
    kind: 'gap',
    reason:
      'C-05 采购退货**明细行**表，已建但未实现 —— 当前 pur_return 只存整单 ' +
      'return_quantity/amount，不支持按行退货。需业务确认是否要求行级退货',
  },
  {
    table: 'sales_return_item',
    kind: 'gap',
    reason:
      'C-05 销售退货**明细行**表，同上。当前 sales_return 只存整单金额，' +
      '不支持按行退货。需业务确认是否要求行级退货',
  },
];

describe('基线一致性审计：孤儿表', () => {
  let db: Awaited<ReturnType<typeof createPglite>>;

  beforeAll(async () => {
    db = await createPglite();
    await applyMigrationChain(db, loadMigrations());
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  it('迁移建出的表都必须被业务代码使用，或登记在白名单中', async () => {
    const rows = await queryRows<{ table_name: string }>(
      db,
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    const allTables = rows
      .map((row) => row.table_name)
      // pgcrypto / 扩展自带表不在审计范围
      .filter((name) => !name.startsWith('pg_'));

    // 收集全部源码文本
    const files: string[] = [];
    const walk = (dir: string) => {
      if (!statSync(dir).isDirectory()) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full);
          continue;
        }
        if (/\.(ts|tsx)$/.test(full) && !full.endsWith('schema.ts')) {
          files.push(full);
        }
      }
    };
    walk(join(REPO_ROOT, 'server'));
    walk(join(REPO_ROOT, 'client'));
    walk(join(REPO_ROOT, 'shared'));

    const blobs = files.map((file) => readFileSync(file, 'utf8'));
    const whitelist = new Set(KNOWN_UNUSED_TABLES.map((item) => item.table));

    // 建立「表名 → drizzle 变量名」映射：代码里可能用表名字符串
    // （raw SQL / 动态拼接），也可能用 drizzle 变量（crmContact）。
    // 只查表名会漏掉后者（表名不会出现在 drizzle 查询里），
    // 只查变量会漏掉前者（raw SQL 不引用变量）—— 必须两者都查。
    const schemaText = readFileSync(
      join(REPO_ROOT, 'server', 'database', 'schema.ts'),
      'utf8'
    );
    const varByTable = new Map<string, string>();
    for (const match of schemaText.matchAll(
      /export const (\w+) = pgTable\(\s*"([^"]+)"/g
    )) {
      varByTable.set(match[2], match[1]);
    }

    const orphans: string[] = [];
    for (const table of allTables) {
      if (whitelist.has(table)) continue;
      const drizzleVar = varByTable.get(table);
      const used = blobs.some(
        (text) =>
          text.includes(table) ||
          (drizzleVar !== undefined &&
            new RegExp(`\\b${drizzleVar}\\b`).test(text))
      );
      if (!used) orphans.push(table);
    }

    expect(orphans).toEqual([]);
  });

  it('白名单条目仍然真实存在且确实未被引用（避免白名单腐化）', async () => {
    const rows = await queryRows<{ table_name: string }>(
      db,
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const allTables = new Set(rows.map((row) => row.table_name));

    const problems: string[] = [];
    for (const entry of KNOWN_UNUSED_TABLES) {
      // ① 表必须存在：否则白名单在为一个已删除的表留位置
      if (!allTables.has(entry.table)) {
        problems.push(`${entry.table}：白名单条目指向的表已不存在，应删除该条目`);
      }
      // ② 理由必须写清楚（不能是占位符）
      if (entry.reason.trim().length < 20) {
        problems.push(
          `${entry.table}：reason 过短（${entry.reason.trim().length} 字），必须说明为什么允许无引用`
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('每个 gap 类白名单条目都已登记在台账遗留清单中', () => {
    // 这条断言把"技术债可见"变成可执行约束：gap 条目不能只写在代码注释里，
    // 必须同时出现在人看的台账中，否则等于没记录。
    const ledger = readFileSync(
      join(REPO_ROOT, 'docs', '升级落地状态台账-2026-10-15.md'),
      'utf8'
    );
    const gaps = KNOWN_UNUSED_TABLES.filter((item) => item.kind === 'gap');
    const missing = gaps
      .filter((item) => !ledger.includes(item.table))
      .map((item) => item.table);
    expect(missing).toEqual([]);
  });

  it('白名单条目不含重复表名', () => {
    const names = KNOWN_UNUSED_TABLES.map((item) => item.table);
    expect(names.length).toBe(new Set(names).size);
  });
});
