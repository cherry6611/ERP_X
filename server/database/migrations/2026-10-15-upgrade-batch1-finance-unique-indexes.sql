-- 批次一：唯一索引与 schema.ts 声明对齐（NULLS NOT DISTINCT，避免 tax_entity_id 为 NULL 时重复）
-- requires: 2026-10-15-upgrade-batch1-vat-declaration.sql, 2026-10-15-upgrade-batch1-accounting-base.sql
--
-- 修正（全新库迁移链实测）：本文件名排序在 2026-10-15-upgrade-batch1-vat-declaration.sql 之前
-- （f < v），而 fin_vat_declaration 表由后者创建，直接建索引会报 42P01 relation does not exist。
-- 故此处先判表是否存在：已存在则按原意图把旧表达式索引替换为 NULLS NOT DISTINCT；
-- 尚不存在则跳过，由 vat-declaration.sql 直接建成同一最终定义（两处最终状态一致，无静默降级）。

DO $$
BEGIN
  IF to_regclass('fin_vat_declaration') IS NULL THEN
    RAISE NOTICE 'fin_vat_declaration 尚未创建，唯一索引由 vat-declaration.sql 建立';
    RETURN;
  END IF;
  DROP INDEX IF EXISTS uq_fin_vat_declaration_period_entity;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_vat_declaration_period_entity
    ON fin_vat_declaration (period, tax_entity_id) NULLS NOT DISTINCT;
END $$;

DROP INDEX IF EXISTS uq_fin_year_end_close_year;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_year_end_close_year
  ON fin_year_end_close (fiscal_year, tax_entity_id) NULLS NOT DISTINCT;

DROP INDEX IF EXISTS uq_fin_account_balance_snapshot;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_account_balance_snapshot
  ON fin_account_balance_snapshot (period, account_code, tax_entity_id) NULLS NOT DISTINCT;
