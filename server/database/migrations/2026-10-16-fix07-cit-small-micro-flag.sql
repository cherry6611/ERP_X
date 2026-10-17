-- 2026-10-16 审计修复 · 迁移 7
-- requires: 2026-10-16-fix06-stamp-duty-accounts.sql（222114 应交企业所得税已建）
--
-- ============================================================================
-- 目的：修复审计报告 §4.7(e) —— **企业所得税完全未实现**
--
-- 报告原文：`ACCOUNT_INCOME_TAX = '6801'`（所得税费用）在全仓**无引用**，
-- 利润表第 11 行（所得税费用）与第 12 行（净利润）实际取数恒为 0。
--
-- ## 本迁移做什么
--
-- 只加**资格列**（计算逻辑在 `server/common/tax/income-tax.ts`，分录模板在同目录
-- 的 `income-tax-posting.ts`，科目 6801 / 222114 已在基线 + fix06 就位）。
--
-- ### 为什么要单独一个资格列，而不是从现有字段推导
--
-- 小型微利企业的三项条件（财政部 税务总局公告 2023 年第 12 号）：
--   ① 年度应纳税所得额 ≤ 300 万元；
--   ② 从业人数 ≤ 300 人；
--   ③ 资产总额 ≤ 5,000 万元。
--
-- 条件①本系统能算（`computeIncomeTax` 会算并在超门槛时**自动降级**）；
-- 但条件②③需要"从业人数"与"资产总额"，而 `md_tax_entity` **没有这两个字段**，
-- 也不该在这里维护（人数在人资、资产在资产模块）。
--
-- ### 为什么 NULL 表示"未确认"而不是"默认享受"
--
-- 取值语义：
--   · `1` = 已人工确认符合三项条件 → 享受 5% 实际税负
--   · `0` = 已确认不符合 → 25%
--   · **NULL = 未确认** → 按 **不享受** 处理（偏严）
--
-- 代价不对称是这里唯一的判断依据：
--   · 按"不享受"多计提 → 汇算清缴可退，**无滞纳金**；
--   · 按"享受"少计提 → 需补税 + 按日万分之五滞纳金，且"以为自己是小微
--     结果不是"是税务稽查的常见情形（人数或资产超标而不自知）。
--
-- 因此本列**故意不设 DEFAULT** —— 一个 `DEFAULT 1` 会让所有主体在无人确认的
-- 情况下自动享受 5%，那正是"静默少缴"。这与 `vat_filing_cycle` 同一取向
-- （见 fix03 的论证）。
--
-- ## 为什么不用 CHECK 约束限死 0/1
--
-- 用 CHECK `IN (0, 1)` 看似更严，但会让"将来要记录第三态（如'待复核'）"
-- 变成一次迁移。`resolveCitSmallMicro()` 已把"只认 1"的判定收在一处并配了规格，
-- 库层的宽松不会造成静默错误 —— 判定口径由代码统一，不由列类型决定。
-- ============================================================================

ALTER TABLE md_tax_entity
  ADD COLUMN IF NOT EXISTS cit_small_micro boolean;

COMMENT ON COLUMN md_tax_entity.cit_small_micro IS
  '企业所得税「小型微利企业」资格（§4.7(e)）：1=已人工确认符合三项条件（享受 5% 实际税负）；'
  '0=已确认不符合（25%）；NULL=未确认（按不享受处理，偏严）。'
  '故意不设 DEFAULT —— 默认享受等于在无人确认时静默少缴。'
  '注意：本列与 taxpayer_type（增值税小规模资格）是**两套标准**，不得互相推导。';

-- 自检：企业所得税所需科目必须齐备，否则计算出的税额无处落账
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(expected.code, ', ') INTO missing
  FROM (VALUES ('6801'), ('222114')) AS expected(code)
  WHERE NOT EXISTS (
    SELECT 1 FROM fin_account f WHERE f.code = expected.code AND f.is_leaf = 1
  );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      '企业所得税所需末级科目缺失：%。6801（所得税费用）应在基线科目表中、'
      '222114（应交企业所得税）应由 fix06 建立；请检查迁移链完整性',
      missing;
  END IF;
END $$;

-- 自检：2221 的下钻目标必须仍是 222101（fix06 已加 222113/222114，此处复核）
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
    RAISE EXCEPTION
      '2221 下钻目标已变为 %（期望 222101），会改变既有凭证落账口径，已中断', drill_target;
  END IF;
END $$;
