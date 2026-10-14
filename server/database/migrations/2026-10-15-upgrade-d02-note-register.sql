-- 批次三 / D-02：票据备查簿深化
-- requires: 2026-10-15-upgrade-batch3-core.sql
--
-- 背景：C-04 已实现票据状态机与单张票的贴现息计算，但**备查簿**还差两项
-- 《票据管理实施办法》要求的硬能力：
--   ① 缺号 / 重号检查 —— 备查簿须连续登记；缺号可能是漏登记（票丢了不知道），
--      重号必然是重复登记（同一张票抵扣两次）。都必须能被主动发现。
--   ② 贴现成本可解释 —— 多张票分批贴现时，"这批票一共付了多少贴现息、
--      综合成本率多少"是资金成本分析的基础数据。
--
-- 为支持 ②，本迁移补一个**贴现计息天数**列。为什么必须落库而不是从
-- `settled_date`/`due_date` 现算：贴现天数在贴现那一刻固定，
-- 而"距今天数"随时间变化；用后者冒充前者会算出一个"每天都不一样"的年化率。

/* ========== ① 贴现计息天数 ========== */

ALTER TABLE erp_note ADD COLUMN IF NOT EXISTS discount_days integer;

COMMENT ON COLUMN erp_note.discount_days IS
  'D-02：贴现计息天数（贴现日→到期日，算头不算尾），贴现时写入；用于备查簿的年化成本率分析';

-- 历史贴现票回填：贴现天数 = 到期日 − 贴现日（算头不算尾，即差值本身）
UPDATE erp_note
SET discount_days = (due_date - settled_date)
WHERE status = 'discounted'
  AND discount_days IS NULL
  AND settled_date IS NOT NULL
  AND due_date IS NOT NULL
  AND (due_date - settled_date) > 0;

-- 贴现票但无法回填天数的（缺 settled_date 或日期异常）保持 NULL，
-- 备查簿会在"数据不完整"清单里列出来提示补录，而不是用错的天数算年化。

/* ========== ② 备查簿连续性检查的索引 ========== */

-- 按票号查询重复/排序检查需要索引（票号已有唯一索引 uq_erp_note_no，
-- 但唯一索引阻止重复登记 —— 与"检测历史重复"不冲突：
-- 唯一索引是 C-04 就有的，本迁移不改它）
CREATE INDEX IF NOT EXISTS idx_erp_note_type_no
  ON erp_note (note_type, note_no);

-- 到期结构分桶需要按到期日排序
CREATE INDEX IF NOT EXISTS idx_erp_note_due_status
  ON erp_note (due_date, status);
