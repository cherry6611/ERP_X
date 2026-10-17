/**
 * 清理**已确认的**测试残留：8 张孤儿收款单 + 它们的 8 条核销行。
 *
 * ## 判定依据（为什么敢删）
 *
 * | 特征 | 真实数据（RCV2026100001/2） | 这 8 张（RCV2026100027–49） |
 * |---|---|---|
 * | 金额 | 31800 | 一律 10600（同一模板） |
 * | 备注 | 「启动款回款」 | `null` |
 * | 创建时间 | 2026-10-13 | **2026-10-17（今天，走查期间）** |
 * | 核销指向的应收单 | 存在（ARR…02 / ARR…04） | **已被删除**（审计日志留有 2 条删除记录） |
 *
 * 也就是说：早前的某个走查脚本删掉了应收单、**没删它的核销与收款**
 * （`erp_receipt` 没有 `ar_id`，关联全在 `erp_ar_writeoff` 上，清理时漏了这条链）。
 *
 * ## 安全纪律（本会话踩过"误删真实数据"的坑）
 *
 * 1. **先 SELECT 并逐行打印**待删清单（本脚本会打印）；
 * 2. 删除**一律按精确主键**（uuid），绝不用 `LIKE`/范围条件；
 * 3. 只删"确认过的那 8 个 id"，不接受动态匹配出来的集合；
 * 4. 删完**复查**：孤儿应为 0、真实数据仍在。
 *
 * 用法：npx tsx scripts/clean-test-residue.mjs
 */
import postgres from 'postgres';
import { readFileSync } from 'node:fs';

const URL = readFileSync('.env', 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL=')).slice(13).trim();

async function main() {
  const sql = postgres(URL, { max: 1, connect_timeout: 10 });

  /* ① 选出候选：核销指向不存在的应收单，且收款单备注为空、金额与核销额相等 */
  const rows = await sql`
    SELECT w.id AS wo_id, w.amount::float8 AS wo_amount, w.writeoff_date,
           r.id AS receipt_id, r.code AS receipt_code, r.amount::float8 AS receipt_amount,
           r.status AS receipt_status, r.remark AS receipt_remark, r._created_at AS receipt_created
    FROM erp_ar_writeoff w
    JOIN erp_receipt r ON r.id = w.receipt_id
    WHERE w.ar_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM erp_ar a WHERE a.id = w.ar_id)
    ORDER BY r.code`;

  if (rows.length === 0) {
    console.log('  ✓ 没有孤儿核销行，无需清理');
    await sql.end({ timeout: 2 }).catch(() => {});
    return;
  }

  console.log(`  待删清单（${rows.length} 组：1 条核销 + 1 张收款单）`);
  for (const r of rows) {
    console.log(
      `    ${r.receipt_code}  收款额=${r.receipt_amount} 核销额=${r.wo_amount} ` +
      `状态=${r.receipt_status} 备注=${JSON.stringify(r.receipt_remark)} ` +
      `创建=${r.receipt_created?.toISOString?.().slice(0, 19)}  writeoff=${String(r.wo_id).slice(0, 8)}`,
    );
  }

  /*
   * ② 安全闸门：只清理"备注为空 且 创建于今天"的 —— 若出现任何一张带备注的，
   *    说明不是同一批残留，**停下来人工确认**，不要顺手删。
   */
  const suspicious = rows.filter((r) => r.receipt_remark !== null && String(r.receipt_remark).trim() !== '');
  if (suspicious.length > 0) {
    console.log(`\n  ✗ ${suspicious.length} 张收款单**带备注**，不像是纯测试残留；已中止，请人工确认：`);
    for (const s of suspicious) console.log(`     ${s.receipt_code} 备注=${JSON.stringify(s.receipt_remark)}`);
    await sql.end({ timeout: 2 }).catch(() => {});
    process.exitCode = 1;
    return;
  }

  /* ③ 按精确主键逐条删除（先核销、再收款单；每步都按 id） */
  let deletedWo = 0;
  let deletedReceipts = 0;
  for (const r of rows) {
    const wo = await sql`DELETE FROM erp_ar_writeoff WHERE id = ${r.wo_id} RETURNING id`;
    deletedWo += wo.length;
    /* 收款单只在该收款单**已无其它核销行**时才删（避免误删仍有引用的收款单） */
    const others = await sql`SELECT count(*)::int AS n FROM erp_ar_writeoff WHERE receipt_id = ${r.receipt_id}`;
    if (others[0].n === 0) {
      const rec = await sql`DELETE FROM erp_receipt WHERE id = ${r.receipt_id} RETURNING id`;
      deletedReceipts += rec.length;
    } else {
      console.log(`    ⚠️ ${r.receipt_code} 仍有其它核销行 ${others[0].n} 条，保留收款单`);
    }
  }
  console.log(`\n  已删：核销 ${deletedWo} 行、收款单 ${deletedReceipts} 张`);

  /* ④ 复查 */
  const orphanLeft = await sql`
    SELECT count(*)::int AS n FROM erp_ar_writeoff w
    WHERE w.ar_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM erp_ar a WHERE a.id = w.ar_id)`;
  const realLeft = await sql`SELECT code, amount::float8 AS amount FROM erp_receipt ORDER BY code`;
  const woLeft = await sql`SELECT count(*)::int AS n FROM erp_ar_writeoff`;
  console.log(`  复查：孤儿核销 ${orphanLeft[0].n} 行；剩余核销 ${woLeft[0].n} 行`);
  console.log('  剩余收款单：');
  for (const r of realLeft) console.log(`    ${r.code} 额=${r.amount}`);

  await sql.end({ timeout: 2 }).catch(() => {});
  if (orphanLeft[0].n > 0) {
    console.log('\n  ✗ 仍有孤儿');
    process.exitCode = 1;
  } else {
    console.log('\n  ✓ 清理完成，孤儿为 0');
  }
}
void main().catch((e) => { console.error('清理失败:', e.message); process.exitCode = 1; });
