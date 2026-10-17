/**
 * 定点复验：费用申请的**预算闸门**在抽出 `./budget-check` 后行为一致。
 *
 * ## 验什么
 *
 * 纯函数那 16 条断言验的是"给定入参 → 给定结果"；真实链路还多三件事：
 *   ① 预算行的**维度匹配**真的作用在 SQL 出来的数据上（`budgetMatchesDoc`）；
 *   ② 申请侧的 `pending | approved` **都**计入在途——所以连续提两笔、每笔都在额度内，
 *      第二笔应因"第一笔在途"被拒；
 *   ③ 无预算维度**不拦**（不能因为没编预算就一律拒绝）。
 *
 * 全程用 `[API_TEST]` 前缀的临时部门/预算/申请，结束按精确主键清理。
 *
 * 用法：npx tsx scripts/verify-budget-gate.mjs
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const API = process.env.WT_API ?? 'http://127.0.0.1:3000';
const TAG = '[API_TEST]';

function envOf(key) {
  const line = readFileSync('.env', 'utf8').split(/\r?\n/u).find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : undefined;
}

const results = [];
const rec = (n, pass, d) => {
  results.push({ n, pass, d });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
};

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: envOf('BOOTSTRAP_ADMIN_USERNAME'),
      password: envOf('BOOTSTRAP_ADMIN_PASSWORD'),
    }),
  });
  if (login.status !== 201) throw new Error(`登录失败 ${login.status}`);
  const jar = login.headers.getSetCookie?.() ?? [];
  const session = jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session=')).slice(12);
  const call = async (method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: `erp_session=${session}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, json, text };
  };

  const sql = postgres({
    host: '127.0.0.1', port: 5433, user: 'erp', password: process.env.DB_PASSWORD ?? '',
    database: 'shengseerp', connect_timeout: 5,
  });
  const made = { budgetIds: [], applyIds: [], deptId: null };
  const PERIOD = '2026-10';
  const CATEGORY = 'travel';

  try {
    /*
     * 准备部门。
     *
     * ⚠️ 2026-10-17：本脚本必须**自给自足**，不能依赖"库里恰好有一个部门"。
     * 清理测试夹具把部门清空后，这个脚本报「库里没有部门」整体失败 ——
     * 暴露了它此前的通过**依赖了环境中的残留数据**（不可复现）。
     * 现在：有部门就用第一个；没有就自建一个 `[API_TEST]` 临时部门，结束时清掉。
     */
    let dept = (await sql`SELECT id, name FROM hr_department ORDER BY name LIMIT 1`)[0];
    let createdDept = false;
    if (!dept) {
      const created = await sql`
        INSERT INTO hr_department (name, code)
        VALUES (${`${TAG} 闸门复验部门`}, 'API-TEST-DEPT')
        RETURNING id, name`;
      dept = created[0];
      createdDept = true;
      console.log('  库里无部门 → 已自建临时部门');
    }
    made.deptId = dept.id;
    made.createdDept = createdDept;
    console.log(`  使用部门: ${dept.name}（${String(dept.id).slice(0, 8)}）`);

    /* 先清掉本次可能残留的旧数据（同维度、同 remark 前缀） */
    await sql`DELETE FROM fin_expense_apply WHERE remark LIKE ${`%${TAG}%`}`.catch(() => {});
    await sql`DELETE FROM fin_budget WHERE remark LIKE ${`%${TAG}%`}`.catch(() => {});

    /*
     * ① 建一条本期间、本部门、本类别的预算 1000。
     * ⚠️ 走**接口**而不是裸 INSERT：`fin_budget.code` 是 NOT NULL 且由
     * `generateBizCode` 生成（我第一版裸插直接撞 not-null）。
     */
    const budgetRes = await call('POST', '/api/fin-budget/budgets', {
      departmentId: String(dept.id),
      expenseCategory: CATEGORY,
      period: PERIOD,
      budgetAmount: 1000,
      remark: `${TAG} 闸门复验预算`,
    });
    if (budgetRes.json?.id) made.budgetIds.push(budgetRes.json.id);
    rec(
      '建预算（1000，本部门+本类别+2026-10）',
      budgetRes.status < 300 && !!budgetRes.json?.id,
      `HTTP ${budgetRes.status} ${budgetRes.text.slice(0, 70)}`,
    );
    if (!budgetRes.json?.id) return;

    const mkApply = (amount, suffix) =>
      call('POST', '/api/fin-expense/applies', {
        applyType: 'travel',
        title: `${TAG} 申请-${suffix}`,
        departmentId: String(dept.id),
        expenseCategory: CATEGORY,
        amount,
        expectDate: `${PERIOD}-15`,
        reason: TAG,
        remark: `${TAG} 闸门复验`,
      });

    /* ② 700 ≤ 1000 → 通过；且该申请进入"在途占用" */
    const a1 = await mkApply(700, 'A');
    if (a1.json?.id) made.applyIds.push(a1.json.id);
    rec('申请 700（额度内）→ 通过', a1.status < 300 && !!a1.json?.id, `HTTP ${a1.status} ${a1.text.slice(0, 70)}`);

    /* ③ 再申请 400：700(在途) + 400 = 1100 > 1000 → **必须被拒**
     *    这一条正是"申请侧 pending|approved 都计入在途"的端到端证据。 */
    const a2 = await mkApply(400, 'B');
    const msg2 = a2.json?.error?.message ?? '';
    rec(
      '⚠️ 再申请 400 被拒（在途 700 + 本次 400 > 1000）',
      a2.status === 400 && /预算不足/.test(msg2),
      `HTTP ${a2.status} ${msg2.slice(0, 78)}`,
    );
    rec(
      '拦截提示含 4 个数（总额/已执行/在途/本次）与超出额',
      /预算总额 1000 元/.test(msg2) && /在途占用 700 元/.test(msg2) && /本次申请 400 元/.test(msg2) && /超出 100 元/.test(msg2),
      msg2.slice(0, 100),
    );

    /* ④ 边界：再申请恰好 300（700+300=1000，等于额度）→ 应通过（判据是严格大于） */
    const a3 = await mkApply(300, 'C');
    if (a3.json?.id) made.applyIds.push(a3.json.id);
    rec('申请 300（700+300 恰好=1000）→ 通过（判据严格大于）', a3.status < 300, `HTTP ${a3.status} ${a3.text.slice(0, 60)}`);

    /* ⑤ 无预算维度（换一个不存在的类别）→ 不拦 */
    const a4 = await call('POST', '/api/fin-expense/applies', {
      applyType: 'travel',
      title: `${TAG} 申请-无预算类别`,
      departmentId: String(dept.id),
      expenseCategory: 'office',
      amount: 999999,
      expectDate: `${PERIOD}-20`,
      reason: TAG,
      remark: `${TAG} 闸门复验`,
    });
    if (a4.json?.id) made.applyIds.push(a4.json.id);
    rec(
      '⚠️ 无匹配预算的类别（office）不拦 —— "没编预算就不管"口径',
      a4.status < 300,
      `HTTP ${a4.status} ${a4.text.slice(0, 60)}`,
    );
  } finally {
    try {
      const applies = await sql`SELECT id FROM fin_expense_apply WHERE remark LIKE ${`%${TAG}%`}`;
      const budgets = await sql`SELECT id FROM fin_budget WHERE remark LIKE ${`%${TAG}%`}`;
      console.log(`  待删: 申请 ${applies.length} 条 / 预算 ${budgets.length} 条`);
      for (const a of applies) {
        await sql`DELETE FROM fin_expense_apply WHERE id = ${a.id}`;
      }
      for (const b of budgets) {
        await sql`DELETE FROM fin_budget WHERE id = ${b.id}`;
      }
      /*
       * 自建的临时部门：**只在没有其它引用时**删（有引用就留着，不为了清干净去删真实数据）。
       * 顺序必须在预算/申请删完之后 —— 否则它仍被刚删的那些行引用着。
       */
      if (made.deptId && made.createdDept) {
        const refE = await sql`SELECT count(*)::int AS n FROM md_employee WHERE department_id = ${made.deptId}`;
        const refB = await sql`SELECT count(*)::int AS n FROM fin_budget WHERE department_id = ${made.deptId}`;
        const refA = await sql`SELECT count(*)::int AS n FROM fin_expense_apply WHERE department_id = ${made.deptId}`;
        if (refE[0].n + refB[0].n + refA[0].n === 0) {
          await sql`DELETE FROM hr_department WHERE id = ${made.deptId}`;
          console.log('  已清理自建的临时部门');
        } else {
          console.log(`  ⚠️ 临时部门仍被引用（员工${refE[0].n}/预算${refB[0].n}/申请${refA[0].n}），保留`);
        }
      }
    } catch (e) { console.log('  清理出错:', e.message); }
    const left = await sql`SELECT
      (SELECT count(*)::int FROM fin_expense_apply WHERE remark LIKE ${`%${TAG}%`}) AS applies,
      (SELECT count(*)::int FROM fin_budget WHERE remark LIKE ${`%${TAG}%`}) AS budgets`;
    console.log(`  残留: 申请=${left[0].applies} 预算=${left[0].budgets}`);
    await sql.end({ timeout: 2 }).catch(() => {});
  }

  const bad = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) { for (const b of bad) console.log(`  - ${b.n}  ${b.d ?? ''}`); process.exitCode = 1; }
}
void main().catch((e) => { console.error('复核失败:', e.message); process.exitCode = 1; });
