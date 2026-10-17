-- requires: 2026-10-17-fix12-voucher-line-fk.sql（同一类缺陷的第二处，接续修复）
--
-- 修复 `erp_contract_item.contract_id` **没有外键**导致合同明细孤儿行。
--
-- ## 与 fix12 同一类问题，第二处实例
--
-- fix12 修的是 `fin_voucher_line.voucher_id`（凭证分录 → 凭证）。
-- 本次审计把"父子关联但无外键"的表逐个查了一遍，发现**合同明细**同样有孤儿：
-- 实测 `erp_contract_item` 共 12 行，其中 **6 行的 `contract_id` 在 `erp_contract` 里不存在**，
-- 且这 6 行的 `item_name` 全部是 `[API_TEST] 走查合同` / `[API_TEST] 复现` ——
-- 即走查脚本"建合同 → 断言 → 删合同"时，删了父表没删子表。
--
-- ## 危害
--
-- 合同明细是**收入/开票的基数**（明细金额合计 = 合同金额）。
-- 孤儿明细的父合同已不存在，但：
--   ① 任何"按 contract_id 汇总明细"的查询会因父表缺失而漏掉它们（汇总口径与明细口径不符）；
--   ② 逆向上，若有人 `SELECT sum(amount) FROM erp_contract_item` 做总额核对，会**多算**。
--
-- ## 本迁移做两件事
--
-- 1. 清理父合同已不存在的明细（只删孤儿，不动任何有父合同的明细）；
-- 2. 加外键 + `ON DELETE CASCADE`（删合同自动删明细）。
--
-- 级联安全性：合同明细是合同的**组成部分**，没有独立生命周期，
-- 因此 `ON DELETE CASCADE` 是正确的语义（而不是 `RESTRICT`）。
--
-- ## 幂等
--
-- · 清理是 `WHERE NOT EXISTS`；
-- · 外键用 `duplicate_object` 例外包裹；
-- · 末尾断言外键确实存在。

-- ① 清理孤儿明细
DELETE FROM erp_contract_item i
WHERE NOT EXISTS (SELECT 1 FROM erp_contract c WHERE c.id = i.contract_id);

-- ② 加外键（幂等）
DO $$
BEGIN
  ALTER TABLE erp_contract_item
    ADD CONSTRAINT fk_erp_contract_item_contract
    FOREIGN KEY (contract_id) REFERENCES erp_contract (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- ③ 断言外键存在
DO $$
DECLARE
  fk_count int;
BEGIN
  SELECT count(*) INTO fk_count
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  WHERE c.relname = 'erp_contract_item'
    AND con.contype = 'f'
    AND con.conname = 'fk_erp_contract_item_contract';
  IF fk_count = 0 THEN
    RAISE EXCEPTION 'erp_contract_item 的外键 fk_erp_contract_item_contract 未建立';
  END IF;
END $$;
