-- requires: 0000_baseline.sql（fin_account 为基线表）
-- P2-6 / P2-11：汇总科目的下钻目标改为可配置
--
-- 背景：分录模板使用准则一级编码（如 6602 管理费用、1002 银行存款），
-- `AccountResolverService.pick()` 会把汇总科目下钻到"编码字典序第一个启用末级后代"。
-- 这个结果完全由编码顺序决定：
--   - 科目表新增一个编码更小的子科目 → 入账科目静默漂移，凭证明细看不出换过科目；
--   - 业务想把进项税额固定到某个费用明细 → 系统无法表达，只能靠巧合。
--
-- 本迁移新增 `default_leaf_code`：汇总科目可显式指定下钻目标。
-- 为空时行为与迁移前完全一致（回落字典序第一个启用末级后代），因此**存量数据不受影响**。
--
-- 取值校验由 `AccountResolverService` 在运行时完成：必须是本节点的启用末级后代，
-- 否则记告警并回落到原行为（不阻断做账）。

ALTER TABLE fin_account
  ADD COLUMN IF NOT EXISTS default_leaf_code varchar(20);

COMMENT ON COLUMN fin_account.default_leaf_code IS
  '汇总科目的指定下钻末级科目；NULL = 沿用编码字典序第一个启用末级后代（P2-6）';
