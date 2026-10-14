-- 批次二 C-10：合同到期提醒纳入自动化任务开关
-- requires: 2026-10-15-upgrade-batch1z-code-rules-seed.sql
--
-- 背景：`comp_automation_config` 是行政页「自动化任务」(/admin-automation) 的数据源，
-- 逐任务可视化管理启停。`AutomationConfigService.isEnabled()` 在表里**查不到该 key 时
-- 默认返回 true**，因此新增 cron handler 不登记也不会报错 —— 但行政页上就看不到
-- 这个任务，业务方无法停用/启用它。C-10 的合同到期提醒属新增任务，必须登记。
--
-- 命名与 `server/platform/cron-map.ts` 的 trigger key 保持一致：
-- `contract_expiry_remind`（每日 09:15，避开 09:00 的应收/票据提醒高峰）。

INSERT INTO comp_automation_config (task_key, task_name, description, enabled)
SELECT v.task_key, v.task_name, v.description, v.enabled
FROM (VALUES
  ('contract_expiry_remind',
   '合同到期提醒',
   'C-10：每日 09:15 扫描生效中/履约中合同，对 30/15/3 天后到期的合同按负责人推送提醒（同一收件人合并为一封）；无负责人时发 admin。',
   true)
) AS v(task_key, task_name, description, enabled)
WHERE NOT EXISTS (
  SELECT 1 FROM comp_automation_config c WHERE c.task_key = v.task_key
);
