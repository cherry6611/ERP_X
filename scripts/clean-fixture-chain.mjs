/**
 * 清理**走查测试夹具链**：`验收部门-*` ← `验收员工-*` ← `验收预算`。
 *
 * ## 为什么必须按链清、且顺序不能反
 *
 * 部门被员工与预算引用，直接删部门会**制造新孤儿**（正是本会话刚修完的两处缺陷的成因）。
 * 所以顺序是：**先删最下游的被引用方，再删上游**。
 *
 * ## 为什么判定它们是测试数据（不是"看到中文就删"）
 *
 * | 表 | 行 | 判定依据 |
 * |---|---|---|
 * | `md_employee` | `验收员工-2026-10-13212552/707/818` | 姓名形如 `验收员工-<时间戳>`，且部门指向 `验收部门-<同时间戳>` |
 * | `hr_department` | `验收部门-2026-10-13212552/707/818` | 同上 |
 * | `fin_budget` | `验收预算` ×4 | 备注一律「验收预算」、金额一律 200000、期间一律 2026-10 |
 *
 * 保留：`EMP2026100001 成天权`（管理员本人员工档案，真实数据）。
 *
 * ⚠️ 这是**开发库**的演示数据清理。生产库按上线文档用迁移**全新构建**，
 * 不继承本库任何数据；此处清理的目的是让"上线前库内无演示数据"这条可核验。
 *
 * 用法：npx tsx scripts/clean-fixture-chain.mjs
 */
import postgres from 'postgres';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const URL = readFileSync('.env', 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL=')).slice(13).trim();

/** 夹具特征：名称带「验收」+ 时间戳后缀 */
const FIXTURE_RE = /^(验收部门|验收员工)-[\d-]{10,}$/u;
const BUDGET_REMARK = '验收预算';

async function main() {
  const sql = postgres(URL, { max: 1, connect_timeout: 10 });
  const backup = {};

  /* ① 夹具员工 */
  const emps = await sql`
    SELECT e.id, e.code, e.name, e.department_id
    FROM md_employee e
    WHERE e.name ~ ${'^(验收员工)-[0-9-]{10,}$'} OR e.name ~ ${'^(验收部门)-[0-9-]{10,}$'}`;
  /* ② 夹具部门 */
  const depts = await sql`
    SELECT id, name FROM hr_department WHERE name ~ ${'^(验收部门)-[0-9-]{10,}$'}`;
  /* ③ 夹具预算（备注「验收预算」） */
  const budgets = await sql`
    SELECT id, code, period, remark FROM fin_budget WHERE remark = ${BUDGET_REMARK}`;

  backup.md_employee = emps;
  backup.hr_department = depts;
  backup.fin_budget = budgets;

  console.log(`  待清理夹具：员工 ${emps.length} / 部门 ${depts.length} / 预算 ${budgets.length}`);
  for (const e of emps) console.log(`    员工 ${e.code} ${e.name}`);
  for (const d of depts) console.log(`    部门 ${d.name}`);
  for (const b of budgets) console.log(`    预算 ${b.code} ${b.remark}`);

  /* 双保险：部门必须命中正则 */
  const badDept = depts.filter((d) => !FIXTURE_RE.test(d.name));
  if (badDept.length) {
    console.log('  ✗ 有部门名不匹配夹具正则，中止：', badDept.map((d) => d.name));
    await sql.end({ timeout: 2 }).catch(() => {});
    process.exitCode = 1;
    return;
  }

  mkdirSync('../docs/api-test-data-archive', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(
    `../docs/api-test-data-archive/fixture-chain-${stamp}.json`,
    JSON.stringify(backup, null, 2),
    'utf8',
  );
  console.log(`\n  已备份 → docs/api-test-data-archive/fixture-chain-${stamp}.json`);

  /* ④ 按链的顺序删：预算 → 员工 → 部门 */
  let nBudget = 0;
  for (const b of budgets) {
    const d = await sql`DELETE FROM fin_budget WHERE id = ${b.id} RETURNING id`;
    nBudget += d.length;
  }
  let nEmp = 0;
  for (const e of emps) {
    /* 员工若被其它业务单据引用（工时/工资单等），跳过并报告 */
    const refs = [];
    for (const [t, c, label] of [
      ['hr_timesheet', 'employee_id', '工时'],
      ['hr_payroll', 'employee_id', '工资单'],
      ['hr_attendance', 'employee_id', '考勤'],
      ['hr_leave_request', 'employee_id', '请假'],
    ]) {
      try {
        const r = await sql.unsafe(`SELECT count(*)::int AS n FROM "${t}" WHERE "${c}" = $1`, [e.id]);
        if (r[0].n > 0) refs.push(`${label}×${r[0].n}`);
      } catch { /* 表不存在 */ }
    }
    if (refs.length) {
      console.log(`    ⏭  员工 ${e.name} 被引用（${refs.join('、')}），跳过`);
      continue;
    }
    const d = await sql`DELETE FROM md_employee WHERE id = ${e.id} RETURNING id`;
    nEmp += d.length;
  }
  let nDept = 0;
  for (const d0 of depts) {
    /* 删前再查一次是否还有引用（前面跳过的员工可能仍指向它） */
    let stillRef = 0;
    for (const [t, c] of [
      ['md_employee', 'department_id'],
      ['erp_project', 'department_id'],
      ['fin_budget', 'department_id'],
      ['fin_expense_apply', 'department_id'],
    ]) {
      try {
        const r = await sql.unsafe(`SELECT count(*)::int AS n FROM "${t}" WHERE "${c}" = $1`, [d0.id]);
        stillRef += r[0].n;
      } catch { /* 表不存在 */ }
    }
    if (stillRef > 0) {
      console.log(`    ⏭  部门 ${d0.name} 仍被引用 ${stillRef} 处，跳过`);
      continue;
    }
    const d = await sql`DELETE FROM hr_department WHERE id = ${d0.id} RETURNING id`;
    nDept += d.length;
  }
  console.log(`\n  已删：预算 ${nBudget} / 员工 ${nEmp} / 部门 ${nDept}`);

  /* ⑤ 复查 */
  const left = await sql`
    SELECT (SELECT count(*)::int FROM hr_department WHERE name ~ ${'^(验收部门)-[0-9-]{10,}$'}) AS dept,
           (SELECT count(*)::int FROM md_employee WHERE name ~ ${'^(验收员工)-[0-9-]{10,}$'}) AS emp,
           (SELECT count(*)::int FROM fin_budget WHERE remark = ${BUDGET_REMARK}) AS bud`;
  console.log(`  复查剩余夹具：部门 ${left[0].dept} / 员工 ${left[0].emp} / 预算 ${left[0].bud}`);
  const real = await sql`SELECT (SELECT count(*)::int FROM md_employee) AS emp, (SELECT count(*)::int FROM hr_department) AS dept, (SELECT count(*)::int FROM fin_budget) AS bud`;
  console.log(`  保留数据：员工 ${real[0].emp} / 部门 ${real[0].dept} / 预算 ${real[0].bud}`);

  await sql.end({ timeout: 2 }).catch(() => {});
}
void main().catch((e) => { console.error('清理失败:', e.message); process.exitCode = 1; });
