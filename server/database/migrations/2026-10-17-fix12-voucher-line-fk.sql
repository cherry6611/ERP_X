-- requires: 2026-10-15-upgrade-batch1-accounting-base.sql（fin_voucher_line 的 direction / account_code 冗余列由该迁移引入）
--
-- 修复 `fin_voucher_line.voucher_id` **没有外键**导致的分录孤儿行。
--
-- ## 问题
--
-- `fin_voucher_line.voucher_id` 在 schema 里只有**索引**、没有外键
-- （实测：`fin_voucher_line` 外键数 = 0；而 `fin_voucher_line_aux.line_id`
-- 反而有 `REFERENCES fin_voucher_line(id) ON DELETE CASCADE`）。
--
-- 后果是"删了凭证、分录还在"：实测本库 `fin_voucher_line` 共 638 行，
-- 其中 **109 行（17%）的 `voucher_id` 在 `fin_voucher` 里不存在**。
-- 这些孤儿行的来源是走查脚本"建凭证 → 断言 → 删凭证"，删父表时没删子表。
--
-- ## 为什么现在报表面上看不出错
--
-- `ledgers.service.ts` 的取数用的是 `innerJoin(finVoucher, …)`，
-- 孤儿行被 join 过滤掉了 —— 所以**金额没有虚增**。
-- 但这仍是数据完整性缺陷，且有三个隐患：
--   ① 任何"不 join 直接按 account_code 汇总"的新查询会**立刻算错**；
--   ② `fin_voucher_line_aux` 有 CASCADE 指向本表，孤儿行上的辅助核算项
--      永远查不到、也永远不会被清理；
--   ③ 上线后若有人用 `SELECT count(*) FROM fin_voucher_line` 做对账，
--      得到的数字与实际凭证不一致。
--
-- ## 本迁移做两件事（顺序不能换）
--
-- 1. **先清理孤儿行** —— 否则下面加外键会因存量脏数据失败
--    （`ALTER TABLE … ADD CONSTRAINT` 会校验存量行）。
--    清理只删"父凭证不存在"的行，**不动任何有效分录**。
-- 2. **再加外键 + `ON DELETE CASCADE`** —— 从此删凭证自动删分录。
--    级联是安全的：实测代码里**没有任何**单独删除 `fin_voucher_line` 的地方
--    （`grep 'delete(finVoucherLine)'` 零命中），所以不会与业务逻辑冲突。
--
-- ## 幂等
--
-- · 清理是 `WHERE NOT EXISTS`，重复执行删不到东西；
-- · 外键用 `DO $$ … EXCEPTION WHEN duplicate_object` 包裹，重复执行不报错。

-- ① 清理孤儿分录（只影响父凭证已不存在的行）
DELETE FROM fin_voucher_line l
WHERE NOT EXISTS (SELECT 1 FROM fin_voucher v WHERE v.id = l.voucher_id);

-- ② 加外键（幂等）
DO $$
BEGIN
  ALTER TABLE fin_voucher_line
    ADD CONSTRAINT fk_fin_voucher_line_voucher
    FOREIGN KEY (voucher_id) REFERENCES fin_voucher (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN
  NULL; -- 已存在则跳过
END $$;

-- ③ 断言：外键必须存在（防止上面的 DO 块因其它原因静默失败）
DO $$
DECLARE
  fk_count int;
BEGIN
  SELECT count(*) INTO fk_count
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  WHERE c.relname = 'fin_voucher_line'
    AND con.contype = 'f'
    AND con.conname = 'fk_fin_voucher_line_voucher';
  IF fk_count = 0 THEN
    RAISE EXCEPTION 'fin_voucher_line 的外键 fk_fin_voucher_line_voucher 未建立';
  END IF;
END $$;
