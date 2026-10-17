-- 2026-10-16 审计修复 · 迁移 5
-- requires: 2026-10-15-upgrade-batch3-core.sql（erp_timesheet 及 employee_id 列已建）、2026-10-15-upgrade-batch5-sales-return-cost.sql
--
-- ============================================================================
-- 目的：修复审计报告 §7.2 B8（工时无唯一约束 + createTimesheet 无查重）
--       与 C-02 同源的"同人同项目同日重复登记 → 成本翻倍"
--
-- ## 缺陷
--
-- `erp_timesheet` 只有 `uq_erp_timesheet_code`（业务编号唯一），
-- **没有 `(employee_id, project_id, work_date)` 唯一约束**，
-- 而 `costs.service.ts` 的 `createTimesheet` 也**不做查重**。
--
-- 于是同一个人在同一天对同一个项目可以登记任意多条工时：
--   · 前端连点「提交」两次 / 网络重试 → 两条完全相同的记录；
--   · 两条都会被「确认」，**各生成一笔成本与一张凭证** → 成本翻倍。
-- 而事后**没有任何对账能发现它** —— `erp_project_cost` 里两笔成本的
-- `source_ref` 不同（`timesheet:TS...0001` / `...0002`），看起来就是两次真实工作。
--
-- ## 约束设计（为什么是部分唯一索引，而不是全表唯一）
--
-- ### ① 为什么按 `employee_id` 而不是 `employee_name`
--
-- 姓名可重复（同名员工），按姓名唯一会**误拦两个不同的人**在同一天
-- 给同一项目报工时 —— 那是完全正常的场景（如两位同名顾问）。
-- `employee_id` 在 `createTimesheet` 里是必填（未绑定员工直接拒绝），
-- 因此对**新数据**它总是有值。历史数据可能为空，故用
-- `coalesce(employee_id::text, employee_name)` 作为键 —— 对历史行退化到姓名，
-- 对新行用 id，两者都不放松。
--
-- ### ② 为什么排除 `status = 'confirmed'`
--
-- 已确认的工时**已经生成过成本与凭证**，此时再加约束毫无意义
-- （重复已经发生）；而把它纳入约束反而会让"确认后想再补一条"
-- （业务上可能是合理的，如漏记了下午的半天）在库层被拒，
-- 却给不出可理解的错误。真正要拦的是**同一个人的同一天出现多条
-- 尚未合并的活跃记录**：
--     draft / submitted 是"还没算过钱的"，重复会变成两份成本。
--
-- ### ③ 冲突处理
--
-- 与 `fix04` 的收入台账同策略：**先探测，有冲突就中断迁移并列出来**，
-- 由人工核对后重跑。绝不自动合并小时数（那会静默改动已入账口径）。
-- 本仓开发库实测 0 冲突，但迁移必须对任何库都安全。
-- ============================================================================

-- ── 前置探查：同人 + 同项目 + 同日 + 未确认 的重复 ──────────────────────────
DO $$
DECLARE
  dup_count int;
  sample text;
BEGIN
  SELECT count(*), string_agg(key_text, ' | ')
  INTO dup_count, sample
  FROM (
    SELECT coalesce(employee_id::text, employee_name) || '@' ||
           coalesce(project_id::text, '-') || '@' || work_date::text AS key_text
    FROM erp_timesheet
    WHERE work_date IS NOT NULL
      AND coalesce(status, 'draft') <> 'confirmed'
    GROUP BY coalesce(employee_id::text, employee_name), project_id, work_date
    HAVING count(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      '存在 % 组「同人 + 同项目 + 同日」的未确认工时（如 %），无法建立唯一约束。'
      '请先人工核对并删除/合并重复记录（注意：若其中已有 confirmed 的，'
      '对应成本与凭证需要一并红冲），处理完成后再重跑本迁移。'
      '本迁移**不会**自动合并或删除任何工时。',
      dup_count, left(coalesce(sample, ''), 500);
  END IF;
END $$;

-- ── 部分唯一索引 ────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_timesheet_employee_project_date
  ON erp_timesheet (
    coalesce(employee_id::text, employee_name),
    project_id,
    work_date
  )
  WHERE work_date IS NOT NULL
    AND coalesce(status, 'draft') <> 'confirmed';

COMMENT ON INDEX uq_erp_timesheet_employee_project_date IS
  'B8：同一员工 + 同一项目 + 同一工作日的**未确认**工时唯一。'
  '旧实现无此约束，连点两次提交会产生两条记录、各生成一笔成本与凭证（成本翻倍），'
  '且事后无法从 erp_project_cost 看出重复（source_ref 不同）。'
  '已确认（confirmed）的记录排除在外 —— 它们已生成成本，重复已经发生，'
  '再加约束只会误拦合理的补录。';

-- ── 工时合理性：单日单人 ≤ 24 小时 ──────────────────────────────────────────
-- 这一条**不是**审计点名的，但同一处写入路径缺了它会导致明显的脏数据
-- （例如误把 8 输成 80，成本直接放大 10 倍，而没有任何拦阻）。
-- 库层兜住绕过 service 的路径；service 层另有更友好的中文提示。
DO $$ BEGIN
  ALTER TABLE erp_timesheet
    ADD CONSTRAINT chk_timesheet_hours_range
    CHECK (hours IS NULL OR (hours > 0 AND hours <= 24));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON CONSTRAINT chk_timesheet_hours_range ON erp_timesheet IS
  '单条工时记录必须落在 (0, 24] 小时：0 或负数没有业务含义，'
  '超过 24 说明录入错误（把 8 输成 80 会让成本直接放大 10 倍）。';
