/**
 * U-04 并发压测脚手架（干跑 / 实打可选）
 *
 * 用途：对高风险写接口施加 N 路并发，观察幂等与行锁表现。
 * 目标接口（需自行填 ID / 路径参数）：
 *   1. 工资条审批  POST /api/hr/payrolls/:id/actions   body: { action: "approve" }
 *   2. 成本红冲    POST /api/costs/:id/red-flush
 *   3. 回款核销    POST /api/finance/ar-writeoffs       body: { arId, receiptId, amount }
 *
 * 环境变量：
 *   BASE_URL   默认 http://127.0.0.1:3000
 *   TOKEN      Bearer JWT；未设置则只打印计划并跳过实打（dry-run）
 *   CONCURRENCY 默认 10
 *   TARGET     payroll | redflush | receipt-match | all（默认 all）
 *   PAYROLL_ID / COST_ID / AR_ID / RECEIPT_ID / MATCH_AMOUNT  实打时必填对应项
 *
 * 示例：
 *   node scripts/stress-concurrency.mjs
 *   TOKEN=xxx CONCURRENCY=20 TARGET=redflush COST_ID=... node scripts/stress-concurrency.mjs
 */

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(
  /\/$/,
  ''
);
const TOKEN = process.env.TOKEN || '';
const CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.CONCURRENCY || '10', 10) || 10
);
const TARGET = (process.env.TARGET || 'all').toLowerCase();

/** @typedef {{ name: string; method: string; path: string; body?: object }} StressCase */

/** @returns {StressCase[]} */
function buildCases() {
  /** @type {StressCase[]} */
  const cases = [];
  if (TARGET === 'all' || TARGET === 'payroll') {
    const id = process.env.PAYROLL_ID || '<PAYROLL_ID>';
    cases.push({
      name: 'payroll-approve',
      method: 'POST',
      path: `/api/hr/payrolls/${id}/actions`,
      body: { action: 'approve' },
    });
  }
  if (TARGET === 'all' || TARGET === 'redflush') {
    const id = process.env.COST_ID || '<COST_ID>';
    cases.push({
      name: 'cost-redflush',
      method: 'POST',
      path: `/api/costs/${id}/red-flush`,
    });
  }
  if (TARGET === 'all' || TARGET === 'receipt-match') {
    cases.push({
      name: 'receipt-match',
      method: 'POST',
      path: '/api/finance/ar-writeoffs',
      body: {
        arId: process.env.AR_ID || '<AR_ID>',
        receiptId: process.env.RECEIPT_ID || '<RECEIPT_ID>',
        amount: Number(process.env.MATCH_AMOUNT || '1'),
      },
    });
  }
  return cases;
}

/**
 * @param {StressCase} c
 * @returns {Promise<{ status: number; ok: boolean; text: string }>}
 */
async function hit(c) {
  const resp = await fetch(`${BASE_URL}${c.path}`, {
    method: c.method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: c.body ? JSON.stringify(c.body) : undefined,
  });
  const text = await resp.text();
  return { status: resp.status, ok: resp.ok, text: text.slice(0, 200) };
}

async function runCase(c) {
  console.log(`\n=== ${c.name} × ${CONCURRENCY} @ ${BASE_URL}${c.path} ===`);
  if (!TOKEN) {
    console.log('未设置 TOKEN，跳过实打（dry-run）。请导出 TOKEN 后再跑。');
    console.log('示例 body:', c.body ? JSON.stringify(c.body) : '(empty)');
    return;
  }
  if (c.path.includes('<') || JSON.stringify(c.body || {}).includes('<')) {
    console.log('路径/参数仍含占位符，跳过实打。请设置对应环境变量。');
    return;
  }
  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => hit(c))
  );
  const elapsed = Date.now() - started;
  const byStatus = new Map();
  for (const r of results) {
    byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1);
  }
  console.log(`耗时 ${elapsed}ms；状态分布:`, Object.fromEntries(byStatus));
  const sample = results.find((r) => !r.ok) || results[0];
  if (sample) {
    console.log(`样例响应 [${sample.status}]:`, sample.text);
  }
}

const cases = buildCases();
console.log(
  `U-04 stress-concurrency | BASE_URL=${BASE_URL} CONCURRENCY=${CONCURRENCY} TARGET=${TARGET} TOKEN=${TOKEN ? 'set' : 'missing'}`
);
for (const c of cases) {
  await runCase(c);
}
console.log('\n完成。关注：重复审批/红冲应返回业务错误而非双记账；核销超额应被行锁挡住。');
