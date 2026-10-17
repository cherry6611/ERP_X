-- requires: 2026-10-15-upgrade-f01-vat-transfer-accounts.sql（本迁移新增 222106/222110/222111，须排在 222101 之后）
-- 附加税费接线（第 2 步）：2221 应交税费下补税种末级明细
--
-- ## 为什么这次可以安全地追加（修正上一轮的判断）
--
-- 上一轮曾判断"2221 是末级科目，改成汇总会改变既有凭证落账"——**该判断错误**。
-- 依据 `2026-10-15-upgrade-batch1-chart-of-accounts.sql:10`：
--     2221 应交税费（贷，**非末级**）  222101 销项税（贷）  222102 进项税（借）
-- 且 `...-chart-of-accounts-fix.sql:10` 已把 2221 名称改为"应交税费"。
-- 也就是说 2221 早已是汇总科目，本次只是**追加同级末级明细**，不改变任何既有结构。
--
-- ## 唯一的真实约束：编码必须排在 222102 之后
--
-- `AccountResolverService` 对汇总科目下钻的规则是"**编码字典序第一个启用末级后代**"。
-- 2221 当前的下钻目标 = 222101（销项税）。若新增编码排在 222101 之前，
-- 或 222101 被停用，下钻目标就会漂移 —— 这是一类**不报错、不平账**的静默错误。
-- 因此本次选用 222106 / 222110 / 222111，均排在 222102 之后，下钻结果保持 222101 不变。

INSERT INTO fin_account (code, name, account_type, parent_code, level, is_leaf, direction, sort_no, status)
SELECT v.code, v.name, 'liability', '2221', 2, 1, 'credit', v.sort_no, 'active'
FROM (VALUES
  ('222106', '应交税费-城建税',        222106),
  ('222110', '应交税费-教育费附加',    222110),
  ('222111', '应交税费-地方教育附加',  222111)
) AS v(code, name, sort_no)
WHERE NOT EXISTS (SELECT 1 FROM fin_account f WHERE f.code = v.code);

-- 自检：2221 的下钻目标必须仍是 222101，否则本迁移破坏了既有落账口径。
-- 用 DO 块断言，失败即中断迁移（宁可迁移失败，也不要静默漂移）。
DO $$
DECLARE
  drill_target text;
BEGIN
  SELECT f.code INTO drill_target
  FROM fin_account f
  WHERE f.parent_code = '2221' AND f.is_leaf = 1 AND f.status = 'active'
  ORDER BY f.code
  LIMIT 1;

  IF drill_target IS NOT NULL AND drill_target <> '222101' THEN
    RAISE EXCEPTION '2221 下钻目标已变为 %（期望 222101），本迁移会改变既有凭证落账口径，已中断', drill_target;
  END IF;
END $$;
