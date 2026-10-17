/**
 * 清理**已确认的**测试业务数据（`audit-test-residue.mjs` ① 栏报出的那些）。
 *
 * ## 为什么单独写一个脚本而不是手敲 SQL
 *
 * 因为删除顺序与引用检查必须**逐表确认**，手敲容易漏：
 *   · `md_supplier` 被应付/进项发票引用时**不能删**（会产生新孤儿）；
 *   · `hr_department` 被人事档案引用时不能删；
 *   · `fin_voucher` 现在是 `ON DELETE CASCADE` 到分录的（fix12），删凭证会连带删分录 —— 这是期望行为。
 *
 * 所以每一步都先查引用，被引用就**跳过并报告**，绝不"为了清干净而连带删真实数据"。
 *
 * ## 安全纪律
 *
 * 1. 先 SELECT 打印待删清单；
 * 2. 只删带测试标记的行（`item_name`/`name`/`title`/`summary` 必须命中标记）；
 * 3. 每步检查引用，被引用则跳过；
 * 4. 先备份到 `docs/api-test-data-archive/`；
 * 5. 删完复查（孤儿数不变、真实数据仍在）。
 *
 * 用法：npx tsx scripts/clean-business-residue.mjs
 */
import postgres from 'postgres';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const URL = readFileSync('.env', 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL=')).slice(13).trim();

const MARKERS = ['[API_TEST]', 'API_TEST', '[TEST]', 'test-', 'probe-', '走查', '验收部门-'];
const hasMarker = (v) => typeof v === 'string' && MARKERS.some((m) => v.includes(m));

const backup = {};
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

/** 检查某行是否被其它表引用；返回被引用的说明（空串=未被引用） */
async function referencesOf(sql, table, id) {
  const checks = {
    erp_cost_allocation: [['erp_project_cost', 'cost_allocation_id', '项目成本']],
    hr_department: [
      ['md_employee', 'department_id', '员工档案'],
      ['erp_project', 'department_id', '项目'],
      ['fin_budget', 'department_id', '预算'],
      ['fin_expense_apply', 'department_id', '费用申请'],
    ],
    crm_opportunity: [
      ['erp_contract', 'opportunity_id', '合同'],
      ['crm_quotation', 'opportunity_id', '报价单'],
    ],
    md_supplier: [
      ['erp_ap_bill', 'supplier_id', '应付单'],
      ['erp_payment', 'supplier_id', '付款单'],
      ['erp_invoice', 'supplier_id', '进项发票'],
      ['md_employee', 'supplier_id', '外协员工'],
      ['erp_project_cost', 'supplier_id', '项目成本'],
    ],
    fin_voucher: [
      ['erp_cost_allocation', 'voucher_id', '成本分摊'],
      ['erp_project_cost', 'voucher_id', '项目成本'],
      ['erp_invoice', 'voucher_id', '发票'],
    ],
  };
  const list = checks[table] ?? [];
  const found = [];
  for (const [child, col, label] of list) {
    try {
      const r = await sql.unsafe(`SELECT count(*)::int AS n FROM "${child}" WHERE "${col}" = $1`, [id]);
      if (r[0].n > 0) found.push(`${label}×${r[0].n}`);
    } catch { /* 表/列不存在 */ }
  }
  return found.join('、');
}

async function main() {
  const sql = postgres(URL, { max: 1, connect_timeout: 10 });

  /* ① 取待删清单 */
  const plan = [
    {
      table: 'fin_voucher',
      label: '凭证',
      select: sql.unsafe(
        `SELECT id, code, status, summary FROM fin_voucher
         WHERE summary ILIKE ANY($1)
            OR EXISTS (SELECT 1 FROM fin_voucher_line l WHERE l.voucher_id = fin_voucher.id AND l.summary ILIKE ANY($1))`,
        [MARKERS.map((m) => `%${m}%`)],
      ),
      describe: (r) => `${r.code} ${r.status} ${JSON.stringify(r.summary).slice(0, 40)}`,
    },
    {
      table: 'erp_cost_allocation',
      label: '成本分摊',
      select: sql.unsafe(
        `SELECT id, source_desc, remark FROM erp_cost_allocation
         WHERE source_desc ILIKE ANY($1) OR remark ILIKE ANY($1)`,
        [MARKERS.map((m) => `%${m}%`)],
      ),
      describe: (r) => `${JSON.stringify(r.source_desc).slice(0, 40)}`,
    },
    {
      table: 'crm_opportunity',
      label: '商机',
      select: sql.unsafe(
        `SELECT id, title FROM crm_opportunity WHERE title ILIKE ANY($1)`,
        [MARKERS.map((m) => `%${m}%`)],
      ),
      describe: (r) => `${JSON.stringify(r.title).slice(0, 44)}`,
    },
    {
      table: 'md_supplier',
      label: '供应商',
      select: sql.unsafe(
        `SELECT id, name, remark FROM md_supplier WHERE name ILIKE ANY($1) OR remark ILIKE ANY($1)`,
        [MARKERS.map((m) => `%${m}%`)],
      ),
      describe: (r) => `${JSON.stringify(r.name).slice(0, 44)}`,
    },
    {
      table: 'hr_department',
      label: '部门',
      select: sql.unsafe(
        `SELECT id, name FROM hr_department WHERE name ILIKE ANY($1)`,
        [MARKERS.map((m) => `%${m}%`)],
      ),
      describe: (r) => `${JSON.stringify(r.name).slice(0, 44)}`,
    },
  ];

  const collected = [];
  for (const p of plan) {
    let rows = [];
    try {
      rows = await p.select;
    } catch (e) {
      console.log(`  ⚠️ ${p.label}(${p.table}) 查询失败：${String(e.message).split('\n')[0]}`);
      continue;
    }
    /* 双保险：只保留确实带标记的行 */
    const key = p.table === 'hr_department' ? 'name' : p.table === 'crm_opportunity' ? 'title'
      : p.table === 'md_supplier' ? 'name' : p.table === 'fin_voucher' ? 'summary' : 'source_desc';
    const keep = rows.filter((r) => hasMarker(r[key]) || (p.table === 'fin_voucher' && hasMarker(r.summary)));
    backup[p.table] = keep;
    collected.push({ ...p, rows: keep });
    console.log(`  ${p.label}：待删 ${keep.length} 行`);
    for (const r of keep) console.log(`     ${p.describe(r)}`);
  }

  mkdirSync('../docs/api-test-data-archive', { recursive: true });
  writeFileSync(
    `../docs/api-test-data-archive/business-residue-${stamp}.json`,
    JSON.stringify(backup, null, 2),
    'utf8',
  );
  console.log(`\n  已备份 → docs/api-test-data-archive/business-residue-${stamp}.json`);

  /* ② 按顺序删（被引用则跳过） */
  console.log('\n  执行删除：');
  const order = ['fin_voucher', 'erp_cost_allocation', 'crm_opportunity', 'md_supplier', 'hr_department'];
  let deleted = 0;
  for (const table of order) {
    const item = collected.find((c) => c.table === table);
    if (!item || item.rows.length === 0) continue;
    for (const r of item.rows) {
      const ref = await referencesOf(sql, table, r.id);
      if (ref) {
        console.log(`     ⏭  ${item.label} ${item.describe(r)} —— 被引用（${ref}），跳过`);
        continue;
      }
      const d = await sql.unsafe(`DELETE FROM "${table}" WHERE id = $1 RETURNING id`, [r.id]);
      deleted += d.length;
    }
    console.log(`     ✓ ${item.label} 处理完`);
  }
  console.log(`\n  已删 ${deleted} 行`);

  /* ③ 复查 */
  const orphanV = await sql`SELECT count(*)::int AS n FROM fin_voucher_line l WHERE NOT EXISTS (SELECT 1 FROM fin_voucher f WHERE f.id=l.voucher_id)`;
  const orphanC = await sql`SELECT count(*)::int AS n FROM erp_contract_item i WHERE NOT EXISTS (SELECT 1 FROM erp_contract c WHERE c.id=i.contract_id)`;
  console.log(`  复查：凭证分录孤儿 ${orphanV[0].n}；合同明细孤儿 ${orphanC[0].n}`);
  const real = await sql`SELECT (SELECT count(*)::int FROM md_customer) AS cust, (SELECT count(*)::int FROM erp_ar) AS ar, (SELECT count(*)::int FROM erp_contract) AS ctr, (SELECT count(*)::int FROM fin_voucher) AS vc`;
  console.log(`  真实数据仍在：客户 ${real[0].cust} / 应收 ${real[0].ar} / 合同 ${real[0].ctr} / 凭证 ${real[0].vc}`);

  await sql.end({ timeout: 2 }).catch(() => {});
  if (orphanV[0].n > 0 || orphanC[0].n > 0) process.exitCode = 1;
}
void main().catch((e) => { console.error('清理失败:', e.message); process.exitCode = 1; });
