#!/usr/bin/env node
/**
 * D-09 / NFR-S8：审计日志防篡改的**真实数据库**自检。
 *
 * ## 为什么需要这个脚本（而不是只靠迁移 dryrun）
 *
 * `npm run migrate:dryrun` 在 pglite（WASM PostgreSQL）上跑迁移链，能证明
 * "迁移能执行"；但**不能证明生产库上的约束真的生效** —— 触发器、异常码、
 * `SET LOCAL` 语义在两个实现之间可能不同。等保测评与渗透测试整改都需要
 * "在真实库上看到拒绝行为"的证据，本脚本就是产出这份证据的工具。
 *
 * 用法：
 *   node ./scripts/check-audit-immutability.mjs
 *   DATABASE_URL=postgres://... node ./scripts/check-audit-immutability.mjs
 *
 * 退出码：0 = 全部通过；1 = 存在不符合项（打印 FAIL 行）。
 *
 * ⚠️ 本脚本会向 `comp_audit_log` 插入若干 `actor='d09-probe'` 的探针行，
 * 并在测试用清理步骤中带归档标记删除它们。它不会删除任何非探针数据。
 * 建议在**预发/生产**只读窗口外执行，或先用 `--dry-run` 看要做什么。
 */
import postgres from 'postgres';

const DRY_RUN = process.argv.includes('--dry-run');
const PROBE_ACTOR = 'd09-probe';
const url =
  process.env.DATABASE_URL ?? 'postgresql://erp@127.0.0.1:5433/shengseerp';

/** 与迁移里的算法保持一致 */
const RECOMPUTE_SQL = `md5(
  coalesce(prev_hash,'GENESIS') || '|' || chain_seq::text || '|' ||
  coalesce(actor,'') || '|' || coalesce(action,'') || '|' ||
  coalesce(object_type,'') || '|' || coalesce(object_id::text,'') || '|' ||
  coalesce(object_code,'') || '|' ||
  to_char(_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS') || '|' ||
  coalesce(detail,'')
)`;

const results = [];
function check(label, passed, extra = '') {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  results.push({ label, passed });
}

const sql = postgres(url, { max: 1 });

async function seedProbe(label) {
  await sql`
    INSERT INTO comp_audit_log (actor, action, object_type, detail)
    VALUES (${PROBE_ACTOR}, 'probe', 'probe', ${`D-09 自检：${label}`})`;
}

async function probeCount() {
  const rows = await sql`
    SELECT count(*)::int AS total FROM comp_audit_log WHERE actor = ${PROBE_ACTOR}`;
  return Number(rows[0].total);
}

/** 带归档标记删除探针行（唯一被允许的删除路径） */
async function purgeProbes() {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.retention_purge','on',true)`;
    await tx`DELETE FROM comp_audit_log WHERE actor = ${PROBE_ACTOR}`;
  });
}

