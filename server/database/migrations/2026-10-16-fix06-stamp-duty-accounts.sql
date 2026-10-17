-- 2026-10-16 审计修复 · 迁移 6
-- requires: 2026-10-15-upgrade-f01-vat-transfer-accounts.sql（2221 下钻目标已确立为 222101）
--
-- ============================================================================
-- 目的：修复审计报告 §4.7(f) —— **印花税完全未实现**
--
-- 报告原文：全仓（ts/tsx/sql/md）grep「印花税」**零命中**；
-- 技术合同 0.3‰ 未实现；6403 明细也无印花税末级科目。
--
-- ## 影响
--
-- 数据服务公司的主要合同是技术合同，印花税率 0.3‰。签 500 万合同
-- 应缴 1,500 元，系统里既不计提、也不申报、也不进利润表 ——
-- 而印花税的滞纳金是**按日万分之五**（年化 18.25%），
-- 且税务稽查对印花税是常规检查项。金额小、漏缴后果重。
--
-- ## 本迁移做什么
--
-- 只加科目（计算逻辑在 `server/common/tax/stamp-duty.ts`，分录模板在同目录的
-- `stamp-duty-posting.ts`）。四个末级科目：
--
--   | 编码 | 名称 | 方向 | 用途 |
--   |---|---|---|---|
--   | 640304 | 税金及附加-印花税 | 借方 | 计提时借记 |
--   | 222113 | 应交税费-印花税 | 贷方 | 计提时贷记；缴纳时借记冲减 |
--
-- 同时为 §4.7(e)「企业所得税完全未实现」预置配套科目：
--
--   | 编码 | 名称 | 方向 |
--   |---|---|---|
--   | 222114 | 应交税费-应交企业所得税 | 贷方 |
--
-- （`6801 所得税费用` 已在基线科目表中存在，全仓原本无引用。）
--
-- ## ⚠️ 编码顺序约束（与 batch9 / batch11 / fix01 同一约束）
--
-- `AccountResolverService` 对汇总科目 2221 的下钻规则是「编码字典序第一个
-- 启用末级后代」，当前目标为 222101（销项税）。222113 / 222114 均排在
-- 222101 之后，下钻结果不变；迁移末尾有自检断言。
--
-- 640304 同理排在 640301 之后，不影响 6403 的下钻目标。
-- ============================================================================

INSERT INTO fin_account (code, name, account_type, parent_code, level, is_leaf, direction, sort_no, status)
SELECT v.code, v.name, v.account_type, v.parent_code, v.level, 1, v.direction, v.sort_no, 'active'
FROM (VALUES
  ('640304', '税金及附加-印花税',      'expense',   '6403', 2, 'debit',  640304),
  ('222113', '应交税费-印花税',        'liability', '2221', 2, 'credit', 222113),
  ('222114', '应交税费-应交企业所得税', 'liability', '2221', 2, 'credit', 222114)
) AS v(code, name, account_type, parent_code, level, direction, sort_no)
WHERE NOT EXISTS (SELECT 1 FROM fin_account f WHERE f.code = v.code);

-- 自检 ①：2221 的下钻目标必须仍是 222101，否则本迁移破坏了既有落账口径
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

-- 自检 ②：6403 的下钻目标必须仍是 640301（同理，印花税排在它之后）
DO $$
DECLARE
  drill_target text;
BEGIN
  SELECT f.code INTO drill_target
  FROM fin_account f
  WHERE f.parent_code = '6403' AND f.is_leaf = 1 AND f.status = 'active'
  ORDER BY f.code
  LIMIT 1;

  IF drill_target IS NOT NULL AND drill_target <> '640301' THEN
    RAISE EXCEPTION '6403 下钻目标已变为 %（期望 640301），本迁移会改变既有凭证落账口径，已中断', drill_target;
  END IF;
END $$;

-- 自检 ③：三个科目必须全部建立（防止某一步被静默跳过）
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(expected.code, ', ') INTO missing
  FROM (VALUES ('640304'), ('222113'), ('222114')) AS expected(code)
  WHERE NOT EXISTS (SELECT 1 FROM fin_account f WHERE f.code = expected.code);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '印花税/所得税科目未全部建立，缺失：%，已中断', missing;
  END IF;
END $$;
