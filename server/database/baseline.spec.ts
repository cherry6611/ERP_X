import { readFileSync } from 'node:fs';

describe('baseline migration', () => {
  const sql = readFileSync('server/database/migrations/0000_baseline.sql', 'utf8');

  it('creates both composite types', () => {
    expect(sql).toContain('CREATE TYPE user_profile');
    expect(sql).toContain('CREATE TYPE file_attachment');
  });

  it('creates the business tables and local auth tables', () => {
    const tables = sql.match(/CREATE TABLE/g) ?? [];
    expect(tables.length).toBeGreaterThanOrEqual(66);
    expect(sql).toContain('"sys_user"');
    expect(sql).toContain('"sys_role_member"');
    expect(sql).toContain('"comp_biz_code_seq"');
    expect(sql).toContain('"comp_voucher_job"');
  });
});
