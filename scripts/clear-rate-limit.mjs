import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('缺少 DATABASE_URL');
  process.exit(1);
}
const sql = postgres(url, { max: 1 });
await sql`DELETE FROM comp_rate_limit`;
console.log('cleared');
await sql.end({ timeout: 2 });
