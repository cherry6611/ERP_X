import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  applyMigrationChain,
  createPglite,
  loadMigrations,
  queryRows,
  tableExists,
} from './pglite-harness';

// 本文件位于 server/test/integration/，故仓库根需上溯三级
const REPO_ROOT = resolve(__dirname, '../../..');

/**
 * 提取源码中的 **SQL 模板片段**。
 *
 * 做两件事：
 * 1. 去掉注释（避免把文档注释里的示例当成真实 SQL）；
 * 2. 取出反引号模板里含 SQL 关键字的片段。
 *
 * 为什么不是"扫全文 + 列名黑名单"：本仓 SQL 别名惯例是小写单字母，
 * 与 TypeScript 回调参数（`(t) => t.weight`）完全同名，无法靠列名区分。
 * 限定到 SQL 片段后这类误报从根上消失，且不需要维护黑名单。
 */
function extractSqlTemplateRegions(text: string): string[] {
  const noComments = text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
  const regions: string[] = [];
  // 反引号模板（含 sql`...` 与普通模板）；非贪婪跨行
  for (const match of noComments.matchAll(/`([^`]*)`/gs)) {
    const body = match[1];
    // 只保留看起来是 SQL 的片段：出现 FROM/JOIN 且出现表名
    if (/\b(FROM|JOIN)\s+[a-z_]/i.test(body)) regions.push(body);
  }
  return regions;
}

/**
 * A-01/A-06 修复回归：**代码引用的列必须在库里真实存在**。
 *
 * ## 为什么需要这个 spec
 *
 * `fin_voucher.tax_entity_id` 长期缺失，而 `ledgers.service.ts` /
 * `reports.service.ts` / `vat-declaration.service.ts` / `aux-combination.service.ts`
 * 的 SQL 都写了 `AND v.tax_entity_id = ...`。后果是**任何传了 `taxEntityId`
 * 的报表请求直接 500**（PostgreSQL: column does not exist）。
 *
 * CI 没拦住的原因很具体：`migrate:dryrun` 与迁移链集成测试**只执行 DDL**，
 * 从不执行这些业务查询；而现有集成测试都没传 `taxEntityId`。
 * 也就是"迁移通过 ≠ 功能可用"。
 *
 * 因此这个 spec 做两件事：
 * 1. **静态审计**：扫描 `server` 下全部 `.ts` 源码里所有 `别名.列名` 形式的 SQL 引用，
 *    建立「别名 → 表」映射后与真实库结构比对，任何不存在的列都报出来。
 *    这样同类问题（如 `ast_asset.keeper_employee_id`）能在 CI 被发现。
 * 2. **行为验证**：在迁移后的库上真的构造一个纳税主体 + 凭证，
 *    执行按主体过滤的余额查询，断言不报错且结果隔离正确。
 */
describe('A-01/A-06 列引用一致性审计', () => {
  let db: Awaited<ReturnType<typeof createPglite>>;

  beforeAll(async () => {
    db = await createPglite();
    await applyMigrationChain(db, loadMigrations());
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  it('fin_voucher 必须具备 tax_entity_id（报表按主体出具的前提）', async () => {
    const rows = await queryRows<{ column_name: string }>(
      db,
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'fin_voucher' AND column_name = 'tax_entity_id'`
    );
    expect(rows).toHaveLength(1);
  });

  it('未归属凭证自检视图可用（供运维发现漏归属）', async () => {
    const rows = await queryRows<{ period: string; voucher_count: number }>(
      db,
      `SELECT period, voucher_count FROM v_fin_voucher_unassigned_entity`
    );
    // 空库应返回 0 行且不报错（视图存在即可）
    expect(Array.isArray(rows)).toBe(true);
  });

  it('静态审计：源码中「别名.列名」引用必须在真实库中存在', async () => {
    const columns = await queryRows<{ table_name: string; column_name: string }>(
      db,
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'`
    );
    const byTable = new Map<string, Set<string>>();
    for (const row of columns) {
      if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Set());
      byTable.get(row.table_name)!.add(row.column_name);
    }

    const serverDir = join(REPO_ROOT, 'server');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (
          full.endsWith('.ts') &&
          !full.endsWith('.spec.ts') &&
          !full.includes(`${join('test', 'integration')}`)
        ) {
          files.push(full);
        }
      }
    };
    walk(serverDir);

    const problems: string[] = [];
    for (const file of files) {
      const raw = readFileSync(file, 'utf8');
      // ⚠️ 只审计**真正的 SQL 片段**，不能扫全文。
      //
      // 原因（实测踩到）：本仓 SQL 别名惯例是**小写单字母**（`v` / `l` / `a` / `c` …），
      // 而 TypeScript 回调参数也大量用小写单字母。扫全文时
      // `dto.targets.map((t) => t.weight)` 会被误判成"表别名 t 的 weight 列"
      // （更巧的是同一文件里确实有 `FROM erp_timesheet t`，于是 t 被登记成别名）。
      // 曾用"列名黑名单"挡这类误报，但黑名单天生不全 —— `weight` 就漏了。
      //
      // 正确做法是**限定作用域**：只在反引号模板中、且内容含 SQL 关键字的片段里找引用。
      // 这样 TS 代码天然被排除，无需维护黑名单。
      const sqlRegions = extractSqlTemplateRegions(raw);
      for (const region of sqlRegions) {
        // ① 别名 → 表
        const aliasToTable = new Map<string, string>();
        for (const match of region.matchAll(
          /(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\s+(?:AS\s+)?([a-z][a-z0-9_]*)\b/gi
        )) {
          const [, table, alias] = match;
          if (byTable.has(table)) aliasToTable.set(alias.toLowerCase(), table);
        }
        if (aliasToTable.size === 0) continue;

        // ② 别名.列
        for (const match of region.matchAll(
          /\b([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]{3,})\b/g
        )) {
          const alias = match[1].toLowerCase();
          const column = match[2];
          const table = aliasToTable.get(alias);
          if (!table) continue;
          if (!byTable.get(table)!.has(column)) {
            problems.push(
              `${file.replace(REPO_ROOT, '')}: ${alias}.${column} 指向表 ${table}，但该表没有列 ${column}`
            );
          }
        }
      }
    }

    // 一次报出全部问题：这类漏列往往是成批出现
    expect([...new Set(problems)]).toEqual([]);
  });

  it('行为验证：按纳税主体过滤的余额查询在真实结构上可用且隔离正确', async () => {
    // 两个纳税主体（taxpayer_type / default_output_rate / default_input_rate 均 NOT NULL，须显式给值）
    await db.exec(`
      INSERT INTO md_tax_entity
        (id, code, name, taxpayer_type, default_output_rate, default_input_rate, is_default, status)
      VALUES
        ('aaaaaaaa-0000-4000-8000-000000000001', '[API_TEST]E1', '[API_TEST]主体一', 'general', 6, 6, 0, 'active'),
        ('aaaaaaaa-0000-4000-8000-000000000002', '[API_TEST]E2', '[API_TEST]主体二', 'general', 6, 6, 0, 'active')
      ON CONFLICT (code) DO NOTHING;
    `);
    expect(await tableExists(db, 'fin_voucher')).toBe(true);

    // 两个主体各一张凭证，同一期间、同一科目
    await db.exec(`
      INSERT INTO fin_voucher (id, code, voucher_date, period, summary, status, tax_entity_id)
      VALUES
        ('bbbbbbbb-0000-4000-8000-000000000001', '[API_TEST]V1', '2026-10-05', '2026-10', '主体一凭证', 'posted', 'aaaaaaaa-0000-4000-8000-000000000001'),
        ('bbbbbbbb-0000-4000-8000-000000000002', '[API_TEST]V2', '2026-10-06', '2026-10', '主体二凭证', 'posted', 'aaaaaaaa-0000-4000-8000-000000000002')
      ON CONFLICT (code) DO NOTHING;

      INSERT INTO fin_voucher_line (id, voucher_id, summary, account_code, debit, credit)
      VALUES
        ('cccccccc-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', '[API_TEST]L1', '1001', 100, 0),
        ('cccccccc-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002', '[API_TEST]L2', '1001', 700, 0)
      ON CONFLICT (id) DO NOTHING;
    `);

    // 这正是 ledgers.service.ts 用到 tax_entity_id 的查询形态
    const scoped = await queryRows<{ account_code: string; total: string }>(
      db,
      `SELECT l.account_code, coalesce(sum(l.debit), 0) AS total
       FROM fin_voucher_line l
       JOIN fin_voucher v ON v.id = l.voucher_id
       WHERE v.status <> 'voided'
         AND v.period = '2026-10'
         AND v.tax_entity_id = 'aaaaaaaa-0000-4000-8000-000000000001'::uuid
       GROUP BY l.account_code`
    );
    expect(scoped).toHaveLength(1);
    expect(Number(scoped[0].total)).toBe(100);

    // 另一个主体
    const other = await queryRows<{ total: string }>(
      db,
      `SELECT coalesce(sum(l.debit), 0) AS total
       FROM fin_voucher_line l
       JOIN fin_voucher v ON v.id = l.voucher_id
       WHERE v.status <> 'voided' AND v.period = '2026-10'
         AND v.tax_entity_id = 'aaaaaaaa-0000-4000-8000-000000000002'::uuid`
    );
    expect(Number(other[0].total)).toBe(700);

    // 无主体过滤时两者合计（确认过滤确实在起作用，而不是恰好都返回 100）
    const all = await queryRows<{ total: string }>(
      db,
      `SELECT coalesce(sum(l.debit), 0) AS total
       FROM fin_voucher_line l
       JOIN fin_voucher v ON v.id = l.voucher_id
       WHERE v.status <> 'voided' AND v.period = '2026-10'`
    );
    expect(Number(all[0].total)).toBe(800);
  });

  it('未归属凭证出现在自检视图中（不能悄悄消失）', async () => {
    await db.exec(`
      INSERT INTO fin_voucher (id, code, voucher_date, period, summary, status, tax_entity_id)
      VALUES ('bbbbbbbb-0000-4000-8000-000000000003', '[API_TEST]V3',
              '2026-10-07', '2026-10', '未归属凭证', 'posted', NULL)
      ON CONFLICT (code) DO NOTHING;
      INSERT INTO fin_voucher_line (id, voucher_id, summary, account_code, debit, credit)
      VALUES ('cccccccc-0000-4000-8000-000000000003',
              'bbbbbbbb-0000-4000-8000-000000000003', '[API_TEST]L3', '1001', 55, 0)
      ON CONFLICT (id) DO NOTHING;
    `);
    const rows = await queryRows<{ period: string; voucher_count: number }>(
      db,
      `SELECT period, voucher_count FROM v_fin_voucher_unassigned_entity
       WHERE period = '2026-10'`
    );
    expect(rows).toHaveLength(1);
    // 未归属凭证必须能被发现，否则"报表少了一块"没人知道
    expect(Number(rows[0].voucher_count)).toBe(1);
  });
});
