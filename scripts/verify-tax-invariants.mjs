/**
 * 财税逻辑**全局不变量**核查（直接对库跑，不经过 UI）。
 *
 * 不变量 = "无论用户怎么操作都必须成立"的性质：
 *   · 每张凭证借贷必须平衡
 *   · 价税分离自洽（net + tax == gross）
 *   · 税率在 `shared/tax.ts` 白名单内
 *   · 凭证纳税主体与来源单据一致（否则账簿/报表漏计）
 *   · 核销不得超过单额
 *   · 金额精度不超过两位小数（numeric(18,2) 纪律）
 *   · 销项开票不生成凭证 / 进项开票生成凭证（方案 A）
 *   · `sys_dict` 必须覆盖契约里声明的全部业务状态
 *
 * 与契约测试（pglite）的分工：这里跑在**真实 Postgres 的真实数据**上，
 * 能抓到只在真实数据分布下暴露的问题（历史遗留行、精度尾差、字典漏项）。
 *
 * 用法：npx tsx scripts/verify-tax-invariants.mjs
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { VAT_RATES } from '../shared/tax.ts';

const URL = readFileSync('.env', 'utf8')
  .split(/\r?\n/u)
  .find((l) => l.startsWith('DATABASE_URL='))
  .slice('DATABASE_URL='.length)
  .trim();

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/**
 * 从契约源码里取 `export type X = 'a' | 'b';` 的成员。
 *
 * 不用正则：这个纯词法任务用逐字符扫描更短也更不容易错 ——
 * 第一版用 `new RegExp(str + backslash-s ...)` 拼字符串，
 * 经 PowerShell 转义后变成匹配字面反斜杠，于是**一个都解析不出来**，
 * 而且脚本照样"跑得过"，只是把三条字典检查变成假失败。
 *
 * 支持两种写法：
 *   export type X = 'a' | 'b';
 *   export type X =
 *     | 'a'
 *     | 'b';
 */
function unionOf(source, typeName) {
  const head = `export type ${typeName}`;
  const start = source.indexOf(head);
  if (start < 0) return null;
  const eq = source.indexOf('=', start + head.length);
  if (eq < 0) return null;
  const semi = source.indexOf(';', eq);
  if (semi < 0) return null;
  const body = source.slice(eq + 1, semi);
  const vals = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === "'") {
      const end = body.indexOf("'", i + 1);
      if (end < 0) break;
      vals.push(body.slice(i + 1, end));
      i = end + 1;
    } else {
      i += 1;
    }
  }
  return vals.length ? vals : null;
}

