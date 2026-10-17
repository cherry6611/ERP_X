-- 批次三收口：补全自动化任务登记（行政页 /admin-automation 的数据源）
-- requires: 2026-10-15-upgrade-batch1z-code-rules-seed.sql
--
-- ## 问题
--
-- `comp_automation_config` 是行政页「自动化任务」的数据源，逐任务可视化管理启停。
-- `AutomationConfigService.isEnabled()` 在表里**查不到该 key 时默认返回 true** ——
-- 也就是说，一个 cron handler 即使从未登记，也会照常执行，只是**行政页上看不到它**，
-- 业务方因此无法停用/启用这些任务。
--
-- C-10 新增合同到期提醒时才发现：除它之外的 cron handler **全都没有登记**
-- （建表迁移只建了表结构，没有种子数据）。结果是行政页长期只显示一条任务，
-- 而实际在跑的有十几条。这是一个**可管理性缺口**，不是显示瑕疵：
-- 业务方以为某个提醒已停用，实际每天早上都在发；或反之，想停却找不到开关。
--
-- ## 处理
--
-- 把 `server/platform/cron-map.ts` 与各 `@BindTrigger` 声明的 trigger 全部登记。
-- `enabled = true` 与既有行为一致（未登记时的默认值就是 true），
-- 因此本迁移**不改变任何运行时行为**，只是让开关可见、可控。
--
-- 维护约定：**新增 `@BindTrigger` 时必须同步登记本表**，
-- 否则又会出现"在跑但看不见"。`cron-map.spec.ts` 已用精确键列表锁住 trigger 集合，
-- 两者配合可避免遗漏。

INSERT INTO comp_automation_config (task_key, task_name, description, enabled)
SELECT v.task_key, v.task_name, v.description, v.enabled
FROM (VALUES
  ('ar_due_reminder_daily',
   '应收到期回款提醒',
   '每日 09:00 扫描 open 且 dueDate≤today+7 的逾期/临期应收，按回款责任人分组推送；无责任人归 admin。',
   true),
  ('delivery_warning_weekly',
   '项目交付周预警',
   '每周一 09:00 扫描逾期/7 天内到期里程碑 + SPI/CPI<0.9 的项目，推送 admin。',
   true),
  ('project_drive_sync_daily',
   '项目文档云盘同步',
   '每日 02:00 同步项目文档至飞书云空间。',
   true),
  ('feishu_daily_sync',
   '飞书多维表格同步',
   '每日 02:00 成本/合同出向同步、工时入向同步（依赖插件配置的 appToken/tableID）。',
   true),
  ('feishu_contact_full',
   '飞书通讯录全量同步',
   '每日 02:00 全量拉取通讯录。',
   true),
  ('feishu_contact_incremental',
   '飞书通讯录增量同步',
   '每 15 分钟增量拉取通讯录变更。',
   true),
  ('customer_credit_alert',
   '客户信用额度预警',
   '每日 09:00 扫描超信用额度/接近上限的客户，推送 admin。',
   true),
  ('admin_rent_expiry_remind',
   '房租合同到期提醒',
   '每日 09:00 扫描即将到期的房租合同，推送 admin。',
   true),
  ('voucher_job_retry',
   '凭证失败队列重试',
   '每 10 分钟重试失败的凭证生成任务（含自动重试上限与人工介入标记）。',
   true),
  ('session_cleanup_daily',
   '会话表清理',
   '每日 03:15 清理 30 天前的会话记录。',
   true),
  ('retention_daily',
   '数据保留与归档',
   '每日 03:30 归档超期审计日志与业务数据（归档后在保留策略允许时清理在线行）。',
   true),
  ('year_end_reminder_daily',
   '年结前置检查提醒',
   '12 月 20 日起每日 09:00 提醒 admin 完成年结前置检查。',
   true),
  ('bi_alert_daily',
   'BI 指标预警扫描',
   '每日 08:30 按用户订阅的指标阈值判定并推送预警。',
   true),
  ('note_due_reminder_daily',
   '票据到期提醒',
   '每日 09:00 扫描逾期与 15 天内到期的应收/应付票据，按责任人推送。',
   true),
  ('reconcile_voucher_ar',
   '凭证补偿对账',
   '每 15 分钟重放凭证失败队列，收敛「已生成应收但未生成凭证」的不一致窗口（最终一致兜底）。',
   true)
) AS v(task_key, task_name, description, enabled)
WHERE NOT EXISTS (
  SELECT 1 FROM comp_automation_config c WHERE c.task_key = v.task_key
);
