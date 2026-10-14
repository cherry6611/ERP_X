import { randomBytes, scryptSync } from 'node:crypto';
import postgres from 'postgres';

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('缺少 DATABASE_URL');
  process.exit(1);
}
const username = process.argv[2] || process.env.ADMIN_USERNAME;
const password = process.argv[3] || process.env.ADMIN_PASSWORD;
if (!username || !password) {
  console.error(
    '用法: node scripts/set-admin-creds.mjs <username> <password>\n' +
      '或设置 ADMIN_USERNAME / ADMIN_PASSWORD（勿在脚本中内置口令）',
  );
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
try {
  const admins = await sql`
    SELECT u.id, u.username
    FROM sys_user u
    JOIN sys_role_member m ON m.user_id = u.id::text
    WHERE m.role_code = 'admin'
    ORDER BY u._created_at ASC
    LIMIT 1
  `;
  let targetId = admins[0]?.id;
  if (!targetId) {
    const fallback = await sql`SELECT id FROM sys_user WHERE username = 'admin' LIMIT 1`;
    targetId = fallback[0]?.id;
  }
  if (!targetId) throw new Error('admin user not found');

  const hash = hashPassword(password);
  await sql`
    UPDATE sys_user
    SET username = ${username},
        email = ${username},
        password_hash = ${hash},
        _updated_at = CURRENT_TIMESTAMP
    WHERE id = ${targetId}
  `;
  try {
    await sql`
      UPDATE sys_login_session
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE user_id = ${String(targetId)} AND revoked_at IS NULL
    `;
  } catch {
    /* ignore */
  }

  const after = await sql`
    SELECT id, username, email, display_name
    FROM sys_user WHERE id = ${targetId}
  `;
  console.log(JSON.stringify({ ok: true, user: after[0] }, null, 2));
} finally {
  await sql.end({ timeout: 2 });
}
