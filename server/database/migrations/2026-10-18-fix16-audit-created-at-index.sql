-- requires: 2026-10-18-fix15-core-fks.sql
-- P2-13：审计日志按时间倒序查询没有索引，日志量上来后 /api/audit/logs 与
-- 校验和链重算会全表排序。补一个 DESC 索引（幂等，可重复执行）。
CREATE INDEX IF NOT EXISTS idx_comp_audit_log_created_at
  ON comp_audit_log (_created_at DESC);
