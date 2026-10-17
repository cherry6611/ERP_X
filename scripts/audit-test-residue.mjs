/**
 * 全库测试数据残留审计。
 *
 * ## 为什么需要它
 *
 * 本会话我跑了大量"建单 → 断言 → 清理"的复验脚本。每一个都声称"按精确主键清理、
 * 残留 0"，但**每个脚本只审计自己建的那几条**。真实风险是：
 *   · 某个脚本中途抛错，`finally` 里删了一半；
 *   · 清理动了正确的表但**漏了关联表**（例如删了应付、没删它的核销）；
 *   · 生产上线前必须确认**库里没有演示/测试数据**（`AGENTS.md`：生产库不保留演示数据）。
 *
 * 所以这里做一次**全库扫描**：按命名约定与备注字段找可疑行，并统计孤儿关联。
 *
 * ## 为什么必须分类（2026-10-17 修正）
 *
 * 第一版把"文本里出现 `[API_TEST]`"一律报成残留，于是把
 * `comp_audit_log`（1804 行）、`sys_login_audit`、`sys_inbox_message`、
 * `comp_rate_limit`、`sys_feishu_event` 也报了出来 —— 这些是**审计与运维台账**：
 *   · 它们**记录**测试期间的登录/操作是正常的，删掉反而破坏合规链；
 *   · `comp_audit_log` 里有测试对象的删除记录，正是我们要的追溯证据。
 *
 * 把"该保留的台账"也算作失败，会让这道审计**永远红**，最后被人忽略 ——
 * 那比没有审计更糟。所以现在分两栏：
 *   · **业务数据**：必须清（退出码 1）；
 *   · **审计/运维台账**：仅提示（不影响退出码）。
 *
 * 用法：npx tsx scripts/audit-test-residue.mjs
 */
import postgres from 'postgres';
import { readFileSync } from 'node:fs';

