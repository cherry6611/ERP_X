-- 销售退货成本冲回（口径：逐单选择处置方式）
--
-- 背景：`return-rules.ts` 早已备好 `salesReturnCostLines()`，注释写明"不自动红冲成本，
-- 退货商品是否回库可用需业务判定，属需财务确认的口径"。本迁移落地该口径的**逐单选择**：
--   - disposal_type = 'restock'：退回商品可再售 → 借 1403 原材料 / 贷 6401 主营业务成本
--   - disposal_type = 'scrap'  ：退回商品报废   → 借 6602 管理费用 / 贷 6401 主营业务成本
-- 之所以必须逐单而不是全局默认：一律回库会把已报废退货错记成库存，一律报废会把可再售
-- 退货错计费用，两者都是"错误数字看起来是对的"。
--
-- cost_amount 记录自动分摊算出的成本冲回金额，供审计复核：
--   金额 = 项目累计成本 × (退货含税金额 / 项目累计已确认收入含税金额)
-- 即按含税收入占比对项目成本做比例分摊。项目无收入或无成本数据时记 0，且不生成成本行。

ALTER TABLE sales_return
  ADD COLUMN IF NOT EXISTS disposal_type varchar(20) NOT NULL DEFAULT 'restock';

ALTER TABLE sales_return
  ADD COLUMN IF NOT EXISTS cost_amount numeric NOT NULL DEFAULT '0';

COMMENT ON COLUMN sales_return.disposal_type IS
  'restock=退回商品回库（借1403原材料）/ scrap=报废（借6602管理费用）；逐单由业务判定';

COMMENT ON COLUMN sales_return.cost_amount IS
  '自动分摊的成本冲回金额 = 项目累计成本 × (退货含税金额 / 项目累计收入含税金额)；0 表示未生成成本行';