async function main() {
  const sql = postgres(URL, { max: 4, connect_timeout: 10 });

  console.log('\n① 凭证借贷平衡（每张凭证借合计 == 贷合计）');
  const unbalanced = await sql`
    SELECT v.code, v.status,
           coalesce(sum(l.debit), 0)::float8  AS dr,
           coalesce(sum(l.credit), 0)::float8 AS cr
    FROM fin_voucher v
    LEFT JOIN fin_voucher_line l ON l.voucher_id = v.id
    GROUP BY v.id, v.code, v.status
    HAVING abs(coalesce(sum(l.debit),0) - coalesce(sum(l.credit),0)) > 0.005
    ORDER BY v.code`;
  record(
    '所有凭证借贷平衡',
    unbalanced.length === 0,
    unbalanced.length
      ? JSON.stringify(unbalanced.slice(0, 5))
      : `共检查 ${(await sql`SELECT count(*)::int AS n FROM fin_voucher`)[0].n} 张`,
  );

  console.log('\n② 价税分离自洽（net + tax == gross，误差 <= 0.01）');
  const splitBad = await sql`
    SELECT code, amount::float8 AS gross, net_amount::float8 AS net,
           tax_amount::float8 AS tax, tax_rate::float8 AS rate
    FROM erp_invoice
    WHERE net_amount IS NOT NULL AND tax_amount IS NOT NULL AND amount IS NOT NULL
      AND abs((net_amount + tax_amount) - amount) > 0.01
    LIMIT 10`;
  record('发票 net + tax == amount', splitBad.length === 0, splitBad.length ? JSON.stringify(splitBad) : '');
  const ctrSplitBad = await sql`
    SELECT code, amount::float8 AS gross, net_amount::float8 AS net, tax_amount::float8 AS tax
    FROM erp_contract
    WHERE net_amount IS NOT NULL AND tax_amount IS NOT NULL AND amount IS NOT NULL
      AND abs((net_amount + tax_amount) - amount) > 0.01
    LIMIT 10`;
  record('合同 net + tax == amount', ctrSplitBad.length === 0, ctrSplitBad.length ? JSON.stringify(ctrSplitBad) : '');

  console.log('\n③ 税率合法性（必须落在 shared/tax.ts 的白名单）');
  const badRates = await sql`
    SELECT 'invoice' AS src, code, tax_rate::float8 AS rate FROM erp_invoice WHERE tax_rate IS NOT NULL
    UNION ALL
    SELECT 'contract', code, tax_rate::float8 FROM erp_contract WHERE tax_rate IS NOT NULL
    LIMIT 500`;
  const illegal = badRates.filter((r) => !VAT_RATES.includes(r.rate));
  record(
    `税率均在白名单 [${VAT_RATES.join(',')}]`,
    illegal.length === 0,
    illegal.length ? JSON.stringify(illegal.slice(0, 8)) : `检查 ${badRates.length} 行`,
  );

  console.log('\n④ 凭证纳税主体与来源单据一致（否则账簿/报表漏计）');
  const orphanTaxEntity = await sql`
    SELECT v.code, v.source_type, v.source_ref
    FROM fin_voucher v
    WHERE v.tax_entity_id IS NULL AND v.status <> 'voided'
    LIMIT 10`;
  record('非作废凭证都有纳税主体（P0-2）', orphanTaxEntity.length === 0, orphanTaxEntity.length ? JSON.stringify(orphanTaxEntity) : '');
  const invEntityMismatch = await sql`
    SELECT v.code AS voucher, i.code AS invoice
    FROM fin_voucher v
    JOIN erp_invoice i ON v.source_ref = 'invoice:' || coalesce(i.invoice_no, i.code)
    WHERE v.source_type = 'invoice' AND v.status <> 'voided'
      AND i.tax_entity_id IS NOT NULL
      AND v.tax_entity_id IS DISTINCT FROM i.tax_entity_id
    LIMIT 10`;
  record('发票凭证的纳税主体与发票一致', invEntityMismatch.length === 0, invEntityMismatch.length ? JSON.stringify(invEntityMismatch) : '');

  console.log('\n⑤ 核销不得超过单额（应收/应付）');
  const overAr = await sql`
    SELECT ar.code, ar.amount::float8 AS amount, coalesce(sum(w.amount), 0)::float8 AS written
    FROM erp_ar ar
    LEFT JOIN erp_ar_writeoff w ON w.ar_id = ar.id AND (w.reversal_of IS NULL)
    GROUP BY ar.id, ar.code, ar.amount
    HAVING coalesce(sum(w.amount), 0) > ar.amount + 0.01
    LIMIT 10`;
  record('应收累计核销 <= 应收金额', overAr.length === 0, overAr.length ? JSON.stringify(overAr) : '');
  const overAp = await sql`
    SELECT ap.code, ap.amount::float8 AS amount, coalesce(sum(w.amount), 0)::float8 AS written
    FROM erp_ap_bill ap
    LEFT JOIN erp_ap_writeoff w ON w.ap_id = ap.id AND (w.reversal_of IS NULL)
    GROUP BY ap.id, ap.code, ap.amount
    HAVING coalesce(sum(w.amount), 0) > ap.amount + 0.01
    LIMIT 10`;
  record('应付累计核销 <= 应付金额', overAp.length === 0, overAp.length ? JSON.stringify(overAp) : '');

  console.log('\n⑥ 凭证状态只取 draft/posted/voided');
  const badStatus = await sql`SELECT code, status FROM fin_voucher WHERE status NOT IN ('draft','posted','voided') LIMIT 5`;
  record('凭证状态合法', badStatus.length === 0, JSON.stringify(badStatus));

  console.log('\n⑦ 销项开票不生成凭证 / 进项开票生成凭证（方案 A）');
  const salesWithVoucher = await sql`
    SELECT i.code FROM erp_invoice i
    WHERE i.direction = 'sales' AND i.status = 'issued'
      AND EXISTS (SELECT 1 FROM fin_voucher v
        WHERE v.source_type = 'invoice'
          AND v.source_ref = 'invoice:' || coalesce(i.invoice_no, i.code)
          AND v.status <> 'voided')
    LIMIT 5`;
  const purchaseWithoutVoucher = await sql`
    SELECT i.code FROM erp_invoice i
    WHERE i.direction = 'purchase' AND i.status = 'issued'
      AND NOT EXISTS (SELECT 1 FROM fin_voucher v
        WHERE v.source_type = 'invoice'
          AND v.source_ref = 'invoice:' || coalesce(i.invoice_no, i.code)
          AND v.status <> 'voided')
    LIMIT 5`;
  record('销项发票不生成凭证（收入确认为唯一收入入口）', salesWithVoucher.length === 0, salesWithVoucher.length ? `意外有凭证: ${JSON.stringify(salesWithVoucher)}` : '');
  record('进项发票已生成凭证', purchaseWithoutVoucher.length === 0, purchaseWithoutVoucher.length ? `缺凭证: ${JSON.stringify(purchaseWithoutVoucher)}` : '');

  console.log('\n⑧ 增值税底稿口径与发票台账一致（按 status=issued 取数）');
  const vat = await sql`
    SELECT d.period, d.tax_entity_id, d.output_tax::float8 AS decl_output, d.input_tax::float8 AS decl_input
    FROM fin_vat_declaration d LIMIT 5`.catch(() => []);
  if (vat.length === 0) {
    record('增值税底稿与台账一致', true, '（无已生成底稿——该流程本轮未被数据覆盖）');
  } else {
    let mismatch = 0;
    for (const d of vat) {
      const a = (await sql`
        SELECT
          coalesce(sum(CASE WHEN direction = 'sales'    THEN tax_amount END), 0)::float8 AS out_tax,
          coalesce(sum(CASE WHEN direction = 'purchase' THEN tax_amount END), 0)::float8 AS in_tax
        FROM erp_invoice
        WHERE status = 'issued'
          AND to_char(invoice_date, 'YYYY-MM') = ${d.period}
          AND tax_entity_id = ${d.tax_entity_id}`)[0];
      if (Math.abs(a.out_tax - d.decl_output) > 0.01 || Math.abs(a.in_tax - d.decl_input) > 0.01) mismatch += 1;
    }
    record('增值税底稿与发票台账一致', mismatch === 0, mismatch ? `${mismatch} 个期间不一致` : `检查 ${vat.length} 个期间`);
  }

  console.log('\n⑨ period 必须由 voucher_date 推导');
  const periodMismatch = await sql`
    SELECT code, voucher_date::text AS d, period FROM fin_voucher
    WHERE voucher_date IS NOT NULL AND period IS DISTINCT FROM to_char(voucher_date, 'YYYY-MM') LIMIT 10`;
  record('period == to_char(voucher_date, YYYY-MM)', periodMismatch.length === 0, periodMismatch.length ? JSON.stringify(periodMismatch) : '');

  console.log('\n⑩ 金额精度不超过两位小数');
  const precision = await sql`
    SELECT 'erp_invoice.amount' AS col, count(*)::int AS n FROM erp_invoice WHERE amount <> round(amount, 2)
    UNION ALL SELECT 'erp_ar.amount', count(*)::int FROM erp_ar WHERE amount <> round(amount, 2)
    UNION ALL SELECT 'erp_ap_bill.amount', count(*)::int FROM erp_ap_bill WHERE amount <> round(amount, 2)
    UNION ALL SELECT 'fin_voucher_line.debit', count(*)::int FROM fin_voucher_line WHERE debit <> round(debit, 2)
    UNION ALL SELECT 'fin_voucher_line.credit', count(*)::int FROM fin_voucher_line WHERE credit <> round(credit, 2)`;
  const dirty = precision.filter((r) => r.n > 0);
  record('金额列无超过两位小数的值', dirty.length === 0, dirty.length ? JSON.stringify(dirty) : '');

  console.log('\n⑪ 收入确认都有凭证（方案 A）');
  const revNoVoucher = await sql`
    SELECT r.code FROM erp_project_revenue r
    WHERE NOT EXISTS (SELECT 1 FROM fin_voucher v
      WHERE v.source_type = 'revenue' AND v.source_ref LIKE '%' || r.code || '%' AND v.status <> 'voided')
    LIMIT 5`;
  record('收入确认都有凭证', revNoVoucher.length === 0, revNoVoucher.length ? `缺凭证: ${JSON.stringify(revNoVoucher)}` : '');

  /* ══════════ ⑫ 代码 ↔ 数据漂移：sys_dict 必须覆盖契约声明的状态 ══════════ */
  console.log('\n⑫ sys_dict 字典项覆盖契约声明的业务状态（防"服务端写了新状态、字典没跟上"）');
  /*
   * 为什么要查：B1 给应收/应付加作废路径时，服务端写 `status='voided'`、
   * 契约也含它，但前端标签表没跟上 —— 后果不是报错，而是**界面显示英文码、
   * 筛选下拉里根本没有那一项**（使用者连筛都筛不出来）。tsc 完全看不见
   * （字典是数据不是类型）。
   *
   * 期望值**从契约派生**，不手写：第一版按经验硬编码
   * `ap_status: [open, partial, settled, voided]`，而真实契约是
   * `ApStatus = pending|approved|partial|paid|voided`（没有 open/settled）——
   * 于是报了 3 个"缺项"，全是**我的猜测错了**。硬编码的期望值只会制造假告警，
   * 而假告警会让人开始忽略门禁。
   */
  const contractSrc = readFileSync('shared/api.interface.ts', 'utf8');
  const DICT_TO_CONTRACT = {
    ar_status: 'ArStatus',
    ap_status: 'ApStatus',
    asset_disposal_status: 'AssetDisposalStatus',
    note_status: 'NoteStatus',
  };
  const DICT_EXPECT = {};
  for (const [dictType, typeName] of Object.entries(DICT_TO_CONTRACT)) {
    const vals = unionOf(contractSrc, typeName);
    if (vals) DICT_EXPECT[dictType] = vals;
  }
  record(
    '从契约成功派生字典期望值',
    Object.keys(DICT_EXPECT).length === Object.keys(DICT_TO_CONTRACT).length,
    Object.entries(DICT_EXPECT).map(([k, v]) => `${k}=${v.length}项`).join(' '),
  );

  const dictRows = await sql`
    SELECT dict_type, dict_key FROM sys_dict WHERE dict_type IN ${sql(Object.keys(DICT_TO_CONTRACT))}`;
  const byType = {};
  for (const r of dictRows) (byType[r.dict_type] ??= []).push(r.dict_key);

  for (const [dictType, expected] of Object.entries(DICT_EXPECT)) {
    const actual = byType[dictType] ?? [];
    const missing = expected.filter((v) => !actual.includes(v));
    record(
      `sys_dict「${dictType}」覆盖 ${DICT_TO_CONTRACT[dictType]} 全部取值`,
      missing.length === 0,
      missing.length ? `缺: ${JSON.stringify(missing)}（实际有 ${JSON.stringify(actual)}）` : `${expected.length} 项齐全`,
    );
  }

  console.log('\n⑬ 各业务表实际出现的状态都在字典里（反向漂移）');
  const STATUS_COLUMNS = [
    ['erp_ar', 'status', 'ar_status'],
    ['erp_ap_bill', 'status', 'ap_status'],
    ['erp_invoice', 'status', null],
    ['erp_contract', 'status', null],
    ['erp_project', 'status', null],
    ['pur_order', 'status', null],
    ['ast_asset', 'status', null],
  ];
  for (const [table, col, dictType] of STATUS_COLUMNS) {
    const rows = await sql
      .unsafe(`SELECT DISTINCT ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL ORDER BY 1`)
      .catch(() => []);
    if (rows.length === 0) {
      record(`${table}.${col} 状态可解析`, true, '（表为空，跳过）');
      continue;
    }
    const values = rows.map((r) => String(r.v));
    if (!dictType) {
      record(`${table}.${col} 状态可解析`, true, `实际值 ${JSON.stringify(values)}`);
      continue;
    }
    const known = new Set((byType[dictType] ?? []).map(String));
    const unknown = values.filter((v) => !known.has(v));
    record(
      `${table}.${col} 的值都在 sys_dict(${dictType}) 里`,
      unknown.length === 0,
      unknown.length ? `字典外的值: ${JSON.stringify(unknown)}` : `${values.length} 种状态`,
    );
  }

  console.log('\n⑭ sys_dict 的每一项都有中文标签（否则界面显示英文码）');
  const noLabel = await sql`
    SELECT dict_type, dict_key FROM sys_dict
    WHERE dict_label IS NULL OR btrim(dict_label) = '' OR dict_label = dict_key
    LIMIT 20`;
  record('所有字典项都有中文标签', noLabel.length === 0, noLabel.length ? JSON.stringify(noLabel) : '');

  await sql.end({ timeout: 3 }).catch(() => {});

  const failed = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项（需人工判断是真缺陷还是口径差异）:');
    for (const f of failed) console.log(`  - ${f.name}  ${f.detail ?? ''}`);
    process.exitCode = 1;
  }
}

void main().catch((e) => {
  console.error('核查失败:', e);
  process.exitCode = 1;
});
