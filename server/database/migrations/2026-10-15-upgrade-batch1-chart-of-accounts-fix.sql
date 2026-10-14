-- 批次一 / A-10（续）：科目方向与名称按科目性质纠偏
-- requires: 2026-10-15-upgrade-batch1-chart-of-accounts.sql
--
-- 背景：`final-audit.sql` / `2026-10-14-deep-fix.sql` 等早期迁移以裸 INSERT 写入科目，
-- 未设置 direction（默认 debit），且 `2221` 在历史迁移里名为"应交税费—应交增值税"，
-- 与准则一级科目"应交税费"不一致，会导致报表按方向取数时符号错误。
-- 本迁移按"科目性质 → 余额方向"重新推导一遍，幂等。

-- 1) 名称纠正
UPDATE fin_account SET name = '应交税费' WHERE code = '2221';
UPDATE fin_account SET name = '应交税费-销项税' WHERE code = '222101';
UPDATE fin_account SET name = '应交税费-进项税' WHERE code = '222102';
UPDATE fin_account SET name = '主营业务收入' WHERE code = '6001';

-- 2) 方向纠正：负债/权益/收入类为贷方，其余为借方
UPDATE fin_account
SET direction = 'credit'
WHERE account_type IN ('liability', 'equity', 'revenue', 'income')
  AND direction <> 'credit';

UPDATE fin_account
SET direction = 'debit'
WHERE account_type IN ('asset', 'expense', 'cost')
  AND direction <> 'debit';

-- 3) 层级/末级兜底：有子科目的父科目一律标记为非末级
UPDATE fin_account p
SET is_leaf = 0
WHERE EXISTS (SELECT 1 FROM fin_account c WHERE c.parent_code = p.code)
  AND p.is_leaf <> 0;

-- 4) 无子科目且未标记层级的科目按编码长度推导层级
UPDATE fin_account
SET level = CASE
  WHEN length(code) <= 4 THEN 1
  WHEN length(code) <= 6 THEN 2
  ELSE 3
END
WHERE level IS NULL OR level < 1;

-- 5) 一级科目（parent_code 为空）level 必须为 1
UPDATE fin_account SET level = 1 WHERE parent_code IS NULL AND level <> 1;
