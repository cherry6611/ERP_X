-- requires: 2026-10-19-fix20-contract-scope-and-fks.sql
--
-- 框架合同可以挂多个项目：去掉「一合同一行项目」唯一索引。
-- 普通合同仍由服务层拒绝第二份项目。
-- 开支单据增加可空的我方主体，历史行留空。

DROP INDEX IF EXISTS uq_erp_project_one_contract;

ALTER TABLE erp_project_cost
  ADD COLUMN IF NOT EXISTS tax_entity_id uuid;

ALTER TABLE pur_order
  ADD COLUMN IF NOT EXISTS tax_entity_id uuid;

ALTER TABLE erp_admin_rent_contract
  ADD COLUMN IF NOT EXISTS tax_entity_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_erp_project_cost_tax_entity') THEN
    ALTER TABLE erp_project_cost
      ADD CONSTRAINT fk_erp_project_cost_tax_entity
      FOREIGN KEY (tax_entity_id) REFERENCES md_tax_entity(id)
      NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_pur_order_tax_entity') THEN
    ALTER TABLE pur_order
      ADD CONSTRAINT fk_pur_order_tax_entity
      FOREIGN KEY (tax_entity_id) REFERENCES md_tax_entity(id)
      NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_admin_rent_tax_entity') THEN
    ALTER TABLE erp_admin_rent_contract
      ADD CONSTRAINT fk_admin_rent_tax_entity
      FOREIGN KEY (tax_entity_id) REFERENCES md_tax_entity(id)
      NOT VALID;
  END IF;
END $$;
