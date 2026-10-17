-- N-1：工资按应发计提 —— 2211 应付职工薪酬拆末级明细 + 2221 补应交个人所得税
-- requires: 2026-10-15-upgrade-batch9-tax-payable-details.sql
--
-- 背景：工资凭证原先按**净额**入账（借 成本费用 / 贷 2211 净额），两处后果：
--   ① 成本费用少计 —— 应计的是应发工资，不是实发；
--   ② 代扣个税从未形成 2221 负债 —— 实际缴税时账上没有可冲的科目，只能硬记。
-- 改为按应发计提后，需要 2211 下的末级明细来承接代扣项、需要 2221 下的个税明细。
--
-- ⚠️ 这是**行为变更**：2211 由末级改为汇总后，`AccountResolverService` 会对它下钻
-- （规则：编码字典序第一个启用末级后代）。因此子科目编码全部排在 221101 之后，
-- 保证下钻目标仍是「工资」。若下钻目标漂移，既有直接引用 2211 的凭证会悄悄改落到
-- 别的明细上 —— 一类不报错、不平账的静默错误，故末尾用 DO 块断言。
-- 2221 同理：下钻目标必须仍是 222101（沿用 batch9 的约束）。

INSERT INTO fin_account (code, name, account_type, parent_code, level, is_leaf, direction, sort_no, status)
SELECT v.code, v.name, 'liability', '2211', 2, 1, 'credit', v.sort_no, 'active'
FROM (VALUES
  ('221101', '应付职工薪酬-工资',       221101),
  ('221102', '应付职工薪酬-社会保险费', 221102),
  ('221103', '应付职工薪酬-住房公积金', 221103),
  ('221104', '应付职工薪酬-其他代扣',   221104)
) AS v(code, name, sort_no)
WHERE NOT EXISTS (SELECT 1 FROM fin_account f WHERE f.code = v.code);

-- 2211 由末级改为汇总：符合 A-10「仅末级科目可做账」。幂等。
UPDATE fin_account SET is_leaf = 0 WHERE code = '2211';

-- 222112 排在 222111 之后 → 不影响 2221 的下钻目标（仍是 222101）。
INSERT INTO fin_account (code, name, account_type, parent_code, level, is_leaf, direction, sort_no, status)
SELECT v.code, v.name, 'liability', '2221', 2, 1, 'credit', v.sort_no, 'active'
FROM (VALUES
  ('222112', '应交税费-应交个人所得税', 222112)
) AS v(code, name, sort_no)
WHERE NOT EXISTS (SELECT 1 FROM fin_account f WHERE f.code = v.code);

-- 自检：两个汇总科目的下钻目标必须保持不变，否则中断迁移
DO $$
DECLARE
  payroll_drill text;
  tax_drill text;
BEGIN
  SELECT f.code INTO payroll_drill
  FROM fin_account f
  WHERE f.parent_code = '2211' AND f.is_leaf = 1 AND f.status = 'active'
  ORDER BY f.code
  LIMIT 1;

  IF payroll_drill IS NOT NULL AND payroll_drill <> '221101' THEN
    RAISE EXCEPTION '2211 下钻目标已变为 %（期望 221101），本迁移会改变既有凭证落账口径，已中断', payroll_drill;
  END IF;

  SELECT f.code INTO tax_drill
  FROM fin_account f
  WHERE f.parent_code = '2221' AND f.is_leaf = 1 AND f.status = 'active'
  ORDER BY f.code
  LIMIT 1;

  IF tax_drill IS NOT NULL AND tax_drill <> '222101' THEN
    RAISE EXCEPTION '2221 下钻目标已变为 %（期望 222101），本迁移会改变既有凭证落账口径，已中断', tax_drill;
  END IF;
END $$;
