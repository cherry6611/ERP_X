-- 批次三收口：删除两张**结构上不可能被使用**的退货明细行表
-- requires: 2026-10-15-upgrade-batch3-core.sql
--
-- ## 决策依据（实测，2026-10-15）
--
-- `pur_return_item` / `sales_return_item` 由 `batch3-core.sql` 建表时的注释写明是
-- "承载『按物料行退货』的扩展能力"——即**面向未来**预留的结构。经核对实际情况：
--
-- 1. **上游单据根本没有明细行**
--    - `pur_order` 是一张**扁平单行**表：`item_name` / `quantity` / `unit_price` /
--      `tax_rate` 都在表头上，不存在 `pur_order_item`；
--    - `erp_project_revenue` 同理（收入确认单本身即单行）；
--    - 全库唯一的"订单明细"表是 `erp_contract_item`（合同行），与采购/收入无关。
--
--    因此"按物料行退货"**在当前数据模型下无法成立**——
--    退货行表没有可引用的对象。这不是"还没实现"，而是"结构上没有落脚点"。
--
-- 2. **完整退货能力并不依赖它**
--    - 部分退货已由 `pur_return.return_quantity`（整数数量）+
--      `returnableQuantity()`（可退 = 已验收 − 已退，含校验）支持；
--    - 金额按原单税率倒算（`returnAmount()` / `sumReturnLines()`），与行表无关。
--
-- 3. **零引用**：两张表在 `server/`、`client/`、`shared/`、`scripts/` 中
--    除 `schema.ts` 定义外**没有任何引用**（含 raw SQL 表名），
--    由 `baseline-consistency.spec.ts` 的孤儿表审计持续核对。
--
-- ## 为什么不"留着等以后用"
--
-- 保留的代价是**schema 会说谎**：看到这两张表的人会以为系统支持按行退货，
-- 进而设计出依赖它的流程，最后发现上游没有明细行。删除是**可逆**的：
-- 若业务将来真的引入多行采购订单，重建这两张表只需一条迁移，
-- 而在此之前它们只会持续误导。
--
-- ## 恢复方式（若将来引入 `pur_order_item`）
--
-- 先建 `pur_order_item`，再按 `batch3-core.sql` 原定义重建本表并加外键指向它；
-- 届时"可退数量"的基准也应从表头 `accepted_quantity` 改为行级 `accepted_quantity`。

DROP TABLE IF EXISTS pur_return_item;
DROP TABLE IF EXISTS sales_return_item;

COMMENT ON COLUMN pur_return.return_quantity IS
  'C-05：本次退货数量（整单口径）。pur_order 为扁单单行模型（无订单明细行），'
  '故退货按整单数量；部分退货由此列支持，可退上限由 returnableQuantity() 校验。';
