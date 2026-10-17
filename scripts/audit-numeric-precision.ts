/**
 * §6.4 numeric 精度审计：统计真实库上无精度 numeric 列的实际位数。
 *
 * ## 为什么必须先探查再改
 *
 * 把 `numeric` 收窄成 `numeric(p, s)` 是**有损操作**：
 *   · 存量数据超界时 PostgreSQL 会**报错拒绝**（这比静默截断好，但会中断迁移）；
 *   · 若为了"保险"选一个过宽的 p/s，等于**没改** —— 161 处改动全部白做。
 *
 * 只有在真实数据上量出"实际用到几位"，才能定一个既够用、又真正起约束作用的档位。
 * 本脚本同时充当**迁移前的安全闸门**：输出实测上限，迁移里的断言以此为准。
 *
 * 用法：`npx tsx scripts/audit-numeric-precision.ts`
 */
import postgres from 'postgres';

interface ColumnStat {
  table: string;
  column: string;
  rowCount: number;
  maxIntegerDigits: number;
  maxScale: number;
}

async function main(): Promise<void> {
  const sql = postgres({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 5433),
    database: process.env.DB_NAME ?? 'shengseerp',
    username: process.env.DB_USER ?? 'erp',
    password: process.env.DB_PASSWORD ?? '',
    max: 1,
  });

  const cols = await sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
      and data_type = 'numeric'
      and numeric_precision is null
    order by table_name, column_name
  `;

  const stats: ColumnStat[] = [];
  for (const col of cols) {
    /*
     * 逐列动态统计。标识符来自 information_schema（非用户输入），
     * 且用双引号包裹 —— 这里不用参数化是因为**标识符不能参数化**，
     * 而列名/表名全部来自系统目录而非请求，注入面为零。
     */
    const r = await sql.unsafe<
      { n: string; mi: number | null; ms: number | null }[]
    >(
      `select count(*)::text as n,
              coalesce(max(length(split_part(abs("${col.column_name}")::text, '.', 1))), 0)::int as mi,
              coalesce(max(length(split_part("${col.column_name}"::text, '.', 2))), 0)::int as ms
       from "${col.table_name}"
       where "${col.column_name}" is not null`,
    );
    stats.push({
      table: col.table_name,
      column: col.column_name,
      rowCount: Number(r[0]?.n ?? '0'),
      maxIntegerDigits: r[0]?.mi ?? 0,
      maxScale: r[0]?.ms ?? 0,
    });
  }

  const withData = stats.filter((s) => s.rowCount > 0);
  const maxInt = Math.max(0, ...withData.map((s) => s.maxIntegerDigits));
  const maxScale = Math.max(0, ...withData.map((s) => s.maxScale));

  console.log(`无精度 numeric 列总数：${stats.length}`);
  console.log(`其中有数据的：${withData.length}`);
  console.log('');
  if (withData.length > 0) {
    console.log('有数据的列（表.列 → 行数 / 最大整数位 / 最大小数位）:');
    for (const s of withData) {
      console.log(
        `  ${s.table}.${s.column} → ${s.rowCount} / ${s.maxIntegerDigits} / ${s.maxScale}`,
      );
    }
    console.log('');
  }
  console.log(`全库实测上限：整数位 ${maxInt}、小数位 ${maxScale}`);
  console.log('');
  console.log(
    '建议档位：金额类 numeric(18,2)（18 位总额、2 位小数）；' +
      '数量/单价类可放宽到 numeric(18,4) 或 numeric(18,6)。',
  );
  console.log(
    `按实测数据校验：numeric(18,2) ${maxInt <= 16 && maxScale <= 2 ? '✅ 安全' : '❌ 有超界风险'}`,
  );

  await sql.end();
}

void main();
