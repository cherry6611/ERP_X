-- requires: 2026-10-19-fix18-invoice-client-request.sql
--
-- 第二批核心外键，仍用 NOT VALID：约束此后的写入，不因存量孤儿阻塞上线。
-- 清理孤儿后再单独 VALIDATE。不要在本文件里删数据。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_erp_project_contract') THEN
    ALTER TABLE erp_project
      ADD CONSTRAINT fk_erp_project_contract
      FOREIGN KEY (contract_id) REFERENCES erp_contract(id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_erp_invoice_contract') THEN
    ALTER TABLE erp_invoice
      ADD CONSTRAINT fk_erp_invoice_contract
      FOREIGN KEY (contract_id) REFERENCES erp_contract(id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_expense_apply_project') THEN
    ALTER TABLE fin_expense_apply
      ADD CONSTRAINT fk_fin_expense_apply_project
      FOREIGN KEY (project_id) REFERENCES erp_project(id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_expense_claim_project') THEN
    ALTER TABLE fin_expense_claim
      ADD CONSTRAINT fk_fin_expense_claim_project
      FOREIGN KEY (project_id) REFERENCES erp_project(id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ast_asset_tax_entity') THEN
    ALTER TABLE ast_asset
      ADD CONSTRAINT fk_ast_asset_tax_entity
      FOREIGN KEY (tax_entity_id) REFERENCES md_tax_entity(id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_expense_apply_tax_entity') THEN
    ALTER TABLE fin_expense_apply
      ADD CONSTRAINT fk_fin_expense_apply_tax_entity
      FOREIGN KEY (tax_entity_id) REFERENCES md_tax_entity(id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_expense_claim_tax_entity') THEN
    ALTER TABLE fin_expense_claim
      ADD CONSTRAINT fk_fin_expense_claim_tax_entity
      FOREIGN KEY (tax_entity_id) REFERENCES md_tax_entity(id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_voucher_tax_entity') THEN
    ALTER TABLE fin_voucher
      ADD CONSTRAINT fk_fin_voucher_tax_entity
      FOREIGN KEY (tax_entity_id) REFERENCES md_tax_entity(id)
      NOT VALID;
  END IF;
END $$;
