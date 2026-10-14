-- 批次三 D-08 修复：资产变更单必须落**结构化**目标归属，否则"转交"不生效
-- requires: 2026-10-15-upgrade-batch3-asset-accounts.sql
--
-- ## 问题（实测复现）
--
-- 需求书 D-08 的"现状与差距"原文即写明：**「`ast_change` 存在但 transfer 不落归属」**。
-- 实测确认该问题**至今未修**：
--
-- - `ast_change` 只有 `before_value` / `after_value` 两个**自由文本**列
--   （形如 `状态:在用；部门:研发部；项目:无`）；
-- - `AssetChangeType` 含 `'transfer'`，但 `changeAction` 的 approve 分支只处理
--   `receive` 与 `scrap` —— **transfer 审批通过后什么都不发生**；
-- - 结果：转交单显示"已批准"，而 `ast_asset.department_id` / `project_id`
--   **一点没变**。资产仍挂在原部门，折旧分摊与部门成本归集全部错位。
--
-- 这类缺陷比"功能缺失"更危险：**它表现为成功**。审批通过、状态变绿，
-- 只有等到部门成本对不上时才会被发现，而那时已经跨了多个期间。
--
-- ## 根因
--
-- 流转信息只存在自由文本里，**没有结构化的目标**可供审批时写回。
-- 因此本迁移补两列结构化目标；`after_value` 文本保留为**展示用快照**，
-- 不再承担数据传递职责（文本解析不可靠：部门改名、格式微调都会让它失效）。
--
-- ## 口径
--
-- - `target_department_id` / `target_project_id` 可空：允许"只转部门"
--   或"只转项目"（例如人跟着项目走但部门不变）；
-- - 不留外键级联删除（`ON DELETE SET NULL`）：部门被删时不应连带删除变更单
--   —— 变更单是审计凭证，必须留存。归属置空由人工补正。

ALTER TABLE ast_change ADD COLUMN IF NOT EXISTS target_department_id uuid;
ALTER TABLE ast_change ADD COLUMN IF NOT EXISTS target_project_id uuid;

DO $$ BEGIN
  ALTER TABLE ast_change
    ADD CONSTRAINT fk_ast_change_target_department
    FOREIGN KEY (target_department_id) REFERENCES hr_department(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE ast_change
    ADD CONSTRAINT fk_ast_change_target_project
    FOREIGN KEY (target_project_id) REFERENCES erp_project(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN ast_change.target_department_id IS
  'D-08：转交后的目标部门（结构化）。审批通过时写回 ast_asset.department_id；'
  '为空表示本次不改变部门。';
COMMENT ON COLUMN ast_change.target_project_id IS
  'D-08：转交后的目标项目（结构化）。审批通过时写回 ast_asset.project_id；'
  '为空表示本次不改变项目。';

-- 便于按目标归属检索（审计"某部门接收过哪些资产"）
CREATE INDEX IF NOT EXISTS idx_ast_change_target_department
  ON ast_change (target_department_id) WHERE target_department_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ast_change_target_project
  ON ast_change (target_project_id) WHERE target_project_id IS NOT NULL;
