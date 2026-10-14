-- F4 辅助：列出因金额分位差卡在 failed 的采购验收凭证任务，便于人工核对后重放
-- 重放：将 status 从 failed 改回 pending（或按业务约定），由定时任务重试
-- 本脚本只读诊断。

SELECT
  q.id,
  q.source_type,
  q.source_ref,
  q.status,
  q.last_error,
  q.attempts,
  q.updated_at
FROM comp_voucher_job q
WHERE q.status = 'failed'
  AND (
    q.source_type = 'ap'
    OR q.source_ref LIKE 'po-accept:%'
    OR coalesce(q.last_error, '') ILIKE '%不平衡%'
    OR coalesce(q.last_error, '') ILIKE '%分%'
  )
ORDER BY q.updated_at DESC;
