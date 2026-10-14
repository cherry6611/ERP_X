-- 审计报告 F7/F8：项目经理 userId 化 + 进项发票勾稽应付
-- 日期：2026-10-14

-- ---- F7：erp_project.pm_user_id ----
ALTER TABLE erp_project
  ADD COLUMN IF NOT EXISTS pm_user_id varchar(64);

CREATE INDEX IF NOT EXISTS idx_erp_project_pm_user
  ON erp_project (pm_user_id);

-- 按员工姓名唯一匹配回填 platform_user_id；同名冲突留空待人工确认
WITH emp_uid AS (
  SELECT
    e.name,
    (e.platform_user_id).user_id AS uid
  FROM md_employee e
  WHERE e.platform_user_id IS NOT NULL
    AND (e.platform_user_id).user_id IS NOT NULL
    AND (e.platform_user_id).user_id <> ''
),
unique_emp AS (
  SELECT name, min(uid) AS uid
  FROM emp_uid
  GROUP BY name
  HAVING count(DISTINCT uid) = 1
)
UPDATE erp_project p
SET pm_user_id = u.uid
FROM unique_emp u
WHERE p.pm IS NOT NULL
  AND p.pm = u.name
  AND (p.pm_user_id IS NULL OR p.pm_user_id = '');

-- 再按 sys_user.display_name 唯一匹配补漏
WITH user_uid AS (
  SELECT display_name AS name, id::text AS uid
  FROM sys_user
  WHERE status = 'active'
),
unique_user AS (
  SELECT name, min(uid) AS uid
  FROM user_uid
  GROUP BY name
  HAVING count(*) = 1
)
UPDATE erp_project p
SET pm_user_id = u.uid
FROM unique_user u
WHERE p.pm IS NOT NULL
  AND p.pm = u.name
  AND (p.pm_user_id IS NULL OR p.pm_user_id = '');

-- 诊断：同名冲突未回填的项目（人工确认）
DO $$
DECLARE
  conflict_cnt int;
BEGIN
  SELECT count(*) INTO conflict_cnt
  FROM erp_project p
  WHERE p.pm IS NOT NULL
    AND p.pm <> ''
    AND (p.pm_user_id IS NULL OR p.pm_user_id = '')
    AND EXISTS (
      SELECT 1 FROM md_employee e WHERE e.name = p.pm
    );
  IF conflict_cnt > 0 THEN
    RAISE NOTICE 'F7: % 个项目因 PM 姓名冲突/无 platform_user_id 未回填 pm_user_id，请人工确认', conflict_cnt;
  END IF;
END $$;

-- ---- F8：进项发票勾稽应付 ----
ALTER TABLE erp_invoice
  ADD COLUMN IF NOT EXISTS ap_id uuid;

CREATE INDEX IF NOT EXISTS idx_erp_invoice_ap
  ON erp_invoice (ap_id);
