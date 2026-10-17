-- requires: 0000_baseline.sql（fin_account）；2026-10-13-tax-final.sql（md_tax_entity）
-- 附加税费接线（第 1、2 步）：主体城建税率 + 6403 税种末级明细
--
-- 口径来源：业务方 2026-10-15 批准
--   ① 城建税率按主体配置、逐主体录入（市区 7 / 县镇 5 / 其他 1，代码推不出来）
--   ④ 6403 下按税种设末级明细
--
-- ⚠️ 关于 2221（应交税费）为何**本次不动**：
--   科目表里 `2221` 目前的名称是"应交税费—应交增值税"，且 `is_leaf = 1`，
--   被既有凭证大量直接引用。若为了挂附加税明细而把 2221 改成汇总科目，
--   `AccountResolverService` 会开始对它下钻（取第一个启用末级后代），
--   从而**悄悄改变既有凭证的落账科目** —— 这是行为变更，必须单独一次迁移、
--   单独验证，不能混在本迁移里。本迁移只动 6403：它目前是**未被任何逻辑引用**的
--   科目（附加税引擎此前不存在），因此拆明细是零风险的。

-- ---------- ① 主体城建税率 ----------

ALTER TABLE md_tax_entity
  ADD COLUMN IF NOT EXISTS urban_maint_rate numeric(5, 2);

COMMENT ON COLUMN md_tax_entity.urban_maint_rate IS
  '城建税率（百分数：市区7/县镇5/其他1）；NULL=未配置，计算时拒绝出数';

-- 税率是百分数，合法区间 0–100；用约束挡住"误填 0.07"这类量纲错误
-- （0.07 会被当成 0.07%，导致附加税几乎为 0 且不报错）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_tax_entity_urban_maint_rate'
  ) THEN
    ALTER TABLE md_tax_entity
      ADD CONSTRAINT chk_tax_entity_urban_maint_rate
      CHECK (urban_maint_rate IS NULL OR (urban_maint_rate > 0 AND urban_maint_rate <= 100));
  END IF;
END $$;

-- ---------- ② 6403 税金及附加 → 按税种设末级明细 ----------

INSERT INTO fin_account (code, name, account_type, parent_code, level, is_leaf, direction, sort_no, status)
SELECT v.code, v.name, 'expense', '6403', 2, 1, 'debit', v.sort_no, 'active'
FROM (VALUES
  ('640301', '税金及附加—城建税', 1),
  ('640302', '税金及附加—教育费附加', 2),
  ('640303', '税金及附加—地方教育附加', 3)
) AS v(code, name, sort_no)
WHERE NOT EXISTS (SELECT 1 FROM fin_account f WHERE f.code = v.code);

-- 6403 由末级改为汇总：符合 A-10"仅末级科目可做账"。
-- 幂等：多次执行结果一致。
UPDATE fin_account SET is_leaf = 0 WHERE code = '6403';