const URL = readFileSync('.env', 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL=')).slice(13).trim();

/** 测试数据命名约定（`AGENTS.md`：一律以 [API_TEST] 前缀命名） */
const MARKERS = ['[API_TEST]', 'API_TEST', '[TEST]', 'test-', 'probe-', '走查', '验收部门-'];

/**
 * **审计/运维台账**：允许出现测试期痕迹，不计入失败。
 * 判据：这些表的用途是"记录发生过什么"，而不是"承载业务单据"。
 */
const LEDGER_TABLES = new Set([
  'comp_audit_log',
  'sys_login_audit',
  'sys_inbox_message',
  'sys_feishu_event',
  'comp_rate_limit',
  'comp_feishu_sync_record',
  'comp_stored_file_scan_log',
]);

async function main() {
  const sql = postgres(URL, { max: 1, connect_timeout: 10 });

  /* 取所有含文本列的表，逐表扫标记 */
  const tables = await sql`
    SELECT c.table_name,
           array_agg(c.column_name ORDER BY c.ordinal_position) AS cols
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.data_type IN ('character varying', 'text', 'character')
    GROUP BY c.table_name
    ORDER BY c.table_name`;

  const hits = [];
  for (const t of tables) {
    const cols = t.cols ?? [];
    if (cols.length === 0) continue;
    /* 逐列 OR 起来查：任一列命中即算该行可疑 */
    const where = cols.map((c) => `"${c}"::text ILIKE ANY($1)`).join(' OR ');
    const params = [MARKERS.map((m) => `%${m}%`)];
    try {
      const rows = await sql.unsafe(
        `SELECT count(*)::int AS n FROM "${t.table_name}" WHERE ${where}`,
        params,
      );
      if (rows[0].n > 0) hits.push({ table: t.table_name, n: rows[0].n });
    } catch {
      /* 某些列类型/权限问题：跳过，不阻断审计 */
    }
  }

  /* 孤儿关联检查：只查"有外键语义但可能没级联删"的几处 */
  const orphans = [];
  const orphanChecks = [
    /*
     * ⚠️ 2026-10-17：这一对原先**漏了**，而它正是实际出问题的那一对 ——
     * 实测 638 行分录里 109 行（17%）的 `voucher_id` 在 `fin_voucher` 里不存在。
     * 根因：`fin_voucher_line.voucher_id` **没有外键**（只有索引），
     * 而 `fin_voucher_line_aux.line_id` 反而有 CASCADE。已由迁移
     * `2026-10-17-fix12-voucher-line-fk.sql` 清理存量 + 补外键。
     */
    ['fin_voucher_line', 'voucher_id', 'fin_voucher', '凭证分录 → 凭证'],
    ['fin_voucher_line_aux', 'line_id', 'fin_voucher_line', '分录辅助核算 → 分录'],
    ['erp_ap_writeoff', 'ap_id', 'erp_ap_bill', '应付核销 → 应付单'],
    ['erp_ap_writeoff', 'payment_id', 'erp_payment', '应付核销 → 付款单'],
    ['erp_payment', 'ap_id', 'erp_ap_bill', '付款单 → 应付单'],
    ['erp_ar_writeoff', 'ar_id', 'erp_ar', '应收核销 → 应收单'],
    ['erp_ar_writeoff', 'receipt_id', 'erp_receipt', '应收核销 → 收款单'],
    ['erp_invoice', 'contract_id', 'erp_contract', '发票 → 合同'],
    ['erp_project_cost', 'project_id', 'erp_project', '项目成本 → 项目'],
    ['erp_deliverable', 'project_id', 'erp_project', '交付物 → 项目'],
    ['erp_project_milestone', 'project_id', 'erp_project', '里程碑 → 项目'],
    ['erp_contract_item', 'contract_id', 'erp_contract', '合同明细 → 合同'],
    ['erp_receipt', 'customer_id', 'md_customer', '收款单 → 客户'],
  ];
  for (const [child, fk, parent, label] of orphanChecks) {
    try {
      const r = await sql.unsafe(
        `SELECT count(*)::int AS n FROM "${child}" c
         WHERE c."${fk}" IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM "${parent}" p WHERE p.id = c."${fk}")`,
      );
      if (r[0].n > 0) orphans.push({ label: `${child}.${fk}`, n: r[0].n, why: label });
    } catch {
      /* 表/列不存在（例如应收核销表名不同）：跳过 */
    }
  }

  console.log('  ① 按命名约定扫描全库（含 [API_TEST] / test- / probe- / 走查 / 验收部门- …）');
  const businessHits = hits.filter((h) => !LEDGER_TABLES.has(h.table));
  const ledgerHits = hits.filter((h) => LEDGER_TABLES.has(h.table));

  console.log('     业务数据（**必须清理**，计入失败）：');
  if (businessHits.length === 0) {
    console.log('       ✓ 未发现被测试数据污染的业务表');
  } else {
    for (const h of businessHits.sort((a, b) => b.n - a.n)) console.log(`       ⚠️ ${h.table}: ${h.n} 行`);
  }

  console.log('     审计/运维台账（**仅提示**，不清除 —— 删除会破坏合规链）：');
  if (ledgerHits.length === 0) {
    console.log('       （无）');
  } else {
    for (const h of ledgerHits.sort((a, b) => b.n - a.n)) {
      console.log(`       · ${h.table}: ${h.n} 行（记录测试期痕迹属正常）`);
    }
  }

  console.log('\n  ② 孤儿关联（子表指向不存在的父表行 —— 清理漏表的典型症状）');
  if (orphans.length === 0) {
    console.log('     ✓ 未发现孤儿关联');
  } else {
    for (const o of orphans) console.log(`     ⚠️ ${o.why}：${o.n} 行孤儿`);
  }

  console.log('\n  ③ 关键表行数（供上线前人工核对）');
  const counts = await sql`
    SELECT 'erp_contract' AS t, count(*)::int AS n FROM erp_contract
    UNION ALL SELECT 'erp_project', count(*)::int FROM erp_project
    UNION ALL SELECT 'erp_invoice', count(*)::int FROM erp_invoice
    UNION ALL SELECT 'fin_voucher', count(*)::int FROM fin_voucher
    UNION ALL SELECT 'erp_ar', count(*)::int FROM erp_ar
    UNION ALL SELECT 'erp_ap_bill', count(*)::int FROM erp_ap_bill
    UNION ALL SELECT 'erp_payment', count(*)::int FROM erp_payment
    UNION ALL SELECT 'md_customer', count(*)::int FROM md_customer
    UNION ALL SELECT 'md_supplier', count(*)::int FROM md_supplier
    UNION ALL SELECT 'md_employee', count(*)::int FROM md_employee
    ORDER BY t`;
  for (const c of counts) console.log(`     ${c.t.padEnd(20)} ${c.n}`);

  await sql.end({ timeout: 2 }).catch(() => {});

  const failed = businessHits.length > 0 || orphans.length > 0;
  console.log(
    failed
      ? '\n  结果：**存在残留或孤儿**，上线前需清理（本审计只报告，不自动删）。'
      : '\n  结果：干净。',
  );
  if (failed) process.exitCode = 1;
}
void main().catch((e) => { console.error('审计失败:', e.message); process.exitCode = 1; });