try {
  console.log(`审计日志防篡改自检（D-09 / NFR-S8）`);
  console.log(`目标库：${url.replace(/:[^:@/]+@/, ':***@')}`);
  if (DRY_RUN) {
    console.log('\n--dry-run：仅检查结构与链完整性，不做写入/删除探针。\n');
  }

  /* ---------- ① 结构：链三列 ---------- */
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'comp_audit_log'
      AND column_name IN ('chain_seq','prev_hash','chain_hash')
    ORDER BY column_name`;
  check(
    '链三列已建立（chain_seq / prev_hash / chain_hash）',
    cols.length === 3,
    cols.map((c) => c.column_name).join(',') || '缺失'
  );

  /* ---------- ② 历史回填 ---------- */
  const nullChain = await sql`
    SELECT count(*)::int AS total FROM comp_audit_log WHERE chain_hash IS NULL`;
  const total = await sql`SELECT count(*)::int AS total FROM comp_audit_log`;
  check(
    '历史行链校验和已回填（无 NULL）',
    Number(nullChain[0].total) === 0,
    `总行数 ${total[0].total}，未回填 ${nullChain[0].total}`
  );

  /* ---------- ③ 链自洽 ---------- */
  const mismatch = await sql.unsafe(`
    SELECT count(*)::int AS total FROM comp_audit_log
    WHERE chain_hash IS NOT NULL AND chain_hash <> ${RECOMPUTE_SQL}`);
  check(
    '全部历史行校验和自洽（内容未被改动）',
    Number(mismatch[0].total) === 0,
    `不匹配 ${mismatch[0].total} 行`
  );

  /* ---------- ④ 链连续性（除归档造成的断点外应连续） ---------- */
  const gaps = await sql`
    WITH ordered AS (
      SELECT chain_seq, prev_hash,
             lag(chain_hash) OVER (ORDER BY chain_seq) AS expected_prev
      FROM comp_audit_log WHERE chain_hash IS NOT NULL
    )
    SELECT count(*)::int AS total FROM ordered
    WHERE expected_prev IS NOT NULL AND prev_hash <> expected_prev`;
  check(
    '链连续（无异常断裂）',
    Number(gaps[0].total) === 0,
    `断裂 ${gaps[0].total} 处（归档删除会造成断点，需与归档记录比对）`
  );

  if (!DRY_RUN) {
    /* ---------- ⑤ 插入自动串链 ---------- */
    const before = await sql`
      SELECT chain_seq, chain_hash FROM comp_audit_log
      WHERE chain_hash IS NOT NULL ORDER BY chain_seq DESC NULLS LAST LIMIT 1`;
    await seedProbe('串链验证');
    const after = await sql`
      SELECT chain_seq, chain_hash, prev_hash FROM comp_audit_log
      WHERE actor = ${PROBE_ACTOR} ORDER BY chain_seq DESC LIMIT 1`;
    check(
      '插入时自动串链（prev_hash 指向上一条）',
      before.length === 0 || after[0].prev_hash === before[0].chain_hash,
      `seq ${before[0]?.chain_seq ?? '-'} → ${after[0].chain_seq}`
    );

    /* ---------- ⑥ UPDATE 必须被拒 ---------- */
    let updateBlocked = false;
    let updateMessage = '';
    try {
      await sql`UPDATE comp_audit_log SET detail='tampered' WHERE actor=${PROBE_ACTOR}`;
    } catch (error) {
      updateBlocked = true;
      updateMessage = String(error.message ?? '').split('\n')[0].slice(0, 60);
    }
    check('UPDATE 被数据库拒绝（只追加约束）', updateBlocked, updateMessage);

    /* ---------- ⑦ DELETE 必须被拒 ---------- */
    const beforeDelete = await probeCount();
    let deleteBlocked = false;
    let deleteMessage = '';
    try {
      await sql`DELETE FROM comp_audit_log WHERE actor=${PROBE_ACTOR}`;
    } catch (error) {
      deleteBlocked = true;
      deleteMessage = String(error.message ?? '').split('\n')[0].slice(0, 60);
    }
    check(
      'DELETE 被数据库拒绝（未设归档标记）',
      deleteBlocked && beforeDelete > 0,
      `命中探针行 ${beforeDelete} 条；${deleteMessage}`
    );

    /* ---------- ⑧ 归档清理路径仍可用 ---------- */
    let purgeWorked = false;
    try {
      await purgeProbes();
      purgeWorked = (await probeCount()) === 0;
    } catch (error) {
      console.log(`      归档删除异常：${String(error.message).slice(0, 80)}`);
    }
    check(
      '设置 app.retention_purge=on 后允许删除（归档清理例外）',
      purgeWorked
    );

    /* ---------- ⑨ 标记不泄漏 ---------- */
    // 关键：必须**重新插入**探针行，否则 0 行 DELETE 不会触发 FOR EACH ROW 触发器，
    // "没报错"会被误判为"允许删除"。（本脚本第一版就踩过这个坑。）
    await seedProbe('SET LOCAL 泄漏探测');
    const beforeLeak = await probeCount();
    let stillBlocked = false;
    let leakMessage = '';
    try {
      await sql`DELETE FROM comp_audit_log WHERE actor=${PROBE_ACTOR}`;
    } catch (error) {
      stillBlocked = true;
      leakMessage = String(error.message ?? '').split('\n')[0].slice(0, 60);
    }
    check(
      'SET LOCAL 未泄漏到事务外（重新插入探针后仍被拒）',
      stillBlocked && beforeLeak > 0,
      `命中探针行 ${beforeLeak} 条；${leakMessage}`
    );

    await purgeProbes();
  }

  /* ---------- ⑩ 归档表带来源校验和 ---------- */
  const archCols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='comp_audit_log_archive'
      AND column_name IN ('source_chain_hash','source_chain_seq')`;
  check('归档表已带来源校验和列（可事后比对）', archCols.length === 2);
} catch (error) {
  console.error(`\n自检执行失败：${String(error.message)}`);
  await sql.end();
  process.exit(1);
} finally {
  await sql.end().catch(() => undefined);
}

const failed = results.filter((item) => !item.passed);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log(`不符合项：`);
  for (const item of failed) console.log(`  · ${item.label}`);
  process.exit(1);
}
console.log('审计日志只追加约束与校验和链均已在真实库上验证生效。');
