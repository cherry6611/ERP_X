-- 2026-10-16 审计修复 · 迁移 8
-- requires: 2026-10-15-upgrade-batch3-core.sql
--
-- ============================================================================
-- 目的：修复审计报告 §7.2 B13（定时任务幂等键缺失）
--
-- ## 缺陷
--
-- `JobScheduler.runExclusive` 已用会话级 advisory lock（`pg_try_advisory_lock`）
-- 解决了**多实例同时执行**（横向重复）。但它挡不住**同一天跑第二次**：
--
--   · 运维手工触发一次（排查问题、补发通知）；
--   · 任务失败后立即重试；
--   · 进程重启导致 cron 在当日再次命中（cron 库按"下一次触发时间"算，
--     重启后如果表达式已过点，有的实现会立即补跑一次）；
--   · 多实例部署下实例 A 跑完释放锁、实例 B 的 cron 稍晚 1 分钟命中。
--
-- 这些情形下**同一个责任人当天会收到两封一模一样的催办**。
-- 对使用者来说这是"系统在刷我"，比不提醒更糟 —— 它会让真实提醒被无视。
--
-- ## 修法：日粒度执行台账（`comp_automation_run`）
--
-- 每个任务每天最多"认领"成功一次：`INSERT ... ON CONFLICT DO NOTHING`
-- 抢到行才执行。这既是幂等键，也是一张**可查的执行台账** ——
-- 原先"这个任务今天到底跑没跑"在系统里无从查证，只能翻日志。
--
-- ## 为什么日粒度而不是"每次执行都记账"
--
-- 本表的用途是**防当日重复**，不是"记录每次执行"。若每次都插入，
-- `ON CONFLICT DO NOTHING` 就失去意义（每次都能插进去）。
-- 因此唯一键是 `(task_key, run_date)`，`run_date` 取**业务时区**日期
-- （`todayInShanghai()`，与 cron 的 `timeZone: 'Asia/Shanghai'` 一致）——
-- 用 UTC 日期会让"北京时间早上 8 点跑的任务"记到前一天。
--
-- ## 与 automation_config 的分工（不要混淆）
--
--   · `comp_automation_config`：这个任务**是否启用**（人工开关，长期有效）
--   · `comp_automation_run`：这个任务**今天是否已跑**（自动记账，日粒度）
--
-- ## 有意不做的事
--
-- **不自动清理历史行**。一年 365 行 × 十几个任务 = 几千行，量级可忽略；
-- 而"能查到三个月前某天任务跑没跑"在排障时很有用。
-- 若将来确实需要清理，走 `retention-tasks.automation.ts` 的既有保留策略，
-- 而不是在这里加一个隐式的 DELETE。
-- ============================================================================

CREATE TABLE IF NOT EXISTS comp_automation_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  /** 任务键，与 `JobScheduler` 的 `BindTrigger(trigger)` 同名 */
  task_key varchar(80) NOT NULL,
  /** 业务时区日期（Asia/Shanghai），与 cron 的 timeZone 一致 —— 不能用 UTC 日期 */
  run_date date NOT NULL,
  /** 首次执行开始时间（重复触发不会更新它，便于判断"第一次是什么时候跑的"） */
  started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  /** 执行结论：success = 正常跑完；failed = 抛错（见 error_message） */
  status varchar(20) NOT NULL DEFAULT 'success',
  /** 失败原因；成功时为 NULL */
  error_message text,
  /** 本次执行的说明（如"命中 3 条、发送 2 封"，便于无需翻日志就了解结果） */
  detail text
);

COMMENT ON TABLE comp_automation_run IS
  'B13：定时任务日粒度执行台账（幂等键）。每个任务每天最多执行一次 —— '
  'advisory lock 只解决多实例并发，挡不住"同一天跑第二次"（手工触发/失败重试/重启补跑），'
  '那会让同一个责任人当天收到两封一样的催办。本表既是幂等键也是可查的执行台账'
  '（原先"今天跑没跑"只能翻日志）。';

-- 幂等键本体的唯一约束
CREATE UNIQUE INDEX IF NOT EXISTS uq_comp_automation_run_task_date
  ON comp_automation_run (task_key, run_date);

-- 排障用：按日期查当天全部任务
CREATE INDEX IF NOT EXISTS idx_comp_automation_run_date
  ON comp_automation_run (run_date DESC);

-- 失败排查用：只索引失败行（成功行占绝大多数，部分索引更小）
CREATE INDEX IF NOT EXISTS idx_comp_automation_run_failed
  ON comp_automation_run (run_date DESC, task_key)
  WHERE status <> 'success';

-- 自检：唯一约束必须真实存在（防止某一步被静默跳过导致幂等失效）
DO $$
DECLARE
  has_unique boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'comp_automation_run'
      AND indexname = 'uq_comp_automation_run_task_date'
      AND indexdef LIKE '%UNIQUE%'
  ) INTO has_unique;

  IF NOT has_unique THEN
    RAISE EXCEPTION
      'comp_automation_run 上的唯一索引 uq_comp_automation_run_task_date 未建立，'
      'B13 的幂等保证会失效（同一任务当天可重复执行），已中断';
  END IF;
END $$;
