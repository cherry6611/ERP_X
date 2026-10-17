-- requires: 0000_baseline.sql（fin_account 为基线表）
-- T-S3：增值税月末结转科目（转出未交增值税 / 未交增值税）
--
-- ## 背景：为什么账上必须有这两个科目
--
-- 增值税申报底稿（fin_vat_declaration）一直在算"应纳税额"，但账上只有
-- 222101 销项 / 222102 进项两个明细，缺一步**月末结转**：
--     借 222103 转出未交增值税（应纳税额）
--     贷 222104 未交增值税
-- 没有这一步的后果：2221 明细余额永远停在"应交增值税"上，
-- 账面应交数、申报表应纳税额、实际欠税三者对不上，且**账面看不出来**。
--
-- ## 与 batch9/batch11 相同的约束：编码必须排在 222101 之后
--
-- `AccountResolverService` 对汇总科目下钻的规则是"编码字典序第一个启用末级
-- 后代"。2221 当前的下钻目标 = 222101（销项税）。若新增编码排在 222101
-- 之前，或 222101 被停用，下钻目标就会漂移 —— 不报错、不平账的静默错误。
-- 因此本次选用 222103 / 222104，均排在 222102 之后，下钻结果不变。
--
-- 方向说明：222103 是**借方**科目（转出方），222104 是**贷方**科目
-- （未交增值税的余额在贷方，缴纳时冲减）。两者都是 2221 下的末级科目。

INSERT INTO fin_account (code, name, account_type, parent_code, level, is_leaf, direction, sort_no, status)
SELECT v.code, v.name, 'liability', '2221', 2, 1, v.direction, v.sort_no, 'active'
FROM (VALUES
  ('222103', '应交税费-转出未交增值税', 'debit',  222103),
  ('222104', '应交税费-未交增值税',     'credit', 222104)
) AS v(code, name, direction, sort_no)
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
