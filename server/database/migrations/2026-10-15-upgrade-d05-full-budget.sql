-- 批次三 / D-05：全面预算（收入预算 / 资本预算 / 滚动预测）
-- requires: 2026-10-15-upgrade-batch1z-code-rules-seed.sql
--
-- 背景：C-09 的预算表 `fin_budget` 只有 `expense_category` + `period` + `budget_amount`，
-- 即**只能编费用预算**。需求书 D-05 要求"从费用预算扩展到收入预算、资本预算、滚动预测"。
--
-- 设计选择：**扩展同一张表**而不是新建 `fin_revenue_budget` / `fin_capex_budget`。
-- 理由：预算的维度（部门/项目/期间）与执行率计算逻辑完全相同，
-- 分成三张表会让 C-09 的匹配函数、三算表、Excel 导入导出各写三遍，
-- 且今后加一种预算类型就要再改一轮。用 `budget_type` 区分，
-- 只在"维度适用性"上有差异（收入/资本预算不适用 expense_category）。
--
-- 【需财务确认】
--   1. 收入预算按**不含税**编制（与利润表口径一致）；若贵司按含税编制，
--      需在报表层另行换算，否则收入预算会系统性虚高 6%~13%。
--   2. 资本预算为**一次性支出**，不按月度执行率考核，只看额度是否够用。
--      若贵司将 CAPEX 按月摊销考核，需改用 expense 类型 + 折旧科目。

/* ========== ① 预算类型 ========== */

ALTER TABLE fin_budget
  ADD COLUMN IF NOT EXISTS budget_type varchar(20) NOT NULL DEFAULT 'expense';

COMMENT ON COLUMN fin_budget.budget_type IS
  'D-05：expense=费用预算（按月考核）/ revenue=收入预算（越高越好）/ capital=资本预算 CAPEX（一次性，只看额度）';

-- 历史行全部是费用预算（C-09 的口径），DEFAULT 已覆盖；这里显式纠偏以防手工改过
UPDATE fin_budget SET budget_type = 'expense' WHERE budget_type IS NULL;

DO $$ BEGIN
  ALTER TABLE fin_budget DROP CONSTRAINT IF EXISTS ck_fin_budget_type;
  ALTER TABLE fin_budget
    ADD CONSTRAINT ck_fin_budget_type
    CHECK (budget_type IN ('expense', 'revenue', 'capital'));
EXCEPTION WHEN others THEN
  RAISE NOTICE 'ck_fin_budget_type 建立失败：%', SQLERRM;
END $$;

/* ========== ② 维度适用性 ========== */

-- 收入/资本预算不按"费用类别"切分（收入没有费用类别；CAPEX 按项目/资产类别）。
-- 但**不强制**清空：历史数据可能已填，强制清空会破坏 C-09 的三算表。
-- 这里只加一条"不得为空的约束仅在费用类型生效"的说明性索引，实际校验在应用层，
-- 以便给出可读中文错误而不是数据库约束原文。

CREATE INDEX IF NOT EXISTS idx_fin_budget_type_period
  ON fin_budget (budget_type, period);

CREATE INDEX IF NOT EXISTS idx_fin_budget_type_project
  ON fin_budget (budget_type, project_id);

/* ========== ③ 滚动预测参数 ========== */

INSERT INTO sys_param (param_key, param_value, value_type, param_group, description, editable)
SELECT v.param_key, v.param_value, 'number', '预算', v.description, 1
FROM (VALUES
  ('budget.forecast_threshold', '10',
   'D-05 滚动预测偏差阈值（%）：已确认期间执行率偏离 100% 超过该值时才给出趋势预测提示'),
  ('budget.variance_threshold', '10',
   'D-05 差异分析阈值（%）：差异率超过该值要求说明原因'),
  ('budget.expense_ratio_tolerance', '2',
   'D-05 费用率容差（百分点）：实际费用率高于预算费用率超过该值才告警')
) AS v(param_key, param_value, description)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_param p WHERE p.param_key = v.param_key
);
