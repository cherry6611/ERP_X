-- 2026-10-16 审计修复 · 迁移 3
-- requires: 2026-10-15-upgrade-batch1-vat-declaration.sql（md_tax_entity / fin_vat_declaration 已存在）
--
-- ============================================================================
-- 目的：修复审计报告 §4.6 的 T9（小规模免征额度未实现）与其前置口径项
--
-- ## T9：月销售额 ≤ 10 万（季 ≤ 30 万）免征两项附加，但**必须知道申报周期**
--
-- 财税〔2016〕12 号：月销售额不超过 10 万元（按季纳税的季度销售额不超过 30 万元）
-- 的缴纳义务人，免征**教育费附加与地方教育附加**；城建税不在免征范围，仍照征。
--
-- `vat-declaration.service.ts` 此前**有意不接线**这个判定，理由写在代码注释里：
--
--   「判定涉及「月报还是季报」的申报口径，若按月度阈值自动判定，
--     在「季度合计 > 30 万但单月 ≤ 10 万」时会错误免征 → **少缴/漏缴**，
--     方向不可接受。保持不减免（偏严）。」
--
-- 这个判断是**对的**：缺"申报周期"这个要件时，任何自动判定都可能少缴。
-- 但"不减免"的代价是**长期多缴** —— 对小规模主体这不是小数目。
-- 正确的修法不是"猜"，而是**把缺失的要件补上**：让主体资料声明申报周期，
-- 声明了才接线，没声明就保持偏严（拒绝减免，并在底稿显式披露原因）。
--
-- 因此本迁移给 `md_tax_entity` 增加：
--   · `vat_filing_cycle`  —— 'monthly' | 'quarterly'，**默认 NULL = 未声明**；
--                           未声明时不减免（偏严、不会少缴），底稿推
--                           `small_scale_exemption_cycle_missing` 差异项提示补录。
--   · `vat_exemption_enabled` —— 是否启用免征额度判定。默认 1（启用），
--                           仅在已声明周期时生效。设为 0 可强制"一律不免征"，
--                           供有特殊口径（如放弃免税权）的主体使用。
--
-- ⚠️ 为什么不做成 NOT NULL DEFAULT 'monthly'：
-- "默认按月报"会在季报主体上**错误免征**（季度合计 30 万以内、但某单月超 10 万
-- 时，按月判定反而更严；反过来季度超过 30 万而单月都不超时，按月判定会错误免征）
-- —— 两个方向都可能少缴。默认 NULL 让"未声明"成为一个显式的、被披露的状态。
-- ============================================================================

ALTER TABLE md_tax_entity
  ADD COLUMN IF NOT EXISTS vat_filing_cycle varchar(20);

ALTER TABLE md_tax_entity
  ADD COLUMN IF NOT EXISTS vat_exemption_enabled integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN md_tax_entity.vat_filing_cycle IS
  '增值税申报周期：monthly=按月申报（免征额度 10 万/月）；quarterly=按季申报（30 万/季）。'
  'NULL=未声明 —— 此时不做免征判定（偏严，不会少缴），底稿会提示补录。';

COMMENT ON COLUMN md_tax_entity.vat_exemption_enabled IS
  '是否启用小规模免征额度判定（财税〔2016〕12 号）。默认 1=启用；'
  '0=一律不免征（适用于放弃免税权等特殊口径）。仅在 vat_filing_cycle 已声明时生效。';

-- 幂等守卫：非 monthly/quarterly/NULL 的取值直接拒绝写入，避免拼错导致口径静默漂移
DO $$ BEGIN
  ALTER TABLE md_tax_entity
    ADD CONSTRAINT chk_tax_entity_vat_filing_cycle
    CHECK (vat_filing_cycle IS NULL OR vat_filing_cycle IN ('monthly', 'quarterly'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE md_tax_entity
    ADD CONSTRAINT chk_tax_entity_vat_exemption_enabled
    CHECK (vat_exemption_enabled IN (0, 1));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
